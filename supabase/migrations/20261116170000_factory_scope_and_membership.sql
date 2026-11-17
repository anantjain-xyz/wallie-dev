-- M03.01: factories become named, archivable children of a workspace with
-- explicit membership and an audited operator trail. Existing sessions,
-- pipelines and repositories are backfilled into the workspace default factory
-- without changing their canonical identities or URLs.
--
-- Workspace remains the tenant boundary. A workspace owner/admin keeps operator
-- visibility over every factory in that workspace; an ordinary workspace member
-- sees only factories they are actively granted. No row is deleted here.

-- ---------------------------------------------------------------------------
-- Factory lifecycle
-- ---------------------------------------------------------------------------

alter table public.factories
  add column name text,
  add column slug text,
  add column status text not null default 'active',
  add column archived_at timestamptz,
  add column archived_by uuid references public.workspace_members(id) on delete set null,
  add column archived_reason text,
  add column updated_at timestamptz not null default clock_timestamp();

-- Default factories keep the stable `default` slug. Any interim non-default
-- factory created before this migration gets a deterministic human-readable
-- slug so canonical factory identity is never rewritten.
update public.factories f
set name = 'Default factory', slug = 'default'
where f.is_default;

with ranked as (
  select id,
    row_number() over (partition by workspace_id order by created_at, id) as position
  from public.factories
  where not is_default
)
update public.factories f
set name = 'Factory ' || ranked.position,
    slug = 'factory-' || ranked.position
from ranked
where ranked.id = f.id;

alter table public.factories
  alter column name set not null,
  alter column slug set not null,
  add constraint factories_workspace_slug_key unique (workspace_id, slug),
  add constraint factories_name_shape_check
    check (char_length(btrim(name)) between 1 and 120),
  add constraint factories_slug_format_check
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) between 1 and 60),
  add constraint factories_status_check
    check (status in ('active', 'archived')),
  add constraint factories_archive_shape_check
    check (
      (status = 'active' and archived_at is null and archived_by is null and archived_reason is null)
      or (status = 'archived' and archived_at is not null)
    );

create index factories_workspace_status_idx on public.factories(workspace_id, status);

-- Provisioning runs after the workspace insert, before the first member is
-- added. Keep the default factory name/slug deterministic for new workspaces.
create or replace function internal.provision_default_factory()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.factories(workspace_id, name, slug)
  values (new.id, 'Default factory', 'default');
  return new;
end;
$$;
revoke all on function internal.provision_default_factory() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Factory membership and audit
-- ---------------------------------------------------------------------------

create table public.factory_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  member_id uuid not null references public.workspace_members(id) on delete cascade,
  role text not null check (role in ('manager', 'member')),
  granted_by_member_id uuid references public.workspace_members(id) on delete set null,
  granted_at timestamptz not null default clock_timestamp(),
  revoked_by_member_id uuid references public.workspace_members(id) on delete set null,
  revoked_at timestamptz,
  revoke_reason text,
  constraint factory_members_workspace_factory_fkey
    foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  constraint factory_members_revocation_shape_check
    check (
      (revoked_at is null and revoked_by_member_id is null)
      or (revoked_at is not null)
    )
);
create unique index factory_members_active_unique_idx
  on public.factory_members(factory_id, member_id) where revoked_at is null;
create index factory_members_member_idx on public.factory_members(member_id) where revoked_at is null;
create index factory_members_workspace_idx on public.factory_members(workspace_id, factory_id);

create table public.factory_audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  action text not null check (action in (
    'factory.created',
    'factory.archived',
    'factory.restored',
    'membership.granted',
    'membership.revoked',
    'membership.suspended',
    'membership.reinstated'
  )),
  actor_member_id uuid references public.workspace_members(id) on delete set null,
  subject_member_id uuid references public.workspace_members(id) on delete set null,
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 8192),
  created_at timestamptz not null default clock_timestamp(),
  constraint factory_audit_events_workspace_factory_fkey
    foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
create index factory_audit_events_factory_idx
  on public.factory_audit_events(workspace_id, factory_id, created_at desc, id desc);

alter table public.factory_members enable row level security;
alter table public.factory_audit_events enable row level security;
revoke all on public.factory_members, public.factory_audit_events
  from public, anon, authenticated, service_role;
grant select on public.factory_members, public.factory_audit_events to authenticated, service_role;

create function internal.enforce_factory_member_refs()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.workspace_members member
    where member.id = new.member_id
      and member.workspace_id = new.workspace_id
      and member.kind = 'human'
  ) then
    raise exception 'Factory membership requires an active human workspace member.'
      using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function internal.enforce_factory_member_refs() from public, anon, authenticated, service_role;
create trigger enforce_factory_member_refs
  before insert or update of workspace_id, factory_id, member_id on public.factory_members
  for each row execute function internal.enforce_factory_member_refs();

-- Membership identity is fixed at grant time. Revocation is the only mutation.
create function internal.preserve_factory_membership_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  -- Account deletion clears attribution through ON DELETE SET NULL. Permit that
  -- cleanup while keeping the grant identity immutable.
  if (new.workspace_id, new.factory_id, new.member_id, new.granted_at)
      is distinct from
     (old.workspace_id, old.factory_id, old.member_id, old.granted_at)
     or (new.granted_by_member_id is distinct from old.granted_by_member_id
         and new.granted_by_member_id is not null) then
    raise exception 'Factory membership identity is immutable.' using errcode = '23514';
  end if;
  if old.revoked_at is not null and
     ((new.revoked_at, new.revoke_reason) is distinct from
       (old.revoked_at, old.revoke_reason)
      or (new.revoked_by_member_id is distinct from old.revoked_by_member_id
          and new.revoked_by_member_id is not null)) then
    raise exception 'A revoked factory membership is final.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.preserve_factory_membership_identity() from public, anon, authenticated, service_role;
create trigger preserve_factory_membership_identity
  before update on public.factory_members
  for each row execute function internal.preserve_factory_membership_identity();

create function internal.preserve_factory_audit_events()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factories
    where (workspace_id, id) = (old.workspace_id, old.factory_id)
  ) then
    return old;
  end if;
  if tg_op = 'UPDATE' then
    -- Candidate deletion clears actor/subject attribution through ON DELETE SET
    -- NULL. Nothing else about the historical event may change.
    if (new.workspace_id, new.factory_id, new.action, new.detail, new.created_at)
        is distinct from
       (old.workspace_id, old.factory_id, old.action, old.detail, old.created_at)
       or (new.actor_member_id is distinct from old.actor_member_id and new.actor_member_id is not null)
       or (new.subject_member_id is distinct from old.subject_member_id and new.subject_member_id is not null) then
      raise exception 'Factory audit events are append-only.' using errcode = '23514';
    end if;
    return new;
  end if;
  raise exception 'Factory audit events are append-only.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_audit_events() from public, anon, authenticated, service_role;
create trigger preserve_factory_audit_events
  before update or delete on public.factory_audit_events
  for each row execute function internal.preserve_factory_audit_events();

-- Every active human inherits member access to the default factory. Workspace
-- operator authority comes from the live workspace role, so changing that role
-- never leaves behind a delegated factory-manager grant.
insert into public.factory_members(workspace_id, factory_id, member_id, role)
select factory.workspace_id, factory.id, member.id, 'member'
from public.factories factory
join public.workspace_members member
  on member.workspace_id = factory.workspace_id
 and member.kind = 'human'
 and member.is_active
where factory.is_default;

-- New workspace members inherit the default factory. Additional factories are
-- granted explicitly through the audited command below.
create function internal.grant_default_factory_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
declare granted_factory uuid;
begin
  if new.kind <> 'human' or not new.is_active then
    return new;
  end if;
  for granted_factory in
    insert into public.factory_members(workspace_id, factory_id, member_id, role)
    select factory.workspace_id, factory.id, new.id, 'member'
    from public.factories factory
    where factory.workspace_id = new.workspace_id
      and factory.is_default
      and not exists (
        select 1 from public.factory_members current
        where current.factory_id = factory.id
          and current.member_id = new.id
          and current.revoked_at is null
      )
    returning factory_id
  loop
    insert into public.factory_audit_events(
      workspace_id, factory_id, action, subject_member_id, detail
    )
    select new.workspace_id, granted_factory, 'membership.granted', new.id,
      jsonb_build_object('role', 'member', 'source', 'default_factory_inheritance');
  end loop;
  return new;
end;
$$;
revoke all on function internal.grant_default_factory_membership() from public, anon, authenticated, service_role;
create trigger workspace_members_grant_default_factory
  after insert on public.workspace_members
  for each row execute function internal.grant_default_factory_membership();

