-- Add accumulation columns to mcp_raw_sync for batch sync support

ALTER TABLE mcp_raw_sync 
ADD COLUMN IF NOT EXISTS accumulated_devices JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS accumulated_tools JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN mcp_raw_sync.accumulated_devices IS 'Accumulated device objects across batches for merging';
COMMENT ON COLUMN mcp_raw_sync.accumulated_tools IS 'Accumulated tool objects across batches for merging';
