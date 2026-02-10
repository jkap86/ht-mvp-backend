-- Enforce case-insensitive uniqueness for email and username at the DB level.

-- Normalize existing data first
UPDATE users SET email = LOWER(TRIM(email)) WHERE email IS NOT NULL AND email != LOWER(TRIM(email));
UPDATE users SET username = LOWER(TRIM(username)) WHERE username != LOWER(TRIM(username));

-- Case-insensitive unique index on email
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));

-- Case-insensitive unique index on username
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
