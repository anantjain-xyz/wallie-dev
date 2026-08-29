-- Cursor user credentials are minted through Cursor.auth.login() by the
-- long-running Wallie worker. The browser-facing app only sees flow state;
-- API keys remain encrypted and service-role-only on every write path.

create table public.user_cursor_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_api_key text not null,
  account_email text,
  api_key_expires_at timestamptz not null,
  reconnect_required boolean not null default false,
  reconnect_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.cursor_auth_flows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  status text not null default 'starting',
  login_url text,
  error_message text,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cursor_auth_flows_status_check
    check (status in ('starting', 'processing', 'prompted', 'authenticated', 'canceled', 'expired', 'error'))
);

create unique index cursor_auth_flows_one_active_per_user_idx
  on public.cursor_auth_flows (user_id)
  where status in ('starting', 'processing', 'prompted');

create index cursor_auth_flows_pending_idx
  on public.cursor_auth_flows (created_at)
  where status = 'starting';

create trigger user_cursor_credentials_touch_updated_at
before update on public.user_cursor_credentials
for each row execute function internal.touch_updated_at();

create trigger cursor_auth_flows_touch_updated_at
before update on public.cursor_auth_flows
for each row execute function internal.touch_updated_at();

alter table public.user_cursor_credentials enable row level security;
alter table public.cursor_auth_flows enable row level security;

revoke all on public.user_cursor_credentials from anon, authenticated;
revoke all on public.cursor_auth_flows from anon, authenticated;

grant select, delete on public.user_cursor_credentials to authenticated;

create policy user_cursor_credentials_select_self
  on public.user_cursor_credentials
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy user_cursor_credentials_delete_self
  on public.user_cursor_credentials
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

alter table public.workspace_agent_config
  drop constraint workspace_agent_config_value_json_known_keys;

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
        and value_json #>> '{}' in ('codex', 'claude-code', 'cursor')
      when 'agent_model' then
        jsonb_typeof(value_json) = 'string'
        and length(value_json #>> '{}') between 1 and 100
        and value_json #>> '{}' ~ '^[a-z0-9][a-z0-9._-]{0,98}[a-z0-9](\[1m\])?$|^[a-z0-9]$'
      else true
    end
  );
