-- Add TOON catalog columns to mcp_raw_sync
-- These store pre-computed TOON formatted catalogs for fast Router access

ALTER TABLE mcp_raw_sync 
ADD COLUMN IF NOT EXISTS toon_devices TEXT,
ADD COLUMN IF NOT EXISTS toon_tools TEXT,
ADD COLUMN IF NOT EXISTS toon_agents TEXT;

-- Add comment for documentation
COMMENT ON COLUMN mcp_raw_sync.toon_devices IS 'TOON formatted device catalog for Router LLM';
COMMENT ON COLUMN mcp_raw_sync.toon_tools IS 'TOON formatted tools catalog for Router LLM';
COMMENT ON COLUMN mcp_raw_sync.toon_agents IS 'TOON formatted agents catalog for Router LLM';
