-- Create a table to track device state changes for forensic analysis (Planner Agent)
CREATE TABLE IF NOT EXISTS device_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL,
    attributes JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by entity and time
CREATE INDEX IF NOT EXISTS idx_device_history_entity_time ON device_history (entity_id, created_at DESC);

-- Policy (Open for now, matching other tables)
ALTER TABLE device_history ENABLE ROW LEVEL SECURITY;

drop policy if exists "Enable read/write for service role" on device_history;
CREATE POLICY "Enable read/write for service role" ON device_history
    USING (true)
    WITH CHECK (true);
