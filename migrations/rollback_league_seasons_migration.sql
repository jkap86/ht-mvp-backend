-- Rollback Script for League Seasons Migration (079-083)
-- CRITICAL: Only run this if migration failed or needs to be reverted
-- This will DELETE all league_seasons data and restore old schema

-- WARNING: This is a DESTRUCTIVE operation. Backup database first!

BEGIN;

-- ============================================================================
-- STEP 1: Remove NOT NULL constraints (reverse of migration 083)
-- ============================================================================
ALTER TABLE rosters ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE drafts ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE matchups ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE trades ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE waiver_claims ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE waiver_wire ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE waiver_priority ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE faab_budgets ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE playoff_brackets ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE roster_transactions ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE roster_lineups ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE auction_lots ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE league_dues ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE dues_payments ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE league_invitations ALTER COLUMN league_season_id DROP NOT NULL;
ALTER TABLE draft_pick_assets ALTER COLUMN league_season_id DROP NOT NULL;

-- ============================================================================
-- STEP 2: Drop indexes created in migration 083
-- ============================================================================
DROP INDEX IF EXISTS idx_rosters_league_season;
DROP INDEX IF EXISTS idx_drafts_league_season;
DROP INDEX IF EXISTS idx_matchups_league_season;
DROP INDEX IF EXISTS idx_matchups_season_week;
DROP INDEX IF EXISTS idx_trades_league_season;
DROP INDEX IF EXISTS idx_trades_season_status;
DROP INDEX IF EXISTS idx_waiver_claims_league_season;
DROP INDEX IF EXISTS idx_waiver_claims_season_roster;
DROP INDEX IF EXISTS idx_waiver_wire_league_season;
DROP INDEX IF EXISTS idx_waiver_priority_league_season;
DROP INDEX IF EXISTS idx_faab_budgets_league_season;
DROP INDEX IF EXISTS idx_playoff_brackets_league_season;
DROP INDEX IF EXISTS idx_roster_transactions_league_season;
DROP INDEX IF EXISTS idx_roster_lineups_league_season;
DROP INDEX IF EXISTS idx_auction_lots_league_season;
DROP INDEX IF EXISTS idx_league_chat_season;
DROP INDEX IF EXISTS idx_league_dues_season;
DROP INDEX IF EXISTS idx_dues_payments_season;
DROP INDEX IF EXISTS idx_league_invitations_season;
DROP INDEX IF EXISTS idx_draft_pick_assets_season;

-- ============================================================================
-- STEP 3: Restore old unique constraints (reverse of migration 083)
-- ============================================================================
ALTER TABLE rosters DROP CONSTRAINT IF EXISTS unique_roster_user_league_season;
ALTER TABLE rosters DROP CONSTRAINT IF EXISTS unique_roster_id_per_league_season;
-- Restore old constraints if needed (check if league_id column still exists)

ALTER TABLE waiver_priority DROP CONSTRAINT IF EXISTS unique_waiver_priority_roster_season;
ALTER TABLE waiver_priority DROP CONSTRAINT IF EXISTS unique_waiver_priority_number_season;

ALTER TABLE faab_budgets DROP CONSTRAINT IF EXISTS unique_faab_budget_roster_season;

ALTER TABLE playoff_brackets DROP CONSTRAINT IF EXISTS unique_playoff_bracket_per_league_season_v2;

ALTER TABLE roster_lineups DROP CONSTRAINT IF EXISTS unique_lineup_per_roster_season_week;

ALTER TABLE league_dues DROP CONSTRAINT IF EXISTS unique_league_dues_per_season;

ALTER TABLE waiver_wire DROP CONSTRAINT IF EXISTS unique_waiver_wire_player_season;

-- ============================================================================
-- STEP 4: Clear league_season_id values (reverse of migration 082)
-- ============================================================================
UPDATE rosters SET league_season_id = NULL;
UPDATE drafts SET league_season_id = NULL;
UPDATE matchups SET league_season_id = NULL;
UPDATE trades SET league_season_id = NULL;
UPDATE waiver_claims SET league_season_id = NULL;
UPDATE waiver_wire SET league_season_id = NULL;
UPDATE waiver_priority SET league_season_id = NULL;
UPDATE faab_budgets SET league_season_id = NULL;
UPDATE playoff_brackets SET league_season_id = NULL;
UPDATE roster_transactions SET league_season_id = NULL;
UPDATE roster_lineups SET league_season_id = NULL;
UPDATE auction_lots SET league_season_id = NULL;
UPDATE league_chat_messages SET league_season_id = NULL;
UPDATE league_dues SET league_season_id = NULL;
UPDATE dues_payments SET league_season_id = NULL;
UPDATE league_invitations SET league_season_id = NULL;
UPDATE draft_pick_assets SET league_season_id = NULL;

-- ============================================================================
-- STEP 5: Drop league_season_id columns (reverse of migration 081)
-- ============================================================================
ALTER TABLE rosters DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE drafts DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE matchups DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE trades DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE waiver_claims DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE waiver_wire DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE waiver_priority DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE faab_budgets DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE playoff_brackets DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE roster_transactions DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE roster_lineups DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE auction_lots DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE league_chat_messages DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE league_dues DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE dues_payments DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE league_invitations DROP COLUMN IF EXISTS league_season_id;
ALTER TABLE draft_pick_assets DROP COLUMN IF EXISTS league_season_id;

-- ============================================================================
-- STEP 6: Drop new tables (reverse of migrations 080 and 079)
-- ============================================================================
DROP TABLE IF EXISTS keeper_selections CASCADE;
DROP TABLE IF EXISTS league_seasons CASCADE;

-- ============================================================================
-- STEP 7: Restore old leagues table columns (if they were removed)
-- ============================================================================
-- NOTE: Only run these if migration 084 (optional cleanup) was executed

-- Uncomment if league_id columns were removed:
-- ALTER TABLE rosters ADD COLUMN IF NOT EXISTS league_id INTEGER REFERENCES leagues(id);
-- ALTER TABLE drafts ADD COLUMN IF NOT EXISTS league_id INTEGER REFERENCES leagues(id);
-- etc...

-- ============================================================================
-- VERIFICATION
-- ============================================================================
DO $$
DECLARE
    seasons_exist BOOLEAN;
    keepers_exist BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'league_seasons'
    ) INTO seasons_exist;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'keeper_selections'
    ) INTO keepers_exist;

    IF seasons_exist OR keepers_exist THEN
        RAISE EXCEPTION 'Rollback failed: league_seasons or keeper_selections still exist';
    ELSE
        RAISE NOTICE '✓ Rollback completed successfully';
        RAISE NOTICE 'league_seasons and keeper_selections tables removed';
        RAISE NOTICE 'league_season_id columns removed from all tables';
    END IF;
END $$;

-- ============================================================================
-- IMPORTANT: Review before committing!
-- ============================================================================
-- Uncomment one of the following lines:

-- COMMIT;    -- To apply the rollback
-- ROLLBACK;  -- To abort the rollback (keeps current state)
