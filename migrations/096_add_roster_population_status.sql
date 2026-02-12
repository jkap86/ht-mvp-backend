-- Add roster_population_status to drafts table
-- Tracks whether roster population completed successfully after draft completion.
-- This enables retry logic if the process crashes midway.
--
-- Values:
--   NULL     - Draft has not completed yet (default for existing drafts)
--   'pending'  - Draft completed, roster population has not started or is in progress
--   'complete' - Roster population finished successfully
--   'failed'   - Roster population failed and needs retry

ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS roster_population_status VARCHAR(20) DEFAULT NULL;

-- Backfill: Mark all already-completed drafts as 'complete' since they presumably finished
UPDATE drafts
  SET roster_population_status = 'complete'
  WHERE status = 'completed' AND roster_population_status IS NULL;

-- Add a check constraint for valid values
ALTER TABLE drafts
  ADD CONSTRAINT chk_roster_population_status
  CHECK (roster_population_status IS NULL OR roster_population_status IN ('pending', 'complete', 'failed'));
