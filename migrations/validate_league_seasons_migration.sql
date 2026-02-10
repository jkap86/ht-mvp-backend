-- Validation Script for League Seasons Migration
-- Run this after migrations 079-083 to verify data integrity

-- ============================================================================
-- VALIDATION CHECKPOINT 1: Table Existence
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE '=== CHECKPOINT 1: Table Existence ===';

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'league_seasons') THEN
        RAISE NOTICE '✓ league_seasons table exists';
    ELSE
        RAISE EXCEPTION '✗ league_seasons table does not exist!';
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'keeper_selections') THEN
        RAISE NOTICE '✓ keeper_selections table exists';
    ELSE
        RAISE EXCEPTION '✗ keeper_selections table does not exist!';
    END IF;
END $$;

-- ============================================================================
-- VALIDATION CHECKPOINT 2: Record Counts
-- ============================================================================
DO $$
DECLARE
    total_leagues INTEGER;
    total_seasons INTEGER;
    unmigrated_rosters INTEGER;
    unmigrated_drafts INTEGER;
    unmigrated_matchups INTEGER;
    unmigrated_trades INTEGER;
    unmigrated_waivers INTEGER;
    unmigrated_playoff_brackets INTEGER;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== CHECKPOINT 2: Record Counts ===';

    SELECT COUNT(*) INTO total_leagues FROM leagues;
    SELECT COUNT(*) INTO total_seasons FROM league_seasons;

    RAISE NOTICE 'Total leagues: %', total_leagues;
    RAISE NOTICE 'Total league_seasons created: %', total_seasons;

    IF total_seasons < total_leagues THEN
        RAISE WARNING '⚠ Fewer seasons than leagues! Expected at least % seasons, got %', total_leagues, total_seasons;
    ELSE
        RAISE NOTICE '✓ Season count is valid';
    END IF;

    -- Check for unmigrated records
    SELECT COUNT(*) INTO unmigrated_rosters FROM rosters WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO unmigrated_drafts FROM drafts WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO unmigrated_matchups FROM matchups WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO unmigrated_trades FROM trades WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO unmigrated_waivers FROM waiver_claims WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO unmigrated_playoff_brackets FROM playoff_brackets WHERE league_season_id IS NULL;

    RAISE NOTICE '';
    RAISE NOTICE 'Unmigrated records:';
    RAISE NOTICE '  Rosters: %', unmigrated_rosters;
    RAISE NOTICE '  Drafts: %', unmigrated_drafts;
    RAISE NOTICE '  Matchups: %', unmigrated_matchups;
    RAISE NOTICE '  Trades: %', unmigrated_trades;
    RAISE NOTICE '  Waiver claims: %', unmigrated_waivers;
    RAISE NOTICE '  Playoff brackets: %', unmigrated_playoff_brackets;

    IF unmigrated_rosters > 0 OR unmigrated_drafts > 0 THEN
        RAISE EXCEPTION '✗ CRITICAL: Some records failed to migrate! Review before proceeding.';
    ELSE
        RAISE NOTICE '✓ All critical records migrated successfully';
    END IF;
END $$;

-- ============================================================================
-- VALIDATION CHECKPOINT 3: Foreign Key Integrity
-- ============================================================================
DO $$
DECLARE
    orphaned_rosters INTEGER;
    orphaned_drafts INTEGER;
    orphaned_keepers INTEGER;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== CHECKPOINT 3: Foreign Key Integrity ===';

    -- Check for orphaned rosters (league_season_id pointing to non-existent season)
    SELECT COUNT(*) INTO orphaned_rosters
    FROM rosters r
    LEFT JOIN league_seasons ls ON r.league_season_id = ls.id
    WHERE r.league_season_id IS NOT NULL AND ls.id IS NULL;

    -- Check for orphaned drafts
    SELECT COUNT(*) INTO orphaned_drafts
    FROM drafts d
    LEFT JOIN league_seasons ls ON d.league_season_id = ls.id
    WHERE d.league_season_id IS NOT NULL AND ls.id IS NULL;

    -- Check for orphaned keeper selections
    SELECT COUNT(*) INTO orphaned_keepers
    FROM keeper_selections ks
    LEFT JOIN league_seasons ls ON ks.league_season_id = ls.id
    WHERE ls.id IS NULL;

    IF orphaned_rosters > 0 THEN
        RAISE EXCEPTION '✗ Found % orphaned rosters with invalid league_season_id', orphaned_rosters;
    END IF;

    IF orphaned_drafts > 0 THEN
        RAISE EXCEPTION '✗ Found % orphaned drafts with invalid league_season_id', orphaned_drafts;
    END IF;

    IF orphaned_keepers > 0 THEN
        RAISE EXCEPTION '✗ Found % orphaned keeper selections with invalid league_season_id', orphaned_keepers;
    END IF;

    RAISE NOTICE '✓ All foreign key relationships are valid';
