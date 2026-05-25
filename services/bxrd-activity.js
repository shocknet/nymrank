'use strict';

/**
 * Activity/profile snapshot from DB (no relay queries).
 */
async function fetchActivityFromDb(database, hexPubkey) {
  const profileResult = await database.query(
    `
    SELECT
      un.name,
      un.nip05,
      un.lud16,
      prq.last_activity_timestamp,
      prq.profile_timestamp,
      prq.last_activity_check,
      prq.last_profile_fetch
    FROM user_names un
    LEFT JOIN profile_refresh_queue prq ON un.pubkey = prq.pubkey
    WHERE un.pubkey = $1
    `,
    [hexPubkey]
  );

  const profile = profileResult.rows[0] || null;
  const lastTs = profile?.last_activity_timestamp || profile?.profile_timestamp;

  return {
    pubkey: hexPubkey,
    latest_event: lastTs
      ? {
          kind: null,
          created_at: Number(lastTs),
          created_at_iso: new Date(Number(lastTs) * 1000).toISOString(),
          days_ago: Math.floor((Date.now() / 1000 - Number(lastTs)) / 86400),
          source: 'bxrd_last_seen_at'
        }
      : null,
    total_events_found: null,
    profile: profile
      ? {
          name: profile.name,
          nip05: profile.nip05,
          lud16: profile.lud16,
          last_activity_timestamp: profile.last_activity_timestamp,
          profile_timestamp: profile.profile_timestamp,
          last_activity_check: profile.last_activity_check,
          last_profile_fetch: profile.last_profile_fetch
        }
      : null
  };
}

module.exports = { fetchActivityFromDb };
