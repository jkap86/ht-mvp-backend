-- Migration: 060_add_playoff_bracket_extensions.sql
-- Add support for 3rd Place Game and Consolation Brackets
-- This migration adds bracket_type to matchups and settings to playoff_brackets

-- ============================================================================
-- STEP 1: Add bracket_type column to matchups table
-- ============================================================================

-- Add the column with DEFAULT so existing rows get 'WINNERS'
ALTER TABLE matchups
ADD COLUMN IF NOT EXISTS bracket_type TEXT NOT NULL DEFAULT 'WINNERS';

-- Add CHECK constraint for allowed bracket types
-- Using DROP/ADD pattern for idempotency
ALTER TABLE matchups DROP CONSTRAINT IF EXISTS matchups_bracket_type_check;
ALTER TABLE matchups ADD CONSTRAINT matchups_bracket_type_check
  CHECK (bracket_type IN ('WINNERS', 'THIRD_PLACE', 'CONSOLATION', 'TOILET_BOWL'));

-- ============================================================================
-- STEP 2: Update unique index for playoff matchups
-- ============================================================================

-- Drop the old index (from 059_add_playoff_matchup_unique_index.sql)
DROP INDEX IF EXISTS idx_playoff_matchups_unique;

-- Create new partial unique index that includes bracket_type
-- This allows same (round, position) to exist in different bracket types
CREATE UNIQUE INDEX IF NOT EXISTS idx_playoff_matchups_unique
ON matchups (league_id, season, bracket_type, playoff_round, bracket_position)
WHERE is_playoff = true;

-- Add index for efficient bracket type queries
CREATE INDEX IF NOT EXISTS idx_matchups_bracket_type
ON matchups(league_id, season, bracket_type)
WHERE is_playoff = true;

-- ============================================================================
-- STEP 3: Add settings columns to playoff_brackets table
-- ============================================================================

-- Enable 3rd place game (losers of semifinals play for 3rd place)
ALTER TABLE playoff_brackets
ADD COLUMN IF NOT EXISTS enable_third_place BOOLEAN NOT NULL DEFAULT false;

-- Consolation bracket type: 'NONE' (disabled), 'CONSOLATION' (winner advances)
ALTER TABLE playoff_brackets
ADD COLUMN IF NOT EXISTS consolation_type TEXT NOT NULL DEFAULT 'NONE';

-- Number of teams in consolation bracket (NULL = auto, or 4/6/8)
ALTER TABLE playoff_brackets
ADD COLUMN IF NOT EXISTS consolation_teams INTEGER NULL;

-- Add CHECK constraint for consolation_type values
ALTER TABLE playoff_brackets DROP CONSTRAINT IF EXISTS playoff_brackets_consolation_type_check;
ALTER TABLE playoff_brackets ADD CONSTRAINT playoff_brackets_consolation_type_check
  CHECK (consolation_type IN ('NONE', 'CONSOLATION'));

-- Add CHECK constraint for consolation_teams valid values
ALTER TABLE playoff_brackets DROP CONSTRAINT IF EXISTS playoff_brackets_consolation_teams_check;
ALTER TABLE playoff_brackets ADD CONSTRAINT playoff_brackets_consolation_teams_check
  CHECK (consolation_teams IS NULL OR consolation_teams IN (4, 6, 8));

-- ============================================================================
-- STEP 4: Add result tracking columns for secondary brackets
-- ============================================================================

-- Track 3rd place winner
ALTER TABLE playoff_brackets
ADD COLUMN IF NOT EXISTS third_place_roster_id INTEGER REFERENCES rosters(id) ON DELETE SET NULL;

-- Track consolation bracket winner
ALTER TABLE playoff_brackets
ADD COLUMN IF NOT EXISTS consolation_winner_roster_id INTEGER REFERENCES rosters(id) ON DELETE SET NULL;
