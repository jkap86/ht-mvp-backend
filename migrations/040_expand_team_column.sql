-- Expand team column to support college team names (e.g., "Mississippi State", "Louisiana-Lafayette")
ALTER TABLE players ALTER COLUMN team TYPE VARCHAR(100);
