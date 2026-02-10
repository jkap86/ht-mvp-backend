-- Migration: Add idempotency support for auction operations
-- Prevents duplicate nominations, bids, and max bid updates on retry

-- Add idempotency key columns if they don't already exist
-- (Some tables may already have these from earlier development)

-- auction_lots: Prevent duplicate nominations
ALTER TABLE auction_lots
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- auction_bid_history: Already has idempotency_key from initial schema
-- Just add constraint if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auction_bid_history_unique_idempotency'
  ) THEN
    ALTER TABLE auction_bid_history
      ADD CONSTRAINT auction_bid_history_unique_idempotency
      UNIQUE (lot_id, roster_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  END IF;
END $$;

-- auction_lots: Ensure unique idempotency key per nomination
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auction_lots_unique_idempotency'
  ) THEN
    ALTER TABLE auction_lots
      ADD CONSTRAINT auction_lots_unique_idempotency
      UNIQUE (draft_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  END IF;
END $$;
