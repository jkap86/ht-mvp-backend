-- Track time used per pick asset selection for chess clock analytics
ALTER TABLE vet_draft_pick_selections ADD COLUMN time_used_seconds NUMERIC(10, 3) DEFAULT NULL;
