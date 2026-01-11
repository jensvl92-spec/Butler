-- Short-Term Memory: Temporary context storage (24h default expiration)
-- Used for: Recipe Mode, Shopping Lists, Ongoing Conversations, etc.

CREATE TABLE IF NOT EXISTS short_term_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
    context_type TEXT NOT NULL,  -- 'recipe', 'shopping_list', 'conversation', 'timer', etc.
    context_key TEXT,            -- Optional key for lookups (e.g., recipe name)
    data JSONB NOT NULL,         -- Flexible data storage
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_short_term_memory_connection ON short_term_memory(connection_id);
CREATE INDEX IF NOT EXISTS idx_short_term_memory_type ON short_term_memory(connection_id, context_type);
CREATE INDEX IF NOT EXISTS idx_short_term_memory_expires ON short_term_memory(expires_at);

-- Enable RLS
ALTER TABLE short_term_memory ENABLE ROW LEVEL SECURITY;

-- Cleanup function (run via cron)
CREATE OR REPLACE FUNCTION cleanup_expired_short_term_memory()
RETURNS void AS $$
BEGIN
    DELETE FROM short_term_memory WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Schedule cleanup every hour (if pg_cron available)
-- SELECT cron.schedule('cleanup-short-term-memory', '0 * * * *', 'SELECT cleanup_expired_short_term_memory();');
