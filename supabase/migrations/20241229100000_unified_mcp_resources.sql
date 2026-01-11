-- Unified MCP Resources Table
-- Combines tools, devices, rooms, and agents in one searchable table
-- Created: 2024-12-29

-- Enable vector extension if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Create unified mcp_resources table
CREATE TABLE IF NOT EXISTS mcp_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID,                    -- NULL for global/shared resources
  resource_type TEXT NOT NULL,           -- 'tool', 'device', 'room', 'agent'
  name TEXT NOT NULL,                    -- 'light.turn_on', 'light.kitchen_1', 'Kitchen'
  display_name TEXT,                     -- Human-readable name
  domain TEXT,                           -- 'light', 'switch', 'climate', etc.
  room TEXT,                             -- Room name for devices
  description TEXT,                      -- Searchable description
  state TEXT,                            -- Current state for devices
  metadata JSONB DEFAULT '{}',           -- Parameters for tools, attributes for devices
  embedding VECTOR(1536),                -- OpenAI text-embedding-3-small dimension
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, resource_type, name)
);

-- Create vector similarity index for fast semantic search
CREATE INDEX IF NOT EXISTS idx_mcp_resources_embedding 
  ON mcp_resources USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Create indexes for common filters
CREATE INDEX IF NOT EXISTS idx_mcp_resources_connection ON mcp_resources(connection_id);
CREATE INDEX IF NOT EXISTS idx_mcp_resources_type ON mcp_resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_mcp_resources_domain ON mcp_resources(domain);
CREATE INDEX IF NOT EXISTS idx_mcp_resources_room ON mcp_resources(room);

-- Unified semantic search function
CREATE OR REPLACE FUNCTION match_mcp_resources(
  query_embedding VECTOR(1536),
  filter_connection_id UUID DEFAULT NULL,
  filter_types TEXT[] DEFAULT ARRAY['tool', 'device', 'room', 'agent'],
  match_threshold FLOAT DEFAULT 0.25,
  match_count INT DEFAULT 30
) RETURNS TABLE(
  id UUID,
  resource_type TEXT,
  name TEXT,
  display_name TEXT,
  domain TEXT,
  room TEXT,
  description TEXT,
  state TEXT,
  metadata JSONB,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    r.id,
    r.resource_type,
    r.name,
    r.display_name,
    r.domain,
    r.room,
    r.description,
    r.state,
    r.metadata,
    1 - (r.embedding <=> query_embedding) AS similarity
  FROM mcp_resources r
  WHERE 
    -- Connection filter: NULL matches global, or specific connection
    (filter_connection_id IS NULL OR r.connection_id IS NULL OR r.connection_id = filter_connection_id)
    -- Type filter
    AND r.resource_type = ANY(filter_types)
    -- Embedding must exist
    AND r.embedding IS NOT NULL
    -- Similarity threshold
    AND 1 - (r.embedding <=> query_embedding) > match_threshold
  ORDER BY r.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Migrate existing tools from mcp_tools to mcp_resources
INSERT INTO mcp_resources (connection_id, resource_type, name, display_name, domain, description, metadata, embedding)
SELECT 
  connection_id,
  'tool' AS resource_type,
  name,
  name AS display_name,
  split_part(name, '.', 1) AS domain,
  COALESCE(description, '') || ' ' || COALESCE(when_to_use, '') AS description,
  jsonb_build_object(
    'parameters', parameters,
    'returns', returns,
    'examples', examples,
    'category', category
  ) AS metadata,
  embedding
FROM mcp_tools
WHERE embedding IS NOT NULL
ON CONFLICT (connection_id, resource_type, name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  embedding = EXCLUDED.embedding,
  updated_at = NOW();

-- Migrate existing agents to mcp_resources
INSERT INTO mcp_resources (connection_id, resource_type, name, display_name, description, metadata)
SELECT 
  NULL AS connection_id,
  'agent' AS resource_type,
  name,
  name AS display_name,
  COALESCE(description, '') || ' ' || COALESCE(when_to_use, '') AS description,
  jsonb_build_object(
    'input', input,
    'output', output,
    'examples', examples,
    'tags', tags
  ) AS metadata
FROM agents
ON CONFLICT (connection_id, resource_type, name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

-- RLS policies
ALTER TABLE mcp_resources ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role has full access to mcp_resources"
  ON mcp_resources FOR ALL
  USING (auth.role() = 'service_role');

-- Allow anon to read global resources
CREATE POLICY "Anon can read global mcp_resources"
  ON mcp_resources FOR SELECT
  USING (connection_id IS NULL);

-- Grant execute on function
GRANT EXECUTE ON FUNCTION match_mcp_resources TO anon, authenticated, service_role;
