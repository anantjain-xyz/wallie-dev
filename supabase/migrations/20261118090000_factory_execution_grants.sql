-- Service principals are factory identities. They cannot inherit membership,
-- sign in as a user or satisfy a human approval through this schema.
create table public.service_principals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) <= 60),
  created_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, slug),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table public.factory_execution_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  service_principal_id uuid not null,
  github_repository_id uuid not null,
  read_context_repository_ids uuid[] not null,
  tool_ids text[] not null,
  execution_policy_revision_id uuid not null,
  budget_payer_member_id uuid not null,
  version bigint not null check (version between 1 and 9007199254740991),
  approved_by_member_id uuid not null,
  approved_at timestamptz not null,
  expires_at timestamptz not null check (isfinite(expires_at) and expires_at > approved_at),
  revoked_at timestamptz,
  revoked_by_member_id uuid,
  revocation_reason text,
  foreign key (workspace_id, factory_id, service_principal_id)
    references public.service_principals(workspace_id, factory_id, id) on delete cascade,
  check ((revoked_at is null and revoked_by_member_id is null and revocation_reason is null)
    or (revoked_at is not null and revoked_by_member_id is not null and revoked_at >= approved_at))
);
create index factory_execution_grants_scope_idx
  on public.factory_execution_grants(workspace_id, factory_id, service_principal_id);

alter table public.service_principals enable row level security;
alter table public.factory_execution_grants enable row level security;
revoke all on public.service_principals, public.factory_execution_grants from public, anon, authenticated, service_role;
grant select on public.service_principals, public.factory_execution_grants to authenticated, service_role;
create policy service_principals_manager_read on public.service_principals for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));
create policy factory_execution_grants_manager_read on public.factory_execution_grants for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));

alter table public.factory_audit_events
  drop constraint factory_audit_events_action_check,
  add constraint factory_audit_events_action_check check (action in (
    'factory.created', 'factory.archived', 'factory.restored',
    'membership.granted', 'membership.revoked', 'membership.suspended', 'membership.reinstated',
    'agent.created', 'agent.prompt_revision_created',
    'skill.created', 'skill.revision_created', 'skill.revision_revoked',
    'service_principal.created', 'execution_grant.approved', 'execution_grant.updated', 'execution_grant.revoked'
  ));

-- Repository and payer UUIDs are historical attribution. Revoking their live
-- access must never erase the grant or redirect it to a different identity.
create function internal.factory_execution_scope_is_current(
  p_workspace_id uuid, p_factory_id uuid, p_github_repository_id uuid,
  p_read_context_repository_ids uuid[], p_execution_policy_revision_id uuid,
  p_budget_payer_member_id uuid
) returns boolean language plpgsql set search_path = '' as $$
declare repository_count integer;
begin
  perform 1 from public.workspace_members payer
  where (payer.workspace_id, payer.id) = (p_workspace_id, p_budget_payer_member_id)
    and payer.kind = 'human' and payer.is_active
  for share nowait;
  if not found then return false; end if;

  if not exists (
    select 1 from public.execution_policy_revisions policy
    where (policy.workspace_id, policy.id) = (p_workspace_id, p_execution_policy_revision_id)
  ) then
    return false;
  end if;

  select count(*) into repository_count from (
    select repository.id from public.github_repositories repository
    join public.github_installations installation
      on (installation.workspace_id, installation.id) = (repository.workspace_id, repository.github_installation_id)
    where (repository.workspace_id, repository.factory_id) = (p_workspace_id, p_factory_id)
      and repository.id = any(array_prepend(p_github_repository_id, p_read_context_repository_ids))
      and not repository.is_archived and not installation.suspended
    order by installation.id, repository.id
    for share of repository, installation nowait
  ) as authorized;
  return repository_count = 1 + cardinality(p_read_context_repository_ids);
exception when lock_not_available then
  raise exception 'Execution grant access is changing. Retry the operation.' using errcode = 'PT409';
