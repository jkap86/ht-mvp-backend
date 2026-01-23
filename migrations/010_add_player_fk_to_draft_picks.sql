-- Add foreign key constraint to draft_picks now that players table exists
ALTER TABLE draft_picks
    ADD CONSTRAINT fk_draft_picks_player
    FOREIGN KEY (player_id)
    REFERENCES players(id)
    ON DELETE SET NULL;
