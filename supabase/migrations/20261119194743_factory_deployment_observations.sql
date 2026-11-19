-- Approval binds a reporter, its exact grant revision, and one provider
-- project, repository, and environment. Revocation never erases prior evidence.
create table internal.factory_deployment_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  repository_id uuid not null,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,31}$'),
  provider_project_id text not null check (provider_project_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  environment text not null check (environment ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null check (execution_grant_version > 0),
  provider_time_authoritative boolean not null,
  approved_by_member_id uuid not null,
  approved_at timestamptz not null default clock_timestamp(),
  revoked_by_member_id uuid,
  revoked_at timestamptz,
  check ((revoked_at is null) = (revoked_by_member_id is null)),
  unique (workspace_id, factory_id, repository_id, id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
create unique index factory_deployment_sources_one_active_idx
  on internal.factory_deployment_sources (
    workspace_id, factory_id, repository_id, provider, provider_project_id, environment
  ) where revoked_at is null;
alter table internal.factory_deployment_sources enable row level security;
revoke all on internal.factory_deployment_sources from public, anon, authenticated, service_role;

-- Provider identity survives credential rotation. A source cannot move the
-- same deployment into another environment or repository.
create table internal.factory_deployments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  repository_id uuid not null,
  provider text not null,
  provider_project_id text not null,
  environment text not null,
  external_deployment_id text not null check (external_deployment_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  unique (workspace_id, factory_id, repository_id, provider, provider_project_id, environment, external_deployment_id),
  unique (workspace_id, factory_id, repository_id, id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
alter table internal.factory_deployments enable row level security;
revoke all on internal.factory_deployments from public, anon, authenticated, service_role;

create table internal.factory_deployment_observation_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  repository_id uuid not null,
  deployment_id uuid not null,
  source_id uuid not null,
  revision integer not null check (revision > 0),
  outcome text not null check (outcome in ('pending', 'failed', 'unknown', 'succeeded')),
  source_sha text check (source_sha ~ '^[a-f0-9]{40}$'),
  provider_occurred_at timestamptz check (isfinite(provider_occurred_at)),
  authoritative_occurred_at timestamptz,
  observed_at timestamptz not null default clock_timestamp(),
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null check (execution_grant_version > 0),
  admission_id uuid not null,
  check (authoritative_occurred_at is null or authoritative_occurred_at is not distinct from provider_occurred_at),
  unique (deployment_id, revision),
  foreign key (workspace_id, factory_id, repository_id, deployment_id)
    references internal.factory_deployments (workspace_id, factory_id, repository_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, repository_id, source_id)
    references internal.factory_deployment_sources (workspace_id, factory_id, repository_id, id) on delete cascade
);
create index factory_deployment_revisions_source_idx
  on internal.factory_deployment_observation_revisions (source_id);
alter table internal.factory_deployment_observation_revisions enable row level security;
revoke all on internal.factory_deployment_observation_revisions from public, anon, authenticated, service_role;

create function internal.guard_factory_deployment_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factories factory
    where (factory.workspace_id, factory.id) = (old.workspace_id, old.factory_id)
  ) then return old; end if;
  if tg_op = 'UPDATE' and tg_table_name = 'factory_deployment_sources' then
    if old.revoked_at is null and new.revoked_at is not null
      and to_jsonb(old) - 'revoked_at' - 'revoked_by_member_id'
        = to_jsonb(new) - 'revoked_at' - 'revoked_by_member_id' then return new; end if;
  end if;
  raise exception 'Factory deployment evidence is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.guard_factory_deployment_history() from public, anon, authenticated, service_role;
create trigger factory_deployment_sources_immutable before update or delete on internal.factory_deployment_sources
  for each row execute function internal.guard_factory_deployment_history();
create trigger factory_deployments_immutable before update or delete on internal.factory_deployments
  for each row execute function internal.guard_factory_deployment_history();
create trigger factory_deployment_revisions_immutable before update or delete on internal.factory_deployment_observation_revisions
  for each row execute function internal.guard_factory_deployment_history();

-- Choose the provider's latest revision, independent of reporting order. A
-- trustworthy successful outcome still needs a scoped exact source-change match.
create view internal.factory_current_deployment_observations with (security_invoker = true) as
  select deployment.workspace_id, deployment.factory_id, deployment.repository_id,
    deployment.id as deployment_id, deployment.provider, deployment.provider_project_id, deployment.environment,
    deployment.external_deployment_id, report.id as observation_id, report.revision, report.outcome, report.source_sha,
    report.provider_occurred_at, report.authoritative_occurred_at, report.observed_at, report.source_id
  from internal.factory_deployments deployment
  cross join lateral (
    select observation.id, observation.revision, observation.outcome, observation.source_sha,
      observation.provider_occurred_at, observation.authoritative_occurred_at, observation.observed_at, observation.source_id
    from internal.factory_deployment_observation_revisions observation
    where observation.deployment_id = deployment.id
    order by observation.revision desc
    limit 1
  ) report;
revoke all on internal.factory_current_deployment_observations from public, anon, authenticated, service_role;

create function internal.factory_deployment_source_summary(source internal.factory_deployment_sources)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('sourceId', source.id, 'repositoryId', source.repository_id,
    'provider', source.provider, 'providerProjectId', source.provider_project_id, 'environment', source.environment,
    'servicePrincipalId', source.service_principal_id, 'executionGrantId', source.execution_grant_id,
    'executionGrantVersion', source.execution_grant_version, 'providerTimeAuthoritative', source.provider_time_authoritative,
    'approvedAt', source.approved_at, 'revokedAt', source.revoked_at);
$$;
revoke all on function internal.factory_deployment_source_summary(internal.factory_deployment_sources)
  from public, anon, authenticated, service_role;

create function public.approve_factory_deployment_source(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_execution_grant_id uuid,
  p_execution_grant_version bigint, p_provider text, p_provider_project_id text, p_environment text,
  p_provider_time_authoritative boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  manager_id uuid;
  approved public.factory_execution_grants;
  source internal.factory_deployment_sources;
begin
  manager_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  approved := internal.require_factory_machine_grant(p_workspace_id, p_factory_id,
    p_execution_grant_id, p_execution_grant_version);
  if not ('deployments:observe'::public.factory_command_scope = any(approved.command_scopes)) then
    raise exception 'The execution grant does not allow deployment observations.' using errcode = 'PT403';
  end if;

  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_-]{0,31}$'
    or p_provider_project_id is null or p_provider_project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    or p_environment is null or p_environment !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
    or p_provider_time_authoritative is null then
    raise exception 'Invalid deployment source identity.' using errcode = '22023';
  end if;
  insert into internal.factory_deployment_sources (
    workspace_id, factory_id, repository_id, provider, provider_project_id, environment,
    service_principal_id, execution_grant_id, execution_grant_version, provider_time_authoritative, approved_by_member_id
  ) values (
    p_workspace_id, p_factory_id, approved.github_repository_id, p_provider, p_provider_project_id, p_environment,
    approved.service_principal_id, approved.id, approved.version, p_provider_time_authoritative, manager_id
  ) returning * into source;
  return internal.factory_deployment_source_summary(source);
exception when unique_violation then
  raise exception 'A deployment source is already approved for this environment.' using errcode = 'PT409';
end;
$$;
revoke all on function public.approve_factory_deployment_source(uuid, uuid, uuid, uuid, bigint, text, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_factory_deployment_source(uuid, uuid, uuid, uuid, bigint, text, text, text, boolean)
  to service_role;

create function public.revoke_factory_deployment_source(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_source_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  manager_id uuid;
  source internal.factory_deployment_sources;
begin
  manager_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select target.* into source from internal.factory_deployment_sources target
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_source_id)
  for update;
  if not found then raise exception 'Deployment source not found.' using errcode = 'P0002'; end if;
  if source.revoked_at is null then
    update internal.factory_deployment_sources target set revoked_at = clock_timestamp(), revoked_by_member_id = manager_id
    where target.id = source.id returning * into source;
  end if;
  return internal.factory_deployment_source_summary(source);
end;
$$;
revoke all on function public.revoke_factory_deployment_source(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_factory_deployment_source(uuid, uuid, uuid, uuid) to service_role;

create function public.execute_factory_deployment_observation(
  p_workspace_id uuid, p_factory_id uuid, p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid, p_credential_digest text, p_request_id uuid, p_request_hash text, p_surface public.factory_command_surface,
  p_admission_id uuid, p_lease_id uuid, p_source_id uuid, p_environment text,
  p_external_deployment_id text, p_revision integer, p_outcome text,
  p_source_sha text default null, p_provider_occurred_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  accepted internal.factory_command_admissions;
  source internal.factory_deployment_sources;
  deployment internal.factory_deployments;
  observation internal.factory_deployment_observation_revisions;
  current_revision integer;
  replayed boolean;
begin
  if p_surface is distinct from 'api'::public.factory_command_surface then
    raise exception 'Deployment observations require the factory API.' using errcode = 'PT403';
  end if;
  accepted := internal.require_factory_command(
    p_workspace_id, p_factory_id, p_credential_kind, p_credential_id, p_credential_digest,
    'deployments:observe', p_request_id, p_request_hash, p_surface, p_admission_id, p_lease_id
  );

  select target.* into source from internal.factory_deployment_sources target
    where (target.workspace_id, target.factory_id, target.id, target.environment) =
      (accepted.workspace_id, accepted.factory_id, p_source_id, p_environment)
      and (target.service_principal_id, target.execution_grant_id, target.execution_grant_version) =
        (accepted.service_principal_id, accepted.execution_grant_id, accepted.execution_grant_version)
      and target.revoked_at is null
    for share;
  if not found then raise exception 'Deployment source or environment is not authorized.' using errcode = 'PT403'; end if;

  if p_external_deployment_id is null or p_external_deployment_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'
    or p_revision is null or p_revision < 1 or p_outcome is null
    or p_outcome not in ('pending', 'failed', 'unknown', 'succeeded')
    or (p_source_sha is not null and p_source_sha !~ '^[a-f0-9]{40}$')
    or (p_provider_occurred_at is not null and not isfinite(p_provider_occurred_at)) then
    raise exception 'Invalid deployment observation.' using errcode = '22023';
  end if;

  insert into internal.factory_deployments (
    workspace_id, factory_id, repository_id, provider, provider_project_id, environment, external_deployment_id
  ) values (
    source.workspace_id, source.factory_id, source.repository_id, source.provider,
    source.provider_project_id, source.environment, p_external_deployment_id
  ) on conflict (workspace_id, factory_id, repository_id, provider, provider_project_id, environment, external_deployment_id)
    do nothing;
  select identity.* into strict deployment from internal.factory_deployments identity
    where (identity.workspace_id, identity.factory_id, identity.repository_id, identity.provider,
      identity.provider_project_id, identity.environment, identity.external_deployment_id) =
      (source.workspace_id, source.factory_id, source.repository_id, source.provider,
      source.provider_project_id, source.environment, p_external_deployment_id)
    for update;

  select report.* into observation from internal.factory_deployment_observation_revisions report
  where (report.deployment_id, report.revision) = (deployment.id, p_revision);
  replayed := found;
  if replayed then
    if (observation.outcome, observation.source_sha, observation.provider_occurred_at)
      is distinct from (p_outcome, p_source_sha, p_provider_occurred_at) then
      raise exception 'This deployment revision identifies a different observation.' using errcode = 'PT409';
    end if;
  else
    insert into internal.factory_deployment_observation_revisions (
      workspace_id, factory_id, repository_id, deployment_id, source_id, revision, outcome, source_sha,
      provider_occurred_at, authoritative_occurred_at, service_principal_id, execution_grant_id,
      execution_grant_version, admission_id
    ) values (
      source.workspace_id, source.factory_id, source.repository_id, deployment.id, source.id, p_revision, p_outcome, p_source_sha,
      p_provider_occurred_at,
      case when source.provider_time_authoritative and p_provider_occurred_at <= clock_timestamp()
        then p_provider_occurred_at end,
      source.service_principal_id, source.execution_grant_id, source.execution_grant_version, accepted.id
    ) returning * into observation;
    perform internal.record_factory_outcome_observation(
      observation.workspace_id, observation.factory_id, 'deployment.observed', 'deployment_report', observation.id::text,
      coalesce(observation.authoritative_occurred_at, observation.observed_at),
      p_repository_id => observation.repository_id, p_actor_service_principal_id => observation.service_principal_id,
      p_status => observation.outcome
    );
  end if;

  select report.revision into strict current_revision
  from internal.factory_deployment_observation_revisions report
  where report.deployment_id = deployment.id order by report.revision desc limit 1;
  perform internal.record_factory_command_use(p_admission_id, p_lease_id);
  return jsonb_build_object(
    'deploymentId', deployment.id, 'observationId', observation.id, 'revision', observation.revision,
    'currentRevision', current_revision, 'repositoryId', observation.repository_id, 'sourceRevision', observation.source_sha,
    'environment', deployment.environment, 'outcome', observation.outcome, 'providerOccurredAt', observation.provider_occurred_at,
    'authoritativeOccurredAt', observation.authoritative_occurred_at, 'observedAt', observation.observed_at, 'replayed', replayed
  );
end;
$$;
revoke all on function public.execute_factory_deployment_observation(
  uuid, uuid, public.factory_command_credential_kind, uuid, text, uuid, text, public.factory_command_surface,
  uuid, uuid, uuid, text, text, integer, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.execute_factory_deployment_observation(
  uuid, uuid, public.factory_command_credential_kind, uuid, text, uuid, text, public.factory_command_surface,
  uuid, uuid, uuid, text, text, integer, text, text, timestamptz
) to service_role;
