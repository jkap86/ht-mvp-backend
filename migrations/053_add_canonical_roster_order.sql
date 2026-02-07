-- Migration: Enforce canonical roster order in matchups
-- Ensures roster1_id is always less than roster2_id to prevent
-- duplicate matchups like (A,B) and (B,A) in same week

-- First, fix existing data that violates the constraint
-- Swap roster1/roster2 (and their points) where roster1_id > roster2_id
UPDATE matchups
SET
    roster1_id = roster2_id,
    roster2_id = roster1_id,
    roster1_points = roster2_points,
    roster2_points = roster1_points
WHERE roster1_id > roster2_id;

-- Now add check constraint to enforce canonical ordering
ALTER TABLE matchups
ADD CONSTRAINT canonical_roster_order
CHECK (roster1_id < roster2_id);
