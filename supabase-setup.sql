create table if not exists public.call_time_workspace (
  user_id uuid primary key references auth.users (id) on delete cascade,
  payload jsonb not null default '{"data":{"calls":[],"attendance":[],"meetings":[],"clients":[],"staff":[]},"tombstones":[]}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.call_time_workspace enable row level security;

revoke all on public.call_time_workspace from anon;
grant select, insert, update on public.call_time_workspace to authenticated;

drop policy if exists "Users can read their own Call & Time data" on public.call_time_workspace;
create policy "Users can read their own Call & Time data"
  on public.call_time_workspace for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own Call & Time data" on public.call_time_workspace;
create policy "Users can insert their own Call & Time data"
  on public.call_time_workspace for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own Call & Time data" on public.call_time_workspace;
create policy "Users can update their own Call & Time data"
  on public.call_time_workspace for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
