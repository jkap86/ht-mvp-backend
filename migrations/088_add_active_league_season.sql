-- Migration: Add active_league_season_id to leagues table
-- Allows quick lookup of current season without querying league_seasons

-- Add column (nullable during migration)
ALTER TABLE leagues
  ADD COLUMN IF NOT EXISTS active_league_season_id INTEGER;

-- Add foreign key constraint
ALTER TABLE leagues
  ADD CONSTRAINT fk_leagues_active_season
  FOREIGN KEY (active_league_season_id)
  REFERENCES league_seasons(id)
  ON DELETE SET NULL;

-- Create index for joins
CREATE INDEX IF NOT EXISTS idx_leagues_active_season
  ON leagues(active_league_season_id);

-- Backfill existing leagues with their current season
UPDATE leagues l
SET active_league_season_id = (
  SELECT ls.id
  FROM league_seasons ls
  WHERE ls.league_id = l.id AND ls.season = l.season
  LIMIT 1
)
WHERE active_league_season_id IS NULL
  AND EXISTS (
    SELECT 1 FROM league_seasons ls
    WHERE ls.league_id = l.id AND ls.season = l.season
  );
