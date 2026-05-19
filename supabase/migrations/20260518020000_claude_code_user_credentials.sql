create table public.user_claude_code_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_api_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_claude_code_credentials_touch_updated_at
before update on public.user_claude_code_credentials
for each row
execute function internal.touch_updated_at();

alter table public.user_claude_code_credentials enable row level security;

revoke all on public.user_claude_code_credentials from anon, authenticated;
grant all on public.user_claude_code_credentials to service_role;
grant select, delete on public.user_claude_code_credentials to authenticated;

create policy user_claude_code_credentials_select_self
  on public.user_claude_code_credentials
  for select
  to authenticated
  using (user_id = auth.uid());

create policy user_claude_code_credentials_delete_self
  on public.user_claude_code_credentials
  for delete
  to authenticated
  using (user_id = auth.uid());
