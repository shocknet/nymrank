'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { aggregateOk } = require('../../services/health-check');

describe('aggregateOk', () => {
  const bxrdOff = { primarySource: false, syncEnabled: false };
  const bxrdOn = { primarySource: true, syncEnabled: true };

  it('requires database', () => {
    const checks = {
      database: { ok: false },
      bxrd_api: { ok: true },
      bxrd_data: { ok: true },
      bxrd_sync: { ok: true },
      lookups: { ok: true }
    };
    assert.equal(aggregateOk(checks, bxrdOn), false);
  });

  it('passes with only database when bxrd disabled', () => {
    const checks = {
      database: { ok: true },
      bxrd_api: { ok: false },
      bxrd_data: { ok: false },
      bxrd_sync: { ok: false },
      lookups: { ok: false }
    };
    assert.equal(aggregateOk(checks, bxrdOff), true);
  });

  it('requires bxrd data and lookups when primary', () => {
    const checks = {
      database: { ok: true },
      bxrd_api: { ok: true },
      bxrd_data: { ok: false },
      bxrd_sync: { ok: true },
      lookups: { ok: true }
    };
    assert.equal(aggregateOk(checks, bxrdOn), false);
  });
});
