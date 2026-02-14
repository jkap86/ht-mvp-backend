-- Fix 1: Track previous owner for correct undo behavior
-- Fix 3: Track is_auto_pick for pick asset selections

ALTER TABLE vet_draft_pick_selections
  ADD COLUMN previous_owner_roster_id INTEGER REFERENCES rosters(id);

-- Backfill: set previous_owner_roster_id to original_roster_id for existing rows
-- (best available approximation for historical data)
UPDATE vet_draft_pick_selections vdps
SET previous_owner_roster_id = dpa.original_roster_id
FROM draft_pick_assets dpa
WHERE vdps.draft_pick_asset_id = dpa.id AND vdps.previous_owner_roster_id IS NULL;

ALTER TABLE vet_draft_pick_selections
  ALTER COLUMN previous_owner_roster_id SET NOT NULL;

ALTER TABLE vet_draft_pick_selections
  ADD COLUMN is_auto_pick BOOLEAN NOT NULL DEFAULT FALSE;
