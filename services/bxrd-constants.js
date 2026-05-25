'use strict';

/** API source identifier — not a Nostr pubkey. */
const BXRD_RANKING_SOURCE = 'bxrd';

/**
 * Placeholder values for legacy PK columns (ranked_user, service, committee).
 * Satisfy NOT NULL + composite PK; only ranked_user_pubkey is a real key.
 */
const BXRD_ROW_SERVICE_KEY = 'bxrd';
const BXRD_ROW_COMMITTEE_KEY = 'bxrd';

function normalizeEtag(etag) {
  if (!etag) return null;
  const trimmed = String(etag).trim();
  return trimmed.replace(/^"|"$/g, '');
}

module.exports = {
  BXRD_RANKING_SOURCE,
  BXRD_ROW_SERVICE_KEY,
  BXRD_ROW_COMMITTEE_KEY,
  normalizeEtag
};
