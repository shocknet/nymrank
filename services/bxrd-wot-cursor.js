'use strict';

/**
 * BXRD delta: attestor_changed_at > floor(since_ms / 1000) (strict).
 * NymRank owns the cursor — BXRD does not return next_since_ms.
 */

function maxAttestorChangedSec(rows) {
  let maxSec = 0;
  for (const row of rows || []) {
    const sec = Number(row.attestor_changed_at);
    if (sec > maxSec) maxSec = sec;
  }
  return maxSec;
}

function trackMaxAttestorChangedSec(rows, currentMaxSec = 0) {
  return Math.max(currentMaxSec, maxAttestorChangedSec(rows));
}

/** After a delta poll: advance only when entries were applied. */
function computeNextSinceMs(entries, sinceMs) {
  if (!entries?.length) {
    return sinceMs;
  }
  const maxSec = maxAttestorChangedSec(entries);
  if (maxSec <= 0) {
    return sinceMs;
  }
  const next = maxSec * 1000 + 1;
  return Math.max(next, sinceMs);
}

function sinceMsFromMaxSec(maxSec) {
  return maxSec > 0 ? maxSec * 1000 + 1 : 0;
}

module.exports = {
  computeNextSinceMs,
  trackMaxAttestorChangedSec,
  sinceMsFromMaxSec,
  maxAttestorChangedSec
};
