-- Migration: Fix vet_draft_pick_selections.roster_id cascade
-- Purpose: Add ON DELETE CASCADE to roster_id FK to allow league deletion
-- Issue: Deleting a league cascades to rosters, but vet_draft_pick_selections
--        blocks roster deletion due to missing cascade constraint

ALTER TABLE vet_draft_pick_selections
DROP CONSTRAINT vet_draft_pick_selections_roster_id_fkey;

ALTER TABLE vet_draft_pick_selections
ADD CONSTRAINT vet_draft_pick_selections_roster_id_fkey
FOREIGN KEY (roster_id) REFERENCES rosters(id) ON DELETE CASCADE;
