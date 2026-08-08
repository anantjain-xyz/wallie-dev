drop function if exists public.acquire_codex_auth_lease(uuid, uuid, timestamptz);
drop function if exists public.release_codex_auth_lease(uuid, uuid);
drop function if exists public.persist_codex_auth_json(
  uuid,
  uuid,
  integer,
  text,
  timestamptz,
  text,
  text
);
drop function if exists public.mark_codex_auth_reconnect_required(uuid, uuid, text);

drop index if exists public.user_codex_credentials_auth_lock_idx;

alter table public.user_codex_credentials
  drop column auth_lock_run_id,
  drop column auth_lock_expires_at;

create or replace function internal.bump_codex_credential_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.credential_version := old.credential_version + 1;
  return new;
end;
$$;

create trigger user_codex_credentials_bump_version
before update on public.user_codex_credentials
for each row
execute function internal.bump_codex_credential_version();

create or replace function public.persist_codex_auth_json(
  target_user_id uuid,
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
    encrypted_credential = new_encrypted_credential,
    updated_at = now()
  where public.user_codex_credentials.user_id = target_user_id
    and public.user_codex_credentials.credential_type = 'chatgpt_auth_json'
    and public.user_codex_credentials.credential_version = previous_credential_version
  returning public.user_codex_credentials.credential_version;
end;
$$;

create or replace function public.mark_codex_auth_reconnect_required(
  target_user_id uuid,
  previous_credential_version integer,
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
    updated_at = now()
  where public.user_codex_credentials.user_id = target_user_id
    and public.user_codex_credentials.credential_type = 'chatgpt_auth_json'
    and public.user_codex_credentials.credential_version = previous_credential_version;
end;
$$;

revoke all on function internal.bump_codex_credential_version() from public, anon, authenticated;
revoke all on function public.persist_codex_auth_json(uuid, integer, text, timestamptz, text, text)
  from public, anon, authenticated;
revoke all on function public.mark_codex_auth_reconnect_required(uuid, integer, text)
  from public, anon, authenticated;

grant execute on function internal.bump_codex_credential_version() to service_role;
grant execute on function public.persist_codex_auth_json(uuid, integer, text, timestamptz, text, text)
  to service_role;
grant execute on function public.mark_codex_auth_reconnect_required(uuid, integer, text)
  to service_role;
