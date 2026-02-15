-- Add auto_populate_league_season_id trigger to draft_pick_assets table.
-- This table has league_id and season columns, so the trigger's ELSIF NEW.season
-- branch will correctly resolve the league_season_id.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'draft_pick_assets' AND column_name = 'league_season_id') THEN
    DROP TRIGGER IF EXISTS trg_draft_pick_assets_auto_league_season ON draft_pick_assets;
    CREATE TRIGGER trg_draft_pick_assets_auto_league_season
      BEFORE INSERT ON draft_pick_assets
      FOR EACH ROW EXECUTE FUNCTION auto_populate_league_season_id();
  END IF;
END $$;
