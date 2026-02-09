-- Migration: Add claim_order column to waiver_claims
-- Purpose: Allow users to prioritize their waiver claims within their roster
-- Used for round-based processing where each roster's #1 claim is processed first,
-- then #2, etc.

-- Add claim_order column with default of 1
ALTER TABLE waiver_claims ADD COLUMN claim_order INTEGER NOT NULL DEFAULT 1;

-- Index for efficient round-based queries (fetch pending claims ordered by roster and claim_order)
CREATE INDEX idx_waiver_claims_roster_week_order
ON waiver_claims(roster_id, season, week, claim_order)
WHERE status = 'pending';

-- Backfill existing pending claims with sequential order based on created_at
-- This ensures existing claims maintain their creation-time order as their claim_order
WITH ordered_claims AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY roster_id, season, week
               ORDER BY created_at ASC
           ) as new_order
    FROM waiver_claims
    WHERE status = 'pending'
)
UPDATE waiver_claims wc
SET claim_order = oc.new_order
FROM ordered_claims oc
WHERE wc.id = oc.id;

COMMENT ON COLUMN waiver_claims.claim_order IS
  'User-defined priority order for claims within a roster. Lower number = higher priority. Processed in this order during round-based waiver runs.';
