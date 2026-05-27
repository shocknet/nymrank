'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeNextSinceMs,
  trackMaxAttestorChangedSec,
  sinceMsFromMaxSec
} = require('../../services/bxrd-wot-cursor');

describe('bxrd-wot-cursor', () => {
  it('empty delta keeps since unchanged', () => {
    const sinceMs = 1779853984001;
    assert.equal(computeNextSinceMs([], sinceMs), sinceMs);
    assert.equal(computeNextSinceMs(null, sinceMs), sinceMs);
  });

  it('non-empty delta uses max attestor_changed_at * 1000 + 1', () => {
    const sinceMs = 1779853984001;
    const entries = [
      { attestor_changed_at: 1779853984 },
      { attestor_changed_at: 1779854018 }
    ];
    assert.equal(computeNextSinceMs(entries, sinceMs), 1779854018001);
  });

  it('does not move cursor backward', () => {
    const sinceMs = 1779855000001;
    const entries = [{ attestor_changed_at: 1779853984 }];
    assert.equal(computeNextSinceMs(entries, sinceMs), sinceMs);
  });

  it('trackMaxAttestorChangedSec accumulates across batches', () => {
    let max = 0;
    max = trackMaxAttestorChangedSec([{ attestor_changed_at: 100 }], max);
    max = trackMaxAttestorChangedSec([{ attestor_changed_at: 200 }], max);
    assert.equal(sinceMsFromMaxSec(max), 200001);
  });

  it('sinceMsFromMaxSec returns 0 when no rows', () => {
    assert.equal(sinceMsFromMaxSec(0), 0);
  });
});
