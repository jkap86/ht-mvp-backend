-- Migration: Auto-populate league_season_id for gradual rollout
-- Creates a trigger to automatically fill league_season_id during transition period

-- Function to auto-populate league_season_id on insert
CREATE OR REPLACE FUNCTION auto_populate_league_season_id()
RETURNS TRIGGER AS $$
DECLARE
  season_id INTEGER;
  target_season INTEGER;
BEGIN
  -- Only if league_season_id is NULL
  IF NEW.league_season_id IS NULL THEN
    -- Determine target season (use NEW.season if available, else league's current season)
    IF TG_TABLE_NAME IN ('rosters', 'matchups', 'roster_lineups', 'roster_transactions') THEN
      target_season := (SELECT season FROM leagues WHERE id = NEW.league_id);
    ELSIF NEW.season IS NOT NULL THEN
      target_season := NEW.season;
    ELSE
      target_season := (SELECT season FROM leagues WHERE id = NEW.league_id);
    END IF;

    -- Find or create league season for this league + season
    SELECT id INTO season_id
    FROM league_seasons
    WHERE league_id = NEW.league_id AND season = target_season
    LIMIT 1;

    IF season_id IS NULL THEN
      -- Create missing league season (band-aid for legacy data)
      INSERT INTO league_seasons (league_id, season, status, season_status, current_week)
      VALUES (NEW.league_id, target_season, 'pre_draft', 'pre_season', 1)
      RETURNING id INTO season_id;
    END IF;

    NEW.league_season_id := season_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to seasonal tables (only if table has league_season_id column)
DO $$
BEGIN
  -- Rosters
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'rosters' AND column_name = 'league_season_id') THEN
    DROP TRIGGER IF EXISTS trg_rosters_auto_league_season ON rosters;
    CREATE TRIGGER trg_rosters_auto_league_season
      BEFORE INSERT ON rosters
      FOR EACH ROW EXECUTE FUNCTION auto_populate_league_season_id();
  END IF;

  -- Drafts
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'drafts' AND column_name = 'league_season_id') THEN
    DROP TRIGGER IF EXISTS trg_drafts_auto_league_season ON drafts;
    CREATE TRIGGER trg_drafts_auto_league_season
      BEFORE INSERT ON drafts
      FOR EACH ROW EXECUTE FUNCTION auto_populate_league_season_id();
  END IF;

  -- Matchups
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'matchups' AND column_name = 'league_season_id') THEN
    DROP TRIGGER IF EXISTS trg_matchups_auto_league_season ON matchups;
    CREATE TRIGGER trg_matchups_auto_league_season
      BEFORE INSERT ON matchups
      FOR EACH ROW EXECUTE FUNCTION auto_populate_league_season_id();
  END IF;

  -- Waiver claims
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'waiver_claims' AND column_name = 'league_season_id') THEN
    DROP TRIGGER IF EXISTS trg_waiver_claims_auto_league_season ON waiver_claims;
    CREATE TRIGGER trg_waiver_claims_auto_league_season
      BEFORE INSERT ON waiver_claims
      FOR EACH ROW EXECUTE FUNCTION auto_populate_league_season_id();
  END IF;

  -- Trades
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'trades' AND column_name = 'league_season_id') THEN
    DROP TRIGGER IF EXISTS trg_trades_auto_league_season ON trades;
    CREATE TRIGGER trg_trades_auto_league_season
      BEFORE INSERT ON trades
      FOR EACH ROW EXECUTE FUNCTION auto_populate_league_season_id();
  END IF;
END $$;

-- Note: This is a temporary band-aid during migration.
-- Once all application INSERT paths explicitly set league_season_id, remove these triggers.
