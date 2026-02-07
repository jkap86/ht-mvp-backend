-- Migration 057: Add live scoring columns to roster_lineups
-- These columns store real-time scoring data during games

ALTER TABLE roster_lineups
ADD COLUMN IF NOT EXISTS total_points_live DECIMAL(6,2),
ADD COLUMN IF NOT EXISTS total_points_projected_live DECIMAL(6,2);

-- Note: No index needed as queries will use existing idx_roster_lineups_lookup
-- which covers (roster_id, season, week)
