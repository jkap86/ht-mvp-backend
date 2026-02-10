-- Migration 083: Add NOT NULL constraints and indexes to league_season_id columns
-- Purpose: Finalize the league_seasons migration by enforcing constraints

-- CRITICAL: Only run this after verifying migration 082 completed successfully!
-- Check that all records have league_season_id populated before running.

-- Add NOT NULL constraints to league_season_id columns
ALTER TABLE rosters ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE drafts ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE matchups ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE trades ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE waiver_claims ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE waiver_wire ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE waiver_priority ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE faab_budgets ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE playoff_brackets ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE roster_transactions ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE roster_lineups ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE auction_lots ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE league_dues ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE dues_payments ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE league_invitations ALTER COLUMN league_season_id SET NOT NULL;
ALTER TABLE draft_pick_assets ALTER COLUMN league_season_id SET NOT NULL;

-- league_chat_messages keeps league_season_id as nullable (chat can span seasons)

-- Add indexes for new FK columns (performance optimization)
CREATE INDEX idx_rosters_league_season ON rosters(league_season_id);
CREATE INDEX idx_drafts_league_season ON drafts(league_season_id);
CREATE INDEX idx_matchups_league_season ON matchups(league_season_id);
CREATE INDEX idx_matchups_season_week ON matchups(league_season_id, week);
CREATE INDEX idx_trades_league_season ON trades(league_season_id);
CREATE INDEX idx_trades_season_status ON trades(league_season_id, status);
CREATE INDEX idx_waiver_claims_league_season ON waiver_claims(league_season_id);
CREATE INDEX idx_waiver_claims_season_roster ON waiver_claims(league_season_id, roster_id);
CREATE INDEX idx_waiver_wire_league_season ON waiver_wire(league_season_id);
CREATE INDEX idx_waiver_priority_league_season ON waiver_priority(league_season_id);
CREATE INDEX idx_faab_budgets_league_season ON faab_budgets(league_season_id);
CREATE INDEX idx_playoff_brackets_league_season ON playoff_brackets(league_season_id);
CREATE INDEX idx_roster_transactions_league_season ON roster_transactions(league_season_id);
CREATE INDEX idx_roster_lineups_league_season ON roster_lineups(league_season_id);
CREATE INDEX idx_auction_lots_league_season ON auction_lots(league_season_id);
CREATE INDEX idx_league_chat_season ON league_chat_messages(league_season_id) WHERE league_season_id IS NOT NULL;
CREATE INDEX idx_league_dues_season ON league_dues(league_season_id);
CREATE INDEX idx_dues_payments_season ON dues_payments(league_season_id);
CREATE INDEX idx_league_invitations_season ON league_invitations(league_season_id);
CREATE INDEX idx_draft_pick_assets_season ON draft_pick_assets(league_season_id);

-- Update unique constraints for tables that previously used league_id + season
-- rosters: Change from UNIQUE(league_id, user_id) to UNIQUE(league_season_id, user_id)
ALTER TABLE rosters DROP CONSTRAINT IF EXISTS rosters_league_id_user_id_key;
ALTER TABLE rosters DROP CONSTRAINT IF EXISTS unique_roster_user_league;
ALTER TABLE rosters ADD CONSTRAINT unique_roster_user_league_season UNIQUE(league_season_id, user_id);

-- rosters: Change from UNIQUE(league_id, roster_id) to UNIQUE(league_season_id, roster_id)
ALTER TABLE rosters DROP CONSTRAINT IF EXISTS rosters_league_id_roster_id_key;
ALTER TABLE rosters DROP CONSTRAINT IF EXISTS unique_roster_id_per_league;
ALTER TABLE rosters ADD CONSTRAINT unique_roster_id_per_league_season UNIQUE(league_season_id, roster_id);

-- waiver_priority: Update unique constraints
ALTER TABLE waiver_priority DROP CONSTRAINT IF EXISTS waiver_priority_league_id_season_roster_id_key;
ALTER TABLE waiver_priority DROP CONSTRAINT IF EXISTS unique_waiver_priority_roster;
ALTER TABLE waiver_priority ADD CONSTRAINT unique_waiver_priority_roster_season UNIQUE(league_season_id, roster_id);

ALTER TABLE waiver_priority DROP CONSTRAINT IF EXISTS waiver_priority_league_id_season_priority_key;
ALTER TABLE waiver_priority DROP CONSTRAINT IF EXISTS unique_waiver_priority_number;
ALTER TABLE waiver_priority ADD CONSTRAINT unique_waiver_priority_number_season UNIQUE(league_season_id, priority);

-- faab_budgets: Update unique constraints
ALTER TABLE faab_budgets DROP CONSTRAINT IF EXISTS faab_budgets_league_id_season_roster_id_key;
ALTER TABLE faab_budgets DROP CONSTRAINT IF EXISTS unique_faab_budget_roster;
ALTER TABLE faab_budgets ADD CONSTRAINT unique_faab_budget_roster_season UNIQUE(league_season_id, roster_id);

-- playoff_brackets: Update unique constraints
ALTER TABLE playoff_brackets DROP CONSTRAINT IF EXISTS playoff_brackets_league_id_season_key;
ALTER TABLE playoff_brackets DROP CONSTRAINT IF EXISTS unique_playoff_bracket_per_league_season;
ALTER TABLE playoff_brackets ADD CONSTRAINT unique_playoff_bracket_per_league_season_v2 UNIQUE(league_season_id);

-- roster_lineups: Update unique constraints
ALTER TABLE roster_lineups DROP CONSTRAINT IF EXISTS roster_lineups_roster_id_season_week_key;
ALTER TABLE roster_lineups DROP CONSTRAINT IF EXISTS unique_lineup_per_roster_week;
ALTER TABLE roster_lineups ADD CONSTRAINT unique_lineup_per_roster_season_week UNIQUE(roster_id, league_season_id, week);

-- league_dues: Update unique constraints (if it had league_id uniqueness)
ALTER TABLE league_dues DROP CONSTRAINT IF EXISTS league_dues_league_id_key;
ALTER TABLE league_dues DROP CONSTRAINT IF EXISTS unique_league_dues;
ALTER TABLE league_dues ADD CONSTRAINT unique_league_dues_per_season UNIQUE(league_season_id);

-- waiver_wire: Update unique constraints
ALTER TABLE waiver_wire DROP CONSTRAINT IF EXISTS waiver_wire_league_id_player_id_key;
ALTER TABLE waiver_wire DROP CONSTRAINT IF EXISTS unique_waiver_wire_player;
ALTER TABLE waiver_wire ADD CONSTRAINT unique_waiver_wire_player_season UNIQUE(league_season_id, player_id);

-- Validation: Verify constraints are in place
DO $$
DECLARE
    roster_count INTEGER;
    draft_count INTEGER;
    season_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO roster_count FROM rosters;
    SELECT COUNT(*) INTO draft_count FROM drafts;
    SELECT COUNT(*) INTO season_count FROM league_seasons;

    RAISE NOTICE 'Migration 083 Validation:';
    RAISE NOTICE '  Total league_seasons: %', season_count;
    RAISE NOTICE '  Total rosters: %', roster_count;
    RAISE NOTICE '  Total drafts: %', draft_count;
    RAISE NOTICE 'All NOT NULL constraints and indexes applied successfully.';
END $$;
