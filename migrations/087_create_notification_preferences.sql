-- Migration: Create notification preferences and device tokens
-- Stream C: Push Notifications (C1.2, C1.3)

-- User notification preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Push notification toggles
    enabled_push BOOLEAN DEFAULT true,
    draft_start BOOLEAN DEFAULT true,
    draft_your_turn BOOLEAN DEFAULT true,
    draft_completed BOOLEAN DEFAULT true,

    trade_offers BOOLEAN DEFAULT true,
    trade_accepted BOOLEAN DEFAULT true,
    trade_countered BOOLEAN DEFAULT true,
    trade_voted BOOLEAN DEFAULT true,
    trade_completed BOOLEAN DEFAULT true,

    waiver_results BOOLEAN DEFAULT true,
    waiver_processing BOOLEAN DEFAULT true,
    waiver_ending_soon BOOLEAN DEFAULT true,

    lineup_locks BOOLEAN DEFAULT true,

    player_news BOOLEAN DEFAULT true,
    breaking_news BOOLEAN DEFAULT true,

    -- Email notification toggles
    enabled_email BOOLEAN DEFAULT true,
    email_weekly_recap BOOLEAN DEFAULT true,
    email_important_only BOOLEAN DEFAULT false,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(user_id)
);

-- Device tokens for push notifications (FCM)
CREATE TABLE IF NOT EXISTS device_tokens (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(500) NOT NULL UNIQUE,
    device_type VARCHAR(20) NOT NULL, -- 'ios', 'android', 'web'
    device_name VARCHAR(200), -- Optional friendly name
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_notification_prefs_user ON notification_preferences(user_id);
CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);
CREATE INDEX idx_device_tokens_active ON device_tokens(user_id, is_active) WHERE is_active = true;
CREATE INDEX idx_device_tokens_token ON device_tokens(token);

-- Add comments
COMMENT ON TABLE notification_preferences IS 'User preferences for push and email notifications';
COMMENT ON TABLE device_tokens IS 'FCM device tokens for push notifications';
COMMENT ON COLUMN device_tokens.is_active IS 'Whether token is still valid (inactive tokens should be cleaned up)';
