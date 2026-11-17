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
  if (new.workspace_id, new.factory_id, new.member_id, new.granted_by_member_id, new.granted_at)
      is distinct from
     (old.workspace_id, old.factory_id, old.member_id, old.granted_by_member_id, old.granted_at) then
    raise exception 'Factory membership identity is immutable.' using errcode = '23514';
  end if;
  if old.revoked_at is not null and
     (new.revoked_at, new.revoked_by_member_id, new.revoke_reason) is distinct from
     (old.revoked_at, old.revoked_by_member_id, old.revoke_reason) then
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

-- Every existing active human member inherits the default factory. Workspace
-- managers become factory managers; ordinary members keep their existing reach.
insert into public.factory_members(workspace_id, factory_id, member_id, role)
select factory.workspace_id, factory.id, member.id,
  case when member.role in ('owner', 'admin') then 'manager' else 'member' end
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
    select factory.workspace_id, factory.id, new.id,
      case when new.role in ('owner', 'admin') then 'manager' else 'member' end
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
      jsonb_build_object('role', case when new.role in ('owner', 'admin') then 'manager' else 'member' end,
        'source', 'default_factory_inheritance');
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
-- without rewriting the original grant.
create function internal.audit_workspace_member_factory_suspension()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind <> 'human' or new.is_active = old.is_active then
    return new;
  end if;
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
  return new;
end;
$$;
revoke all on function internal.audit_workspace_member_factory_suspension()
  from public, anon, authenticated, service_role;
create trigger workspace_members_audit_factory_suspension
  after update of is_active on public.workspace_members
  for each row execute function internal.audit_workspace_member_factory_suspension();

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
  if new.creator_member_id is not null and not exists (
    select 1 from public.factory_members member
    join public.workspace_members workspace_member on workspace_member.id = member.member_id
    where member.workspace_id = new.workspace_id
      and member.factory_id = new.factory_id
      and member.member_id = new.creator_member_id
      and member.revoked_at is null
      and workspace_member.is_active
  ) then
    raise exception 'Session creator is not an active factory member.' using errcode = '42501';
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
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
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
    and member.kind = 'human'
    and member.is_active
  for share;
  if not found then
    raise exception 'Active workspace member required.' using errcode = '42501';
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
revoke all on function internal.assert_factory_manager(uuid, uuid, uuid)
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
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
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
    and member.is_active
  for share;
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
        where manager.workspace_id = p_workspace_id
          and manager.factory_id = p_factory_id
          and manager.role = 'manager'
          and manager.revoked_at is null
          and manager.member_id <> p_member_id
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
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
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
      where manager.workspace_id = p_workspace_id
        and manager.factory_id = p_factory_id
        and manager.role = 'manager'
        and manager.revoked_at is null
        and manager.member_id <> p_member_id
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