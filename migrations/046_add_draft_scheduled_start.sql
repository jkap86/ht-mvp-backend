-- Add scheduled_start column to drafts table
ALTER TABLE drafts ADD COLUMN scheduled_start TIMESTAMPTZ;
