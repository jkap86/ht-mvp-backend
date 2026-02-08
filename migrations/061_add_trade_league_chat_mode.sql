-- Add league_chat_mode column to trades table
-- Replaces boolean notify_league_chat with enum-like mode: none, summary, details

-- Add the column with default 'summary' (matches old notify_league_chat = true behavior)
ALTER TABLE trades ADD COLUMN IF NOT EXISTS league_chat_mode VARCHAR(10) DEFAULT 'summary';

-- Backfill existing data based on notify_league_chat boolean
UPDATE trades
SET league_chat_mode = CASE
  WHEN notify_league_chat = true THEN 'summary'
  ELSE 'none'
END
WHERE league_chat_mode IS NULL;

-- Add constraint for valid values
ALTER TABLE trades ADD CONSTRAINT chk_league_chat_mode
  CHECK (league_chat_mode IN ('none', 'summary', 'details'));

COMMENT ON COLUMN trades.league_chat_mode IS 'League chat notification mode: none (no post), summary (team names only), or details (full trade breakdown)';
