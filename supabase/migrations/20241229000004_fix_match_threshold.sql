-- Redefine the similarity search function to be sure it works
-- Uses cosine similarity (1 - cosine distance)

CREATE OR REPLACE FUNCTION match_mcp_tools (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
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
  ORDER BY mcp_tools.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
