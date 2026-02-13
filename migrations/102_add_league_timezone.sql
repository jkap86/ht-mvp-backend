-- Add timezone support for leagues
-- This allows each league to have its own timezone for waiver processing
-- and other time-sensitive operations

-- Add timezone column (defaults to America/New_York for backward compatibility)
ALTER TABLE leagues
ADD COLUMN timezone VARCHAR(50) DEFAULT 'America/New_York';

-- Set timezone for existing leagues (default to Eastern Time)
UPDATE leagues
SET timezone = 'America/New_York'
WHERE timezone IS NULL;

-- Add check constraint for valid IANA timezone names (optional, can be enabled later)
-- ALTER TABLE leagues
-- ADD CONSTRAINT check_valid_timezone
-- CHECK (timezone IN (
--   'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
--   'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
--   'UTC', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo'
-- ));

-- Add index for queries filtering by timezone
CREATE INDEX IF NOT EXISTS idx_leagues_timezone ON leagues(timezone);

-- Add helpful comment
COMMENT ON COLUMN leagues.timezone IS
  'IANA timezone name for the league (e.g., America/New_York). Used for waiver processing and other time-sensitive operations.';
