'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  mapAttestorRowToRanking,
  mapAttestorRowToProfile
} = require('../../services/bxrd-wot-mapper');

test('mapAttestorRowToRanking rounds wot_score and maps influence', () => {
  const row = {
    pubkey: 'ABC'.repeat(21).toLowerCase().slice(0, 64),
    wot_score: 42.3,
    wot_influence: 0.423,
    wot_average: 0.91,
    wot_confidence: 0.465,
    wot_input: 12.5,
    inbound_follow_count: 100,
    wot_updated_at: 1779728142,
    attestor_changed_at: 1779728142
  };
  row.pubkey = 'a'.repeat(64);

  const r = mapAttestorRowToRanking(row);
  assert.equal(r.event_timestamp.getTime(), 1779728142000);
  assert.equal(r.ranking_source, 'bxrd');
  assert.equal(r.service_pubkey, 'bxrd');
  assert.equal(r.rank_value, 42);
  assert.equal(r.influence_score, 0.423);
  assert.equal(r.follower_count, 100);
  assert.equal(r.hops, 0);
});

test('mapAttestorRowToProfile treats profile_updated_at 0 as null timestamp', () => {
  const row = {
    pubkey: 'b'.repeat(64),
    name: 'alice',
    nip05_local: 'alice',
    lud16_local: '',
    profile_updated_at: 0,
    last_seen_at: 1779639699
  };

  const p = mapAttestorRowToProfile(row);
  assert.equal(p.name, 'alice');
  assert.equal(p.nip05, 'alice');
  assert.equal(p.lud16, null);
  assert.equal(p.profile_timestamp, 1779639699);
  assert.equal(p.last_seen_at, 1779639699);
});
