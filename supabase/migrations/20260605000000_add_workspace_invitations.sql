-- Add workspace invitations as a forward migration.
--
-- The invitations feature was added after production had already applied the
-- consolidated init migration, so production needs this schema change in a new
-- migration version instead of another edit to 20260422000000_init.sql.

do $$
begin
  create type public.workspace_invitation_status as enum ('pending', 'accepted', 'revoked');
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role public.member_role not null default 'member',
  status public.workspace_invitation_status not null default 'pending',
  token_hash text not null unique,
  invited_by_member_id uuid references public.workspace_members(id) on delete set null,
  accepted_by_member_id uuid references public.workspace_members(id) on delete set null,
  expires_at timestamptz not null,
  last_sent_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_invitations_email_normalized_check
    check (email = lower(btrim(email)) and email <> ''),
  constraint workspace_invitations_role_check
    check (role in ('admin', 'member')),
  constraint workspace_invitations_token_hash_present_check
    check (token_hash <> ''),
  constraint workspace_invitations_status_timestamp_check
    check (
      (status = 'pending' and accepted_at is null and revoked_at is null)
      or (status = 'accepted' and accepted_at is not null and revoked_at is null)
      or (status = 'revoked' and revoked_at is not null and accepted_at is null)
    )
);

create unique index if not exists workspace_invitations_one_pending_per_workspace_email
  on public.workspace_invitations (workspace_id, email)
  where status = 'pending';

create index if not exists workspace_invitations_workspace_status_idx
  on public.workspace_invitations (workspace_id, status, created_at desc);

create index if not exists workspace_invitations_pending_expiry_idx
  on public.workspace_invitations (expires_at)
  where status = 'pending';

create or replace function internal.member_role_rank(role_value public.member_role)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case role_value
    when 'owner' then 4
    when 'admin' then 3
    when 'member' then 2
    when 'agent' then 1
    else 0
  end
$$;

create or replace function internal.enforce_workspace_invitation_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.workspace_members',
    new.invited_by_member_id,
    'invited_by_member_id'
  );
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.workspace_members',
    new.accepted_by_member_id,
    'accepted_by_member_id'
  );
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'workspace_invitations_touch_updated_at'
      and tgrelid = 'public.workspace_invitations'::regclass
  ) then
    create trigger workspace_invitations_touch_updated_at
    before update on public.workspace_invitations
    for each row
    execute function internal.touch_updated_at();
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'workspace_invitations_enforce_refs'
      and tgrelid = 'public.workspace_invitations'::regclass
  ) then
    create trigger workspace_invitations_enforce_refs
    before insert or update on public.workspace_invitations
    for each row
    execute function internal.enforce_workspace_invitation_refs();
  end if;
end;
$$;

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
  existing_member public.workspace_members%rowtype;
  accepted_member public.workspace_members%rowtype;
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
  into existing_member
  from public.workspace_members member_record
  where member_record.workspace_id = target_invitation.workspace_id
    and member_record.user_id = actor_user_id
    and member_record.kind = 'human'
  for update;

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
      nullif(actor_full_name, ''),
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
      full_name = coalesce(existing_member.full_name, nullif(actor_full_name, '')),
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

alter table public.workspace_invitations enable row level security;

revoke all on public.workspace_invitations from anon, authenticated;
grant all on public.workspace_invitations to service_role;

revoke all on function public.accept_workspace_invitation(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.accept_workspace_invitation(text, uuid, text, text, text) to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'workspace_invitations'
      and policyname = 'workspace_invitations_service_only'
  ) then
    create policy workspace_invitations_service_only
      on public.workspace_invitations
      for all
      to authenticated
      using (false)
      with check (false);
  end if;
end;
$$;
