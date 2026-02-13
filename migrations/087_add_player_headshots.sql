-- Migration: Add player headshots and enhanced profile data
-- Stream B: Player Profiles & Stats (B1.2)

-- Add headshot URL column to players table
ALTER TABLE players
ADD COLUMN IF NOT EXISTS headshot_url VARCHAR(500),
ADD COLUMN IF NOT EXISTS depth_chart_position VARCHAR(50), -- 'starter', 'backup', 'third_string', null
ADD COLUMN IF NOT EXISTS depth_chart_order INTEGER; -- 1, 2, 3, etc.

-- Add index for depth chart queries
CREATE INDEX idx_players_depth_chart ON players(team, position, depth_chart_order)
WHERE depth_chart_order IS NOT NULL;

-- Add comments
COMMENT ON COLUMN players.headshot_url IS 'URL to player headshot image from Sleeper API or other source';
COMMENT ON COLUMN players.depth_chart_position IS 'Position on depth chart: starter, backup, third_string';
COMMENT ON COLUMN players.depth_chart_order IS 'Numeric order on depth chart (1=starter, 2=first backup, etc)';
