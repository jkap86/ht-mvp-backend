-- Add is_public column to leagues for public/private league visibility
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;

-- Create partial index for efficient querying of public leagues
CREATE INDEX IF NOT EXISTS idx_leagues_is_public ON leagues(is_public) WHERE is_public = true;
