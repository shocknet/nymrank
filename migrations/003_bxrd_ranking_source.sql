-- BXRD is an API source, not a committee member / Nostr pubkey.
-- Tag rows with ranking_source; drop FK so we do not need a fake committee_members row.

ALTER TABLE user_rankings
  ADD COLUMN IF NOT EXISTS ranking_source VARCHAR(16) NOT NULL DEFAULT 'nostr';

ALTER TABLE user_rankings
  DROP CONSTRAINT IF EXISTS user_rankings_committee_member_pubkey_fkey;

CREATE INDEX IF NOT EXISTS idx_user_rankings_source
  ON user_rankings (ranking_source);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_rankings_bxrd_pubkey
  ON user_rankings (ranked_user_pubkey)
  WHERE ranking_source = 'bxrd';

-- Remove mistaken "bxrd committee member" row if an earlier migration added one
DELETE FROM committee_members WHERE name = 'bxrd';
