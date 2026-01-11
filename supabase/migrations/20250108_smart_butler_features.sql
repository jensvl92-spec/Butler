-- Smart Butler Features: Database Migration
-- Features: Anomaly Detection, Predictive Actions, Morning Briefing, Panic Mode

-- =============================================
-- 1. ANOMALY DETECTION
-- =============================================

-- Stores baseline statistics for sensors
CREATE TABLE IF NOT EXISTS anomaly_baselines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    entity_type TEXT,  -- 'power', 'temperature', 'humidity', etc.
    mean_value FLOAT NOT NULL,
    stddev FLOAT NOT NULL,
    min_value FLOAT,
    max_value FLOAT,
    sample_count INT DEFAULT 0,
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(connection_id, entity_id)
);

-- Stores detected anomaly events
CREATE TABLE IF NOT EXISTS anomaly_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    detected_value FLOAT NOT NULL,
    baseline_mean FLOAT NOT NULL,
    baseline_stddev FLOAT NOT NULL,
    deviation_sigma FLOAT NOT NULL,  -- How many standard deviations
    severity TEXT DEFAULT 'warning',  -- 'info', 'warning', 'critical'
    message TEXT,
    acknowledged BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 2. PREDICTIVE ACTIONS (Behavior Patterns)
-- =============================================

CREATE TABLE IF NOT EXISTS behavior_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    service TEXT NOT NULL,  -- e.g., 'light.turn_on'
    day_of_week INT,  -- 0=Sunday, 6=Saturday, NULL=any day
    hour INT NOT NULL,  -- 0-23
    minute_bucket INT DEFAULT 0,  -- 0, 15, 30, 45
    occurrence_count INT DEFAULT 1,
    last_occurred TIMESTAMPTZ DEFAULT NOW(),
    confidence FLOAT DEFAULT 0.0,  -- 0.0 to 1.0
    suppressed BOOLEAN DEFAULT FALSE,  -- User said "stop asking"
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(connection_id, entity_id, service, day_of_week, hour)
);

-- =============================================
-- 3. PANIC MODE CONFIGURATION
-- =============================================

CREATE TABLE IF NOT EXISTS panic_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE UNIQUE,
    enabled BOOLEAN DEFAULT TRUE,
    country_code TEXT DEFAULT 'NL',  -- For emergency numbers
    emergency_contacts JSONB DEFAULT '[]'::jsonb,  -- [{name, phone, notify_sms, notify_push}]
    door_locks JSONB DEFAULT '[]'::jsonb,  -- [entity_ids]
    light_entities JSONB DEFAULT '[]'::jsonb,  -- Lights to turn on
    alarm_entity TEXT,  -- Siren entity
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- 4. USER PREFERENCES (Morning Briefing)
-- =============================================

-- Add columns to existing user preferences or create if not exists
DO $$
BEGIN
    -- Check if user_preferences table exists
    IF NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'user_preferences') THEN
        CREATE TABLE user_preferences (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE UNIQUE,
            briefing_enabled BOOLEAN DEFAULT TRUE,
            briefing_time TIME DEFAULT '07:00',
            briefing_include_weather BOOLEAN DEFAULT TRUE,
            briefing_include_energy BOOLEAN DEFAULT TRUE,
            briefing_include_calendar BOOLEAN DEFAULT FALSE,
            briefing_speak_aloud BOOLEAN DEFAULT TRUE,
            timezone TEXT DEFAULT 'Europe/Amsterdam',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
    ELSE
        -- Add columns if they don't exist
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS briefing_enabled BOOLEAN DEFAULT TRUE;
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS briefing_time TIME DEFAULT '07:00';
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS briefing_include_weather BOOLEAN DEFAULT TRUE;
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS briefing_include_energy BOOLEAN DEFAULT TRUE;
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS briefing_include_calendar BOOLEAN DEFAULT FALSE;
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS briefing_speak_aloud BOOLEAN DEFAULT TRUE;
        ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/Amsterdam';
    END IF;
END $$;

-- =============================================
-- INDEXES
-- =============================================

CREATE INDEX IF NOT EXISTS idx_anomaly_baselines_connection ON anomaly_baselines(connection_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_connection ON anomaly_events(connection_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_events_created ON anomaly_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_patterns_connection ON behavior_patterns(connection_id);
CREATE INDEX IF NOT EXISTS idx_behavior_patterns_time ON behavior_patterns(hour, day_of_week);

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================

ALTER TABLE anomaly_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomaly_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE behavior_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE panic_config ENABLE ROW LEVEL SECURITY;
