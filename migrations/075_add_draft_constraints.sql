-- Migration: Add unique constraints to draft_picks for data integrity
-- Prevents duplicate picks and ensures idempotency safety

-- Ensure each pick number in a draft is unique (no duplicate picks)
ALTER TABLE draft_picks ADD CONSTRAINT draft_picks_unique_pick
  UNIQUE (draft_id, pick_number);

-- Ensure idempotency keys are unique per draft+roster combination
-- This allows the same idempotency key to be reused safely on retry
CREATE UNIQUE INDEX IF NOT EXISTS draft_picks_unique_idempotency
  ON draft_picks (draft_id, roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
