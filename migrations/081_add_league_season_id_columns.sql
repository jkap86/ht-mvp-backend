-- Migration 081: Add league_season_id columns to seasonal tables
-- Purpose: Prepare for FK migration from league_id to league_season_id

-- Add league_season_id column to all seasonal tables (nullable during migration)
-- These will be populated in migration 082, then made NOT NULL in migration 083

ALTER TABLE rosters ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE matchups ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE waiver_claims ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE waiver_wire ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE waiver_priority ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE faab_budgets ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE roster_transactions ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE roster_lineups ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE league_dues ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE dues_payments ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE league_invitations ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;
ALTER TABLE draft_pick_assets ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;

-- Special cases:
-- auction_lots gets league_season_id from draft (will be populated in migration 082)
ALTER TABLE auction_lots ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE CASCADE;

-- league_chat_messages: keep both league_id and league_season_id (chat spans seasons)
ALTER TABLE league_chat_messages ADD COLUMN IF NOT EXISTS league_season_id INTEGER REFERENCES league_seasons(id) ON DELETE SET NULL;

-- Comments
COMMENT ON COLUMN rosters.league_season_id IS 'Reference to the league season (replaces league_id for seasonal scoping)';
COMMENT ON COLUMN drafts.league_season_id IS 'Reference to the league season this draft belongs to';
COMMENT ON COLUMN matchups.league_season_id IS 'Reference to the league season for this matchup';
COMMENT ON COLUMN trades.league_season_id IS 'Reference to the league season when this trade occurred';
COMMENT ON COLUMN waiver_claims.league_season_id IS 'Reference to the league season for this claim';
COMMENT ON COLUMN waiver_wire.league_season_id IS 'Reference to the league season for this waiver wire';
COMMENT ON COLUMN waiver_priority.league_season_id IS 'Reference to the league season for this priority list';
COMMENT ON COLUMN faab_budgets.league_season_id IS 'Reference to the league season for this FAAB budget';
COMMENT ON COLUMN playoff_brackets.league_season_id IS 'Reference to the league season for this playoff bracket';
COMMENT ON COLUMN roster_transactions.league_season_id IS 'Reference to the league season for this transaction';
COMMENT ON COLUMN roster_lineups.league_season_id IS 'Reference to the league season for this lineup';
COMMENT ON COLUMN auction_lots.league_season_id IS 'Reference to the league season (derived from draft)';
COMMENT ON COLUMN league_chat_messages.league_season_id IS 'Optional reference to league season (chat can span seasons)';
COMMENT ON COLUMN league_dues.league_season_id IS 'Reference to the league season for these dues';
COMMENT ON COLUMN dues_payments.league_season_id IS 'Reference to the league season for this payment';
COMMENT ON COLUMN league_invitations.league_season_id IS 'Reference to the league season for this invitation';
COMMENT ON COLUMN draft_pick_assets.league_season_id IS 'Reference to the league season where this pick will be used';
