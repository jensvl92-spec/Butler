
-- Redefine match_mcp_tools with connection_id filtering and SECURITY DEFINER
-- This ensures RLS is bypassed safely but data is scoped to the connection.

DROP FUNCTION IF EXISTS match_mcp_tools(vector(1536), float, int);

CREATE OR REPLACE FUNCTION match_mcp_tools (
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter_connection_id UUID
)
RETURNS TABLE (
  id UUID,
  name text,
  type text,
  category text,
  description text,
  when_to_use text,
  parameters jsonb,
  returns text,
  examples jsonb,
  similarity float
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    mcp_tools.id,
    mcp_tools.name,
    mcp_tools.type,
    mcp_tools.category,
    mcp_tools.description,
    mcp_tools.when_to_use,
    mcp_tools.parameters,
    mcp_tools.returns,
    mcp_tools.examples,
    1 - (mcp_tools.embedding <=> query_embedding) AS similarity
  FROM mcp_tools
  WHERE 1 - (mcp_tools.embedding <=> query_embedding) > match_threshold
  AND (
      mcp_tools.connection_id = filter_connection_id 
      OR mcp_tools.connection_id IS NULL -- Include global tools
  )
  ORDER BY mcp_tools.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
