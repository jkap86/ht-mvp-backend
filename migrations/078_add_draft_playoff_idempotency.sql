-- Migration: Add idempotency support for draft and playoff operations
-- Prevents duplicate executions of start/randomize/confirm/generate/advance operations on retry

-- Draft operations table
CREATE TABLE IF NOT EXISTS draft_operations (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  draft_id INT NOT NULL,
  user_id UUID NOT NULL,
  operation_type TEXT NOT NULL,  -- 'start', 'randomize', 'confirm', 'pause', 'resume'
  result JSONB NOT NULL,  -- Cached response to return on retry
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),

  CONSTRAINT draft_operations_unique_key UNIQUE (idempotency_key, user_id, operation_type),
  CONSTRAINT fk_draft_operations_draft FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
);

-- Index for cleanup job
CREATE INDEX idx_draft_operations_expires_at ON draft_operations(expires_at);
CREATE INDEX idx_draft_operations_draft_id ON draft_operations(draft_id);

-- Playoff operations table
CREATE TABLE IF NOT EXISTS playoff_operations (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  bracket_id INT NOT NULL,
  league_id INT NOT NULL,
  user_id UUID NOT NULL,
  operation_type TEXT NOT NULL,  -- 'generate', 'advance', 'finalize'
  result JSONB NOT NULL,  -- Cached response to return on retry
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),

  CONSTRAINT playoff_operations_unique_key UNIQUE (idempotency_key, user_id, operation_type),
  CONSTRAINT fk_playoff_operations_bracket FOREIGN KEY (bracket_id) REFERENCES playoff_brackets(id) ON DELETE CASCADE
);

-- Index for cleanup job
CREATE INDEX idx_playoff_operations_expires_at ON playoff_operations(expires_at);
CREATE INDEX idx_playoff_operations_league_id ON playoff_operations(league_id);
