-- Add partial unique index to prevent duplicate claim_order for pending claims
-- This ensures no two pending claims from the same roster/season/week have the same order
-- Uses partial index so completed/failed/cancelled claims can have duplicate orders

CREATE UNIQUE INDEX IF NOT EXISTS idx_waiver_claims_unique_pending_order
ON waiver_claims (roster_id, season, week, claim_order)
WHERE status = 'pending';

COMMENT ON INDEX idx_waiver_claims_unique_pending_order IS
  'Ensures unique claim_order per roster/season/week for pending claims only';
