-- Add idempotency key for safe pick retries
ALTER TABLE draft_picks ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Unique per draft+roster combination (allows same key for different rosters)
CREATE UNIQUE INDEX IF NOT EXISTS idx_draft_picks_idempotency
  ON draft_picks(draft_id, roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
