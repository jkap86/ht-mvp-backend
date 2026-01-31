-- Add college football player support
-- Adds fields from College Football Data API (CFBD)

-- Make sleeper_id nullable to support college players (who don't have sleeper IDs)
ALTER TABLE players ALTER COLUMN sleeper_id DROP NOT NULL;

-- Add college-specific columns
ALTER TABLE players ADD COLUMN IF NOT EXISTS cfbd_id INTEGER UNIQUE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS college VARCHAR(100);
ALTER TABLE players ADD COLUMN IF NOT EXISTS height VARCHAR(10);
ALTER TABLE players ADD COLUMN IF NOT EXISTS weight INTEGER;
ALTER TABLE players ADD COLUMN IF NOT EXISTS home_city VARCHAR(100);
ALTER TABLE players ADD COLUMN IF NOT EXISTS home_state VARCHAR(50);
ALTER TABLE players ADD COLUMN IF NOT EXISTS player_type VARCHAR(20) DEFAULT 'nfl';

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_players_cfbd_id ON players(cfbd_id);
CREATE INDEX IF NOT EXISTS idx_players_college ON players(college);
CREATE INDEX IF NOT EXISTS idx_players_player_type ON players(player_type);
