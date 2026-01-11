-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to mcp_tools
-- text-embedding-3-small uses 1536 dimensions
ALTER TABLE mcp_tools ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Index for semantic search
CREATE INDEX IF NOT EXISTS idx_mcp_tools_embedding ON mcp_tools USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
