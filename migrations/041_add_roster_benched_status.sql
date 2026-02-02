-- Add benched status to rosters for team count management
-- Benched members keep their roster/players but don't count against total_rosters

ALTER TABLE rosters ADD COLUMN is_benched BOOLEAN NOT NULL DEFAULT false;

-- Index for efficient lookup of benched members by league
CREATE INDEX idx_rosters_league_benched ON rosters(league_id, is_benched);
