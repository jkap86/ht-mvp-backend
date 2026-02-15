-- Fix: auto_populate_league_season_id trigger fails on drafts table
-- because it references NEW.season which doesn't exist on the drafts table.
-- Add 'drafts' to the list of tables that look up season from the league instead.

CREATE OR REPLACE FUNCTION auto_populate_league_season_id()
RETURNS TRIGGER AS $$
DECLARE
  season_id INTEGER;
  target_season INTEGER;
BEGIN
  -- Only if league_season_id is NULL
  IF NEW.league_season_id IS NULL THEN
    -- Determine target season
    -- Tables without a 'season' column must look it up from the league
    IF TG_TABLE_NAME IN ('rosters', 'matchups', 'roster_lineups', 'roster_transactions', 'drafts') THEN
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
