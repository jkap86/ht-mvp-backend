-- Add invite_code column to leagues table
ALTER TABLE leagues ADD COLUMN IF NOT EXISTS invite_code VARCHAR(8);

-- Create unique index on invite_code
CREATE UNIQUE INDEX IF NOT EXISTS idx_leagues_invite_code ON leagues(invite_code) WHERE invite_code IS NOT NULL;

-- Function to generate random alphanumeric invite code
CREATE OR REPLACE FUNCTION generate_invite_code() RETURNS VARCHAR(8) AS $$
DECLARE
    chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    code TEXT := '';
    i INTEGER;
BEGIN
    FOR i IN 1..8 LOOP
        code := code || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
    END LOOP;
    RETURN code;
END;
$$ LANGUAGE plpgsql;

-- Generate invite codes for existing leagues
UPDATE leagues SET invite_code = generate_invite_code() WHERE invite_code IS NULL;

-- Make invite_code NOT NULL after populating existing rows
ALTER TABLE leagues ALTER COLUMN invite_code SET NOT NULL;

-- Add default for new leagues
ALTER TABLE leagues ALTER COLUMN invite_code SET DEFAULT generate_invite_code();
