-- Create a table for AI proactively generated suggestions
create table public.suggestions (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  title text not null,
  description text,
  actions jsonb not null, -- Stores the action payload { type, entity_id, service, data }
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'expired')),
  connection_id uuid references public.ha_connections(id) on delete cascade -- Optional: link to specific HA connection
);

-- Enable RLS
alter table public.suggestions enable row level security;

-- Policies (Adjust based on your auth model, assuming anon/authenticated access for now)
create policy "Allow public read access to suggestions"
on public.suggestions for select
to public
using (true);

create policy "Allow public update access to suggestions"
on public.suggestions for update
to public
using (true);

create policy "Allow public insert access to suggestions"
on public.suggestions for insert
to public
with check (true);

-- Enable Realtime for this table so the frontend gets instant updates
alter publication supabase_realtime add table public.suggestions;
