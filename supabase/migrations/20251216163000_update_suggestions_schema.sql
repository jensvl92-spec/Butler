-- Create suggestions table if it doesn't exist (it might exist remotely but not locally)
create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null,
  actions jsonb default '[]'::jsonb,
  status text default 'pending', -- pending, accepted, rejected, executed, failed
  context_key text,
  confidence float,
  created_at timestamptz default now()
);

-- Enable RLS
alter table suggestions enable row level security;

create policy "Service Role has full access"
  on suggestions
  for all
  to service_role
  using (true)
  with check (true);

create policy "Authenticated users can view/update suggestions"
  on suggestions
  for all
  to authenticated
  using (true)
  with check (true);

-- Add scheduled_actions column if it doesn't exist
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name = 'suggestions' and column_name = 'scheduled_actions') then
    alter table suggestions add column scheduled_actions jsonb default '[]'::jsonb;
  end if;
end $$;
