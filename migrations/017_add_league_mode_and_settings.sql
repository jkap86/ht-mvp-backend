-- Add mode column for league type
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'redraft';

-- Add constraint for valid modes
ALTER TABLE leagues ADD CONSTRAINT leagues_mode_check
  CHECK (mode IN ('redraft', 'dynasty', 'keeper'));

-- Add league_settings JSONB column for draft/auction configuration
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS league_settings JSONB DEFAULT '{}';

-- Index for mode queries
CREATE INDEX IF NOT EXISTS idx_leagues_mode ON leagues(mode);

-- Documentation
COMMENT ON COLUMN leagues.mode IS 'League type: redraft, dynasty, keeper';
COMMENT ON COLUMN leagues.league_settings IS 'Draft config: draftType, auctionMode, auctionBudget, rosterSlots';
