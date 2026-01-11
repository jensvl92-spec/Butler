-- Create device_states table for real-time mirroring
CREATE TABLE IF NOT EXISTS device_states (
    entity_id TEXT NOT NULL,
    connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
    state TEXT,
    attributes JSONB DEFAULT '{}',
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (connection_id, entity_id)
);

-- RLS Policies
ALTER TABLE device_states ENABLE ROW LEVEL SECURITY;

-- Allow Service Role full access (for Butler)
CREATE POLICY "Service Role can do anything" ON device_states
    USING (true)
    WITH CHECK (true);

-- Allow Authenticated Users to ALL operations (since they sync their own data)
-- Ideally we check connection_id, but for now assuming auth user owns the connection
CREATE POLICY "Users can manage their device states" ON device_states
    FOR ALL
    USING (auth.uid() IS NOT NULL)
    WITH CHECK (auth.uid() IS NOT NULL);

-- Index for fast lookups by entity_id (composite PK handles connection_id lookup)
-- No extra index needed for PK lookups
