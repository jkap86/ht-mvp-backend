-- Add notification preference columns to trades table
-- These allow users to control whether trade notifications are sent

ALTER TABLE trades ADD COLUMN IF NOT EXISTS notify_league_chat BOOLEAN DEFAULT true;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS notify_dm BOOLEAN DEFAULT true;

COMMENT ON COLUMN trades.notify_league_chat IS 'Whether to post a system message in league chat for this trade';
COMMENT ON COLUMN trades.notify_dm IS 'Whether to send a DM notification for this trade';
