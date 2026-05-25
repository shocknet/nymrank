'use strict';

const { getBxrdConfig } = require('./config');
const { BXRD_RANKING_SOURCE } = require('./bxrd-constants');

function isBxrdPrimarySource() {
  return getBxrdConfig().primarySource;
}

function getBxrdRankingSource() {
  return BXRD_RANKING_SOURCE;
}

/** SQL: AND {alias}.ranking_source = 'bxrd' */
function bxrdSourceFilterSql(alias = 'ur') {
  return ` AND ${alias}.ranking_source = '${BXRD_RANKING_SOURCE}'`;
}

/** Profile page on bxrd.app (hex or npub). */
function bxrdUserProfileUrl(pubkey) {
  const id = String(pubkey || '').trim();
  if (!id) return 'https://bxrd.app';
  return `https://bxrd.app/user/${encodeURIComponent(id)}`;
}

module.exports = {
  isBxrdPrimarySource,
  getBxrdRankingSource,
  bxrdSourceFilterSql,
  bxrdUserProfileUrl
};
