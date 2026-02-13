-- Add 'failed' status to trade_status enum and failure_reason column
-- Supports descriptive failure when trades cannot be executed after review period
-- (e.g., roster size changes between accept and execution)

ALTER TYPE trade_status ADD VALUE IF NOT EXISTS 'failed';

ALTER TABLE trades ADD COLUMN IF NOT EXISTS failure_reason TEXT;
