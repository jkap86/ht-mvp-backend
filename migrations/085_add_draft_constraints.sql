-- Migration: Add database constraints for draft integrity
-- Ensures draft picks are unique and idempotency works correctly

-- 1. Ensure unique pick numbers per draft
-- This prevents duplicate pick numbers which would cause data corruption
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'draft_picks_unique_pick_number'
  ) THEN
    ALTER TABLE draft_picks
      ADD CONSTRAINT draft_picks_unique_pick_number
      UNIQUE (draft_id, pick_number);
  END IF;
END $$;

-- 2. Ensure idempotency key uniqueness (partial index for non-null values)
-- This allows the same pick to be retried safely without creating duplicates
DROP INDEX IF EXISTS idx_draft_picks_idempotency;

CREATE UNIQUE INDEX idx_draft_picks_idempotency
  ON draft_picks (draft_id, roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Add index for common queries
CREATE INDEX IF NOT EXISTS idx_draft_picks_draft_id
  ON draft_picks(draft_id);

CREATE INDEX IF NOT EXISTS idx_draft_picks_player_id
  ON draft_picks(player_id)
  WHERE player_id IS NOT NULL;  -- Exclude pick assets
