-- Migration: Add idempotency support for trade proposals
-- Prevents duplicate trade creations on retry

-- Add idempotency_key column to trades table
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);

-- Create partial unique index for idempotency
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_idempotency
  ON trades (league_id, proposer_roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_trades_idempotency_key
  ON trades (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
