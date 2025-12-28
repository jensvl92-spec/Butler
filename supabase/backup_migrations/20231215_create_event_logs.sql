-- Create table for logging raw events for pattern analysis
create table public.event_logs (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  event_type text not null,
  entity_id text,
  state text,
  attributes jsonb,
  connection_id uuid references public.ha_connections(id) on delete set null
);

-- Enable RLS
alter table public.event_logs enable row level security;

-- Policies (Adjust based on auth)
create policy "Allow public insert to event_logs"
on public.event_logs for insert
to public
with check (true);

create policy "Allow public select from event_logs"
on public.event_logs for select
to public
using (true);

-- Create index for faster analysis querying
create index event_logs_created_at_idx on public.event_logs(created_at);
create index event_logs_entity_id_idx on public.event_logs(entity_id);
