-- Add draft_state JSONB column for storing complex draft state
-- Used for: pause/resume state, auction budgets, timer state
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS draft_state JSONB DEFAULT '{}';

-- Create GIN index for efficient JSONB queries
CREATE INDEX IF NOT EXISTS idx_drafts_draft_state ON drafts USING GIN (draft_state);
