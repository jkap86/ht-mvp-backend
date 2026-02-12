-- Add missing BEFORE UPDATE trigger on users table to automatically set updated_at
-- (All other tables with updated_at columns already have this trigger)

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
