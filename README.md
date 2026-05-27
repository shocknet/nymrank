# NymRank

A Nostr-based reputation and name protection system using committee-based ranking.

## Overview

NymRank leverages Web-of-Trust (WoT) reputation scores for users of a given namespace. Instead of relying on a single authority for name issuance, it aggregates rankings from a specific set of committee members to create a multi-perspective view of name occupancy. It includes a search tool to check if a specific name or handle is occupied by a well-reputed user.

### Registration outcomes (for integrators)

The API returns facts (`average_rank`, `name_affinity`, occupancy), not UX enums. A typical mapping for client apps:

| Situation | Suggested stance |
|-----------|------------------|
| Name in `reserved_names` (DB) | **Not enforced by this API** — the table exists in `schema.sql`, but `GET /api/names` does not read it; handle reserved names in your client if needed. |
| Occupied, **average rank ≥ 95** | Strong discouragement (elite-tier signal). |
| Occupied, rank **75–94** | Discourage (established user). |
| Occupied, rank **35–74** | Caution (weaker claim; your product decides resolution). |
| Below rank **35** or not in ranked set | Weak signal; often treated like “available” for promotion flows. |
| Not occupied with affinity ≥ 2 | Available for registration; optional boost flows are product-specific. |

### Name affinity (summary)

Affinity is **0–4**: non-empty `name` **2**, NIP-05 local part **1**, LUD-16 local part **1** (see `services/database.js`). Search uses a **per-query** score (exact name +2, name prefix +1, nip05 +1, lud16 +1) with **≥ 2** required; the **default** search (`services/aggregated-name-search.js`) only considers rows where the handle matches `name` / `name` prefix **or** **both** nip05 and lud16. **Perspective + search** (`routes/web.js`) uses a broader `WHERE` but the same score formula. Details: [event_analysis.md](./event_analysis.md).

### Roadmap (not implemented in this server)

Sybil-fee processing, automated payment receipts, and referrer/committee onboarding are **out of scope** for the current service. The **[`nymrank-boost/`](./nymrank-boost/)** package describes how client apps might combine API lookups with referrals and future paid boosts.

## Committee Members

The system tracks delegation events from these initial committee members:

- **justin**: `3316e3696de74d39959127b9d842df57bddc5d1c7af8a04f1bc7aed80b445088`
- **straycat**: `e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f`
- **vinny**: `2efaa715bbb46dd5be6b7da8d7700266d11674b913b8178addb5c2e63d987331`

These keys are used to:
- Recognize delegation events (kind 10040) from committee members when ingested
- Map service keys to committee members for ranking events (kind 30382)
- Store per-member rows in `user_rankings` and average at query time (and via `precomputed_rankings`)

