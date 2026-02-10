-- Add stats provider configuration to league_seasons
-- This allows different league seasons to use different stats providers if needed.
-- Default is 'sleeper' to maintain backward compatibility.

ALTER TABLE league_seasons
ADD COLUMN IF NOT EXISTS stats_provider VARCHAR(50) DEFAULT 'sleeper';

-- Add index for provider queries
CREATE INDEX idx_league_seasons_stats_provider ON league_seasons(stats_provider);

-- Comment
COMMENT ON COLUMN league_seasons.stats_provider IS 'Stats provider for this season (sleeper, fantasypros, etc.)';
