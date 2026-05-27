'use strict';

const { decode } = require('nostr-tools/nip19');
const { getRelayConfig, getBxrdConfig } = require('../services/config');
const { runAdhocActivityCheck } = require('../services/activity-check');
const { fetchActivityFromDb } = require('../services/bxrd-activity');
const { fetchAggregatedNameSearch } = require('../services/aggregated-name-search');
const { isBxrdPrimarySource, bxrdSourceFilterSql } = require('../services/bxrd-source');
const { runHealthChecks } = require('../services/health-check');

function sendApiError(reply, statusCode, code, message) {
  return reply.code(statusCode).send({
    error: {
      code,
      message
    }
  });
}

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

async function resolveName(database, name) {
  const rows = await fetchAggregatedNameSearch(database, name, 1, 0);
  const row = rows[0];
  if (!row) return null;
  return {
    pubkey: row.ranked_user_pubkey,
    average_rank: row.rank_value,
    name_affinity: row.name_affinity,
    name: row.name,
    nip05: row.nip05,
    lud16: row.lud16
  };
}

function normalizePubkey(input) {
  const value = (input || '').trim();
  if (!value) return null;

  if (value.toLowerCase().startsWith('npub')) {
    const decoded = decode(value);
    if (decoded.type !== 'npub') return null;
    return typeof decoded.data === 'string' ? decoded.data.toLowerCase() : null;
  }

  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return value.toLowerCase();
  }

  return null;
}

module.exports = async function (fastify) {
  const database = fastify.database;
  const socialRelayUrls = getRelayConfig().socialRelayUrls;

  fastify.get('/api/status', async (request, reply) => {
    try {
      const report = await runHealthChecks(database);
      if (!report.ok) {
        return reply.code(503).send(report);
      }
      return report;
    } catch (error) {
      request.log.error({ err: error }, 'API status check failed');
      return sendApiError(reply, 503, 'health_check_failed', 'Health check failed');
    }
  });

  fastify.get('/api/names/:name', async (request, reply) => {
    const normalizedName = normalizeName(request.params.name);
    if (!normalizedName) {
      return sendApiError(reply, 400, 'invalid_name', 'Name is required');
    }

    try {
      const occupant = await resolveName(database, normalizedName);
      if (!occupant) {
        return {
          name: normalizedName,
          available: true,
          occupant: null
        };
      }

      return {
        name: normalizedName,
        available: false,
        occupant: {
          pubkey: occupant.pubkey,
          average_rank: occupant.average_rank,
          name_affinity: occupant.name_affinity,
          profile: {
            name: occupant.name,
            nip05: occupant.nip05,
            lud16: occupant.lud16
          }
        }
      };
    } catch (error) {
      request.log.error({ err: error }, 'Name lookup failed');
      return sendApiError(reply, 500, 'internal_error', 'Failed to resolve name');
    }
  });

  fastify.get('/api/users/:pubkey/rank', async (request, reply) => {
    let normalizedPubkey;
    try {
      normalizedPubkey = normalizePubkey(request.params.pubkey);
    } catch (_) {
      normalizedPubkey = null;
    }

    if (!normalizedPubkey) {
      return sendApiError(reply, 400, 'invalid_pubkey', 'Pubkey must be a 64-char hex key or npub');
    }

    try {
      const bxrdOnly = isBxrdPrimarySource();
      const sourceFilter = bxrdOnly ? bxrdSourceFilterSql('ur') : '';
      const aggregateParams = [normalizedPubkey];

      const aggregateQuery = `
        SELECT
          ur.ranked_user_pubkey AS pubkey,
          ROUND(AVG(ur.rank_value))::INTEGER AS average_rank,
          AVG(ur.influence_score) AS average_influence_score,
          ROUND(AVG(ur.hops))::INTEGER AS average_hops,
          ROUND(AVG(ur.follower_count))::INTEGER AS average_follower_count,
          COUNT(*)::INTEGER AS perspective_count,
          un.name,
          un.nip05,
          un.lud16,
          un.name_affinity
        FROM user_rankings ur
        LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
        WHERE ur.ranked_user_pubkey = $1${sourceFilter}
        GROUP BY ur.ranked_user_pubkey, un.name, un.nip05, un.lud16, un.name_affinity
        LIMIT 1
      `;
      const aggregateResult = await database.query(aggregateQuery, aggregateParams);
      const aggregate = aggregateResult.rows[0];

      if (!aggregate) {
        return sendApiError(reply, 404, 'not_found', 'User ranking not found');
      }

      const committeeQuery = `
        SELECT ur.committee_member_pubkey, ur.rank_value, ur.influence_score, ur.hops, ur.follower_count
        FROM user_rankings ur
        WHERE ur.ranked_user_pubkey = $1${sourceFilter}
        ORDER BY ur.rank_value DESC, ur.committee_member_pubkey ASC
      `;
      const committeeResult = await database.query(committeeQuery, aggregateParams);

      return {
        pubkey: normalizedPubkey,
        average_rank: aggregate.average_rank,
        average_influence_score: aggregate.average_influence_score,
        average_hops: aggregate.average_hops,
        average_follower_count: aggregate.average_follower_count,
        perspective_count: aggregate.perspective_count,
        profile: {
          name: aggregate.name,
          nip05: aggregate.nip05,
          lud16: aggregate.lud16,
          name_affinity: aggregate.name_affinity
        },
        committee_breakdown: committeeResult.rows
      };
    } catch (error) {
      request.log.error({ err: error }, 'User rank lookup failed');
      return sendApiError(reply, 500, 'internal_error', 'Failed to fetch user rank');
    }
  });

  fastify.get('/api/users/:pubkey/activity', async (request, reply) => {
    let normalizedPubkey;
    try {
      normalizedPubkey = normalizePubkey(request.params.pubkey);
    } catch (_) {
      normalizedPubkey = null;
    }

    if (!normalizedPubkey) {
      return sendApiError(reply, 400, 'invalid_pubkey', 'Pubkey must be a 64-char hex key or npub');
    }

    try {
      if (getBxrdConfig().disableRelays) {
        return await fetchActivityFromDb(database, normalizedPubkey);
      }
      return await runAdhocActivityCheck({
        database,
        relayUrls: socialRelayUrls,
        hexPubkey: normalizedPubkey,
        log: request.log
      });
    } catch (error) {
      request.log.error({ err: error }, 'Activity check failed');
      return sendApiError(reply, 500, 'internal_error', 'Activity check failed');
    }
  });
};