-- Deactivation blocks access immediately through the access helpers. Record the
-- suspension/reinstatement so the operator trail explains the access change
-- without rewriting the original grant. Reactivation through an invitation is an
-- UPDATE, so it must restore the inherited default-factory grant here.
create function internal.audit_workspace_member_factory_suspension()
returns trigger language plpgsql security definer set search_path = '' as $$
declare granted_factory uuid; promoted_member uuid;
begin
  if new.kind <> 'human' or new.is_active = old.is_active then
    return new;
  end if;

  -- The caller owns the workspace member row. Factory commands use the same
  -- member -> factory lock order. Lock every affected factory in id order,
  -- even when the member's current grant is still an ordinary grant.
  perform 1
  from public.factories factory
  where factory.workspace_id = new.workspace_id
    and (
      factory.is_default
      or exists (
        select 1
        from public.factory_members membership
        where membership.workspace_id = new.workspace_id
          and membership.factory_id = factory.id
          and membership.member_id = new.id
          and membership.revoked_at is null
      )
    )
  order by factory.id
  for update;

  insert into public.factory_audit_events(
    workspace_id, factory_id, action, subject_member_id, detail
  )
  select member.workspace_id, member.factory_id,
    case when new.is_active then 'membership.reinstated' else 'membership.suspended' end,
    new.id,
    jsonb_build_object('source', 'workspace_member_status')
  from public.factory_members member
  where member.member_id = new.id
    and member.revoked_at is null;

  -- Promote the longest-standing active ordinary member when a delegated
  -- manager departs. Workspace operators already have live management authority
  -- and do not need a persistent manager grant for fallback.
  if not new.is_active then
    for granted_factory in
      select manager.factory_id
      from public.factory_members manager
      where manager.member_id = new.id
        and manager.workspace_id = new.workspace_id
        and manager.role = 'manager'
        and manager.revoked_at is null
        and not exists (
          select 1
          from public.factory_members other
          join public.workspace_members other_member
            on other_member.id = other.member_id
          where other.workspace_id = manager.workspace_id
            and other.factory_id = manager.factory_id
            and other.role = 'manager'
            and other.revoked_at is null
            and other.member_id <> new.id
            and other_member.is_active
            and other_member.kind = 'human'
        )
    loop
      promoted_member := null;
      update public.factory_members membership
      set role = 'manager'
      from (
        select candidate.id
        from public.factory_members candidate
        join public.workspace_members candidate_member
          on candidate_member.id = candidate.member_id
        where candidate.workspace_id = new.workspace_id
          and candidate.factory_id = granted_factory
          and candidate.revoked_at is null
          and candidate.member_id <> new.id
          and candidate_member.is_active
          and candidate_member.kind = 'human'
          and candidate_member.role not in ('owner', 'admin')
        order by candidate.granted_at, candidate.id
        limit 1
      ) promotion
      where membership.id = promotion.id
      returning membership.member_id into promoted_member;

      if promoted_member is not null then
        insert into public.factory_audit_events(
          workspace_id, factory_id, action, subject_member_id, detail
        ) values (
          new.workspace_id, granted_factory, 'membership.granted', promoted_member,
          jsonb_build_object('role', 'manager', 'source', 'workspace_member_deactivation')
        );
      end if;
    end loop;
  end if;

  if new.is_active then
    for granted_factory in
      insert into public.factory_members(workspace_id, factory_id, member_id, role)
      select factory.workspace_id, factory.id, new.id, 'member'
      from public.factories factory
      where factory.workspace_id = new.workspace_id
        and factory.is_default
        and not exists (
          select 1 from public.factory_members current
          where current.workspace_id = factory.workspace_id
            and current.factory_id = factory.id
            and current.member_id = new.id
        )
      returning factory_id
    loop
      insert into public.factory_audit_events(
        workspace_id, factory_id, action, subject_member_id, detail
      ) values (
        new.workspace_id, granted_factory, 'membership.granted', new.id,
        jsonb_build_object('role', 'member', 'source', 'default_factory_reactivation')
      );
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function internal.audit_workspace_member_factory_suspension()
  from public, anon, authenticated, service_role;
create trigger workspace_members_audit_factory_suspension
  after update of is_active on public.workspace_members
  for each row execute function internal.audit_workspace_member_factory_suspension();

-- These workspace commands acquire the same workspace fence as factory
-- admission before changing member rows. This also serializes them with
-- definition activation, which takes the workspace fence exclusively.
alter function public.remove_workspace_member(uuid, uuid) set schema internal;
revoke all on function internal.remove_workspace_member(uuid, uuid)
  from public, anon, authenticated, service_role;
create function public.remove_workspace_member(target_member_id uuid, expected_workspace_id uuid)
returns table (id uuid, full_name text, email text, role public.member_role)
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.workspaces workspace
  where workspace.id = expected_workspace_id for share;
  return query select * from internal.remove_workspace_member(target_member_id, expected_workspace_id);
