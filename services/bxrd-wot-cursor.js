'use strict';

/**
 * BXRD delta filter: max(wot_updated_at, profile_updated_at) >= floor(since_ms / 1000).
 * Cursor must use attestor_changed_at / next_since_ms — not updated_at or last_seen_at.
 */
function entryAttestorChangedMs(row) {
  const changedSec = Number(row.attestor_changed_at);
  if (changedSec > 0) return changedSec * 1000;

  const wotSec = Number(row.wot_updated_at);
  const profileSec = Number(row.profile_updated_at);
  const secs = [wotSec, profileSec].filter((s) => s > 0);
  return secs.length ? Math.max(...secs) * 1000 : 0;
}

function computeNextSinceMs(entries, deltaData, pollStartMs) {
  const serverNext = Number(deltaData?.next_since_ms);
  if (Number.isFinite(serverNext) && serverNext > 0) {
    return serverNext;
  }

  let next = pollStartMs;
  for (const row of entries || []) {
    const rowMs = entryAttestorChangedMs(row);
    if (rowMs > 0) next = Math.max(next, rowMs);
  }
  return next + 1;
}

module.exports = {
  entryAttestorChangedMs,
  computeNextSinceMs
};
