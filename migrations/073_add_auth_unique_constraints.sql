-- Migration: Add unique constraints on case-insensitive email and username
-- This prevents duplicate accounts with different case/whitespace variations

-- Add exclusion constraint for case-insensitive unique email
-- Note: Migration 071 already added the index idx_users_email_lower
-- This constraint provides enforcement at the database level
ALTER TABLE users ADD CONSTRAINT users_email_lower_unique
  EXCLUDE USING btree (LOWER(email) WITH =);

-- Add exclusion constraint for case-insensitive unique username
-- Note: Migration 071 already added the index idx_users_username_lower
-- This constraint provides enforcement at the database level
ALTER TABLE users ADD CONSTRAINT users_username_lower_unique
  EXCLUDE USING btree (LOWER(username) WITH =);
