'use strict';

const HOURS_DEFAULT = 48;

function parseHours(query) {
  const h = parseInt(query?.hours, 10);
  return Number.isFinite(h) && h > 0 && h <= 168 ? h : HOURS_DEFAULT;
}

async function fetchBxrdStats(database, hours) {
  const interval = `${hours} hours`; // passed to Postgres ::interval

  const [state, counts, syncRuns, historySummary, recentInserts, recentUpdates, hourly] =
    await Promise.all([
      database.getBxrdSyncState(),
      database.query(`
        SELECT
          COUNT(*) FILTER (WHERE ranking_source = 'bxrd')::int AS bxrd_rankings,
          COUNT(*) FILTER (WHERE ranking_source = 'nostr')::int AS nostr_rankings,
          COUNT(*) FILTER (
            WHERE ranking_source = 'bxrd' AND last_updated > NOW() - $1::interval
          )::int AS bxrd_touched_recent
        FROM user_rankings
      `, [interval]),
      database.query(`
        SELECT id, run_type, entries_count, since_ms, next_since_ms, snapshot_etag,
               duration_ms, created_at
        FROM bxrd_sync_runs
        WHERE created_at > NOW() - $1::interval
        ORDER BY created_at DESC
        LIMIT 200
      `, [interval]),
      database.query(`
        SELECT
          change_kind,
          COUNT(*)::int AS n
        FROM bxrd_rank_history
        WHERE recorded_at > NOW() - $1::interval
        GROUP BY change_kind
      `, [interval]),
      database.query(`
        SELECT h.recorded_at, h.ranked_user_pubkey, h.rank_value, h.follower_count,
               h.influence_score, un.name, un.nip05
        FROM bxrd_rank_history h
        LEFT JOIN user_names un ON un.pubkey = h.ranked_user_pubkey
        WHERE h.change_kind = 'insert' AND h.recorded_at > NOW() - $1::interval
        ORDER BY h.recorded_at DESC
        LIMIT 100
      `, [interval]),
      database.query(`
        SELECT h.recorded_at, h.ranked_user_pubkey, h.rank_value, h.follower_count,
               h.prev_rank_value, h.prev_follower_count, h.influence_score,
               un.name, un.nip05,
               (h.rank_value - COALESCE(h.prev_rank_value, h.rank_value)) AS rank_delta,
               (h.follower_count - COALESCE(h.prev_follower_count, h.follower_count)) AS follower_delta
        FROM bxrd_rank_history h
        LEFT JOIN user_names un ON un.pubkey = h.ranked_user_pubkey
        WHERE h.change_kind = 'update' AND h.recorded_at > NOW() - $1::interval
        ORDER BY h.recorded_at DESC
        LIMIT 150
      `, [interval]),
      database.query(`
        SELECT date_trunc('hour', created_at) AS hour,
               run_type,
               COUNT(*)::int AS runs,
               SUM(entries_count)::int AS entries
        FROM bxrd_sync_runs
        WHERE created_at > NOW() - $1::interval
        GROUP BY 1, 2
        ORDER BY 1 DESC, 2
      `, [interval])
    ]);

  const historyRows = historySummary.rows;
  const inserts = historyRows.find((r) => r.change_kind === 'insert')?.n ?? 0;
  const updates = historyRows.find((r) => r.change_kind === 'update')?.n ?? 0;
  const snapshots = syncRuns.rows.filter((r) => r.run_type === 'snapshot');
  const deltas = syncRuns.rows.filter((r) => r.run_type === 'delta');

  return {
    hours,
    generatedAt: new Date().toISOString(),
    syncState: state,
    counts: counts.rows[0],
    historyLogged: { inserts, updates, hasTable: inserts + updates > 0 || syncRuns.rows.length > 0 },
    syncRuns: syncRuns.rows,
    snapshotRuns: snapshots.length,
    deltaRuns: deltas.length,
    recentInserts: recentInserts.rows,
    recentUpdates: recentUpdates.rows,
    hourly: hourly.rows
  };
}

module.exports = { fetchBxrdStats, parseHours };
