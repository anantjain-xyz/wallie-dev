-- Authorize the current member and read ciphertext in one SQL statement.
-- These worker-only functions are invokers; no RLS bypass is introduced.

CREATE OR REPLACE FUNCTION public.load_session_claude_code_credential(p_creator_member_id uuid, p_workspace_id uuid)
 RETURNS SETOF public.user_claude_code_credentials
 LANGUAGE sql
 SECURITY INVOKER
 STABLE
 SET search_path TO ''
AS $function$
  select credential.*
  from public.workspace_members member
  join public.user_claude_code_credentials credential on credential.user_id = member.user_id
  where member.id = p_creator_member_id
    and member.workspace_id = p_workspace_id
    and member.is_active
    and member.kind = 'human';
$function$
;

CREATE OR REPLACE FUNCTION public.load_session_codex_credential(p_creator_member_id uuid, p_workspace_id uuid, p_expected_user_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF public.user_codex_credentials
 LANGUAGE sql
 SECURITY INVOKER
 STABLE
 SET search_path TO ''
AS $function$
  select credential.*
  from public.workspace_members member
  join public.user_codex_credentials credential on credential.user_id = member.user_id
  where member.id = p_creator_member_id
    and member.workspace_id = p_workspace_id
    and member.is_active
    and member.kind = 'human'
    and (p_expected_user_id is null or member.user_id = p_expected_user_id);
$function$
;

CREATE OR REPLACE FUNCTION public.load_session_cursor_credential(p_creator_member_id uuid, p_workspace_id uuid)
 RETURNS SETOF public.user_cursor_credentials
 LANGUAGE sql
 SECURITY INVOKER
 STABLE
 SET search_path TO ''
AS $function$
  select credential.*
  from public.workspace_members member
  join public.user_cursor_credentials credential on credential.user_id = member.user_id
  where member.id = p_creator_member_id
    and member.workspace_id = p_workspace_id
    and member.is_active
    and member.kind = 'human';
$function$
;

CREATE OR REPLACE FUNCTION public.load_session_opencode_credentials(p_creator_member_id uuid, p_workspace_id uuid, p_provider_id text)
 RETURNS TABLE(user_id uuid, encrypted_api_key text, zen_encrypted_api_key text)
 LANGUAGE sql
 SECURITY INVOKER
 STABLE
 SET search_path TO ''
AS $function$
  select member.user_id,
    case when p_provider_id = 'opencode' then zen.encrypted_api_key
      else provider.encrypted_api_key end,
    zen.encrypted_api_key
  from public.workspace_members member
  left join public.user_opencode_credentials zen on zen.user_id = member.user_id
  left join public.user_opencode_provider_credentials provider
    on provider.user_id = member.user_id and provider.provider_id = p_provider_id
  where member.id = p_creator_member_id
    and member.workspace_id = p_workspace_id
    and member.is_active
    and member.kind = 'human'
    and case when p_provider_id = 'opencode' then zen.encrypted_api_key is not null
      else provider.encrypted_api_key is not null end;
$function$
;


revoke all on function public.load_session_codex_credential(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.load_session_claude_code_credential(uuid, uuid) from public, anon, authenticated;
revoke all on function public.load_session_cursor_credential(uuid, uuid) from public, anon, authenticated;
revoke all on function public.load_session_opencode_credentials(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.load_session_codex_credential(uuid, uuid, uuid) to service_role;
grant execute on function public.load_session_claude_code_credential(uuid, uuid) to service_role;
grant execute on function public.load_session_cursor_credential(uuid, uuid) to service_role;
grant execute on function public.load_session_opencode_credentials(uuid, uuid, text) to service_role;
