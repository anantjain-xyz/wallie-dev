alter table public.workspace_invitations
  add column full_name text;

alter table public.workspace_invitations
  add constraint workspace_invitations_full_name_check
  check (
    full_name is null
    or (
      full_name = btrim(full_name)
      and full_name <> ''
      and char_length(full_name) <= 100
    )
  );

-- Existing profile names are user-owned. Fill only missing workspace copies so
-- session and approver labels can use them immediately after this migration.
update public.workspace_members as member
set full_name = btrim(profile.full_name)
from public.profiles as profile
where member.user_id = profile.id
  and member.kind = 'human'
  and nullif(btrim(member.full_name), '') is null
  and nullif(btrim(profile.full_name), '') is not null;

-- Auth metadata may seed a missing profile name, but it must never overwrite a
-- name the user has edited inside Wallie.
create or replace function public.ensure_own_profile(
  actor_email text default null,
  actor_full_name text default null,
  actor_avatar_url text default null
)
returns public.profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  actor_user_id uuid := auth.uid();
  saved_profile public.profiles%rowtype;
begin
  if actor_user_id is null then
    raise exception 'Authenticated user required to ensure a profile'
      using errcode = '42501';
  end if;

  insert into public.profiles as profile (
    id,
    primary_email,
    full_name,
    avatar_url
  )
  values (
    actor_user_id,
    nullif(btrim(actor_email), ''),
    nullif(btrim(actor_full_name), ''),
    nullif(btrim(actor_avatar_url), '')
  )
  on conflict (id)
  do update
    set primary_email = coalesce(excluded.primary_email, profile.primary_email),
        full_name = coalesce(nullif(btrim(profile.full_name), ''), excluded.full_name),
        avatar_url = coalesce(excluded.avatar_url, profile.avatar_url)
  returning * into saved_profile;

  return saved_profile;
end;
$$;

revoke all on function public.ensure_own_profile(text, text, text)
  from public, anon, authenticated;
grant execute on function public.ensure_own_profile(text, text, text)
  to authenticated;

-- The API authenticates the caller, then invokes this function with the
-- service role. Keeping both writes in one transaction prevents profiles and
-- workspace member labels from drifting apart.
create or replace function public.update_user_display_name(
  actor_user_id uuid,
  actor_full_name text
)
returns public.profiles
language plpgsql
security invoker
set search_path = ''
as $$
declare
  normalized_full_name text := btrim(coalesce(actor_full_name, ''));
  saved_profile public.profiles%rowtype;
begin
  if actor_user_id is null then
    raise exception 'actor_user_id is required'
      using errcode = '22023';
  end if;

  if normalized_full_name = '' then
    raise exception 'actor_full_name is required'
      using errcode = '22023';
  end if;

  if char_length(normalized_full_name) > 100 then
    raise exception 'actor_full_name must be 100 characters or fewer'
      using errcode = '22023';
  end if;

  insert into public.profiles as profile (id, full_name)
  values (actor_user_id, normalized_full_name)
  on conflict (id)
  do update set full_name = excluded.full_name
  returning * into saved_profile;

  update public.workspace_members
  set full_name = normalized_full_name
  where user_id = actor_user_id
    and kind = 'human';

  return saved_profile;
end;
$$;

revoke all on function public.update_user_display_name(uuid, text)
  from public, anon, authenticated;
grant execute on function public.update_user_display_name(uuid, text)
  to service_role;

