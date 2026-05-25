-- BXRD sync cursor persistence (no Nostr identity for BXRD — see 003 for ranking_source)

CREATE TABLE IF NOT EXISTS bxrd_sync_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_since_ms BIGINT,
  last_snapshot_etag TEXT,
  last_snapshot_at TIMESTAMPTZ,
  last_delta_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO bxrd_sync_state (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
