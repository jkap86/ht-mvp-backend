-- Migration: Add idempotency support for auction operations
-- Prevents duplicate nominations, bids, and max bid updates on retry

-- Add idempotency key columns if they don't already exist
-- (Some tables may already have these from earlier development)

-- auction_lots: Prevent duplicate nominations
ALTER TABLE auction_lots
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- auction_bid_history: Already has idempotency_key from initial schema
-- Just add constraint if it doesn't exist
CREATE UNIQUE INDEX IF NOT EXISTS auction_bid_history_unique_idempotency
  ON auction_bid_history (lot_id, roster_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- auction_lots: Ensure unique idempotency key per nomination
CREATE UNIQUE INDEX IF NOT EXISTS auction_lots_unique_idempotency
  ON auction_lots (draft_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
