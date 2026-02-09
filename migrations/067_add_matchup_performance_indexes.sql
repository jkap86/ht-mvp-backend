-- Add indexes for matchup performance optimizations
-- These indexes improve query performance for roster-based matchup lookups

-- Index for matchups by roster1 and season (used in standings queries)
CREATE INDEX IF NOT EXISTS idx_matchups_roster1_season
ON matchups (roster1_id, season);

-- Index for matchups by roster2 and season (used in standings queries)
CREATE INDEX IF NOT EXISTS idx_matchups_roster2_season
ON matchups (roster2_id, season);

-- Index for roster_players by roster_id for faster roster lookups
CREATE INDEX IF NOT EXISTS idx_roster_players_roster_id
ON roster_players (roster_id);

-- Composite index for roster_players queries that filter by both roster and player
CREATE INDEX IF NOT EXISTS idx_roster_players_roster_player
ON roster_players (roster_id, player_id);
