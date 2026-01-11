-- Chat History Table
-- Persists user <-> AI interactions for the "Last 50 Chats" feature.
-- Read by AppContext.tsx

CREATE TABLE IF NOT EXISTS chat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  user_message TEXT NOT NULL,
  ai_response JSONB, -- Stores full response object or text
  actions_taken JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}', -- Stores language, etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast retrieval by connection
CREATE INDEX IF NOT EXISTS idx_chat_history_connection ON chat_history(connection_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_created_at ON chat_history(created_at);

-- Disable RLS for now (as requested for other tables) to ensure easy access
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable read access for all users" ON chat_history
    FOR SELECT
    USING (true);

CREATE POLICY "Enable insert access for all users" ON chat_history
    FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Enable update access for all users" ON chat_history
    FOR UPDATE
    USING (true);

CREATE POLICY "Enable delete access for all users" ON chat_history
    FOR DELETE
    USING (true);
