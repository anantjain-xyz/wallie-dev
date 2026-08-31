create table public.user_opencode_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_api_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_opencode_credentials_touch_updated_at
before update on public.user_opencode_credentials
for each row
execute function internal.touch_updated_at();

alter table public.user_opencode_credentials enable row level security;

revoke all on public.user_opencode_credentials from public, anon, authenticated;
grant all on public.user_opencode_credentials to service_role;
grant select, delete on public.user_opencode_credentials to authenticated;

create policy user_opencode_credentials_select_self
  on public.user_opencode_credentials
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy user_opencode_credentials_delete_self
  on public.user_opencode_credentials
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

alter table public.workspace_agent_config
  drop constraint if exists workspace_agent_config_value_json_known_keys;

alter table public.workspace_agent_config
  add constraint workspace_agent_config_value_json_known_keys check (
    case key
      when 'concurrency_limit' then
        jsonb_typeof(value_json) = 'number'
        and (value_json::text)::numeric = floor((value_json::text)::numeric)
        and (value_json::text)::numeric between 1 and 20
      when 'stall_timeout_ms' then
        jsonb_typeof(value_json) = 'number'
        and (value_json::text)::numeric = floor((value_json::text)::numeric)
        and (value_json::text)::numeric between 30000 and 1800000
      when 'max_retries' then
        jsonb_typeof(value_json) = 'number'
        and (value_json::text)::numeric = floor((value_json::text)::numeric)
        and (value_json::text)::numeric between 0 and 10
      when 'agent_provider' then
        jsonb_typeof(value_json) = 'string'
        and value_json #>> '{}' in ('codex', 'claude-code', 'cursor', 'opencode')
      when 'agent_model' then
        jsonb_typeof(value_json) = 'string'
        and length(value_json #>> '{}') between 1 and 100
        and (
          value_json #>> '{}' ~ '^[a-z0-9][a-z0-9._-]{0,98}[a-z0-9](\[1m\])?$|^[a-z0-9]$'
          or value_json #>> '{}' ~ '^opencode/[a-z0-9]([a-z0-9._-]{0,89}[a-z0-9])?$'
        )
      else true
    end
  );
