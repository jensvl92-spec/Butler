create table if not exists public.user_tokens (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  provider text not null, -- 'spotify', 'google', etc.
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, provider)
);

-- Enable RLS
alter table public.user_tokens enable row level security;

-- Policies
create policy "Users can view their own tokens"
  on public.user_tokens for select
  using (auth.uid() = user_id);

create policy "Users can insert their own tokens"
  on public.user_tokens for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own tokens"
  on public.user_tokens for update
  using (auth.uid() = user_id);

create policy "Users can delete their own tokens"
  on public.user_tokens for delete
  using (auth.uid() = user_id);
