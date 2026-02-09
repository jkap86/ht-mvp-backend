-- Migration: 066_add_playoff_series_support.sql
-- Add support for multi-week playoff series (Sleeper-style "Playoff Weeks")
-- Each playoff round can span 1 or 2 weeks with aggregate scoring

-- ============================================================================
-- STEP 1: Add series tracking columns to matchups table
-- ============================================================================

-- UUID linking all games in the same playoff series
ALTER TABLE matchups ADD COLUMN IF NOT EXISTS series_id UUID;

-- Which game this is in the series (1 or 2)
ALTER TABLE matchups ADD COLUMN IF NOT EXISTS series_game INTEGER DEFAULT 1;

-- Total games in the series (1 or 2)
ALTER TABLE matchups ADD COLUMN IF NOT EXISTS series_length INTEGER DEFAULT 1;

-- Add CHECK constraint for series_game (must be 1 or 2)
ALTER TABLE matchups DROP CONSTRAINT IF EXISTS matchups_series_game_check;
ALTER TABLE matchups ADD CONSTRAINT matchups_series_game_check
  CHECK (series_game IS NULL OR series_game IN (1, 2));

-- Add CHECK constraint for series_length (must be 1 or 2)
ALTER TABLE matchups DROP CONSTRAINT IF EXISTS matchups_series_length_check;
ALTER TABLE matchups ADD CONSTRAINT matchups_series_length_check
  CHECK (series_length IS NULL OR series_length IN (1, 2));

-- Add CHECK constraint for series_game <= series_length
ALTER TABLE matchups DROP CONSTRAINT IF EXISTS matchups_series_game_length_check;
ALTER TABLE matchups ADD CONSTRAINT matchups_series_game_length_check
  CHECK (series_game IS NULL OR series_length IS NULL OR series_game <= series_length);

-- Index for efficient series lookups
CREATE INDEX IF NOT EXISTS idx_matchups_series
ON matchups(series_id) WHERE series_id IS NOT NULL;

-- ============================================================================
-- STEP 2: Add weeks_by_round configuration to playoff_brackets
-- ============================================================================

-- JSONB array storing weeks per round, e.g., [1, 2, 2]
-- Index 0 = Round 1, Index 1 = Round 2, etc.
-- NULL means all 1-week rounds (backward compatible)
ALTER TABLE playoff_brackets ADD COLUMN IF NOT EXISTS weeks_by_round JSONB;

-- ============================================================================
-- STEP 3: Update unique index for playoff matchups to include series_game
-- ============================================================================

-- Drop the old index
DROP INDEX IF EXISTS idx_playoff_matchups_unique;

-- Create new partial unique index that includes series_game
-- COALESCE handles NULL values for backward compatibility
CREATE UNIQUE INDEX IF NOT EXISTS idx_playoff_matchups_unique
ON matchups (league_id, season, bracket_type, playoff_round, bracket_position, COALESCE(series_game, 1))
WHERE is_playoff = true;

-- ============================================================================
-- STEP 4: Backfill existing playoff matchups with series defaults
-- ============================================================================

-- Set series_game = 1 and series_length = 1 for existing playoff matchups
-- that don't have these values set
UPDATE matchups
SET
  series_game = 1,
  series_length = 1
WHERE is_playoff = true
  AND (series_game IS NULL OR series_length IS NULL);
