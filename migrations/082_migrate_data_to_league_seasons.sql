-- Migration 082: Migrate existing data to league_seasons model
-- Purpose: Create league_season for each existing league and populate FK references

-- CRITICAL: This migration transforms the data model. Backup database before running!

-- Step 1: Create initial league_season for each existing league
INSERT INTO league_seasons (league_id, season, status, season_status, current_week, created_at, updated_at, started_at)
SELECT
    id as league_id,
    CAST(season AS INTEGER) as season,
    -- Map league status to valid league_seasons status values
    CASE status
        WHEN 'pre_draft' THEN 'pre_draft'
        WHEN 'drafting' THEN 'drafting'
        WHEN 'regular_season' THEN 'in_season'
        WHEN 'in_season' THEN 'in_season'
        WHEN 'playoffs' THEN 'playoffs'
        WHEN 'completed' THEN 'completed'
        WHEN 'offseason' THEN 'completed'
        ELSE 'pre_draft'
    END as status,
    season_status,
    current_week,
    created_at,
    updated_at,
    CASE
        WHEN status != 'pre_draft' THEN created_at
        ELSE NULL
    END as started_at
FROM leagues
WHERE season IS NOT NULL AND season ~ '^\d{4}$'; -- Only migrate leagues with valid year format

-- Step 2: Create temporary mapping table for migration
CREATE TEMP TABLE league_season_mapping AS
SELECT
    l.id as league_id,
    ls.id as league_season_id,
    l.season
FROM leagues l
JOIN league_seasons ls ON ls.league_id = l.id AND CAST(l.season AS INTEGER) = ls.season;

-- Step 3: Update rosters table
UPDATE rosters r
SET league_season_id = m.league_season_id
FROM league_season_mapping m
WHERE r.league_id = m.league_id;

-- Step 4: Update drafts table
UPDATE drafts d
SET league_season_id = m.league_season_id
FROM league_season_mapping m
WHERE d.league_id = m.league_id;

-- Step 5: Update matchups table (match by league_id AND season)
UPDATE matchups mt
SET league_season_id = ls.id
FROM league_seasons ls
WHERE mt.league_id = ls.league_id
    AND mt.season = ls.season;

-- Step 6: Update trades table (match by league_id AND season)
UPDATE trades t
SET league_season_id = ls.id
FROM league_seasons ls
WHERE t.league_id = ls.league_id
    AND CAST(t.season AS INTEGER) = ls.season;

-- Step 7: Update waiver_claims table (match by league_id AND season)
UPDATE waiver_claims wc
SET league_season_id = ls.id
FROM league_seasons ls
WHERE wc.league_id = ls.league_id
    AND CAST(wc.season AS INTEGER) = ls.season;

-- Step 8: Update waiver_wire table (match by league_id AND season)
UPDATE waiver_wire ww
SET league_season_id = ls.id
FROM league_seasons ls
WHERE ww.league_id = ls.league_id
    AND CAST(ww.season AS INTEGER) = ls.season;

-- Step 9: Update waiver_priority table (match by league_id AND season)
UPDATE waiver_priority wp
SET league_season_id = ls.id
FROM league_seasons ls
WHERE wp.league_id = ls.league_id
    AND CAST(wp.season AS INTEGER) = ls.season;

-- Step 10: Update faab_budgets table (match by league_id AND season)
UPDATE faab_budgets fb
SET league_season_id = ls.id
FROM league_seasons ls
WHERE fb.league_id = ls.league_id
    AND CAST(fb.season AS INTEGER) = ls.season;

-- Step 11: Update playoff_brackets table (match by league_id AND season)
UPDATE playoff_brackets pb
SET league_season_id = ls.id
FROM league_seasons ls
WHERE pb.league_id = ls.league_id
    AND pb.season = ls.season;

-- Step 12: Update roster_transactions table (match by league_id AND season)
UPDATE roster_transactions rt
SET league_season_id = ls.id
FROM league_seasons ls
WHERE rt.league_id = ls.league_id
    AND CAST(rt.season AS INTEGER) = ls.season;

-- Step 13: Update roster_lineups table (via roster relationship)
UPDATE roster_lineups rl
SET league_season_id = r.league_season_id
FROM rosters r
WHERE rl.roster_id = r.id
    AND r.league_season_id IS NOT NULL;

-- Step 14: Update auction_lots table (via draft relationship)
UPDATE auction_lots al
SET league_season_id = d.league_season_id
FROM drafts d
WHERE al.draft_id = d.id
    AND d.league_season_id IS NOT NULL;

-- Step 15: Update league_chat_messages (optional season association)
UPDATE league_chat_messages lcm
SET league_season_id = m.league_season_id
FROM league_season_mapping m
WHERE lcm.league_id = m.league_id;

-- Step 16: Update league_invitations
UPDATE league_invitations li
SET league_season_id = m.league_season_id
FROM league_season_mapping m
WHERE li.league_id = m.league_id;

-- Step 17: Update league_dues
UPDATE league_dues ld
SET league_season_id = m.league_season_id
FROM league_season_mapping m
WHERE ld.league_id = m.league_id;

-- Step 18: Update dues_payments (via roster → league_season)
UPDATE dues_payments dp
SET league_season_id = r.league_season_id
FROM rosters r
WHERE dp.roster_id = r.id
    AND r.league_season_id IS NOT NULL;

-- Step 19: Update draft_pick_assets (match by league_id AND season year)
UPDATE draft_pick_assets dpa
SET league_season_id = ls.id
FROM league_seasons ls
WHERE dpa.league_id = ls.league_id
    AND dpa.season = ls.season;

-- Validation: Check for any records that failed to migrate
DO $$
DECLARE
    unmigrated_rosters INTEGER;
    unmigrated_drafts INTEGER;
    unmigrated_matchups INTEGER;
    unmigrated_trades INTEGER;
    total_leagues INTEGER;
    total_seasons INTEGER;
BEGIN
    SELECT COUNT(*) INTO unmigrated_rosters FROM rosters WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO unmigrated_drafts FROM drafts WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO unmigrated_matchups FROM matchups WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO unmigrated_trades FROM trades WHERE league_season_id IS NULL;
    SELECT COUNT(*) INTO total_leagues FROM leagues;
    SELECT COUNT(*) INTO total_seasons FROM league_seasons;

    RAISE NOTICE 'Migration 082 Validation:';
    RAISE NOTICE '  Total leagues: %', total_leagues;
    RAISE NOTICE '  Total league_seasons created: %', total_seasons;
    RAISE NOTICE '  Unmigrated rosters: %', unmigrated_rosters;
    RAISE NOTICE '  Unmigrated drafts: %', unmigrated_drafts;
    RAISE NOTICE '  Unmigrated matchups: %', unmigrated_matchups;
    RAISE NOTICE '  Unmigrated trades: %', unmigrated_trades;

    IF unmigrated_rosters > 0 OR unmigrated_drafts > 0 THEN
        RAISE WARNING 'Some records failed to migrate. Review data before proceeding to migration 083.';
    END IF;
END $$;
