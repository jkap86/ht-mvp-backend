-- Migration: Add waiver_processing_runs table
-- Purpose: Prevent duplicate waiver processing within the same hour window
--          and track processing history for auditing

CREATE TABLE waiver_processing_runs (
    id SERIAL PRIMARY KEY,
    league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    window_start_at TIMESTAMPTZ NOT NULL,  -- The hour when processing window started (truncated)
    ran_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    claims_found INTEGER NOT NULL DEFAULT 0,
    claims_successful INTEGER NOT NULL DEFAULT 0,

    -- Unique constraint prevents duplicate processing for same league/season/week/window
    UNIQUE(league_id, season, week, window_start_at)
);

-- Index for efficient lookup during job processing
CREATE INDEX idx_waiver_processing_runs_lookup
ON waiver_processing_runs(league_id, season, week, window_start_at);

-- Comment for documentation
COMMENT ON TABLE waiver_processing_runs IS 'Tracks waiver processing runs to prevent duplicate processing within the same hour window';
