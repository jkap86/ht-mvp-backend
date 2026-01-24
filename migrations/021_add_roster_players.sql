-- Link players to rosters (current roster composition)
CREATE TABLE IF NOT EXISTS roster_players (
    id SERIAL PRIMARY KEY,
    roster_id INTEGER NOT NULL REFERENCES rosters(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    acquired_type VARCHAR(20) NOT NULL, -- 'draft', 'free_agent', 'trade', 'waiver'
    acquired_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(roster_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_roster_players_roster ON roster_players(roster_id);
CREATE INDEX IF NOT EXISTS idx_roster_players_player ON roster_players(player_id);

-- Add league season state
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS current_week INTEGER DEFAULT 1;
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS season_status VARCHAR(20) DEFAULT 'pre_season';
-- season_status: 'pre_season', 'regular_season', 'playoffs', 'offseason'
