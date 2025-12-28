-- Enable the pgvector extension to work with embedding vectors
create extension if not exists vector;

-- Create a table to store your memories
create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding vector(1536), -- Dimension for text-embedding-3-small
  type text default 'general', -- 'feedback', 'fact', 'rule'
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

-- Create a function to search for memories
create or replace function match_memories (
  query_embedding vector(1536),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  content text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    memories.id,
    memories.content,
    1 - (memories.embedding <=> query_embedding) as similarity
  from memories
  where 1 - (memories.embedding <=> query_embedding) > match_threshold
  order by memories.embedding <=> query_embedding
  limit match_count;
end;
$$;
