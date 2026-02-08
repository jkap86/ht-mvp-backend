-- Migration: 062_add_consolation_seeds.sql
-- Add bracket_type to playoff_seeds to support persisted consolation seeds
-- This enables proper 6-team consolation bye handling by storing seeds 1-2 explicitly

-- ============================================================================
-- STEP 1: Add bracket_type column to playoff_seeds
-- ============================================================================

-- Add bracket_type column with default 'WINNERS' for backwards compatibility
ALTER TABLE playoff_seeds
ADD COLUMN IF NOT EXISTS bracket_type TEXT NOT NULL DEFAULT 'WINNERS';

-- Add CHECK constraint for allowed bracket types
ALTER TABLE playoff_seeds DROP CONSTRAINT IF EXISTS playoff_seeds_bracket_type_check;
ALTER TABLE playoff_seeds ADD CONSTRAINT playoff_seeds_bracket_type_check
  CHECK (bracket_type IN ('WINNERS', 'CONSOLATION'));

-- ============================================================================
-- STEP 2: Update unique constraints to include bracket_type
-- ============================================================================

-- Drop old unique constraints
ALTER TABLE playoff_seeds DROP CONSTRAINT IF EXISTS playoff_seeds_bracket_id_seed_key;
ALTER TABLE playoff_seeds DROP CONSTRAINT IF EXISTS playoff_seeds_bracket_id_roster_id_key;

-- Recreate constraints including bracket_type
-- Same seed number can exist in different bracket types
CREATE UNIQUE INDEX IF NOT EXISTS idx_playoff_seeds_bracket_type_seed
ON playoff_seeds (bracket_id, bracket_type, seed);

-- Same roster can appear in different bracket types (but not twice in same bracket type)
CREATE UNIQUE INDEX IF NOT EXISTS idx_playoff_seeds_bracket_type_roster
ON playoff_seeds (bracket_id, bracket_type, roster_id);

-- ============================================================================
-- STEP 3: Add index for efficient bracket type queries
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_playoff_seeds_bracket_type
ON playoff_seeds(bracket_id, bracket_type);
