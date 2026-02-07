-- Add bestball support to roster_lineups table
-- Bestball leagues auto-generate optimal lineups each week

ALTER TABLE roster_lineups
ADD COLUMN IF NOT EXISTS is_bestball BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS bestball_generated_at TIMESTAMPTZ;

-- Index for efficient bestball queries
CREATE INDEX IF NOT EXISTS idx_roster_lineups_bestball
ON roster_lineups(roster_id, season, week) WHERE is_bestball = true;
