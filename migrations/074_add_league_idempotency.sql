-- Migration: Add idempotency support for league operations
-- Prevents duplicate executions of create/join/kick/delete operations on retry

CREATE TABLE IF NOT EXISTS league_operations (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  league_id UUID,  -- NULL for create league (league doesn't exist yet)
  user_id UUID NOT NULL,
  operation_type TEXT NOT NULL,  -- 'create', 'join', 'kick', 'reinstate', 'delete', 'season-controls', 'reset'
  result JSONB NOT NULL,  -- Cached response to return on retry
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),

  CONSTRAINT league_operations_unique_key UNIQUE (idempotency_key, user_id, operation_type)
);

-- Index for cleanup job
CREATE INDEX idx_league_operations_expires_at ON league_operations(expires_at);