end;
$$;
revoke all on function internal.factory_execution_scope_is_current(uuid, uuid, uuid, uuid[], uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.create_service_principal(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_name text, p_slug text
) returns public.service_principals
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  principal public.service_principals;
  principal_name text := btrim(coalesce(p_name, ''));
  principal_slug text := btrim(coalesce(p_slug, ''));
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if char_length(principal_name) not between 1 and 120
    or principal_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or char_length(principal_slug) > 60 then
    raise exception 'Provide a name and lowercase hyphenated slug for the service principal.' using errcode = '22023';
  end if;

  insert into public.service_principals(workspace_id, factory_id, name, slug, created_by_member_id)
    values (p_workspace_id, p_factory_id, principal_name, principal_slug, actor_member_id)
    returning * into principal;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id, 'service_principal.created', actor_member_id,
      jsonb_build_object('id', principal.id, 'name', principal.name, 'slug', principal.slug));
  return principal;
exception when unique_violation then
  raise exception 'A service principal already uses this slug in the factory.' using errcode = 'PT409';
end;
$$;
revoke all on function public.create_service_principal(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_service_principal(uuid, uuid, uuid, text, text) to service_role;

create function public.approve_factory_execution_grant(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_service_principal_id uuid,
  p_github_repository_id uuid, p_read_context_repository_ids uuid[], p_tool_ids text[],
  p_execution_policy_revision_id uuid, p_budget_payer_member_id uuid, p_expires_at timestamptz,
  p_expected_version bigint, p_grant_id uuid default null
) returns public.factory_execution_grants
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  execution_grant public.factory_execution_grants;
  decision_time timestamptz;
begin
  actor_member_id := internal.assert_factory_manager(
    p_workspace_id, p_factory_id, p_actor_user_id, p_budget_payer_member_id
  );
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_grant_id is not null then
    select * into execution_grant from public.factory_execution_grants target
    where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_grant_id)
    for update;
    if not found then raise exception 'Execution grant not found.' using errcode = 'P0002'; end if;
    if execution_grant.revoked_at is not null then
      raise exception 'A revoked execution grant cannot be changed.' using errcode = 'PT409';
    end if;
    if execution_grant.service_principal_id is distinct from p_service_principal_id then
      raise exception 'The service principal on an execution grant is fixed.' using errcode = '22023';
    end if;
  end if;
  if p_expected_version is distinct from coalesce(execution_grant.version, 0) then
    raise exception 'Execution grant changed. Reload before saving.' using errcode = 'PT409';
  end if;

  if not exists (
    select 1 from public.service_principals principal
    where (principal.workspace_id, principal.factory_id, principal.id) =
      (p_workspace_id, p_factory_id, p_service_principal_id)
  ) then
    raise exception 'Service principal not found.' using errcode = 'P0002';
  end if;
  if p_github_repository_id is null
    or p_read_context_repository_ids is null
    or cardinality(p_read_context_repository_ids) > 50
    or array_position(p_read_context_repository_ids, null) is not null
    or p_github_repository_id = any(p_read_context_repository_ids)
    or cardinality(p_read_context_repository_ids) <> (select count(distinct id) from unnest(p_read_context_repository_ids) id)
    or p_tool_ids is null or cardinality(p_tool_ids) > 32
    or array_position(p_tool_ids, null) is not null
    or cardinality(p_tool_ids) <> (select count(distinct id) from unnest(p_tool_ids) id)
    or exists (select 1 from unnest(p_tool_ids) id where id !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$')
    or internal.factory_execution_scope_is_current(p_workspace_id, p_factory_id, p_github_repository_id,
          p_read_context_repository_ids, p_execution_policy_revision_id, p_budget_payer_member_id) is not true then
    raise exception 'Execution grant scope must name live repositories, explicit tools, a workspace budget and an active payer.'
      using errcode = '22023';
  end if;

  decision_time := clock_timestamp();
  if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at <= decision_time then
    raise exception 'Execution grant expiry must be a finite future time.' using errcode = '22023';
  end if;
  if p_grant_id is null then
    insert into public.factory_execution_grants(
      workspace_id, factory_id, service_principal_id, github_repository_id, read_context_repository_ids,
      tool_ids, execution_policy_revision_id, budget_payer_member_id, version, approved_by_member_id, approved_at, expires_at
    ) values (p_workspace_id, p_factory_id, p_service_principal_id, p_github_repository_id, p_read_context_repository_ids,
      p_tool_ids, p_execution_policy_revision_id, p_budget_payer_member_id, 1, actor_member_id, decision_time, p_expires_at)
    returning * into execution_grant;
  else
    update public.factory_execution_grants target set
      github_repository_id = p_github_repository_id,
      read_context_repository_ids = p_read_context_repository_ids,
      tool_ids = p_tool_ids,
      execution_policy_revision_id = p_execution_policy_revision_id,
      budget_payer_member_id = p_budget_payer_member_id,
      version = target.version + 1,
      approved_by_member_id = actor_member_id,
      approved_at = decision_time,
      expires_at = p_expires_at
    where target.id = p_grant_id returning * into execution_grant;
  end if;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id,
      case when p_grant_id is null then 'execution_grant.approved' else 'execution_grant.updated' end,
      actor_member_id, to_jsonb(execution_grant));
  return execution_grant;
