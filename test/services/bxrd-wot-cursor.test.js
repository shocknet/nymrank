'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeNextSinceMs,
  entryAttestorChangedMs
} = require('../../services/bxrd-wot-cursor');

describe('bxrd-wot-cursor', () => {
  it('entryAttestorChangedMs prefers attestor_changed_at', () => {
    const row = {
      attestor_changed_at: 1779728142,
      wot_updated_at: 1,
      profile_updated_at: 9999999999,
      updated_at: '2026-05-25T17:55:04.851Z',
      last_seen_at: 1709228985
    };
    assert.equal(entryAttestorChangedMs(row), 1779728142000);
  });

  it('entryAttestorChangedMs falls back to max wot and profile', () => {
    const row = { wot_updated_at: 100, profile_updated_at: 200 };
    assert.equal(entryAttestorChangedMs(row), 200000);
  });

  it('computeNextSinceMs uses server next_since_ms when present', () => {
    const next = computeNextSinceMs([], { next_since_ms: 1779731766001 }, 1000);
    assert.equal(next, 1779731766001);
  });

  it('computeNextSinceMs uses max attestor_changed_at + 1 when no server cursor', () => {
    const entries = [{ attestor_changed_at: 1779728142 }];
    const next = computeNextSinceMs(entries, {}, 1000);
    assert.equal(next, 1779728142001);
  });

  it('ignores updated_at and last_seen_at for cursor', () => {
    const row = {
      updated_at: '2026-05-25T10:00:01.000Z',
      last_seen_at: 1999999999,
      profile_updated_at: 0,
      wot_updated_at: 0
    };
    assert.equal(entryAttestorChangedMs(row), 0);
  });
});
