'use strict';

const { isBxrdPrimarySource, bxrdSourceFilterSql } = require('./bxrd-source');

/** Matches home-page search (no committee perspective): blend + filters. */
const MIN_RANK_VALUE = 35;

function sourceFilterSql() {
  if (!isBxrdPrimarySource()) return '';
  return bxrdSourceFilterSql('ur');
}

const AGGREGATED_NAME_SEARCH_BODY = `
  SELECT
    ur.ranked_user_pubkey,
    un.name,
    un.nip05,
    un.lud16,
    ROUND(AVG(ur.rank_value))::INTEGER AS rank_value,
    AVG(ur.influence_score) AS influence_score,
    ROUND(AVG(ur.hops))::INTEGER AS hops,
    ROUND(AVG(ur.follower_count))::INTEGER AS follower_count,
    COALESCE(prq.last_activity_timestamp, un.profile_timestamp) AS last_seen,
    (
      CASE
        WHEN LOWER(un.name) = LOWER($1) THEN 2
        WHEN LOWER(un.name) LIKE LOWER($1) || ' %' THEN 1
        ELSE 0
      END +
      CASE WHEN LOWER(un.nip05) = LOWER($1) THEN 1 ELSE 0 END +
      CASE WHEN LOWER(un.lud16) = LOWER($1) THEN 1 ELSE 0 END
    )::INTEGER AS name_affinity,
    (
      AVG(ur.influence_score) *
      CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) < 180 * 86400 THEN 1.0
        WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) < 365 * 86400 THEN 0.9
        WHEN EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(COALESCE(prq.last_activity_timestamp, un.profile_timestamp)))) < 730 * 86400 THEN 0.7
        ELSE 0.5
      END *
      LOG(GREATEST(AVG(ur.follower_count), 1) + 1)
    ) * (
      CASE
        WHEN LOWER(un.name) = LOWER($1) THEN 2
        WHEN LOWER(un.name) LIKE LOWER($1) || ' %' THEN 1
        ELSE 0
      END +
      CASE WHEN LOWER(un.nip05) = LOWER($1) THEN 1 ELSE 0 END +
      CASE WHEN LOWER(un.lud16) = LOWER($1) THEN 1 ELSE 0 END
    ) AS blended_score
  FROM user_rankings ur
  LEFT JOIN user_names un ON ur.ranked_user_pubkey = un.pubkey
  LEFT JOIN profile_refresh_queue prq ON ur.ranked_user_pubkey = prq.pubkey
  WHERE (
    (LOWER(un.name) = LOWER($1) AND un.name IS NOT NULL)
    OR (LOWER(un.name) LIKE LOWER($1) || ' %' AND un.name IS NOT NULL)
    OR (LOWER(un.nip05) = LOWER($1) AND LOWER(un.lud16) = LOWER($1) AND un.nip05 IS NOT NULL AND un.lud16 IS NOT NULL)
  )
  AND ur.rank_value >= ${MIN_RANK_VALUE}
  ${sourceFilterSql()}
  GROUP BY ur.ranked_user_pubkey, un.name, un.nip05, un.lud16, prq.last_activity_timestamp, un.profile_timestamp
  HAVING (
    CASE
      WHEN LOWER(un.name) = LOWER($1) THEN 2
      WHEN LOWER(un.name) LIKE LOWER($1) || ' %' THEN 1
      ELSE 0
    END +
    CASE WHEN LOWER(un.nip05) = LOWER($1) THEN 1 ELSE 0 END +
    CASE WHEN LOWER(un.lud16) = LOWER($1) THEN 1 ELSE 0 END
  ) >= 2
`;

/**
 * Rows for aggregated name search (same ordering as home search UI).
 * @param {object} database
 * @param {string} searchTrimmed
 * @param {number} limit
 * @param {number} offset
 */
async function fetchAggregatedNameSearch(database, searchTrimmed, limit, offset) {
  const query = `
    ${AGGREGATED_NAME_SEARCH_BODY}
    ORDER BY blended_score DESC NULLS LAST, ranked_user_pubkey ASC
    LIMIT $2 OFFSET $3
  `;
  const result = await database.query(query, [searchTrimmed, limit, offset]);
  return result.rows;
}

/**
 * Count of distinct pubkey groups matching the same filter as {@link fetchAggregatedNameSearch}.
 */
async function countAggregatedNameSearch(database, searchTrimmed) {
  const query = `
    SELECT COUNT(*)::bigint AS c
    FROM (
      ${AGGREGATED_NAME_SEARCH_BODY}
    ) ranked
  `;
  const result = await database.query(query, [searchTrimmed]);
  return parseInt(result.rows[0].c, 10);
}

module.exports = {
  MIN_RANK_VALUE,
  fetchAggregatedNameSearch,
  countAggregatedNameSearch
};
