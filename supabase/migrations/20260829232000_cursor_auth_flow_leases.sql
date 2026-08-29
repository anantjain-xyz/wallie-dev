-- Bind completion to the worker that owns the renewable auth-flow lease. A
-- stale worker cannot publish credentials after another worker reclaims a flow.

drop function public.complete_cursor_auth_flow(uuid, text, timestamptz, timestamptz, text);

create function public.complete_cursor_auth_flow(
  p_flow_id uuid,
  p_claimed_by text,
  p_encrypted_api_key text,
  p_api_key_expires_at timestamptz,
  p_completed_at timestamptz,
  p_account_email text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_user_id uuid;
begin
  update public.cursor_auth_flows
  set
    completed_at = p_completed_at,
    status = 'authenticated'
  where id = p_flow_id
    and claimed_by = p_claimed_by
    and status in ('processing', 'prompted')
    and expires_at > p_completed_at
  returning user_id into target_user_id;

  if target_user_id is null then
    return false;
  end if;

  insert into public.user_cursor_credentials (
    user_id,
    credential_generation,
    encrypted_api_key,
    account_email,
    api_key_expires_at,
    reconnect_required,
    reconnect_reason,
    updated_at
  ) values (
    target_user_id,
    gen_random_uuid(),
    p_encrypted_api_key,
    p_account_email,
    p_api_key_expires_at,
    false,
    null,
    p_completed_at
  )
  on conflict (user_id) do update set
    credential_generation = excluded.credential_generation,
    encrypted_api_key = excluded.encrypted_api_key,
    account_email = excluded.account_email,
    api_key_expires_at = excluded.api_key_expires_at,
    reconnect_required = false,
    reconnect_reason = null,
    updated_at = excluded.updated_at;

  return true;
end;
$$;

revoke all on function public.complete_cursor_auth_flow(uuid, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.complete_cursor_auth_flow(uuid, text, text, timestamptz, timestamptz, text)
  to service_role;
