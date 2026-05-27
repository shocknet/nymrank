'use strict';

const { getBxrdConfig } = require('./config');
const { BXRD_RANKING_SOURCE } = require('./bxrd-constants');

const BXRD_PROBE_TIMEOUT_MS = 8000;
const DEFAULT_MIN_BXRD_RANKINGS = 1000;

function checkResult(ok, details = {}) {
  return { ok, ...details };
}

async function checkDatabase(database) {
  const started = Date.now();
  await database.query('SELECT 1');
  return checkResult(true, { latency_ms: Date.now() - started });
}

async function probeBxrdApi(config) {
  if (!config.bearerToken) {
    return checkResult(false, { error: 'token_not_configured' });
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BXRD_PROBE_TIMEOUT_MS);

  try {
    const base = config.apiBaseUrl.replace(/\/$/, '');
    const url = `${base}/wot?since=${Date.now()}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.bearerToken}` },
      signal: controller.signal
    });
    const latency_ms = Date.now() - started;

    if (!res.ok) {
      return checkResult(false, { latency_ms, error: `http_${res.status}` });
    }

    const body = await res.json();
    if (!body.success || !body.data) {
      return checkResult(false, { latency_ms, error: 'invalid_response' });
    }

    return checkResult(true, {
      latency_ms,
      entries: Array.isArray(body.data.entries) ? body.data.entries.length : 0
    });
  } catch (err) {
    const error = err.name === 'AbortError' ? 'timeout' : err.message;
    return checkResult(false, { error, latency_ms: Date.now() - started });
  } finally {
    clearTimeout(timer);
  }
}

async function checkBxrdData(database, minRankings) {
  const countResult = await database.query(
    `SELECT COUNT(*)::int AS count
     FROM user_rankings
     WHERE ranking_source = $1 AND rank_value >= 35`,
    [BXRD_RANKING_SOURCE]
  );
  const ranking_count = countResult.rows[0]?.count ?? 0;

  const precomputedResult = await database.query(
    'SELECT COUNT(*)::int AS count FROM precomputed_rankings'
  );
  const precomputed_count = precomputedResult.rows[0]?.count ?? 0;

  const ok = ranking_count >= minRankings && precomputed_count > 0;
  return checkResult(ok, {
    ranking_count,
    precomputed_count,
    min_rankings: minRankings
  });
}

async function checkBxrdSync(database, deltaPollMs) {
  const state = await database.getBxrdSyncState();
  const maxStaleMs = deltaPollMs * 4 + 120000;
  const lastMs = Math.max(
    state.last_delta_at ? new Date(state.last_delta_at).getTime() : 0,
    state.last_snapshot_at ? new Date(state.last_snapshot_at).getTime() : 0
  );

  const age_ms = lastMs > 0 ? Date.now() - lastMs : null;
  const ok = lastMs > 0 && age_ms <= maxStaleMs;

  return checkResult(ok, {
    last_since_ms: state.last_since_ms,
    last_snapshot_etag: state.last_snapshot_etag ? 'set' : null,
    last_snapshot_at: state.last_snapshot_at,
    last_delta_at: state.last_delta_at,
    age_ms,
    max_stale_ms: maxStaleMs
  });
}

async function checkLookupPath(database) {
  const sample = await database.query(
    `SELECT ur.ranked_user_pubkey AS pubkey
     FROM user_rankings ur
     WHERE ur.ranking_source = $1 AND ur.rank_value >= 35
     LIMIT 1`,
    [BXRD_RANKING_SOURCE]
  );
  const pubkey = sample.rows[0]?.pubkey;
  if (!pubkey) {
    return checkResult(false, { error: 'no_sample_pubkey' });
  }

  const rankResult = await database.query(
    `SELECT ROUND(AVG(ur.rank_value))::INTEGER AS average_rank,
            COUNT(*)::int AS perspective_count
     FROM user_rankings ur
     WHERE ur.ranked_user_pubkey = $1 AND ur.ranking_source = $2
     GROUP BY ur.ranked_user_pubkey`,
    [pubkey, BXRD_RANKING_SOURCE]
  );

  const ok = rankResult.rows.length > 0;
  return checkResult(ok, { sample_pubkey: pubkey, perspective_count: rankResult.rows[0]?.perspective_count });
}

function minBxrdRankingsRequired() {
  const parsed = parseInt(process.env.HEALTH_MIN_BXRD_RANKINGS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_BXRD_RANKINGS;
}

function aggregateOk(checks, bxrdConfig) {
  if (!checks.database.ok) return false;
  if (!bxrdConfig.primarySource && !bxrdConfig.syncEnabled) return true;

  if (bxrdConfig.syncEnabled && !checks.bxrd_api.skipped && !checks.bxrd_api.ok) return false;
  if (bxrdConfig.primarySource) {
    if (!checks.bxrd_data.ok || !checks.lookups.ok) return false;
    if (bxrdConfig.syncEnabled && !checks.bxrd_sync.skipped && !checks.bxrd_sync.ok) {
      return false;
    }
  }
  return true;
}

async function runHealthChecks(database) {
  const bxrdConfig = getBxrdConfig();
  const checks = {
    database: checkResult(false),
    bxrd_api: checkResult(false, { skipped: true }),
    bxrd_data: checkResult(false, { skipped: true }),
    bxrd_sync: checkResult(false, { skipped: true }),
    lookups: checkResult(false, { skipped: true })
  };

  try {
    checks.database = await checkDatabase(database);
  } catch (err) {
    checks.database = checkResult(false, { error: err.message });
  }

  const needsBxrd = bxrdConfig.primarySource || bxrdConfig.syncEnabled;
  if (needsBxrd && checks.database.ok) {
    checks.bxrd_api = await probeBxrdApi(bxrdConfig);
  }

  if (bxrdConfig.primarySource && checks.database.ok) {
    try {
      checks.bxrd_data = await checkBxrdData(database, minBxrdRankingsRequired());
      checks.lookups = await checkLookupPath(database);
    } catch (err) {
      const fail = checkResult(false, { error: err.message });
      if (!checks.bxrd_data.ok) checks.bxrd_data = fail;
      if (!checks.lookups.ok) checks.lookups = fail;
    }

    if (bxrdConfig.syncEnabled) {
      try {
        checks.bxrd_sync = await checkBxrdSync(database, bxrdConfig.deltaPollMs);
      } catch (err) {
        checks.bxrd_sync = checkResult(false, { error: err.message });
      }
    }
  }

  const ok = aggregateOk(checks, bxrdConfig);
  return {
    ok,
    service: 'nymrank-api',
    uptime_seconds: Math.floor(process.uptime()),
    bxrd_primary_source: bxrdConfig.primarySource,
    bxrd_sync_enabled: bxrdConfig.syncEnabled,
    checks
  };
}

module.exports = {
  runHealthChecks,
  probeBxrdApi,
  checkDatabase,
  checkBxrdData,
  checkBxrdSync,
  checkLookupPath,
  aggregateOk
};