end;
$$;
revoke all on function public.approve_factory_execution_grant(uuid, uuid, uuid, uuid, uuid, uuid[], text[], uuid, uuid, timestamptz, bigint, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_factory_execution_grant(uuid, uuid, uuid, uuid, uuid, uuid[], text[], uuid, uuid, timestamptz, bigint, uuid)
  to service_role;

create function public.revoke_factory_execution_grant(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_grant_id uuid,
  p_expected_version bigint, p_reason text default null
) returns public.factory_execution_grants
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  execution_grant public.factory_execution_grants;
  reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into execution_grant from public.factory_execution_grants target
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_grant_id)
  for update;
  if not found then raise exception 'Execution grant not found.' using errcode = 'P0002'; end if;
  if execution_grant.version is distinct from p_expected_version or execution_grant.revoked_at is not null then
    raise exception 'Execution grant changed. Reload before revoking.' using errcode = 'PT409';
  end if;
  if octet_length(reason) > 400 or reason ~ '[[:cntrl:]]' then
    raise exception 'Use a single-line revocation reason of up to 400 bytes.' using errcode = '22023';
  end if;

  update public.factory_execution_grants target set
    version = target.version + 1,
    revoked_at = clock_timestamp(),
    revoked_by_member_id = actor_member_id,
    revocation_reason = reason
  where target.id = p_grant_id returning * into execution_grant;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id, 'execution_grant.revoked', actor_member_id, to_jsonb(execution_grant));
  return execution_grant;
end;
$$;
revoke all on function public.revoke_factory_execution_grant(uuid, uuid, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_factory_execution_grant(uuid, uuid, uuid, uuid, bigint, text) to service_role;

-- A pinned grant is an identity and version, never a cached authorization.
-- Share locks keep the winning grant decision and live access through commit.
create function internal.require_current_factory_execution_grant(
  p_workspace_id uuid, p_factory_id uuid, p_grant_id uuid, p_expected_version bigint,
  p_repository_id uuid, p_read_context_repository_ids uuid[], p_tool_ids text[], p_execution_policy_revision_id uuid
) returns public.factory_execution_grants language plpgsql set search_path = '' as $$
declare execution_grant public.factory_execution_grants;
begin
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select * into execution_grant from public.factory_execution_grants target
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_grant_id)
  for share;
  if not found or execution_grant.revoked_at is not null
    or execution_grant.version is distinct from p_expected_version
    or execution_grant.expires_at <= clock_timestamp()
    or execution_grant.github_repository_id is distinct from p_repository_id
    or execution_grant.execution_policy_revision_id is distinct from p_execution_policy_revision_id
    or (p_read_context_repository_ids <@ execution_grant.read_context_repository_ids) is not true
    or (p_tool_ids <@ execution_grant.tool_ids) is not true
    or internal.factory_execution_scope_is_current(p_workspace_id, p_factory_id, p_repository_id,
      p_read_context_repository_ids, p_execution_policy_revision_id, execution_grant.budget_payer_member_id) is not true
    or execution_grant.expires_at <= clock_timestamp() then
    raise exception 'Execution grant is unavailable or does not authorize these resources.' using errcode = '42501';
  end if;
  return execution_grant;
end;
$$;
revoke all on function internal.require_current_factory_execution_grant(uuid, uuid, uuid, bigint, uuid, uuid[], text[], uuid)
  from public, anon, authenticated, service_role;
