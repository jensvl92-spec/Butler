-- Create automations table to store synced HA Scripts
create table if not exists automations (
  id uuid default gen_random_uuid() primary key,
  connection_id uuid references ha_connections(id) on delete cascade not null,
  entity_id text not null, -- e.g. script.good_morning
  alias text not null,     -- e.g. "Good Morning Routine"
  description text,        -- e.g. "Triggered manually"
  last_synced_at timestamptz default now(),
  
  -- Use compound unique constraint to perform upserts easily
  unique(connection_id, entity_id)
);

-- Enable RLS
alter table automations enable row level security;

-- Policies
create policy "Service Role has full access"
  on automations
  for all
  to service_role
  using (true)
  with check (true);

create policy "Users can view own automations"
  on automations
  for select
  to authenticated
  using (
    exists (
      select 1 from ha_connections
      where ha_connections.id = automations.connection_id
      and ha_connections.user_id = auth.uid()
    )
  );

create policy "Users can update own automations"
  on automations
  for update
  to authenticated
  using (
    exists (
      select 1 from ha_connections
      where ha_connections.id = automations.connection_id
      and ha_connections.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from ha_connections
      where ha_connections.id = automations.connection_id
      and ha_connections.user_id = auth.uid()
    )
  );

create policy "Users can delete own automations"
  on automations
  for delete
  to authenticated
  using (
    exists (
      select 1 from ha_connections
      where ha_connections.id = automations.connection_id
      and ha_connections.user_id = auth.uid()
    )
  );
