-- Add database-level guards for draft completion
-- These triggers serve as safety nets to prevent operations on completed drafts

-- Prevent picks on completed drafts
CREATE OR REPLACE FUNCTION prevent_picks_on_completed_draft()
RETURNS TRIGGER AS $$
DECLARE
  draft_status VARCHAR(20);
BEGIN
  SELECT status INTO draft_status FROM drafts WHERE id = NEW.draft_id;

  IF draft_status = 'completed' THEN
    RAISE EXCEPTION 'Cannot add picks to completed draft %', NEW.draft_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_draft_completed_before_pick
BEFORE INSERT ON draft_picks
FOR EACH ROW EXECUTE FUNCTION prevent_picks_on_completed_draft();

-- Prevent pick asset selections on completed drafts
CREATE TRIGGER check_draft_completed_before_pick_asset_selection
BEFORE INSERT ON vet_draft_pick_selections
FOR EACH ROW EXECUTE FUNCTION prevent_picks_on_completed_draft();

-- Prevent queue modifications on completed drafts
CREATE OR REPLACE FUNCTION prevent_queue_ops_on_completed_draft()
RETURNS TRIGGER AS $$
DECLARE
  draft_status VARCHAR(20);
BEGIN
  SELECT status INTO draft_status FROM drafts WHERE id = NEW.draft_id;

  IF draft_status = 'completed' THEN
    RAISE EXCEPTION 'Cannot modify queue on completed draft %', NEW.draft_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_draft_completed_before_queue_insert
BEFORE INSERT ON draft_queue
FOR EACH ROW EXECUTE FUNCTION prevent_queue_ops_on_completed_draft();

-- Add helpful comment
COMMENT ON TRIGGER check_draft_completed_before_pick ON draft_picks IS
  'Prevents picks from being made on completed drafts';

COMMENT ON TRIGGER check_draft_completed_before_pick_asset_selection ON vet_draft_pick_selections IS
  'Prevents pick asset selections on completed drafts';

COMMENT ON TRIGGER check_draft_completed_before_queue_insert ON draft_queue IS
  'Prevents queue modifications on completed drafts';
