-- Migration: Fix invalid partial unique constraint syntax
-- PostgreSQL requires CREATE UNIQUE INDEX for partial constraints, not ALTER TABLE ADD CONSTRAINT

-- Drop the constraint if it was somehow created
ALTER TABLE waiver_claims
  DROP CONSTRAINT IF EXISTS waiver_claims_unique_idempotency;

-- Create proper partial unique index instead
CREATE UNIQUE INDEX IF NOT EXISTS idx_waiver_claims_idempotency
  ON waiver_claims (league_id, roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
