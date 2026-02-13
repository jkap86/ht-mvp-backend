-- Migration: Fix league_id type in league_operations table
-- league_id should be INTEGER (SERIAL) not UUID to match leagues table

-- Drop existing foreign key constraint if it exists
ALTER TABLE league_operations
  DROP CONSTRAINT IF EXISTS fk_league_operations_league;

-- Change league_id from UUID to INTEGER
ALTER TABLE league_operations
  ALTER COLUMN league_id TYPE INTEGER USING league_id::text::integer;

-- Add proper foreign key constraint
ALTER TABLE league_operations
  ADD CONSTRAINT fk_league_operations_league
  FOREIGN KEY (league_id) REFERENCES leagues(id) ON DELETE CASCADE;

-- Create index for better join performance
CREATE INDEX IF NOT EXISTS idx_league_operations_league_id
  ON league_operations(league_id);
