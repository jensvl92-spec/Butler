-- Migration: 20261107_proactive_correlations.sql
-- Enables true proactive habit learning through multi-variable context correlation mining

-- 1. Context Snapshots: logs user interactions and state changes with full environmental context
CREATE TABLE IF NOT EXISTS context_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID REFERENCES ha_connections(id) ON DELETE CASCADE,
    entity_id TEXT NOT NULL,
    service TEXT,
    service_data JSONB DEFAULT '{}'::jsonb,
    outdoor_temp FLOAT,
    outdoor_weather TEXT,
    presence_state TEXT,
    user_destination TEXT,
    hour_of_day INT NOT NULL,
    day_of_week INT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for temporal and connection lookups
CREATE INDEX IF NOT EXISTS idx_context_snapshots_conn_entity ON context_snapshots(connection_id, entity_id);
CREATE INDEX IF NOT EXISTS idx_context_snapshots_created ON context_snapshots(created_at DESC);

-- 2. Behavior Correlations: stores mined association rules (Condition -> Action)
CREATE TABLE IF NOT EXISTS behavior_correlations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    trigger_entity_id TEXT NOT NULL,
    trigger_state TEXT NOT NULL,
    conditions JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"outdoor_temp_lte": 14, "weather": "rainy"}
    action_entity_id TEXT NOT NULL,
    action_service TEXT NOT NULL,
    action_data JSONB NOT NULL DEFAULT '{}'::jsonb, -- e.g. {"temperature": 21}
    occurrence_count INT DEFAULT 1,
    confidence FLOAT DEFAULT 0.5,
    auto_executable BOOLEAN DEFAULT FALSE,
    suppressed BOOLEAN DEFAULT FALSE,
    last_triggered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(connection_id, trigger_entity_id, trigger_state, action_entity_id, action_service)
);

CREATE INDEX IF NOT EXISTS idx_correlations_lookup ON behavior_correlations(connection_id, trigger_entity_id, trigger_state);
CREATE INDEX IF NOT EXISTS idx_correlations_confidence ON behavior_correlations(confidence DESC);

-- Enable RLS
ALTER TABLE context_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE behavior_correlations ENABLE ROW LEVEL SECURITY;

-- Policies for context_snapshots
CREATE POLICY "Allow service_role full access to context_snapshots"
    ON context_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow authenticated read on context_snapshots"
    ON context_snapshots FOR SELECT TO authenticated
    USING (connection_id IN (SELECT id FROM ha_connections WHERE user_id = auth.uid()));

-- Policies for behavior_correlations
CREATE POLICY "Allow service_role full access to behavior_correlations"
    ON behavior_correlations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Allow authenticated read and update on behavior_correlations"
    ON behavior_correlations FOR ALL TO authenticated
    USING (connection_id IN (SELECT id FROM ha_connections WHERE user_id = auth.uid()))
    WITH CHECK (connection_id IN (SELECT id FROM ha_connections WHERE user_id = auth.uid()));
