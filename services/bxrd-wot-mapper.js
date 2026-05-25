'use strict';

const {
  BXRD_RANKING_SOURCE,
  BXRD_ROW_SERVICE_KEY,
  BXRD_ROW_COMMITTEE_KEY
} = require('./bxrd-constants');

function sanitizeString(str) {
  if (!str || typeof str !== 'string') return null;
  const cleaned = str
    .replace(/\x00/g, '')
    .replace(/[\x01-\x08\x0B-\x1F\x7F]/g, '')
    .substring(0, 255);
  return cleaned || null;
}

function emptyToNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function parseRankingEventTimestamp(row) {
  const changedSec = Number(row.attestor_changed_at);
  if (changedSec > 0) return new Date(changedSec * 1000);

  const wotSec = Number(row.wot_updated_at);
  if (wotSec > 0) return new Date(wotSec * 1000);

  const profileSec = Number(row.profile_updated_at);
  if (profileSec > 0) return new Date(profileSec * 1000);

  return new Date();
}

function mapAttestorRowToRanking(row) {
  const pubkey = String(row.pubkey || '').toLowerCase();
  return {
    ranked_user_pubkey: pubkey,
    ranking_source: BXRD_RANKING_SOURCE,
    service_pubkey: BXRD_ROW_SERVICE_KEY,
    committee_member_pubkey: BXRD_ROW_COMMITTEE_KEY,
    rank_value: Math.round(Number(row.wot_score) || 0),
    hops: 0,
    influence_score: row.wot_influence != null ? Number(row.wot_influence) : null,
    average_score: row.wot_average != null ? Number(row.wot_average) : null,
    confidence_score: row.wot_confidence != null ? Number(row.wot_confidence) : null,
    input_value: row.wot_input != null ? Number(row.wot_input) : null,
    pagerank_score: null,
    follower_count: parseInt(row.inbound_follow_count, 10) || 0,
    muter_count: 0,
    reporter_count: 0,
    event_timestamp: parseRankingEventTimestamp(row)
  };
}

function mapAttestorRowToProfile(row) {
  const pubkey = String(row.pubkey || '').toLowerCase();
  const profileTs = Number(row.profile_updated_at);
  const lastSeen = Number(row.last_seen_at);
  const profileTimestamp =
    profileTs > 0 ? profileTs : lastSeen > 0 ? lastSeen : null;

  return {
    pubkey,
    name: sanitizeString(row.name),
    nip05: sanitizeString(emptyToNull(row.nip05_local)),
    lud16: sanitizeString(emptyToNull(row.lud16_local)),
    profile_timestamp: profileTimestamp,
    last_seen_at: lastSeen > 0 ? lastSeen : null
  };
}

function mapAttestorRows(entries) {
  const rankings = [];
  const profiles = [];
  for (const row of entries) {
    if (!row?.pubkey) continue;
    rankings.push(mapAttestorRowToRanking(row));
    profiles.push(mapAttestorRowToProfile(row));
  }
  return { rankings, profiles };
}

module.exports = {
  mapAttestorRowToRanking,
  mapAttestorRowToProfile,
  mapAttestorRows,
  sanitizeString
};
