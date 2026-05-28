-- BXRD ops stats: sync run log + per-row rank/follower history (bxrd rows only)

CREATE TABLE IF NOT EXISTS bxrd_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  run_type VARCHAR(16) NOT NULL,
  entries_count INTEGER NOT NULL DEFAULT 0,
  since_ms BIGINT,
  next_since_ms BIGINT,
  snapshot_etag TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bxrd_sync_runs_created ON bxrd_sync_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS bxrd_rank_history (
  id BIGSERIAL PRIMARY KEY,
  ranked_user_pubkey VARCHAR(64) NOT NULL,
  rank_value INTEGER NOT NULL,
  follower_count INTEGER NOT NULL DEFAULT 0,
  influence_score DOUBLE PRECISION,
  change_kind VARCHAR(16) NOT NULL,
  prev_rank_value INTEGER,
  prev_follower_count INTEGER,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bxrd_rank_history_recorded ON bxrd_rank_history (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_bxrd_rank_history_pubkey ON bxrd_rank_history (ranked_user_pubkey, recorded_at DESC);

CREATE OR REPLACE FUNCTION log_bxrd_rank_history()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ranking_source IS DISTINCT FROM 'bxrd' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO bxrd_rank_history (
      ranked_user_pubkey, rank_value, follower_count, influence_score, change_kind
    ) VALUES (
      NEW.ranked_user_pubkey, NEW.rank_value, NEW.follower_count, NEW.influence_score, 'insert'
    );
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    OLD.rank_value IS DISTINCT FROM NEW.rank_value
    OR OLD.follower_count IS DISTINCT FROM NEW.follower_count
    OR OLD.influence_score IS DISTINCT FROM NEW.influence_score
  ) THEN
    INSERT INTO bxrd_rank_history (
      ranked_user_pubkey, rank_value, follower_count, influence_score, change_kind,
      prev_rank_value, prev_follower_count
    ) VALUES (
      NEW.ranked_user_pubkey, NEW.rank_value, NEW.follower_count, NEW.influence_score, 'update',
      OLD.rank_value, OLD.follower_count
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bxrd_rank_history_trigger ON user_rankings;
CREATE TRIGGER bxrd_rank_history_trigger
  AFTER INSERT OR UPDATE ON user_rankings
  FOR EACH ROW
  EXECUTE FUNCTION log_bxrd_rank_history();
