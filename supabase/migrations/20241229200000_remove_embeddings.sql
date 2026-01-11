-- MCP LLM-Native Refactor: Remove Embeddings
-- Simplifies architecture by removing vector search in favor of LLM selection

-- Drop embedding-related objects
DROP FUNCTION IF EXISTS match_mcp_resources CASCADE;
DROP FUNCTION IF EXISTS match_mcp_tools CASCADE;
DROP INDEX IF EXISTS idx_mcp_resources_embedding;

-- Remove embedding column (keep rest of schema)
ALTER TABLE mcp_resources DROP COLUMN IF EXISTS embedding;
ALTER TABLE mcp_tools DROP COLUMN IF EXISTS embedding;
