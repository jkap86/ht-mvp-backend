-- Migration: Add status tracking to waiver processing runs
-- Prevents crashes from stalling the waiver processing system

-- Add status column if not exists (may already exist from migration 077)
ALTER TABLE waiver_processing_runs
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'processing';

-- Add completed_at column if not exists
ALTER TABLE waiver_processing_runs
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Create index for monitoring stale runs
CREATE INDEX IF NOT EXISTS idx_waiver_processing_runs_status
  ON waiver_processing_runs(status, created_at);

-- Update any existing 'pending' runs to 'processing' (legacy migration)
UPDATE waiver_processing_runs
SET status = 'processing'
WHERE status = 'pending';
