-- Migration: Enforce canonical roster order in matchups
-- Ensures roster1_id is always less than roster2_id to prevent
-- duplicate matchups like (A,B) and (B,A) in same week

-- Add check constraint to enforce canonical ordering
ALTER TABLE matchups
ADD CONSTRAINT canonical_roster_order
CHECK (roster1_id < roster2_id);
