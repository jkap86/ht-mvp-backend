-- Migration: Add idempotency and crash recovery for waiver system
-- Prevents duplicate claims and allows retry of failed processing runs

-- Add idempotency key to waiver claims
ALTER TABLE waiver_claims
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Ensure unique idempotency key per league+roster combination
-- Prevents the same claim from being submitted twice even with different players
CREATE UNIQUE INDEX IF NOT EXISTS waiver_claims_unique_idempotency
  ON waiver_claims (league_id, roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Add status and completion tracking to processing runs
-- Allows detection of crashed runs that need retry
ALTER TABLE waiver_processing_runs
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';  -- 'pending', 'processing', 'completed', 'failed'

ALTER TABLE waiver_processing_runs
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Create index for finding stale/failed runs
CREATE INDEX IF NOT EXISTS idx_waiver_processing_runs_status
  ON waiver_processing_runs(status, ran_at);
