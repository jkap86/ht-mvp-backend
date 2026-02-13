-- Add overnight pause window configuration to drafts table
-- Allows commissioners to configure time windows when drafts automatically pause

ALTER TABLE drafts
ADD COLUMN overnight_pause_enabled BOOLEAN DEFAULT FALSE NOT NULL,
ADD COLUMN overnight_pause_start TIME DEFAULT NULL,
ADD COLUMN overnight_pause_end TIME DEFAULT NULL;

-- Add comment explaining the feature
COMMENT ON COLUMN drafts.overnight_pause_enabled IS 'Whether overnight pause window is enabled for this draft';
COMMENT ON COLUMN drafts.overnight_pause_start IS 'Start time of overnight pause window (HH:MM format, UTC)';
COMMENT ON COLUMN drafts.overnight_pause_end IS 'End time of overnight pause window (HH:MM format, UTC)';

-- Index for finding drafts with overnight pause enabled during tick processing
CREATE INDEX IF NOT EXISTS idx_drafts_overnight_pause_enabled
ON drafts(overnight_pause_enabled)
WHERE overnight_pause_enabled = TRUE;