-- Invitation names seed only the target workspace membership. Existing
-- user-owned profile or membership names always win over the inviter's value.
create or replace function public.accept_workspace_invitation(
  invitation_token_hash text,
  actor_user_id uuid,
  actor_email text,
  actor_full_name text default null,
  actor_avatar_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_actor_email text;
  target_invitation public.workspace_invitations%rowtype;
  target_workspace public.workspaces%rowtype;
  actor_profile public.profiles%rowtype;
  existing_member public.workspace_members%rowtype;
  accepted_member public.workspace_members%rowtype;
  effective_full_name text;
  next_role public.member_role;
begin
  if invitation_token_hash is null or btrim(invitation_token_hash) = '' then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_invitation');
  end if;

  if actor_user_id is null then
    return jsonb_build_object('ok', false, 'error_code', 'auth_required');
  end if;

  normalized_actor_email := lower(btrim(coalesce(actor_email, '')));
  if normalized_actor_email = '' then
    return jsonb_build_object('ok', false, 'error_code', 'email_required');
  end if;

  select *
  into target_invitation
  from public.workspace_invitations invitation_record
  where invitation_record.token_hash = invitation_token_hash
  for update;

  if target_invitation.id is null then
    return jsonb_build_object('ok', false, 'error_code', 'invalid_invitation');
  end if;

  if target_invitation.status = 'accepted' then
    return jsonb_build_object('ok', false, 'error_code', 'already_accepted');
  end if;

  if target_invitation.status = 'revoked' then
    return jsonb_build_object('ok', false, 'error_code', 'revoked');
  end if;

  if target_invitation.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error_code', 'expired');
  end if;

  if target_invitation.email <> normalized_actor_email then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'email_mismatch',
      'invited_email', target_invitation.email,
      'actor_email', normalized_actor_email
    );
  end if;

  select *
  into target_workspace
  from public.workspaces workspace_record
  where workspace_record.id = target_invitation.workspace_id;

  if target_workspace.id is null then
    return jsonb_build_object('ok', false, 'error_code', 'workspace_not_found');
  end if;

  select *
  into actor_profile
  from public.profiles profile_record
  where profile_record.id = actor_user_id;

  select *
  into existing_member
  from public.workspace_members member_record
  where member_record.workspace_id = target_invitation.workspace_id
    and member_record.user_id = actor_user_id
    and member_record.kind = 'human'
  for update;

  effective_full_name := coalesce(
    nullif(btrim(actor_profile.full_name), ''),
    nullif(btrim(existing_member.full_name), ''),
    nullif(btrim(target_invitation.full_name), ''),
    nullif(btrim(actor_full_name), '')
  );

  if existing_member.id is null then
    insert into public.workspace_members (
      workspace_id,
      user_id,
      kind,
      role,
      email,
      full_name,
      avatar_url,
      is_active
    )
    values (
      target_invitation.workspace_id,
      actor_user_id,
      'human',
      target_invitation.role,
      normalized_actor_email,
      effective_full_name,
      nullif(actor_avatar_url, ''),
      true
    )
    returning *
    into accepted_member;
  else
    if existing_member.is_active then
      if internal.member_role_rank(target_invitation.role) > internal.member_role_rank(existing_member.role) then
        next_role := target_invitation.role;
      else
        next_role := existing_member.role;
      end if;
    else
      next_role := target_invitation.role;
    end if;

    update public.workspace_members
    set
      avatar_url = coalesce(existing_member.avatar_url, nullif(actor_avatar_url, '')),
      email = normalized_actor_email,
      full_name = effective_full_name,
      is_active = true,
      role = next_role
    where id = existing_member.id
    returning *
    into accepted_member;
  end if;

  update public.workspace_invitations
  set
    accepted_at = now(),
    accepted_by_member_id = accepted_member.id,
    status = 'accepted'
  where id = target_invitation.id;

  return jsonb_build_object(
    'ok', true,
    'invitation_id', target_invitation.id,
    'workspace', jsonb_build_object(
      'id', target_workspace.id,
      'name', target_workspace.name,
      'slug', target_workspace.slug
    ),
    'member', jsonb_build_object(
      'id', accepted_member.id,
      'role', accepted_member.role
    )
  );
end;
$$;

revoke all on function public.accept_workspace_invitation(text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.accept_workspace_invitation(text, uuid, text, text, text)
  to service_role;
