
-- Create the scheduled_actions table
create table if not exists scheduled_actions (
  id uuid default gen_random_uuid() primary key,
  connection_id uuid references ha_connections(id) on delete cascade not null,
  title text not null,
  actions jsonb not null, -- Array of AIAction
  scheduled_for timestamptz not null,
  status text default 'pending' check (status in ('pending', 'executed', 'failed')),
  created_at timestamptz default now(),
  executed_at timestamptz,
  error text
);

-- Index for fast lookup of due tasks
create index if not exists idx_scheduled_actions_pending 
on scheduled_actions(scheduled_for) 
where status = 'pending';

-- Enable Row Level Security (RLS)
alter table scheduled_actions enable row level security;

-- Policy: Users can see their own scheduled actions via connection_id ownership
-- (Assuming ha_connections is linked to auth.users, or using service role for workers)
create policy "Service Role has full access"
on scheduled_actions
for all
to service_role
using (true)
with check (true);
