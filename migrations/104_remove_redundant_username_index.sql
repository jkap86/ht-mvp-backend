-- Remove redundant username index
-- Migration 071 created idx_users_username_lower (LOWER(username)) which is more useful
-- The original idx_users_username from migration 002 is now redundant

DROP INDEX IF EXISTS idx_users_username;

-- Keep idx_users_username_lower as it provides case-insensitive uniqueness
-- COMMENT: No need to recreate, keeping idx_users_username_lower from migration 071
