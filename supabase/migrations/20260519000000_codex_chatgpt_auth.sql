alter table public.user_codex_credentials
  add column credential_version integer not null default 1,
  add column auth_cache_last_refresh timestamptz,
  add column auth_lock_run_id uuid,
  add column auth_lock_expires_at timestamptz,
  add column auth_reconnect_required boolean not null default false,
  add column auth_reconnect_reason text,
  add constraint user_codex_credentials_credential_version_positive
    check (credential_version > 0);

alter table public.user_codex_credentials
  drop constraint user_codex_credentials_credential_type_check,
  add constraint user_codex_credentials_credential_type_check
    check (credential_type in ('chatgpt_auth_json', 'codex_access_token', 'platform_api_key'));

create index user_codex_credentials_auth_lock_idx
  on public.user_codex_credentials (auth_lock_expires_at)
  where credential_type = 'chatgpt_auth_json' and auth_lock_run_id is not null;

create table public.codex_device_auth_flows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'starting',
  sandbox_id text not null,
  command_id text not null,
  verification_uri text,
  user_code text,
  instructions text,
  error text,
  encrypted_auth_json text,
  account_id text,
  account_email text,
  auth_cache_last_refresh timestamptz,
  output_tail text,
  expires_at timestamptz not null,
  completed_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint codex_device_auth_flows_status_check
    check (status in ('starting', 'prompted', 'authenticated', 'canceled', 'error', 'expired')),
  constraint codex_device_auth_flows_auth_json_status_check
    check (encrypted_auth_json is null or status = 'authenticated')
);

create index codex_device_auth_flows_user_active_idx
  on public.codex_device_auth_flows (user_id, expires_at)
  where status in ('starting', 'prompted', 'authenticated');

create trigger codex_device_auth_flows_touch_updated_at
before update on public.codex_device_auth_flows
for each row
execute function internal.touch_updated_at();

alter table public.codex_device_auth_flows enable row level security;
revoke all on public.codex_device_auth_flows from anon, authenticated;
grant all on public.codex_device_auth_flows to service_role;

create or replace function public.acquire_codex_auth_lease(
  target_user_id uuid,
  target_run_id uuid,
  lease_expires_at timestamptz
)
returns table (
  credential_type text,
  encrypted_credential text,
  access_token_expires_at timestamptz,
  credential_version integer,
  auth_cache_last_refresh timestamptz,
  auth_reconnect_required boolean,
  auth_reconnect_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.user_codex_credentials
  set
    auth_lock_run_id = target_run_id,
    auth_lock_expires_at = lease_expires_at,
    updated_at = now()
  where public.user_codex_credentials.user_id = target_user_id
    and public.user_codex_credentials.credential_type = 'chatgpt_auth_json'
    and public.user_codex_credentials.auth_reconnect_required = false
    and (
      public.user_codex_credentials.auth_lock_run_id is null
      or public.user_codex_credentials.auth_lock_run_id = target_run_id
      or public.user_codex_credentials.auth_lock_expires_at is null
      or public.user_codex_credentials.auth_lock_expires_at <= now()
    )
  returning
    public.user_codex_credentials.credential_type,
    public.user_codex_credentials.encrypted_credential,
    public.user_codex_credentials.access_token_expires_at,
    public.user_codex_credentials.credential_version,
    public.user_codex_credentials.auth_cache_last_refresh,
    public.user_codex_credentials.auth_reconnect_required,
    public.user_codex_credentials.auth_reconnect_reason;
end;
$$;

create or replace function public.persist_codex_auth_json(
  target_user_id uuid,
  target_run_id uuid,
  previous_credential_version integer,
  new_encrypted_credential text,
  new_auth_cache_last_refresh timestamptz,
  new_account_id text,
  new_account_email text
)
returns table (
  credential_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.user_codex_credentials
  set
    account_email = new_account_email,
    account_id = new_account_id,
    auth_cache_last_refresh = new_auth_cache_last_refresh,
    auth_reconnect_reason = null,
    auth_reconnect_required = false,
    credential_version = public.user_codex_credentials.credential_version + 1,
    encrypted_credential = new_encrypted_credential,
    updated_at = now()
  where public.user_codex_credentials.user_id = target_user_id
    and public.user_codex_credentials.credential_type = 'chatgpt_auth_json'
    and public.user_codex_credentials.auth_lock_run_id = target_run_id
    and public.user_codex_credentials.credential_version = previous_credential_version
  returning public.user_codex_credentials.credential_version;
end;
$$;

create or replace function public.release_codex_auth_lease(
  target_user_id uuid,
  target_run_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.user_codex_credentials
  set
    auth_lock_run_id = null,
    auth_lock_expires_at = null,
    updated_at = now()
  where public.user_codex_credentials.user_id = target_user_id
    and public.user_codex_credentials.auth_lock_run_id = target_run_id;
end;
$$;

create or replace function public.mark_codex_auth_reconnect_required(
  target_user_id uuid,
  target_run_id uuid,
  reconnect_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.user_codex_credentials
  set
    auth_reconnect_reason = left(reconnect_reason, 500),
    auth_reconnect_required = true,
    auth_lock_run_id = null,
    auth_lock_expires_at = null,
    updated_at = now()
  where public.user_codex_credentials.user_id = target_user_id
    and public.user_codex_credentials.credential_type = 'chatgpt_auth_json'
    and public.user_codex_credentials.auth_lock_run_id = target_run_id;
end;
$$;

revoke all on function public.acquire_codex_auth_lease(uuid, uuid, timestamptz) from public;
revoke all on function public.persist_codex_auth_json(uuid, uuid, integer, text, timestamptz, text, text) from public;
revoke all on function public.release_codex_auth_lease(uuid, uuid) from public;
revoke all on function public.mark_codex_auth_reconnect_required(uuid, uuid, text) from public;

grant execute on function public.acquire_codex_auth_lease(uuid, uuid, timestamptz) to service_role;
grant execute on function public.persist_codex_auth_json(uuid, uuid, integer, text, timestamptz, text, text) to service_role;
grant execute on function public.release_codex_auth_lease(uuid, uuid) to service_role;
grant execute on function public.mark_codex_auth_reconnect_required(uuid, uuid, text) to service_role;