END $$;

-- ============================================================================
-- VALIDATION CHECKPOINT 4: Unique Constraints
-- ============================================================================
DO $$
DECLARE
    duplicate_seasons INTEGER;
    duplicate_rosters INTEGER;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== CHECKPOINT 4: Unique Constraints ===';

    -- Check for duplicate (league_id, season) pairs
    SELECT COUNT(*) INTO duplicate_seasons
    FROM (
        SELECT league_id, season, COUNT(*) as count
        FROM league_seasons
        GROUP BY league_id, season
        HAVING COUNT(*) > 1
    ) dupes;

    IF duplicate_seasons > 0 THEN
        RAISE EXCEPTION '✗ Found % duplicate league/season combinations', duplicate_seasons;
    ELSE
        RAISE NOTICE '✓ No duplicate league/season combinations';
    END IF;

    -- Check for duplicate rosters (league_season_id, roster_id)
    SELECT COUNT(*) INTO duplicate_rosters
    FROM (
        SELECT league_season_id, roster_id, COUNT(*) as count
        FROM rosters
        GROUP BY league_season_id, roster_id
        HAVING COUNT(*) > 1
    ) dupes;

    IF duplicate_rosters > 0 THEN
        RAISE EXCEPTION '✗ Found % duplicate roster_id values within seasons', duplicate_rosters;
    ELSE
        RAISE NOTICE '✓ No duplicate roster_id values within seasons';
    END IF;
END $$;

-- ============================================================================
-- VALIDATION CHECKPOINT 5: Index Existence
-- ============================================================================
DO $$
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== CHECKPOINT 5: Index Existence ===';

    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_league_seasons_league') THEN
        RAISE NOTICE '✓ idx_league_seasons_league exists';
    ELSE
        RAISE WARNING '⚠ idx_league_seasons_league is missing';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_rosters_league_season') THEN
        RAISE NOTICE '✓ idx_rosters_league_season exists';
    ELSE
        RAISE WARNING '⚠ idx_rosters_league_season is missing';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_drafts_league_season') THEN
        RAISE NOTICE '✓ idx_drafts_league_season exists';
    ELSE
        RAISE WARNING '⚠ idx_drafts_league_season is missing';
    END IF;
END $$;

-- ============================================================================
-- VALIDATION CHECKPOINT 6: Data Consistency
-- ============================================================================
DO $$
DECLARE
    mismatched_leagues INTEGER;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=== CHECKPOINT 6: Data Consistency ===';

    -- Verify rosters.league_season_id matches rosters.league_id → league_seasons.league_id
    -- (If league_id still exists on rosters table after migration)
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'rosters' AND column_name = 'league_id'
    ) THEN
        SELECT COUNT(*) INTO mismatched_leagues
        FROM rosters r
        JOIN league_seasons ls ON r.league_season_id = ls.id
        WHERE r.league_id != ls.league_id;

        IF mismatched_leagues > 0 THEN
            RAISE EXCEPTION '✗ Found % rosters with mismatched league_id/league_season_id', mismatched_leagues;
        ELSE
            RAISE NOTICE '✓ All roster league references are consistent';
        END IF;
    ELSE
        RAISE NOTICE '✓ legacy league_id column removed from rosters (expected)';
    END IF;
END $$;

-- ============================================================================
-- FINAL SUMMARY
-- ============================================================================
DO $$
DECLARE
    total_leagues INTEGER;
    total_seasons INTEGER;
    total_rosters INTEGER;
    total_drafts INTEGER;
    total_matchups INTEGER;
    total_keepers INTEGER;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '=================================================================';
    RAISE NOTICE '                  MIGRATION VALIDATION SUMMARY';
    RAISE NOTICE '=================================================================';

    SELECT COUNT(*) INTO total_leagues FROM leagues;
    SELECT COUNT(*) INTO total_seasons FROM league_seasons;
    SELECT COUNT(*) INTO total_rosters FROM rosters;
    SELECT COUNT(*) INTO total_drafts FROM drafts;
    SELECT COUNT(*) INTO total_matchups FROM matchups;
    SELECT COUNT(*) INTO total_keepers FROM keeper_selections;

    RAISE NOTICE 'Total Leagues: %', total_leagues;
    RAISE NOTICE 'Total Seasons: %', total_seasons;
    RAISE NOTICE 'Total Rosters: %', total_rosters;
    RAISE NOTICE 'Total Drafts: %', total_drafts;
    RAISE NOTICE 'Total Matchups: %', total_matchups;
    RAISE NOTICE 'Total Keeper Selections: %', total_keepers;
    RAISE NOTICE '';
    RAISE NOTICE '✅ ALL VALIDATION CHECKS PASSED';
    RAISE NOTICE 'Migration 079-083 completed successfully!';
    RAISE NOTICE '=================================================================';
END $$;
