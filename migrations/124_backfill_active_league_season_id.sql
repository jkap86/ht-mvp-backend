-- Migration 124: Backfill active_league_season_id for pre-existing leagues
-- Purpose: Leagues created before the fix in leagues.service.ts have
-- active_league_season_id = NULL, causing season-scoped endpoints to fail
-- with "No active season configured for league X".

-- Step 1: Create missing league_seasons rows for leagues that have none
-- The auto_populate_league_season_id trigger (084/122) may have already
-- created rows for some leagues; this only fills in the gaps.
DO $$
DECLARE
  created_count INTEGER;
BEGIN
  INSERT INTO league_seasons (league_id, season, status, season_status, current_week)
  SELECT
    l.id,
    CAST(l.season AS INTEGER),
    CASE l.status
      WHEN 'pre_draft' THEN 'pre_draft'
      WHEN 'drafting' THEN 'drafting'
      WHEN 'regular_season' THEN 'in_season'
      WHEN 'in_season' THEN 'in_season'
      WHEN 'playoffs' THEN 'playoffs'
      WHEN 'completed' THEN 'completed'
      WHEN 'offseason' THEN 'completed'
      ELSE 'pre_draft'
    END,
    l.season_status,
    COALESCE(l.current_week, 1)
  FROM leagues l
  WHERE l.active_league_season_id IS NULL
    AND l.season IS NOT NULL
    AND l.season ~ '^\d{4}$'
    AND NOT EXISTS (
      SELECT 1 FROM league_seasons ls
      WHERE ls.league_id = l.id AND ls.season = CAST(l.season AS INTEGER)
    );

  GET DIAGNOSTICS created_count = ROW_COUNT;
  RAISE NOTICE 'Created % missing league_seasons rows', created_count;
END $$;

-- Step 2: Point active_league_season_id at the matching league_seasons row
DO $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE leagues l
  SET active_league_season_id = ls.id,
      updated_at = CURRENT_TIMESTAMP
  FROM league_seasons ls
  WHERE l.id = ls.league_id
    AND ls.season = CAST(l.season AS INTEGER)
    AND l.active_league_season_id IS NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Backfilled active_league_season_id for % leagues', updated_count;
END $$;
