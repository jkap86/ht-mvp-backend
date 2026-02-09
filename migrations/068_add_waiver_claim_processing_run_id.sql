-- Migration: Add processing_run_id to waiver_claims
-- Purpose: Enable snapshotting of claims at processing start to prevent
--          mid-run claim inclusion during waiver processing

-- Add processing_run_id column to link claims to specific processing runs
ALTER TABLE waiver_claims
ADD COLUMN processing_run_id INTEGER REFERENCES waiver_processing_runs(id);

-- Index for efficient querying of claims by processing run
-- Partial index only covers non-null values (snapshotted claims)
CREATE INDEX idx_waiver_claims_processing_run
ON waiver_claims(processing_run_id) WHERE processing_run_id IS NOT NULL;

-- Comment for documentation
COMMENT ON COLUMN waiver_claims.processing_run_id IS
'Links claim to specific processing run when snapshotted. NULL means not yet included in any processing run.';
