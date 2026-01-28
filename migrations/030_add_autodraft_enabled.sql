-- Add autodraft enabled flag to draft_order table
-- When enabled, the system will automatically pick from the user's queue when their timer expires
-- When disabled and timeout occurs, the system still makes the pick but then enables autodraft
ALTER TABLE draft_order ADD COLUMN IF NOT EXISTS is_autodraft_enabled BOOLEAN DEFAULT FALSE;
