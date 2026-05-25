const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const DEFAULT_RANKING_RELAYS = ['wss://nip85.brainstorm.world'];
const DEFAULT_SOCIAL_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nostrue.com',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.land'
];

const DEFAULT_BXRD_API_BASE_URL = 'https://bxrd.app/api';

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return value === '1' || value.toLowerCase() === 'true';
}

function parseRelayList(value, fallback) {
  if (!value || typeof value !== 'string') {
    return [...fallback];
  }

  const parsed = value
    .split(',')
    .map((relay) => relay.trim())
    .filter((relay) => relay.length > 0);

  return parsed.length > 0 ? parsed : [...fallback];
}

function getRelayConfig() {
  const socialRelayUrls = parseRelayList(
    process.env.SOCIAL_RELAY_URLS,
    DEFAULT_SOCIAL_RELAYS
  );

  return {
    rankingRelayUrls: parseRelayList(process.env.RANKING_RELAY_URLS, DEFAULT_RANKING_RELAYS),
    socialRelayUrls,
    profileRelayUrls: socialRelayUrls
  };
}

function getBxrdConfig() {
  const syncEnabled = parseBool(process.env.BXRD_SYNC_ENABLED, true);
  const primarySource = parseBool(process.env.BXRD_PRIMARY_SOURCE, true);
  const disableRelays = parseBool(
    process.env.BXRD_DISABLE_RELAYS,
    syncEnabled
  );

  return {
    apiBaseUrl: (process.env.BXRD_API_BASE_URL || DEFAULT_BXRD_API_BASE_URL).replace(/\/$/, ''),
    bearerToken: process.env.BXRD_ATTESTOR_BEARER_TOKEN || '',
    syncEnabled,
    syncOnStart: parseBool(process.env.BXRD_SYNC_ON_START, syncEnabled),
    deltaPollMs: parseInt(process.env.BXRD_DELTA_POLL_MS, 10) || 30000,
    disableRelays,
    primarySource,
    syncMode: process.env.BXRD_SYNC_MODE || 'upsert'
  };
}

module.exports = {
  getRelayConfig,
  getBxrdConfig,
  DEFAULT_BXRD_API_BASE_URL
};