end;
$$;
revoke all on function public.remove_workspace_member(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.remove_workspace_member(uuid, uuid) to service_role;

alter function public.accept_workspace_invitation(text, uuid, text, text, text) set schema internal;
revoke all on function internal.accept_workspace_invitation(text, uuid, text, text, text)
  from public, anon, authenticated, service_role;
create function public.accept_workspace_invitation(
  invitation_token_hash text,
  actor_user_id uuid,
  actor_email text,
  actor_full_name text default null,
  actor_avatar_url text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform workspace.id from public.workspaces workspace
  join public.workspace_invitations invitation on invitation.workspace_id = workspace.id
  where invitation.token_hash = invitation_token_hash for share of workspace;
  return internal.accept_workspace_invitation(
    invitation_token_hash, actor_user_id, actor_email, actor_full_name, actor_avatar_url
  );
end;
$$;
revoke all on function public.accept_workspace_invitation(text, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_workspace_invitation(text, uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Resource scope
-- ---------------------------------------------------------------------------

alter table public.pipelines add column factory_id uuid;
alter table public.github_repositories add column factory_id uuid;
alter table public.sessions add column factory_id uuid;

update public.pipelines resource
set factory_id = factory.id
from public.factories factory
where factory.workspace_id = resource.workspace_id and factory.is_default;

update public.github_repositories resource
set factory_id = factory.id
from public.factories factory
where factory.workspace_id = resource.workspace_id and factory.is_default;

update public.sessions resource
set factory_id = factory.id
from public.factories factory
where factory.workspace_id = resource.workspace_id and factory.is_default;

alter table public.pipelines
  alter column factory_id set not null,
  add constraint pipelines_workspace_factory_fkey
    foreign key (workspace_id, factory_id) references public.factories(workspace_id, id);
alter table public.github_repositories
  alter column factory_id set not null,
  add constraint github_repositories_workspace_factory_fkey
    foreign key (workspace_id, factory_id) references public.factories(workspace_id, id);
alter table public.sessions
  alter column factory_id set not null,
  add constraint sessions_workspace_factory_fkey
    foreign key (workspace_id, factory_id) references public.factories(workspace_id, id);

create index pipelines_factory_idx on public.pipelines(workspace_id, factory_id);
create index github_repositories_factory_idx on public.github_repositories(workspace_id, factory_id);
create index sessions_factory_idx on public.sessions(workspace_id, factory_id);

create function internal.assert_factory_accepts_work(target_workspace_id uuid, target_factory_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare factory_status text;
begin
  select factory.status into factory_status
  from public.factories factory
  where factory.workspace_id = target_workspace_id and factory.id = target_factory_id
  for share;
  if not found then
    raise exception 'Factory not found.' using errcode = '23503';
  end if;
  if factory_status <> 'active' then
    raise exception 'Factory is archived.' using errcode = 'P0011';
  end if;
end;
$$;
revoke all on function internal.assert_factory_accepts_work(uuid, uuid)
  from public, anon, authenticated;
grant execute on function internal.assert_factory_accepts_work(uuid, uuid) to service_role;

-- Fill the owning factory when a legacy caller does not supply one, and fence
-- every new resource write to an active factory in the same workspace.
create function internal.assign_resource_factory()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Take the workspace fence before the factory lock so admission (and the
  -- existing session workspace trigger) always use workspace -> factory order.
  perform internal.assert_workspace_accepts_work(new.workspace_id);
  if new.factory_id is null then
    select factory.id into new.factory_id
    from public.factories factory
    where factory.workspace_id = new.workspace_id and factory.is_default;
  end if;
  if new.factory_id is null then
    raise exception 'Workspace has no default factory.' using errcode = 'P0002';
  end if;
  -- GitHub installation sync uses an upsert keyed by installation/repo. The
  -- conflict update never writes factory_id, so an existing repository keeps
  -- its scope and may still be refreshed while its factory is archived.
  if tg_table_name = 'github_repositories' then
    if exists (
      select 1 from public.github_repositories existing
      where existing.github_installation_id = (to_jsonb(new) ->> 'github_installation_id')::uuid
        and existing.repo_id = (to_jsonb(new) ->> 'repo_id')::bigint
    ) then
      return new;
    end if;
  end if;
  perform internal.assert_factory_accepts_work(new.workspace_id, new.factory_id);
  return new;
end;
$$;
revoke all on function internal.assign_resource_factory() from public, anon, authenticated, service_role;

create trigger pipelines_assign_factory before insert on public.pipelines
  for each row execute function internal.assign_resource_factory();
create trigger github_repositories_assign_factory before insert on public.github_repositories
  for each row execute function internal.assign_resource_factory();
create trigger sessions_assign_factory before insert on public.sessions
  for each row execute function internal.assign_resource_factory();

create function internal.preserve_resource_factory_scope()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.factory_id is distinct from old.factory_id then
    raise exception 'Resource factory scope is immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.preserve_resource_factory_scope()
  from public, anon, authenticated, service_role;
create trigger pipelines_preserve_factory_scope before update of factory_id on public.pipelines
  for each row execute function internal.preserve_resource_factory_scope();
create trigger github_repositories_preserve_factory_scope before update of factory_id on public.github_repositories
  for each row execute function internal.preserve_resource_factory_scope();
create trigger sessions_preserve_factory_scope before update of factory_id on public.sessions
  for each row execute function internal.preserve_resource_factory_scope();

-- Admission is a session insert. An archived factory keeps historical reads but
-- cannot receive new sessions until an authorized operator restores it.
create function internal.guard_factory_session_admission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Workspace operators already have factory access. Ordinary creators need an
  -- explicit active grant in the exact factory that will own the session.
  if new.creator_member_id is not null and not exists (
    select 1 from public.workspace_members creator
    where creator.id = new.creator_member_id
      and creator.workspace_id = new.workspace_id
      and creator.kind = 'human'
      and creator.is_active
      and (
        creator.role in ('owner', 'admin')
        or exists (
          select 1 from public.factory_members member
          where member.workspace_id = new.workspace_id
            and member.factory_id = new.factory_id
            and member.member_id = creator.id
            and member.revoked_at is null
        )
      )
  ) then
    raise exception 'Session creator is not authorized for this factory.' using errcode = '42501';
  end if;
  -- Links selected during admission must already live in the session factory.
  -- This stops a caller from steering default-factory work at a restricted
  -- sibling repository or pipeline by supplying a known UUID.
  if new.pipeline_id is not null and not exists (
    select 1 from public.pipelines pipeline
    where pipeline.id = new.pipeline_id
      and pipeline.workspace_id = new.workspace_id
      and pipeline.factory_id = new.factory_id
  ) then
    raise exception 'Session pipeline is outside the factory scope.' using errcode = '42501';
  end if;
  if new.github_repository_id is not null and not exists (
    select 1 from public.github_repositories repository
    where repository.id = new.github_repository_id
      and repository.workspace_id = new.workspace_id
      and repository.factory_id = new.factory_id
  ) then
    raise exception 'Session repository is outside the factory scope.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_factory_session_admission()
  from public, anon, authenticated, service_role;
create trigger sessions_guard_factory_admission before insert on public.sessions
  for each row execute function internal.guard_factory_session_admission();

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

create function internal.can_access_factory(target_workspace_id uuid, target_factory_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    auth.role() = 'service_role'
    or exists (
      select 1
      from public.workspaces workspace
      join public.workspace_members workspace_member
        on workspace_member.workspace_id = workspace.id
      where workspace.id = target_workspace_id
        and workspace.deletion_requested_at is null
        and workspace_member.user_id = auth.uid()
        and workspace_member.kind = 'human'
        and workspace_member.is_active
        and workspace_member.role in ('owner', 'admin')
    )
    or exists (
      select 1
      from public.factories factory
      join public.factory_members member
        on member.workspace_id = factory.workspace_id and member.factory_id = factory.id
      join public.workspace_members workspace_member on workspace_member.id = member.member_id
      join public.workspaces workspace on workspace.id = factory.workspace_id
      where factory.workspace_id = target_workspace_id
        and factory.id = target_factory_id
        and workspace.deletion_requested_at is null
        and member.revoked_at is null
        and workspace_member.user_id = auth.uid()
        and workspace_member.kind = 'human'
        and workspace_member.is_active
    ),
    false
  )
$$;
revoke all on function internal.can_access_factory(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function internal.can_access_factory(uuid, uuid) to authenticated, service_role;

create function internal.can_manage_factory(target_workspace_id uuid, target_factory_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    auth.role() = 'service_role'
    or exists (
      select 1
      from public.workspaces workspace
      join public.workspace_members workspace_member
        on workspace_member.workspace_id = workspace.id
      where workspace.id = target_workspace_id
        and workspace.deletion_requested_at is null
        and workspace_member.user_id = auth.uid()
        and workspace_member.kind = 'human'
        and workspace_member.is_active
        and workspace_member.role in ('owner', 'admin')
    )
    or exists (
      select 1
      from public.factories factory
      join public.factory_members member
        on member.workspace_id = factory.workspace_id and member.factory_id = factory.id
      join public.workspace_members workspace_member on workspace_member.id = member.member_id
      join public.workspaces workspace on workspace.id = factory.workspace_id
      where factory.workspace_id = target_workspace_id
        and factory.id = target_factory_id
        and workspace.deletion_requested_at is null
        and member.revoked_at is null
        and member.role = 'manager'
        and workspace_member.user_id = auth.uid()
        and workspace_member.kind = 'human'
        and workspace_member.is_active
    ),
    false
  )
$$;
revoke all on function internal.can_manage_factory(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function internal.can_manage_factory(uuid, uuid) to authenticated, service_role;

create function internal.can_access_session(target_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions session
    where session.id = target_session_id
      and internal.can_access_factory(session.workspace_id, session.factory_id)
  )
$$;
revoke all on function internal.can_access_session(uuid)
  from public, anon, authenticated, service_role;
grant execute on function internal.can_access_session(uuid) to authenticated, service_role;

create function internal.current_user_factory_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select distinct member.factory_id
  from public.factory_members member
  join public.workspace_members workspace_member on workspace_member.id = member.member_id
  join public.workspaces workspace on workspace.id = member.workspace_id
  where workspace_member.user_id = auth.uid()
    and workspace_member.kind = 'human'
    and workspace_member.is_active
    and member.revoked_at is null
    and workspace.deletion_requested_at is null
$$;
revoke all on function internal.current_user_factory_ids()
  from public, anon, authenticated, service_role;
grant execute on function internal.current_user_factory_ids() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: factory scope
-- ---------------------------------------------------------------------------

drop policy factories_select_membership on public.factories;
create policy factories_select_membership on public.factories for select to authenticated using (
  internal.can_access_factory(workspace_id, id)
);

drop policy factory_definition_drafts_select_manager on public.factory_definition_drafts;
create policy factory_definition_drafts_select_manager on public.factory_definition_drafts
  for select to authenticated using (
    internal.can_manage_factory(workspace_id, factory_id)
  );

drop policy factory_definition_revisions_select_membership on public.factory_definition_revisions;
create policy factory_definition_revisions_select_membership on public.factory_definition_revisions
  for select to authenticated using (
    internal.can_access_factory(workspace_id, factory_id)
  );

drop policy factory_definition_activations_select_membership on public.factory_definition_activations;
create policy factory_definition_activations_select_membership on public.factory_definition_activations
  for select to authenticated using (
    internal.can_access_factory(workspace_id, factory_id)
  );

drop policy factory_definition_smoke_tests_select_manager on public.factory_definition_smoke_tests;
create policy factory_definition_smoke_tests_select_manager on public.factory_definition_smoke_tests
  for select to authenticated using (
    internal.can_manage_factory(workspace_id, factory_id)
  );

create policy factory_members_select_membership on public.factory_members
  for select to authenticated using (
    internal.can_access_factory(workspace_id, factory_id)
  );

create policy factory_audit_events_select_manager on public.factory_audit_events
  for select to authenticated using (
    internal.can_manage_factory(workspace_id, factory_id)
  );

-- ---------------------------------------------------------------------------
-- RLS: resource scope
-- ---------------------------------------------------------------------------

drop policy sessions_select_membership on public.sessions;
create policy sessions_select_membership on public.sessions for select to authenticated using (
  internal.can_access_factory(workspace_id, factory_id)
);
drop policy sessions_update_title_membership on public.sessions;
create policy sessions_update_title_membership on public.sessions for update to authenticated
  using (internal.can_access_factory(workspace_id, factory_id))
  with check (internal.can_access_factory(workspace_id, factory_id));

drop policy pipelines_select_membership on public.pipelines;
create policy pipelines_select_membership on public.pipelines for select to authenticated using (
  internal.can_access_factory(workspace_id, factory_id)
);
drop policy pipelines_insert_manager on public.pipelines;
create policy pipelines_insert_manager on public.pipelines for insert to authenticated with check (
  internal.can_manage_factory(workspace_id, factory_id)
);
drop policy pipelines_update_manager on public.pipelines;
create policy pipelines_update_manager on public.pipelines for update to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id))
  with check (internal.can_manage_factory(workspace_id, factory_id));
drop policy pipelines_delete_manager on public.pipelines;
create policy pipelines_delete_manager on public.pipelines for delete to authenticated using (
  internal.can_manage_factory(workspace_id, factory_id)
);

drop policy github_repositories_select_membership on public.github_repositories;
create policy github_repositories_select_membership on public.github_repositories
  for select to authenticated using (
    internal.can_access_factory(workspace_id, factory_id)
  );

-- Stage and session evidence tables remain keyed by their existing identities,
-- but inherit the factory fence from the owning pipeline/session.
drop policy pipeline_stages_select_membership on public.pipeline_stages;
create policy pipeline_stages_select_membership on public.pipeline_stages
  for select to authenticated using (
    exists (
      select 1 from public.pipelines pipeline
      where pipeline.id = pipeline_stages.pipeline_id
        and internal.can_access_factory(pipeline.workspace_id, pipeline.factory_id)
    )
  );
drop policy pipeline_stages_insert_manager on public.pipeline_stages;
create policy pipeline_stages_insert_manager on public.pipeline_stages
  for insert to authenticated with check (
    exists (
      select 1 from public.pipelines pipeline
      where pipeline.id = pipeline_stages.pipeline_id
        and internal.can_manage_factory(pipeline.workspace_id, pipeline.factory_id)
    )
  );
drop policy pipeline_stages_update_manager on public.pipeline_stages;
create policy pipeline_stages_update_manager on public.pipeline_stages
  for update to authenticated
  using (
    exists (
      select 1 from public.pipelines pipeline
      where pipeline.id = pipeline_stages.pipeline_id
        and internal.can_manage_factory(pipeline.workspace_id, pipeline.factory_id)
    )
  )
  with check (
    exists (
      select 1 from public.pipelines pipeline
      where pipeline.id = pipeline_stages.pipeline_id
        and internal.can_manage_factory(pipeline.workspace_id, pipeline.factory_id)
    )
  );
drop policy pipeline_stages_delete_manager on public.pipeline_stages;
create policy pipeline_stages_delete_manager on public.pipeline_stages
  for delete to authenticated using (
    exists (
      select 1 from public.pipelines pipeline
      where pipeline.id = pipeline_stages.pipeline_id
        and internal.can_manage_factory(pipeline.workspace_id, pipeline.factory_id)
    )
  );

drop policy session_artifacts_select_membership on public.session_artifacts;
create policy session_artifacts_select_membership on public.session_artifacts
  for select to authenticated using (internal.can_access_session(session_id));

drop policy session_artifact_feedback_select_membership on public.session_artifact_feedback;
create policy session_artifact_feedback_select_membership on public.session_artifact_feedback
  for select to authenticated using (internal.can_access_session(session_id));

drop policy session_phase_completions_select_membership on public.session_phase_completions;
create policy session_phase_completions_select_membership on public.session_phase_completions
  for select to authenticated using (internal.can_access_session(session_id));

drop policy session_pull_requests_select_membership on public.session_pull_requests;
create policy session_pull_requests_select_membership on public.session_pull_requests
  for select to authenticated using (internal.can_access_session(session_id));

drop policy agent_runs_select_membership on public.agent_runs;
create policy agent_runs_select_membership on public.agent_runs
  for select to authenticated using (internal.can_access_session(session_id));

drop policy agent_run_messages_select_membership on public.agent_run_messages;
create policy agent_run_messages_select_membership on public.agent_run_messages
  for select to authenticated using (
    exists (
      select 1 from public.agent_runs run
      where run.id = agent_run_messages.agent_run_id
        and internal.can_access_session(run.session_id)
    )
  );

drop policy agent_run_events_select_membership on public.agent_run_events;
create policy agent_run_events_select_membership on public.agent_run_events
  for select to authenticated using (
    exists (
      select 1 from public.agent_runs run
      where run.id = agent_run_events.agent_run_id
        and internal.can_access_session(run.session_id)
    )
    and not exists (
      select 1 from public.agent_run_transcript_expirations expiry
      where expiry.run_id = agent_run_events.agent_run_id
        and expiry.workspace_id = agent_run_events.workspace_id
    )
  );

drop policy agent_run_transcript_expirations_read on public.agent_run_transcript_expirations;
create policy agent_run_transcript_expirations_read on public.agent_run_transcript_expirations
  for select to authenticated using (
    exists (
      select 1 from public.agent_runs run
      where run.id = agent_run_transcript_expirations.run_id
        and run.workspace_id = agent_run_transcript_expirations.workspace_id
        and internal.can_access_session(run.session_id)
    )
  );

drop policy session_selected_stages_select_membership on public.session_selected_stages;
create policy session_selected_stages_select_membership on public.session_selected_stages
  for select to authenticated using (internal.can_access_session(session_id));

drop policy artifact_review_threads_read on public.artifact_review_threads;
create policy artifact_review_threads_read on public.artifact_review_threads
  for select to authenticated using (internal.can_access_session(session_id));

drop policy artifact_review_comments_read on public.artifact_review_comments;
create policy artifact_review_comments_read on public.artifact_review_comments
  for select to authenticated using (
    exists (
      select 1 from public.artifact_review_threads thread
      where thread.id = artifact_review_comments.thread_id
        and internal.can_access_session(thread.session_id)
    )
  );

drop policy artifact_review_events_read on public.artifact_review_events;
create policy artifact_review_events_read on public.artifact_review_events
  for select to authenticated using (
    exists (
      select 1 from public.artifact_review_threads thread
      where thread.id = artifact_review_events.thread_id
        and internal.can_access_session(thread.session_id)
    )
  );

drop policy session_git_roots_select_membership on public.session_git_roots;
create policy session_git_roots_select_membership on public.session_git_roots
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_job_git_inputs_select_membership on public.session_job_git_inputs;
create policy session_job_git_inputs_select_membership on public.session_job_git_inputs
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_git_checkpoints_select_membership on public.session_git_checkpoints;
create policy session_git_checkpoints_select_membership on public.session_git_checkpoints
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_git_heads_select_membership on public.session_git_heads;
create policy session_git_heads_select_membership on public.session_git_heads
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_pr_sync_select_membership on public.session_pr_sync;
create policy session_pr_sync_select_membership on public.session_pr_sync
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_pr_epochs_select_membership on public.session_pr_epochs;
create policy session_pr_epochs_select_membership on public.session_pr_epochs
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_git_continuity_enrollments_read_members on public.session_git_continuity_enrollments;
create policy session_git_continuity_enrollments_read_members on public.session_git_continuity_enrollments
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_pr_refresh_queue_read on public.session_pr_refresh_queue;
create policy session_pr_refresh_queue_read on public.session_pr_refresh_queue
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_pr_verification_observations_read on public.session_pr_verification_observations;
create policy session_pr_verification_observations_read on public.session_pr_verification_observations
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_pr_verification_results_read on public.session_pr_verification_results;
create policy session_pr_verification_results_read on public.session_pr_verification_results
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_validation_evidence_read on public.session_validation_evidence;
create policy session_validation_evidence_read on public.session_validation_evidence
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_validation_assets_read on public.session_validation_assets;
create policy session_validation_assets_read on public.session_validation_assets
  for select to authenticated using (internal.can_access_session(session_id));
drop policy session_validation_plans_read on public.session_validation_plans;
create policy session_validation_plans_read on public.session_validation_plans
  for select to authenticated using (internal.can_access_session(session_id));

-- Storage objects follow the same session asset fence as their metadata row,
-- including receipt ownership and withholding.
drop policy session_validation_storage_read on storage.objects;
create policy session_validation_storage_read on storage.objects for select to authenticated using (
  bucket_id = 'session-validation-evidence'
  and exists (
    select 1
    from public.session_validation_assets asset
    join public.session_validation_evidence receipt
      on (receipt.run_id, receipt.workspace_id, receipt.session_id) =
         (asset.run_id, asset.workspace_id, asset.session_id)
    join public.agent_runs run
      on (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
         (receipt.run_id, receipt.workspace_id, receipt.session_id, receipt.job_id, receipt.attempt_count)
    join public.workspaces workspace on workspace.id = asset.workspace_id
    where asset.storage_path = storage.objects.name
      and workspace.deletion_requested_at is null
      and internal.can_access_session(asset.session_id)
      and not exists (
        select 1 from public.session_validation_asset_withholdings withholding
        where withholding.asset_id = asset.id
      )
  )
);

drop policy session_validation_asset_withholdings_read on public.session_validation_asset_withholdings;
create policy session_validation_asset_withholdings_read on public.session_validation_asset_withholdings
  for select to authenticated using (
    exists (
      select 1 from public.session_validation_assets asset
      join public.workspaces workspace on workspace.id = asset.workspace_id
      where asset.id = session_validation_asset_withholdings.asset_id
        and workspace.deletion_requested_at is null
        and internal.can_access_session(asset.session_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Audited operator commands
-- ---------------------------------------------------------------------------

create function internal.assert_factory_manager(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_subject_member_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid;
begin
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null
    for share;
  if not found then
    raise exception 'Factory workspace is unavailable.' using errcode = 'P0002';
  end if;

  select member.id into actor_member_id
  from public.workspace_members member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_actor_user_id
    and member.kind = 'human';
  if not found then
    raise exception 'Active workspace member required.' using errcode = '42501';
  end if;

  -- Workspace removal owns the member row before it reaches the factory.
  -- Take actor/subject locks in the same order before locking the factory.
  perform member.id from public.workspace_members member
  where member.workspace_id = p_workspace_id
    and member.id in (actor_member_id, p_subject_member_id)
  order by member.id
  for share;
  if not exists (
    select 1 from public.workspace_members member
    where member.workspace_id = p_workspace_id and member.id = actor_member_id
      and member.user_id = p_actor_user_id and member.kind = 'human' and member.is_active
  ) then
    raise exception 'Active workspace member required.' using errcode = '42501';
  end if;

  -- Read the current explicit grant after the lock winner has committed.
  perform 1 from public.factories factory
  where factory.workspace_id = p_workspace_id and factory.id = p_factory_id
  for update;
  if not found then
    raise exception 'Factory is unavailable.' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.workspace_members manager
    where manager.id = actor_member_id and manager.role in ('owner', 'admin')
  ) and not exists (
    select 1 from public.factory_members membership
    where membership.workspace_id = p_workspace_id
      and membership.factory_id = p_factory_id
      and membership.member_id = actor_member_id
      and membership.role = 'manager'
      and membership.revoked_at is null
  ) then
    raise exception 'Factory manager access is required.' using errcode = '42501';
  end if;

  return actor_member_id;
end;
$$;
revoke all on function internal.assert_factory_manager(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.create_factory(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_name text,
  p_slug text
) returns public.factories
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  normalized_name text := btrim(coalesce(p_name, ''));
  normalized_slug text := btrim(coalesce(p_slug, ''));
  created public.factories;
begin
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null
    for update;
  if not found then
    raise exception 'Factory workspace is unavailable.' using errcode = 'P0002';
  end if;

  select member.id into actor_member_id
  from public.workspace_members member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_actor_user_id
    and member.kind = 'human'
    and member.is_active
    and member.role in ('owner', 'admin')
  for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;

  if char_length(normalized_name) not between 1 and 120 then
    raise exception 'Factory name must be between 1 and 120 characters.' using errcode = '22023';
  end if;
  if normalized_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or char_length(normalized_slug) > 60 then
    raise exception 'Factory slug must be a lowercase hyphenated value.' using errcode = '22023';
  end if;

  insert into public.factories(workspace_id, name, slug, is_default, status)
  values (p_workspace_id, normalized_name, normalized_slug, false, 'active')
  returning * into created;

  insert into public.factory_members(
    workspace_id, factory_id, member_id, role, granted_by_member_id
  ) values (
    p_workspace_id, created.id, actor_member_id, 'manager', actor_member_id
  );

  insert into public.factory_audit_events(
    workspace_id, factory_id, action, actor_member_id, detail
  ) values (
    p_workspace_id, created.id, 'factory.created', actor_member_id,
    jsonb_build_object('name', created.name, 'slug', created.slug)
  );

  return created;
end;
$$;
revoke all on function public.create_factory(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_factory(uuid, uuid, text, text) to service_role;

create function public.archive_factory(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid,
  p_reason text default null
) returns public.factories
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  target public.factories;
  normalized_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select factory.* into target
  from public.factories factory
  where factory.workspace_id = p_workspace_id and factory.id = p_factory_id
  for update;
  if not found then
    raise exception 'Factory is unavailable.' using errcode = 'P0002';
  end if;
  if target.status = 'archived' then
    raise exception 'Factory is already archived.' using errcode = 'PT409';
  end if;

  update public.factories
  set status = 'archived',
      archived_at = clock_timestamp(),
      archived_by = actor_member_id,
      archived_reason = normalized_reason,
      updated_at = clock_timestamp()
  where workspace_id = p_workspace_id and id = p_factory_id
  returning * into target;

  insert into public.factory_audit_events(
    workspace_id, factory_id, action, actor_member_id, detail
  ) values (
    p_workspace_id, p_factory_id, 'factory.archived', actor_member_id,
    jsonb_build_object('reason', normalized_reason)
  );

  return target;
end;
$$;
revoke all on function public.archive_factory(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.archive_factory(uuid, uuid, uuid, text) to service_role;

create function public.restore_factory(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid
) returns public.factories
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  target public.factories;
  previous_archived_at timestamptz;
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select factory.* into target
  from public.factories factory
  where factory.workspace_id = p_workspace_id and factory.id = p_factory_id
  for update;
  if not found then
    raise exception 'Factory is unavailable.' using errcode = 'P0002';
  end if;
  if target.status = 'active' then
    raise exception 'Factory is already active.' using errcode = 'PT409';
  end if;
  previous_archived_at := target.archived_at;

  update public.factories
  set status = 'active',
      archived_at = null,
      archived_by = null,
      archived_reason = null,
      updated_at = clock_timestamp()
  where workspace_id = p_workspace_id and id = p_factory_id
  returning * into target;

  insert into public.factory_audit_events(
    workspace_id, factory_id, action, actor_member_id, detail
  ) values (
    p_workspace_id, p_factory_id, 'factory.restored', actor_member_id,
    jsonb_build_object('previousArchivedAt', previous_archived_at)
  );

  return target;
end;
$$;
revoke all on function public.restore_factory(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.restore_factory(uuid, uuid, uuid) to service_role;

create function public.grant_factory_membership(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid,
  p_member_id uuid,
  p_role text default 'member'
) returns public.factory_members
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  target_factory public.factories;
  target_member public.workspace_members;
  existing public.factory_members;
  granted public.factory_members;
  last_manager boolean;
begin
  actor_member_id := internal.assert_factory_manager(
    p_workspace_id, p_factory_id, p_actor_user_id, p_member_id
  );
  select factory.* into target_factory
  from public.factories factory
  where factory.workspace_id = p_workspace_id and factory.id = p_factory_id
  for update;
  if not found then
    raise exception 'Factory is unavailable.' using errcode = 'P0002';
  end if;
  if target_factory.status <> 'active' then
    raise exception 'Factory is archived.' using errcode = 'P0011';
  end if;
  if p_role not in ('manager', 'member') then
    raise exception 'Factory role must be manager or member.' using errcode = '22023';
  end if;

  select member.* into target_member
  from public.workspace_members member
  where member.workspace_id = p_workspace_id
    and member.id = p_member_id
    and member.kind = 'human'
    and member.is_active;
  if not found then
    raise exception 'An active workspace member is required.' using errcode = 'P0002';
  end if;

  select membership.* into existing
  from public.factory_members membership
  where membership.workspace_id = p_workspace_id
    and membership.factory_id = p_factory_id
    and membership.member_id = p_member_id
    and membership.revoked_at is null
  for update;

  if found then
    if existing.role = 'manager' and p_role <> 'manager' then
      select not exists (
        select 1 from public.factory_members manager
        join public.workspace_members manager_member on manager_member.id = manager.member_id
        where manager.workspace_id = p_workspace_id
          and manager.factory_id = p_factory_id
          and manager.role = 'manager'
          and manager.revoked_at is null
          and manager.member_id <> p_member_id
          and manager_member.is_active
          and manager_member.kind = 'human'
      ) into last_manager;
      if last_manager then
        raise exception 'A factory must retain at least one manager.' using errcode = '23514';
      end if;
    end if;
    update public.factory_members
    set role = p_role
    where id = existing.id
    returning * into granted;
  else
    insert into public.factory_members(
      workspace_id, factory_id, member_id, role, granted_by_member_id
    ) values (
      p_workspace_id, p_factory_id, p_member_id, p_role, actor_member_id
    )
    returning * into granted;
  end if;

  insert into public.factory_audit_events(
    workspace_id, factory_id, action, actor_member_id, subject_member_id, detail
  ) values (
    p_workspace_id, p_factory_id, 'membership.granted', actor_member_id, p_member_id,
    jsonb_build_object('role', p_role, 'previousRole', existing.role)
  );

  return granted;
end;
$$;
revoke all on function public.grant_factory_membership(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.grant_factory_membership(uuid, uuid, uuid, uuid, text) to service_role;

create function public.revoke_factory_membership(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid,
  p_member_id uuid,
  p_reason text default null
) returns public.factory_members
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  target public.factory_members;
  last_manager boolean;
  normalized_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  actor_member_id := internal.assert_factory_manager(
    p_workspace_id, p_factory_id, p_actor_user_id, p_member_id
  );
  perform 1 from public.factories factory
  where factory.workspace_id = p_workspace_id and factory.id = p_factory_id
  for update;
  if not found then
    raise exception 'Factory is unavailable.' using errcode = 'P0002';
  end if;

  select membership.* into target
  from public.factory_members membership
  where membership.workspace_id = p_workspace_id
    and membership.factory_id = p_factory_id
    and membership.member_id = p_member_id
    and membership.revoked_at is null
  for update;
  if not found then
    raise exception 'Active factory membership is required.' using errcode = 'P0002';
  end if;

  if target.role = 'manager' then
    select not exists (
      select 1 from public.factory_members manager
      join public.workspace_members manager_member on manager_member.id = manager.member_id
      where manager.workspace_id = p_workspace_id
        and manager.factory_id = p_factory_id
        and manager.role = 'manager'
        and manager.revoked_at is null
        and manager.member_id <> p_member_id
        and manager_member.is_active
        and manager_member.kind = 'human'
    ) into last_manager;
    if last_manager then
      raise exception 'A factory must retain at least one manager.' using errcode = '23514';
    end if;
  end if;

  update public.factory_members
  set revoked_at = clock_timestamp(),
      revoked_by_member_id = actor_member_id,
      revoke_reason = normalized_reason
  where id = target.id
  returning * into target;

  insert into public.factory_audit_events(
    workspace_id, factory_id, action, actor_member_id, subject_member_id, detail
  ) values (
    p_workspace_id, p_factory_id, 'membership.revoked', actor_member_id, p_member_id,
    jsonb_build_object('role', target.role, 'reason', normalized_reason)
  );

  return target;
end;
$$;
revoke all on function public.revoke_factory_membership(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_factory_membership(uuid, uuid, uuid, uuid, text) to service_role;

-- Read model for the future factory selector and governance screen. Scope is
-- resolved by the same workspace/factory rules as RLS.
create function public.read_factory_scope(
  p_workspace_id uuid,
  p_actor_user_id uuid
) returns table (
  factory_id uuid,
  name text,
  slug text,
  is_default boolean,
  status text,
  role text,
  session_count bigint,
  pipeline_count bigint,
  repository_count bigint,
  member_count bigint
)
language sql stable security definer set search_path = '' as $$
  select factory.id, factory.name, factory.slug, factory.is_default, factory.status,
    case
      when workspace_member.role in ('owner', 'admin') then 'manager'
      else coalesce(membership.role, 'member')
    end as role,
    (select count(*) from public.sessions session
      where session.workspace_id = factory.workspace_id and session.factory_id = factory.id),
    (select count(*) from public.pipelines pipeline
      where pipeline.workspace_id = factory.workspace_id and pipeline.factory_id = factory.id),
    (select count(*) from public.github_repositories repository
      where repository.workspace_id = factory.workspace_id and repository.factory_id = factory.id),
    (select count(*) from public.factory_members member
      where member.workspace_id = factory.workspace_id and member.factory_id = factory.id
        and member.revoked_at is null)
  from public.workspaces workspace
  join public.workspace_members workspace_member
    on workspace_member.workspace_id = workspace.id
   and workspace_member.user_id = p_actor_user_id
   and workspace_member.kind = 'human'
   and workspace_member.is_active
  join public.factories factory on factory.workspace_id = workspace.id
  left join public.factory_members membership
    on membership.workspace_id = factory.workspace_id
   and membership.factory_id = factory.id
   and membership.member_id = workspace_member.id
   and membership.revoked_at is null
  where workspace.id = p_workspace_id
    and workspace.deletion_requested_at is null
    and (
      workspace_member.role in ('owner', 'admin')
      or membership.id is not null
    )
  order by factory.is_default desc, factory.name, factory.id
$$;
revoke all on function public.read_factory_scope(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_scope(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Security-definer read/write RPCs inherit the same factory fence
-- ---------------------------------------------------------------------------

-- Review mutations must not accept known sibling-factory session IDs.
create or replace function internal.artifact_review_actor(p_workspace_id uuid, p_session_id uuid)
returns public.workspace_members language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; reviewed public.sessions;
begin
  if auth.uid() is null then raise exception 'Active human membership required.' using errcode='42501'; end if;
  select * into reviewed from public.sessions s where s.id=p_session_id and s.workspace_id=p_workspace_id
    and s.archived_at is null for no key update;
  if not found then raise exception 'Review session is unavailable.' using errcode='42501'; end if;
  if reviewed.phase_status='approved' then
    raise exception 'This session is closed for review changes.' using errcode='PT409';
  end if;
  select m.* into actor from public.workspace_members m where m.workspace_id=p_workspace_id
    and m.user_id=auth.uid() and m.kind='human' and m.is_active for share;
  if not found then raise exception 'Active human membership required.' using errcode='42501'; end if;
  -- Active membership is not enough: the reviewer must also hold the exact
  -- factory that owns the session, so a sibling-factory ID cannot be mutated.
  if not internal.can_access_factory(reviewed.workspace_id, reviewed.factory_id) then
    raise exception 'Review session is unavailable.' using errcode='42501';
  end if;
  return actor;
end;
$$;

-- Image attachments on the session page follow the owning session scope.
create or replace function public.get_session_prompt_attachments(
  target_workspace_slug text,
  target_session_number integer
)
returns table (
  id uuid,
  original_filename text,
  content_type text,
  size_bytes bigint,
  attachment_position smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    attachment.id,
    attachment.original_filename,
    attachment.content_type,
    attachment.size_bytes,
    attachment.position
  from public.workspaces workspace
  join public.sessions session
    on session.workspace_id = workspace.id
   and session.number = target_session_number
  join public.session_attachments attachment
    on attachment.session_id = session.id
   and attachment.workspace_id = workspace.id
   and attachment.status = 'attached'
  where workspace.slug = target_workspace_slug
    and workspace.id in (select internal.current_user_workspace_ids())
    and internal.can_access_factory(session.workspace_id, session.factory_id)
  order by attachment.position
$$;

-- Session detail and list RPCs are security definer; expose no row outside the
-- caller's factory scope even after membership revocation.
CREATE OR REPLACE FUNCTION public.get_session_detail_page(target_workspace_slug text, target_session_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_workspace_id uuid;
  v_has_any_workspace boolean;
  v_session public.sessions%rowtype;
  v_current_stage public.pipeline_stages%rowtype;
  v_creator_display_name text;
  v_stages jsonb := '[]'::jsonb;
  v_phase_completions jsonb := '[]'::jsonb;
  v_artifacts jsonb := '[]'::jsonb;
  v_pull_requests jsonb := '[]'::jsonb;
  v_effective_repository_id uuid;
  v_repository jsonb := null;
begin
  select w.id
  into v_workspace_id
  from public.workspaces w
  join public.workspace_members wm
    on wm.workspace_id = w.id
  where w.slug = target_workspace_slug
    and wm.user_id = auth.uid()
    and wm.is_active
    and wm.kind = 'human'
  limit 1;

  if v_workspace_id is null then
    select exists (
      select 1
      from public.workspace_members wm
      where wm.user_id = auth.uid()
        and wm.is_active
        and wm.kind = 'human'
    )
    into v_has_any_workspace;

    return jsonb_build_object(
      'access', jsonb_build_object(
        'hasAnyWorkspace', v_has_any_workspace
      )
    );
  end if;

  select *
  into v_session
  from public.sessions s
  where s.workspace_id = v_workspace_id
    and s.number = target_session_number;

  if not found then
    return null;
  end if;

  if not internal.can_access_factory(v_session.workspace_id, v_session.factory_id) then
    return null;
  end if;

  select *
  into v_current_stage
  from internal.session_execution_stages(v_session) ps
  where ps.id = v_session.current_stage_id;

  select coalesce(
    nullif(btrim(wm.full_name), ''),
    nullif(btrim(wm.username), ''),
    nullif(btrim(wm.email), ''),
    'Unknown member'
  )
  into v_creator_display_name
  from public.workspace_members wm
  where wm.id = v_session.creator_member_id
    and wm.workspace_id = v_workspace_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'description', ps.description,
        'id', ps.id,
        'name', ps.name,
        'position', ps.position,
        'slug', ps.slug
      )
      order by ps.position asc
    ),
    '[]'::jsonb
  )
  into v_stages
  from internal.session_execution_stages(v_session) ps
  join public.session_selected_stages selection
    on selection.stage_id = ps.id
   and selection.session_id = v_session.id
   and selection.workspace_id = v_workspace_id
  where ps.pipeline_id = v_session.pipeline_id
    and ps.workspace_id = v_workspace_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'completedAt', spc.completed_at,
        'id', spc.id,
        'stageId', spc.stage_id,
        'stageSlug', spc.stage_slug
      )
      order by spc.completed_at asc
    ),
    '[]'::jsonb
  )
  into v_phase_completions
  from public.session_phase_completions spc
  where spc.session_id = v_session.id
    and spc.workspace_id = v_workspace_id;

  if v_current_stage.id is not null and v_session.current_artifact_version > 0 then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', sa.id,
          'createdAt', sa.created_at,
          'payload', sa.artifact_json,
          'stageSlug', v_current_stage.slug,
          'version', sa.version
        )
        order by sa.version desc
      ),
      '[]'::jsonb
    )
    into v_artifacts
    from public.session_artifacts sa
    where sa.session_id = v_session.id
      and sa.workspace_id = v_workspace_id
      and sa.stage_id = v_current_stage.id
      and sa.version = v_session.current_artifact_version
      and sa.id = v_session.current_artifact_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', spr.id,
        'pullRequestNumber', spr.pull_request_number,
        'pullRequestUrl', spr.pull_request_url
      )
      order by spr.created_at desc
    ),
    '[]'::jsonb
  )
  into v_pull_requests
  from public.session_pull_requests spr
  where spr.workspace_id = v_workspace_id
    and spr.session_id = v_session.id;

  with latest_pull_request_repository as (
    select spr.github_repository_id
    from public.session_pull_requests spr
    where spr.workspace_id = v_workspace_id
      and spr.session_id = v_session.id
      and spr.github_repository_id is not null
    order by spr.created_at desc
    limit 1
  ),
  expanded_candidates(priority, repository_id) as (
    values (1, case when v_session.execute_pinned_definition then
      (internal.pinned_session_execution_definition(v_session)->>'repositoryId')::uuid
      else v_session.github_repository_id end)
    union all
    select 2, spr.github_repository_id
    from latest_pull_request_repository spr
    join public.github_repositories repository
      on repository.id = spr.github_repository_id
     and repository.workspace_id = v_workspace_id
     and repository.factory_id = v_session.factory_id
    where not v_session.execute_pinned_definition
      and internal.can_access_factory(repository.workspace_id, repository.factory_id)
    union all
    select 3, wrp.github_repository_id
    from public.workspace_repository_profiles wrp
    join public.github_repositories repository
      on repository.id = wrp.github_repository_id
     and repository.workspace_id = v_workspace_id
     and repository.factory_id = v_session.factory_id
    where wrp.workspace_id = v_workspace_id
      and wrp.is_primary
      and not v_session.execute_pinned_definition
      and internal.can_access_factory(repository.workspace_id, repository.factory_id)
    union all
    select 4, wo.selected_github_repository_id
    from public.workspace_onboarding wo
    join public.github_repositories repository
      on repository.id = wo.selected_github_repository_id
     and repository.workspace_id = v_workspace_id
     and repository.factory_id = v_session.factory_id
    where wo.workspace_id = v_workspace_id
      and not v_session.execute_pinned_definition
      and internal.can_access_factory(repository.workspace_id, repository.factory_id)
  ),
  first_configured as (
    select repository_id
    from expanded_candidates
    where repository_id is not null
    order by priority
    limit 1
  ),
  resolved as (
    select gr.*
    from expanded_candidates ec
    join public.github_repositories gr
      on gr.id = ec.repository_id
     and gr.workspace_id = v_workspace_id
     and gr.factory_id = v_session.factory_id
    where ec.repository_id is not null
    order by ec.priority
    limit 1
  )
  select
    coalesce((select id from resolved), (select repository_id from first_configured)),
    (
      select jsonb_build_object(
        'defaultBranch', default_branch,
        'defaultProgrammingLanguage', default_programming_language,
        'fullName', full_name,
        'htmlUrl', html_url,
        'id', id,
        'isArchived', is_archived,
        'isPrivate', private
      )
      from resolved
    )
  into v_effective_repository_id, v_repository;

  return jsonb_build_object(
    'activity', jsonb_build_object(
      'repository', v_repository,
      'sessionGithubRepositoryId', v_effective_repository_id,
      'sessionId', v_session.id,
      'workspaceId', v_workspace_id
    ),
    'creatorDisplayName', v_creator_display_name,
    'session', jsonb_build_object(
      'archivedAt', v_session.archived_at,
      'artifacts', v_artifacts,
      'createdAt', v_session.created_at,
      'currentArtifactId', v_session.current_artifact_id,
      'currentArtifactVersion', v_session.current_artifact_version,
      'currentStageId', v_session.current_stage_id,
      'currentStageSlug', coalesce(v_current_stage.slug, 'unknown'),
      'id', v_session.id,
      'linearIssueId', v_session.linear_issue_id,
      'linearIssueUrl', v_session.linear_issue_url,
      'number', v_session.number,
      'phaseCompletions', v_phase_completions,
      'phaseStatus', v_session.phase_status,
      'pipeline', jsonb_build_object('stages', v_stages),
      'promptMd', v_session.prompt_md,
      'pullRequests', v_pull_requests,
      'title', v_session.title,
      'updatedAt', v_session.updated_at
    ),
    'workspaceSlug', target_workspace_slug
  );
end;
$function$;

create or replace function public.get_session_list_page(
  target_workspace_slug text,
  session_scope text default 'all',
  stage_filter_slug text default null,
  search_query text default null,
  page_limit integer default 50,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null,
  sort_key text default 'updated',
  cursor_number integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workspace_id uuid;
  v_factory_ids uuid[];
  v_limit integer := least(greatest(coalesce(page_limit, 50), 1), 100);
  v_scope text := case
    when session_scope in ('all', 'active', 'archived') then session_scope
    else 'all'
  end;
  v_sort text := case
    when sort_key in ('updated', 'oldest', 'number') then sort_key
    else 'updated'
  end;
  v_stage_slug text := nullif(stage_filter_slug, '');
  v_search_raw text := nullif(
    regexp_replace(coalesce(search_query, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  v_search_digits text := null;
  v_search_number integer := null;
  v_search_query tsquery := null;
  v_search_like_pattern text := null;
  v_rows jsonb := '[]'::jsonb;
  v_stage_facets jsonb := '[]'::jsonb;
  v_scope_facets jsonb := jsonb_build_object('active', 0, 'archived', 0, 'all', 0);
  v_has_any_session boolean := false;
  v_has_more boolean := false;
begin
  if v_search_raw ~ '^#?[0-9]+$' then
    v_search_digits := ltrim(ltrim(v_search_raw, '#'), '0');
    -- Bound the cast first: malformed and arbitrarily large input stays text search.
    if length(v_search_digits) between 1 and 10 then
      if v_search_digits::bigint <= 2147483647 then
        v_search_number := v_search_digits::integer;
        v_search_raw := v_search_digits;
      end if;
    end if;
  end if;

  if v_search_raw is not null then
    v_search_query := websearch_to_tsquery('simple', v_search_raw);
    v_search_like_pattern := '%' ||
      replace(
        replace(
          replace(lower(v_search_raw), '\', '\\'),
          '%',
          '\%'
        ),
        '_',
        '\_'
      ) ||
      '%';
  end if;

  select w.id
  into v_workspace_id
  from public.workspaces w
  join public.workspace_members wm
    on wm.workspace_id = w.id
  where w.slug = target_workspace_slug
    and wm.user_id = auth.uid()
    and wm.is_active
    and wm.kind = 'human'
  limit 1;

  if v_workspace_id is null then
    return null;
  end if;

  select coalesce(array_agg(factory.id), '{}'::uuid[])
  into v_factory_ids
  from public.factories factory
  where factory.workspace_id = v_workspace_id
    and internal.can_access_factory(factory.workspace_id, factory.id);

  select exists (
    select 1
    from public.sessions s
    where s.workspace_id = v_workspace_id
      and s.factory_id = any(v_factory_ids)
  )
  into v_has_any_session;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'count', session_count,
        'name', name,
        'position', position,
        'slug', slug
      )
      order by position asc, name asc
    ),
    '[]'::jsonb
  )
  into v_stage_facets
  from (
    select
      (array_agg(name order by updated_at desc, created_at desc, id desc))[1] as name,
      (array_agg(position order by updated_at desc, created_at desc, id desc))[1] as position,
      slug,
      count(*)::integer as session_count
    from (
      select
        ps.created_at,
        ps.id,
        ps.name,
        ps.position,
        ps.slug,
        ps.updated_at
      from public.sessions s
      join public.pipeline_stages ps
        on ps.id = s.current_stage_id
      where s.workspace_id = v_workspace_id
        and s.factory_id = any(v_factory_ids)
        and (v_scope <> 'active' or s.archived_at is null)
        and (v_scope <> 'archived' or s.archived_at is not null)
        and (
          v_search_raw is null
          or s.number = v_search_number
          or s.search_document @@ v_search_query
          or s.search_text like v_search_like_pattern escape '\'
        )
    ) stage_rows
    group by slug
  ) facets;

  -- Scope counts ignore the scope filter itself so every option keeps a total.
  select jsonb_build_object(
    'active', count(*) filter (where s.archived_at is null)::integer,
    'archived', count(*) filter (where s.archived_at is not null)::integer,
    'all', count(*)::integer
  )
  into v_scope_facets
  from public.sessions s
  join public.pipeline_stages ps
    on ps.id = s.current_stage_id
  where s.workspace_id = v_workspace_id
    and s.factory_id = any(v_factory_ids)
    and (v_stage_slug is null or ps.slug = v_stage_slug)
    and (
      v_search_raw is null
      or s.number = v_search_number
      or s.search_document @@ v_search_query
      or s.search_text like v_search_like_pattern escape '\'
    );

  with filtered as (
    select
      s.id,
      s.archived_at,
      s.created_at,
      s.current_artifact_version,
      s.current_stage_id,
      s.linear_issue_id,
      s.linear_issue_url,
      s.number,
      s.phase_status,
      s.pipeline_id,
      s.rejection_count,
      s.title,
      s.updated_at,
      s.workspace_id,
      ps.name as current_stage_name,
      ps.position as current_stage_position,
      ps.slug as current_stage_slug,
      gr.full_name as repository_full_name,
      coalesce(prs.pull_request_count, 0)::integer as pull_request_count,
      coalesce(prs.pull_requests, '[]'::jsonb) as pull_requests
    from public.sessions s
    join public.pipeline_stages ps
      on ps.id = s.current_stage_id
    left join public.github_repositories gr
      on gr.id = s.github_repository_id
     and gr.workspace_id = v_workspace_id
    left join lateral (
      select
        count(*)::integer as pull_request_count,
        jsonb_agg(
          jsonb_build_object(
            'branchName', spr.branch_name,
            'id', spr.id,
            'isDraft', spr.is_draft,
            'pullRequestNumber', spr.pull_request_number,
            'pullRequestState', spr.pull_request_state,
            'pullRequestUrl', spr.pull_request_url,
            'repositoryFullName', repo.full_name,
            'repositoryHtmlUrl', repo.html_url,
            'updatedAt', spr.updated_at
          )
          order by spr.created_at desc
        ) as pull_requests
      from public.session_pull_requests spr
      left join public.github_repositories repo
        on repo.id = spr.github_repository_id
       and repo.workspace_id = v_workspace_id
      where spr.workspace_id = v_workspace_id
        and spr.session_id = s.id
    ) prs on true
    where s.workspace_id = v_workspace_id
      and s.factory_id = any(v_factory_ids)
      and (v_scope <> 'active' or s.archived_at is null)
      and (v_scope <> 'archived' or s.archived_at is not null)
      and (v_stage_slug is null or ps.slug = v_stage_slug)
      and (
        v_search_raw is null
        or s.number = v_search_number
        or s.search_document @@ v_search_query
        or s.search_text like v_search_like_pattern escape '\'
      )
      and (
        cursor_id is null
        or (
          v_search_number is not null
          and cursor_number = v_search_number
          and s.number <> v_search_number
        )
        or (
          coalesce(s.number = v_search_number, false)
            = coalesce(cursor_number = v_search_number, false)
          and (
            (
              v_sort = 'updated'
              and cursor_updated_at is not null
              and (
                s.updated_at < cursor_updated_at
                or (s.updated_at = cursor_updated_at and s.id < cursor_id)
              )
            )
            or (
              v_sort = 'oldest'
              and cursor_updated_at is not null
              and (
                s.updated_at > cursor_updated_at
                or (s.updated_at = cursor_updated_at and s.id > cursor_id)
              )
            )
            or (
              v_sort = 'number'
              and cursor_number is not null
              and (
                s.number < cursor_number
                or (s.number = cursor_number and s.id < cursor_id)
              )
            )
          )
        )
      )
    order by
      coalesce(s.number = v_search_number, false) desc,
      case when v_sort = 'updated' then s.updated_at end desc nulls last,
      case when v_sort = 'updated' then s.id::text end desc nulls last,
      case when v_sort = 'oldest' then s.updated_at end asc nulls last,
      case when v_sort = 'oldest' then s.id::text end asc nulls last,
      case when v_sort = 'number' then s.number end desc nulls last,
      case when v_sort = 'number' then s.id::text end desc nulls last
    limit v_limit + 1
  ),
  numbered as (
    select filtered.*, row_number() over () as rn
    from filtered
  ),
  with_latest_run as (
    select numbered.*, lr.latest_run_status
    from numbered
    left join lateral (
      select ar.status as latest_run_status
      from public.agent_runs ar
      where ar.workspace_id = v_workspace_id
        and ar.session_id = numbered.id
      order by ar.created_at desc, ar.id desc
      limit 1
    ) lr on true
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'archivedAt', archived_at,
          'createdAt', created_at,
          'currentArtifactVersion', current_artifact_version,
          'currentStageId', current_stage_id,
          'currentStageName', current_stage_name,
          'currentStagePosition', current_stage_position,
          'currentStageSlug', current_stage_slug,
          'id', id,
          'linearIssueId', linear_issue_id,
          'linearIssueUrl', linear_issue_url,
          'number', number,
          'phaseStatus', phase_status,
          'latestRunStatus', latest_run_status,
          'pipelineId', pipeline_id,
          'pullRequestCount', pull_request_count,
          'pullRequests', pull_requests,
          'rejectionCount', rejection_count,
          'repositoryFullName', repository_full_name,
          'title', title,
          'updatedAt', updated_at,
          'workspaceId', workspace_id
        )
        order by rn
      ) filter (where rn <= v_limit),
      '[]'::jsonb
    ),
    count(*) > v_limit
  into v_rows, v_has_more
  from with_latest_run;

  return jsonb_build_object(
    'hasAnySession', v_has_any_session,
    'hasMore', v_has_more,
    'scopeFacets', v_scope_facets,
    'sessions', v_rows,
    'stageFacets', v_stage_facets,
    'workspaceId', v_workspace_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Immutable feedback snapshots and the pipeline dashboard inherit the fence
-- ---------------------------------------------------------------------------

-- Feedback batches copy review text and artifact anchors. Keep those immutable
-- snapshots behind the owning session's factory, not just workspace membership.
drop policy artifact_feedback_batches_read on public.artifact_feedback_batches;
create policy artifact_feedback_batches_read on public.artifact_feedback_batches
  for select to authenticated
  using (
    workspace_id in (select internal.current_user_workspace_ids())
    and internal.can_access_session(session_id)
  );

drop policy artifact_feedback_batch_threads_read on public.artifact_feedback_batch_threads;
create policy artifact_feedback_batch_threads_read on public.artifact_feedback_batch_threads
  for select to authenticated
  using (
    workspace_id in (select internal.current_user_workspace_ids())
    and internal.can_access_session(session_id)
  );

drop policy artifact_feedback_batch_jobs_read on public.artifact_feedback_batch_jobs;
create policy artifact_feedback_batch_jobs_read on public.artifact_feedback_batch_jobs
  for select to authenticated
  using (
    workspace_id in (select internal.current_user_workspace_ids())
    and internal.can_access_session(session_id)
  );

-- The pipeline dashboard is security definer and returns session titles, links
-- and run identities across lanes. Fence both lane definitions and the session
-- snapshot so it cannot bypass the table policies.
create or replace function public.get_pipeline_dashboard_page(
  target_workspace_id uuid,
  target_pipeline_id uuid default null,
  target_stage_id uuid default null,
  page_limit integer default 25,
  cursor_seen_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lanes jsonb := '[]'::jsonb;
  v_factory_ids uuid[];
  v_limit integer := least(greatest(coalesce(page_limit, 25), 1), 25);
  v_seen_ids uuid[] := coalesce(cursor_seen_ids, '{}'::uuid[]);
begin
  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = auth.uid()
      and wm.is_active
      and wm.kind = 'human'
  ) then
    return null;
  end if;

  select coalesce(array_agg(factory.id), '{}'::uuid[])
  into v_factory_ids
  from public.factories factory
  where factory.workspace_id = target_workspace_id
    and internal.can_access_factory(factory.workspace_id, factory.id);

  if (target_pipeline_id is null) <> (target_stage_id is null) then
    raise exception 'pipeline and stage filters must be provided together';
  end if;

  with lane_definitions as materialized (
    -- Always render every stage from the current default pipeline, including
    -- empty lanes and fully custom stage sets.
    select
      p.id as pipeline_id,
      p.is_default as pipeline_is_default,
      p.name as pipeline_name,
      ps.description,
      ps.id as stage_id,
      ps.name as stage_name,
      ps.position,
      ps.slug
    from public.pipelines p
    join public.pipeline_stages ps
      on ps.pipeline_id = p.id
     and ps.workspace_id = target_workspace_id
    where p.workspace_id = target_workspace_id
      and p.factory_id = any(v_factory_ids)
      and p.is_default
      and (
        target_pipeline_id is null
        or (p.id = target_pipeline_id and ps.id = target_stage_id)
      )

    union

    -- Historical and non-default pipelines contribute their full stage shape
    -- while they still have an active pinned session. The pipeline_id is part
    -- of lane identity; matching stage slugs on different pipelines never merge.
    select distinct
      p.id as pipeline_id,
      p.is_default as pipeline_is_default,
      p.name as pipeline_name,
      ps.description,
      ps.id as stage_id,
      ps.name as stage_name,
      ps.position,
      ps.slug
    from public.pipelines p
    join public.pipeline_stages ps
      on ps.pipeline_id = p.id
     and ps.workspace_id = target_workspace_id
    where p.workspace_id = target_workspace_id
      and p.factory_id = any(v_factory_ids)
      and exists (
        select 1
        from public.sessions s
        where s.workspace_id = target_workspace_id
          and s.pipeline_id = p.id
          and s.archived_at is null
      )
      and (
        target_pipeline_id is null
        or (p.id = target_pipeline_id and ps.id = target_stage_id)
      )
  ),
  snapshot_sessions as materialized (
    select
      s.created_at,
      s.current_stage_id,
      s.id,
      s.linear_issue_id,
      s.linear_issue_url,
      s.number,
      s.phase_status,
      s.pipeline_id,
      s.rejection_count,
      s.title,
      s.updated_at,
      s.workspace_id,
      case when s.phase_status = 'awaiting_review' then 0 else 1 end as attention_rank
    from public.sessions s
    join lane_definitions ld
      on ld.pipeline_id = s.pipeline_id
     and ld.stage_id = s.current_stage_id
    where s.workspace_id = target_workspace_id
      and s.factory_id = any(v_factory_ids)
      and s.archived_at is null
  ),
  lane_counts as (
    select pipeline_id, current_stage_id as stage_id, count(*)::integer as total_count
    from snapshot_sessions
    group by pipeline_id, current_stage_id
  ),
  remaining_sessions as (
    select
      ss.*,
      count(*) over (
        partition by ss.pipeline_id, ss.current_stage_id
      )::integer as remaining_count,
      row_number() over (
        partition by ss.pipeline_id, ss.current_stage_id
        order by ss.attention_rank asc, ss.updated_at desc, ss.id desc
      )::integer as page_row
    from snapshot_sessions ss
    where not (ss.id = any(v_seen_ids))
  ),
  page_sessions as (
    select *
    from remaining_sessions
    where page_row <= v_limit
  ),
  card_rows as (
    select
      ps.*,
      lr.latest_run_id,
      lr.latest_run_status,
      coalesce(prs.pull_requests, '[]'::jsonb) as pull_requests
    from page_sessions ps
    left join lateral (
      select jsonb_agg(
        jsonb_build_object(
          'id', spr.id,
          'pullRequestNumber', spr.pull_request_number,
          'pullRequestUrl', spr.pull_request_url
        )
        order by spr.created_at desc, spr.id desc
      ) as pull_requests
      from public.session_pull_requests spr
      where spr.workspace_id = target_workspace_id
        and spr.session_id = ps.id
        and spr.pull_request_url is not null
    ) prs on true
    left join lateral (
      select
        ar.id as latest_run_id,
        ar.status as latest_run_status
      from public.agent_runs ar
      where ar.workspace_id = target_workspace_id
        and ar.session_id = ps.id
      order by ar.created_at desc, ar.id desc
      limit 1
    ) lr on true
  ),
  lane_pages as (
    select
      ld.*,
      coalesce(lc.total_count, 0) as total_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'createdAt', cr.created_at,
            'currentStageId', cr.current_stage_id,
            'id', cr.id,
            'latestRunId', cr.latest_run_id,
            'latestRunStatus', cr.latest_run_status,
            'linearIssueId', cr.linear_issue_id,
            'linearIssueUrl', cr.linear_issue_url,
            'number', cr.number,
            'phaseStatus', cr.phase_status,
            'pipelineId', cr.pipeline_id,
            'pullRequests', cr.pull_requests,
            'rejectionCount', cr.rejection_count,
            'title', cr.title,
            'updatedAt', cr.updated_at,
            'workspaceId', cr.workspace_id
          )
          order by cr.attention_rank asc, cr.updated_at desc, cr.id desc
        ) filter (where cr.id is not null),
        '[]'::jsonb
      ) as cards,
      case
        when coalesce(max(cr.remaining_count), 0) > v_limit then
          jsonb_build_object(
            'pipelineId', ld.pipeline_id,
            'stageId', ld.stage_id
          )
        else null
      end as next_cursor
    from lane_definitions ld
    left join lane_counts lc
      on lc.pipeline_id = ld.pipeline_id
     and lc.stage_id = ld.stage_id
    left join card_rows cr
      on cr.pipeline_id = ld.pipeline_id
     and cr.current_stage_id = ld.stage_id
    group by
      ld.pipeline_id,
      ld.pipeline_is_default,
      ld.pipeline_name,
      ld.description,
      ld.stage_id,
      ld.stage_name,
      ld.position,
      ld.slug,
      lc.total_count
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'cards', lp.cards,
        'cursor', lp.next_cursor,
        'description', lp.description,
        'id', lp.stage_id,
        'name', lp.stage_name,
        'pipeline', jsonb_build_object(
          'id', lp.pipeline_id,
          'isDefault', lp.pipeline_is_default,
          'name', lp.pipeline_name
        ),
        'position', lp.position,
        'slug', lp.slug,
        'totalCount', lp.total_count
      )
      order by
        lp.pipeline_is_default desc,
        lp.pipeline_name asc,
        lp.pipeline_id asc,
        lp.position asc,
        lp.stage_id asc
    ),
    '[]'::jsonb
  )
  into v_lanes
  from lane_pages lp;

  return jsonb_build_object('lanes', v_lanes);
end;
$$;

revoke all on function public.get_pipeline_dashboard_page(
  uuid,
  uuid,
  uuid,
  integer,
  uuid[]
) from public;

grant execute on function public.get_pipeline_dashboard_page(
  uuid,
  uuid,
  uuid,
  integer,
  uuid[]
) to authenticated;
