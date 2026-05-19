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
  where user_id = target_user_id
    and credential_type = 'chatgpt_auth_json'
    and auth_reconnect_required = false
    and (
      auth_lock_run_id is null
      or auth_lock_run_id = target_run_id
      or auth_lock_expires_at is null
      or auth_lock_expires_at <= now()
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
    credential_version = credential_version + 1,
    encrypted_credential = new_encrypted_credential,
    updated_at = now()
  where user_id = target_user_id
    and credential_type = 'chatgpt_auth_json'
    and auth_lock_run_id = target_run_id
    and credential_version = previous_credential_version
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
  where user_id = target_user_id
    and auth_lock_run_id = target_run_id;
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
  where user_id = target_user_id
    and credential_type = 'chatgpt_auth_json'
    and (auth_lock_run_id = target_run_id or auth_lock_run_id is null);
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
