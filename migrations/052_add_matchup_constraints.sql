-- Migration: Add constraints to prevent invalid matchup schedules
-- This ensures data integrity for the matchups table

-- Ensure roster2_id is also unique per week (prevents same team appearing twice in a week)
-- Note: roster1_id already has UNIQUE(league_id, season, week, roster1_id) from original schema
ALTER TABLE matchups
ADD CONSTRAINT unique_roster2_per_week
UNIQUE(league_id, season, week, roster2_id);

-- Add check constraint to prevent self-matchups (team playing against itself)
ALTER TABLE matchups
ADD CONSTRAINT no_self_matchups
CHECK (roster1_id != roster2_id);

-- Add index to improve query performance for season-based queries
CREATE INDEX IF NOT EXISTS idx_matchups_league_season
ON matchups(league_id, season);
