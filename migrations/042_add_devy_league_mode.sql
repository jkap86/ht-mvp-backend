-- Add 'devy' as a valid league mode
-- Devy leagues allow drafting college players

ALTER TABLE leagues DROP CONSTRAINT IF EXISTS leagues_mode_check;
ALTER TABLE leagues ADD CONSTRAINT leagues_mode_check
  CHECK (mode IN ('redraft', 'dynasty', 'keeper', 'devy'));
