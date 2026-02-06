-- Add phase column for derby draft order mode
-- Phase represents workflow stage: SETUP, DERBY, LIVE
-- This is orthogonal to status (operational state)

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS phase VARCHAR(20) DEFAULT 'SETUP';

-- Create index for querying by phase (especially for derby job)
CREATE INDEX IF NOT EXISTS idx_drafts_phase ON drafts(phase);

-- Backfill existing drafts based on status:
-- - completed/in_progress drafts are in LIVE phase
-- - not_started/paused drafts are in SETUP phase
UPDATE drafts SET phase = 'LIVE' WHERE status IN ('completed', 'in_progress') AND phase = 'SETUP';