**Ingestion (BXRD, default):** Rankings and profiles come from the [BXRD WoT attestor API](https://bxrd.app/api). **Daytime:** `GET /wot?since=<last_since_ms>` every ~30s; cursor advances only when entries are applied (`max(attestor_changed_at) * 1000 + 1`, unchanged on empty poll). **Nightly:** `GET /wot/export.ndjson.gz` (new ETag) full-reconciles rows but does **not** reset `last_since_ms` — intraday accuracy stays on the delta cursor. **First run:** gzip seed sets etag + initial `last_since_ms` from the export. Rows are tagged `ranking_source = 'bxrd'`. Set `BXRD_ATTESTOR_BEARER_TOKEN` and run `npm run import:bxrd:seed` once, then the app poller keeps data fresh.

**Legacy ingestion (optional):** Kind **10040** and **30382** via **`backfill-attestations.js`** / JSONL importers (`ranking_source = 'nostr'`). Disable relay fetches with `BXRD_DISABLE_RELAYS=true`.

## Setup

### Prerequisites

1. PostgreSQL 17 with a database named `nymrank`
2. strfry compiled and available at `~/strfry/strfry`
   - Clone: `git clone https://github.com/hoytech/strfry.git ~/strfry`
   - Build: `cd ~/strfry && make`

### Initial Backfill

Before running the app, you must backfill attestations and delegations from the relay using negentropy:

```bash
node backfill-attestations.js
```

This will:
1. Use strfry sync with negentropy to download delegations (kind 10040) and attestations (kind 30382) from the configured relay for committee members
2. Stream exported lines into the event processor (attestations limited to roughly the **past week** by timestamp in `backfill-attestations.js`)
3. Persist into PostgreSQL (strfry db files remain under the strfry directory next to the repo — see script paths)

This is a one-time operation that may take several minutes.

### Database Setup

If this is your first run:

```bash
psql -d nymrank -f schema.sql
```

### Start the App

After backfill:

```bash
npm start
```

Or for development with auto-reload:

```bash
npm run dev
```

The app will:
1. Fetch profiles (kind 0) for all ranked users (1-day cooldown between fetches)
2. Check for activity to update last-seen (background window **10 days**; see **Background activity checks** below)
3. Start the web UI on http://localhost:3333

## Features

- **Multi-perspective Ranking**: Averages reputation scores from all committee members
- **Name Availability**: Search tool to check if a name/handle is occupied
- **Activity Tracking**: Displays when users were last active ("Recently" for <7 days, "Xd ago" for 7-29 days, "Xmo ago" for 30+ days)
- **Name Affinity Scoring**: Scores based on name, NIP-05, and LUD-16 fields (partial name matches score lower)
- **FAQ Page**: Explains how to optimize profiles for name occupation

## Architecture

- **Backfill**: Negentropy sync via strfry for kind 10040 / 30382 into PostgreSQL (one-time or manual)
- **Profile fetching**: Batched kind-0 queries on **social** relays with **1-day** cooldown (`profile_refresh_queue.last_profile_fetch`)
- **Activity checking**: Batched queries (any kind) on **social** relays with a **10-day** window and tiered batch sizes (see **Background activity checks**)
- **Rankings**: Stored per committee member; averages computed in SQL / materialized view — **not** continuously synced from ranking relays after backfill unless you re-run import tools
- **Materialized View**: `precomputed_rankings` for fast default list queries, refreshed on ranking changes (see `services/database.js`)
- **UI**: Fastify web server with search, browse, pagination, and perspective switching

## Database Schema

### Key Tables

- `user_rankings`: Individual rankings from each committee member
- `user_names`: Profile metadata (name, nip05, lud16) from kind 0 events
- `profile_refresh_queue`: Tracks profile and activity fetch timestamps
  - `profile_timestamp`: Timestamp of the kind 0 event
  - `last_activity_timestamp`: Most recent activity event
  - `last_profile_fetch`: When we last fetched kind-0 profile
  - `last_activity_check`: When we last checked for activity events

### Materialized View

`precomputed_rankings` aggregates rankings for the default list view, refreshed automatically on ranking changes.

## API Endpoints

- `GET /` - Main search/browse UI
- `GET /faq` - FAQ page (served from `/public/faq.html`)
- `GET /api-docs` - Interactive API page (form inputs + live JSON responses)
- `GET /api/status` - Health/readiness: DB, BXRD API (when sync/primary), BXRD row counts, sync freshness, sample rank lookup (`503` if any required check fails)
- `GET /api/names/:name` - Resolve name occupancy (`pubkey`, `average_rank`, `name_affinity`)
- `GET /api/users/:pubkey/rank` - Averaged user rank and committee breakdown
- `GET /api/users/:pubkey/activity` - Ad-hoc activity + profile refresh (hex or npub; same family as `/api/users/:pubkey/rank`)
- `GET /log` - Recent in-memory log tail (used for light debugging; not a structured log API)

### Rankings list (`/`)

- Default browse (`precomputed_rankings`) and **perspective** browse queries do **not** apply a `rank ≥ 35` SQL filter on the listed rows — anyone in `user_rankings` can appear. **Search** and **occupied-nym counts** use **`rank ≥ 35`** (and search uses the match score rules in [event_analysis.md](./event_analysis.md)).
- Default and perspective views **hide** accounts whose last-seen (activity or kind-0 profile time) is older than **365 days** (`LISTING_HIDE_LAST_SEEN_OLDER_THAN_DAYS` in `routes/web.js`), so the table is not dominated by long-dormant rows. Rows with **unknown** last-seen (no timestamps) still appear.
- **Total occupied nyms** counts distinct pubkeys with **`rank ≥ 35`** and **stored** `user_names.name_affinity ≥ 2**, independent of the 365-day list filter. **Page count** follows how many rows match the list (with the stale filter when enabled).
- Append **`?include_stale=1`** or **`?all=1`** to show everyone. **Search** is not filtered.

### Background activity checks

Uses one definition of **recent**: **10 days** (same window for “activity in DB counts as fresh” and “time before we run another check”).

- **Who gets checked** (`rank_value ≥ 35`): no `last_activity_timestamp`, or it is **older than 10 days**, **and** we never checked activity or `last_activity_check` is **older than 10 days**. Anyone with activity in the DB **within 10 days** is skipped (no relay query that cycle).
- **Tier 1** — first pass, batches of **10** authors per relay filter.
- **Tier 2** — **after** tier 1 in the **same** run, only for pubkeys that **still** have no activity in the last **10 days** in the DB; batches of **3**. If tier-1 eligibility is empty, **neither** tier runs (tier 2 is not a separate scheduler).

Periodic scheduling: a **6 hour** `setInterval` triggers checks. While a run is in progress, overlapping ticks are **skipped** (`profileCheckRunning`). If a run **did work** (kind-0 fetch and/or activity tiers), a **one-shot** follow-up runs **~60s** later so long backlogs can make progress without polling every minute when idle.

## Environment Variables

- `PORT`: Server port (default: **3333**, see `app.js`)
- `DB_HOST`: PostgreSQL host (default: localhost)
- `DB_PORT`: PostgreSQL port (default: 5432)
- `DB_NAME`: Database name (default: nymrank)
- `DB_USER`: Database user (default: nymrank_user)
- `DB_PASSWORD`: Database password (default: nymrank_password)
- `BXRD_API_BASE_URL`: Attestor base (default: `https://bxrd.app/api`)
- `BXRD_ATTESTOR_BEARER_TOKEN`: Shared Bearer token (required for sync)
- `BXRD_SYNC_ENABLED`, `BXRD_SYNC_ON_START`, `BXRD_DELTA_POLL_MS` (default 30000)
- `BXRD_DISABLE_RELAYS`, `BXRD_PRIMARY_SOURCE`: Skip relay scraping; UI/API read `ranking_source = 'bxrd'` only
- `RANKING_RELAY_URLS`, `SOCIAL_RELAY_URLS`: Legacy relay ingest when relays enabled

Copy `.env.example` to `.env` and set secrets locally:

```bash
cp .env.example .env
```

## Relay Configuration

Values come from **`RANKING_RELAY_URLS`** and **`SOCIAL_RELAY_URLS`** (comma-separated). When unset, defaults are defined in **`services/config.js`** (`DEFAULT_RANKING_RELAYS`, `DEFAULT_SOCIAL_RELAYS` — the social list includes several public relays, not only three). See **`.env.example`** for a sample override.

## API Response Examples

### `GET /api/names/alice`

```json
{
  "name": "alice",
  "available": false,
  "occupant": {
    "pubkey": "abc123...",
    "average_rank": 86,
    "name_affinity": 3,
    "profile": {
      "name": "alice",
      "nip05": "alice",
      "lud16": "alice"
    }
  }
}
```

### `GET /api/users/<pubkey>/rank`

```json
{
  "pubkey": "abc123...",
  "average_rank": 82,
  "average_influence_score": 0.74,
  "average_hops": 2,
  "average_follower_count": 318,
  "perspective_count": 3,
  "profile": {
    "name": "alice",
    "nip05": "alice",
    "lud16": "alice",
    "name_affinity": 4
  },
  "committee_breakdown": []
}
```

### `GET /api/users/<pubkey>/activity`

Queries `SOCIAL_RELAY_URLS` for the author’s latest event (any kind) and kind 0 profile, then updates `last_activity_check` / `last_activity_timestamp` and profile fields when data is found. Errors use `{ "error": { "code", "message" } }` like other `/api` routes.

```json
{
  "pubkey": "e5272de914bd301755c439b88e6959a43c9d2664831f093c51e9c799a16a102f",
  "latest_event": {
    "id": "...",
    "kind": 1,
    "created_at": 1730000000,
    "created_at_iso": "2024-10-27T00:00:00.000Z",
    "days_ago": 12
  },
  "total_events_found": 42,
  "profile": {
    "name": "alice",
    "nip05": null,
    "lud16": null,
    "last_activity_timestamp": "1730000000",
    "profile_timestamp": "1729900000",
    "last_activity_check": "2025-03-24T12:00:00.000Z",
    "last_profile_fetch": "2025-03-24T11:58:00.000Z"
  }
}
```

`latest_event` is `null` when no events are returned from relays; `profile` is `null` if that pubkey has no row in `user_names` after the run.

## Maintenance

### Reset Activity Checks

To re-run activity checks while preserving existing activity data:

```bash
docker exec -i nymrank_postgres psql -U nymrank_user -d nymrank < reset-activity-checks.sql
```

This sets `last_activity_check` to NULL while keeping `last_activity_timestamp` intact.

