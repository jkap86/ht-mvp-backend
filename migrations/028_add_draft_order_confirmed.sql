-- Add order_confirmed flag to prevent starting draft without explicit order confirmation
ALTER TABLE drafts ADD COLUMN order_confirmed BOOLEAN DEFAULT FALSE;
