create table internal.factory_monitoring_bindings (
  id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  repository_id uuid not null,
  deployment_source_id uuid not null,
  sentry_installation_id uuid not null,
  sentry_project_id text not null check (sentry_project_id ~ '^[1-9][0-9]{0,19}$'),
  encrypted_secret text not null,
  assignment jsonb not null,
  suppression_seconds integer not null check (suppression_seconds between 60 and 86400),
  approved_by_member_id uuid not null,
  approved_at timestamptz not null default clock_timestamp(),
  disabled_at timestamptz,
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id, repository_id, deployment_source_id)
    references internal.factory_deployment_sources (workspace_id, factory_id, repository_id, id) on delete cascade
);
create unique index factory_monitoring_binding_active_idx on internal.factory_monitoring_bindings
  (workspace_id, factory_id, deployment_source_id, sentry_installation_id, sentry_project_id)
  where disabled_at is null;

create table internal.factory_monitoring_incidents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  binding_id uuid not null,
  delivery_command_id uuid not null,
  deployment_id uuid not null,
  observation_id uuid not null,
  causing_session_id uuid not null,
  source_sha text not null,
  sentry_issue_id text not null,
  first_event_id text not null,
  first_event_at timestamptz not null,
  opened_at timestamptz not null,
  suppress_until timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'admitted', 'denied')),
  denial_reason text,
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null,
  session_id uuid unique,
  mutation_receipt_id uuid,
  check ((status = 'admitted') = (session_id is not null and mutation_receipt_id is not null)),
  check ((status = 'denied') = (denial_reason is not null)),
  foreign key (workspace_id, factory_id, binding_id)
    references internal.factory_monitoring_bindings (workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, delivery_command_id)
    references internal.factory_delivery_commands (workspace_id, factory_id, id) on delete cascade,
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions (id, workspace_id, factory_id) on delete cascade
);
create index factory_monitoring_pending_idx on internal.factory_monitoring_incidents (next_attempt_at, id)
  where status = 'pending';
create index factory_monitoring_active_factory_idx on internal.factory_monitoring_incidents (workspace_id, factory_id, status)
  where status in ('pending', 'admitted');
create index factory_monitoring_windows_idx on internal.factory_monitoring_incidents
  (binding_id, delivery_command_id, sentry_issue_id, suppress_until desc);

create table internal.factory_monitoring_signals (
  binding_id uuid not null references internal.factory_monitoring_bindings (id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  sentry_event_id text not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  body_digest text not null,
  incident_id uuid not null references internal.factory_monitoring_incidents (id) on delete cascade,
  primary key (binding_id, sentry_event_id)
);
create index factory_monitoring_factory_rate_idx on internal.factory_monitoring_signals
  (workspace_id, factory_id, recorded_at desc);
create index factory_monitoring_binding_rate_idx on internal.factory_monitoring_signals
  (binding_id, recorded_at desc);

create table internal.factory_monitoring_admission_permits (
  incident_id uuid primary key references internal.factory_monitoring_incidents (id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null,
  writer_repository_id uuid not null,
  transaction_id xid8 not null
);

alter table internal.factory_monitoring_bindings enable row level security;
alter table internal.factory_monitoring_incidents enable row level security;
alter table internal.factory_monitoring_signals enable row level security;
alter table internal.factory_monitoring_admission_permits enable row level security;
revoke all on internal.factory_monitoring_bindings, internal.factory_monitoring_incidents,
  internal.factory_monitoring_signals, internal.factory_monitoring_admission_permits
  from public, anon, authenticated, service_role;

create function internal.factory_monitoring_binding_summary(binding internal.factory_monitoring_bindings)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', binding.id, 'deploymentSourceId', binding.deployment_source_id,
    'installationId', binding.sentry_installation_id, 'projectId', binding.sentry_project_id,
    'suppressionSeconds', binding.suppression_seconds, 'approvedAt', binding.approved_at, 'disabledAt', binding.disabled_at)
$$;

create function public.approve_factory_monitoring_binding(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_binding_id uuid, p_deployment_source_id uuid,
  p_installation_id uuid, p_project_id text, p_encrypted_secret text, p_suppression_seconds integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  source internal.factory_deployment_sources;
  base record;
  approved public.factory_execution_grants;
  binding internal.factory_monitoring_bindings;
  assignment jsonb;
begin
  actor := internal.factory_automation_actor(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_binding_id is null or p_installation_id is null or p_project_id is null
    or p_project_id !~ '^[1-9][0-9]{0,19}$' or p_encrypted_secret is null
    or length(p_encrypted_secret) not between 40 and 1500
    or p_suppression_seconds is null or p_suppression_seconds not between 60 and 86400 then
    raise exception 'Invalid monitoring binding.' using errcode = '22023';
  end if;
  select candidate.* into source from internal.factory_deployment_sources candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_deployment_source_id)
    and candidate.revoked_at is null
  for share;
  if not found then raise exception 'Deployment source is unavailable.' using errcode = 'P0002'; end if;
  select * into base from internal.factory_workflow_authoring_base(p_workspace_id, p_factory_id);
  if (base.definition->>'repositoryId')::uuid is distinct from source.repository_id then
    raise exception 'The deployment and incident agent must use the same repository.' using errcode = 'PT422';
  end if;
  approved := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, base.definition, source.repository_id,
    (base.definition->>'executionPolicyRevisionId')::uuid);
  assignment := jsonb_build_object('target', jsonb_build_object(
    'kind', 'agent', 'definitionRevisionId', base.revision_id, 'agentId', base.definition#>>'{implementationAgent,agentId}'),
    'executionGrant', base.definition->'executionGrant', 'servicePrincipalId', approved.service_principal_id,
    'budgetPayerMemberId', approved.budget_payer_member_id, 'credentialBindingId', base.definition->>'credentialBindingId');
  perform internal.assert_factory_automation_target(p_workspace_id, p_factory_id, assignment);
  if (select count(*) from internal.factory_monitoring_bindings candidate
    where (candidate.workspace_id, candidate.factory_id) = (p_workspace_id, p_factory_id)
      and candidate.disabled_at is null) >= 10 then
    raise exception 'Too many active monitoring bindings.' using errcode = 'PT409';
  end if;
  insert into internal.factory_monitoring_bindings(
    id, workspace_id, factory_id, repository_id, deployment_source_id, sentry_installation_id,
    sentry_project_id, encrypted_secret, assignment, suppression_seconds, approved_by_member_id
  ) values (p_binding_id, p_workspace_id, p_factory_id, source.repository_id, source.id, p_installation_id,
    p_project_id, p_encrypted_secret, assignment, p_suppression_seconds, actor)
  returning * into binding;
  return internal.factory_monitoring_binding_summary(binding);
exception when unique_violation then
  raise exception 'A monitoring binding is already approved.' using errcode = 'PT409';
end;
$$;

create function public.disable_factory_monitoring_binding(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_binding_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare binding internal.factory_monitoring_bindings;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  update internal.factory_monitoring_bindings candidate
    set disabled_at = coalesce(candidate.disabled_at, clock_timestamp())
    where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_binding_id)
    returning * into binding;
  if not found then raise exception 'Monitoring binding is unavailable.' using errcode = 'P0002'; end if;
  return internal.factory_monitoring_binding_summary(binding);
end;
$$;

create function public.list_factory_monitoring_bindings(p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  return coalesce((
    select jsonb_agg(internal.factory_monitoring_binding_summary(binding) order by binding.approved_at desc)
    from (select candidate.* from internal.factory_monitoring_bindings candidate
      where (candidate.workspace_id, candidate.factory_id) = (p_workspace_id, p_factory_id) and candidate.disabled_at is null
      order by candidate.approved_at desc, candidate.id limit 10) binding
  ), '[]'::jsonb);
end;
$$;

create function public.read_factory_monitoring_secret(p_binding_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return (select jsonb_build_object('encryptedSecret', binding.encrypted_secret)
    from internal.factory_monitoring_bindings binding
    where binding.id = p_binding_id and binding.disabled_at is null);
end;
$$;

-- Follow the report writer's source, deployment, and command lock order. The
-- latest authenticated observation and the command correlation must agree.
create function internal.lock_factory_monitoring_deployment(
  p_binding internal.factory_monitoring_bindings, p_command_id uuid, p_environment text,
  p_source_sha text, p_event_at timestamptz
) returns table (deployment_id uuid, observation_id uuid, session_id uuid) language plpgsql set search_path = '' as $$
declare
  source internal.factory_deployment_sources;
  deployment internal.factory_deployments;
  observation internal.factory_deployment_observation_revisions;
  command internal.factory_delivery_commands;
begin
  select candidate.* into source from internal.factory_deployment_sources candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.repository_id, candidate.id, candidate.environment) =
    (p_binding.workspace_id, p_binding.factory_id, p_binding.repository_id, p_binding.deployment_source_id, p_environment)
    and candidate.revoked_at is null for share nowait;
  if not found then return; end if;
  select candidate.* into deployment from internal.factory_deployments candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.repository_id, candidate.provider,
    candidate.provider_project_id, candidate.environment, candidate.external_deployment_id) =
    (source.workspace_id, source.factory_id, source.repository_id, source.provider,
      source.provider_project_id, source.environment, p_command_id::text)
  for share nowait;
  if not found then return; end if;
  select candidate.* into observation from internal.factory_deployment_observation_revisions candidate
  where candidate.deployment_id = deployment.id order by candidate.revision desc limit 1;
  if not found or (observation.source_id, observation.source_sha, observation.outcome) is distinct from
    (source.id, p_source_sha, 'succeeded'::text)
    or coalesce(observation.authoritative_occurred_at, observation.observed_at) > p_event_at then return; end if;
  select candidate.* into command from internal.factory_delivery_commands candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.repository_id, candidate.id,
    candidate.provider, candidate.provider_project_id, candidate.environment, candidate.source_sha) =
    (source.workspace_id, source.factory_id, source.repository_id, p_command_id,
      source.provider, source.provider_project_id, source.environment, p_source_sha)
    and candidate.dispatch_state = 'accepted' and candidate.outcome = 'succeeded'
    and candidate.deployment_observation_id = observation.id
  for share nowait;
  if not found then return; end if;
  return query select deployment.id, observation.id, command.session_id;
end;
$$;

create function internal.factory_monitoring_cause_allowed(
  p_workspace_id uuid, p_factory_id uuid, p_source_session_id uuid
) returns boolean language sql stable set search_path = '' as $$
  select not exists (
    select 1 from internal.factory_monitoring_incidents incident
    where (incident.workspace_id, incident.factory_id) = (p_workspace_id, p_factory_id)
      and incident.session_id in (
        p_source_session_id,
        (select delegation.root_session_id from internal.factory_workflow_delegations delegation
          where (delegation.workspace_id, delegation.factory_id, delegation.child_session_id) =
          (p_workspace_id, p_factory_id, p_source_session_id))
      )
  )
$$;

create function public.record_factory_monitoring_signal(
  p_binding_id uuid, p_installation_id uuid, p_project_id text, p_event_id text, p_issue_id text,
  p_command_id uuid, p_environment text, p_source_sha text, p_event_at timestamptz, p_body_digest text
) returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '500ms' as $$
declare
  binding internal.factory_monitoring_bindings;
  signal internal.factory_monitoring_signals;
  incident internal.factory_monitoring_incidents;
  proof record;
  recorded_now timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_event_id is null or p_event_id !~ '^[a-f0-9]{32}$'
    or p_issue_id is null or p_issue_id !~ '^[1-9][0-9]{0,19}$'
    or p_command_id is null or p_source_sha is null or p_source_sha !~ '^[a-f0-9]{40}$'
    or p_body_digest is null or p_body_digest !~ '^[a-f0-9]{64}$'
    or p_event_at is null or not isfinite(p_event_at) then
    raise exception 'Invalid monitoring signal.' using errcode = '22023';
  end if;
  select candidate.* into binding from internal.factory_monitoring_bindings candidate
  where candidate.id = p_binding_id and candidate.disabled_at is null
    and (candidate.sentry_installation_id, candidate.sentry_project_id) = (p_installation_id, p_project_id);
  if not found then return jsonb_build_object('status', 'ignored'); end if;
  perform 1 from public.workspaces workspace where workspace.id = binding.workspace_id
    and workspace.deletion_requested_at is null for share nowait;
  if not found then return jsonb_build_object('status', 'ignored'); end if;
  -- Serialize the bounded ingress counters across bindings within this factory.
  perform 1 from public.factories factory where (factory.workspace_id, factory.id) = (binding.workspace_id, binding.factory_id)
    and factory.status = 'active' for no key update nowait;
  if not found then return jsonb_build_object('status', 'ignored'); end if;
  select candidate.* into binding from internal.factory_monitoring_bindings candidate
  where candidate.id = p_binding_id and candidate.disabled_at is null for share nowait;
  if not found then return jsonb_build_object('status', 'ignored'); end if;
  recorded_now := clock_timestamp();

  select prior.* into signal from internal.factory_monitoring_signals prior
  where (prior.binding_id, prior.sentry_event_id) = (p_binding_id, p_event_id);
  if found then
    if signal.body_digest <> p_body_digest then return jsonb_build_object('status', 'ignored'); end if;
    return jsonb_build_object('status', 'duplicate', 'incidentId', signal.incident_id);
  end if;
  if p_event_at < recorded_now - interval '1 hour' or p_event_at > recorded_now + interval '5 minutes' then
    return jsonb_build_object('status', 'ignored');
  end if;
  select * into proof from internal.lock_factory_monitoring_deployment(
    binding, p_command_id, p_environment, p_source_sha, p_event_at
  );
  if proof.deployment_id is null
    or not internal.factory_monitoring_cause_allowed(binding.workspace_id, binding.factory_id, proof.session_id) then
    return jsonb_build_object('status', 'ignored');
  end if;
  if (select count(*) from internal.factory_monitoring_signals recent
      where (recent.workspace_id, recent.factory_id) = (binding.workspace_id, binding.factory_id)
        and recent.recorded_at > recorded_now - interval '1 minute') >= 100
    or (select count(*) from internal.factory_monitoring_signals recent
      where recent.binding_id = binding.id and recent.recorded_at > recorded_now - interval '1 minute') >= 30 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  select candidate.* into incident from internal.factory_monitoring_incidents candidate
  where (candidate.binding_id, candidate.delivery_command_id, candidate.sentry_issue_id) =
    (binding.id, p_command_id, p_issue_id) and candidate.suppress_until > recorded_now
  order by candidate.suppress_until desc limit 1;
  if not found then
    if (select count(*) from internal.factory_monitoring_incidents pending
      where (pending.workspace_id, pending.factory_id) = (binding.workspace_id, binding.factory_id)
        and pending.status = 'pending') >= 24 then
      return jsonb_build_object('status', 'rate_limited');
    end if;
    insert into internal.factory_monitoring_incidents (
      workspace_id, factory_id, binding_id, delivery_command_id, deployment_id, observation_id,
      causing_session_id, source_sha, sentry_issue_id, first_event_id, first_event_at, opened_at, suppress_until, next_attempt_at
    ) values (binding.workspace_id, binding.factory_id, binding.id, p_command_id, proof.deployment_id, proof.observation_id,
      proof.session_id, p_source_sha, p_issue_id, p_event_id, p_event_at, recorded_now,
      recorded_now + make_interval(secs => binding.suppression_seconds), recorded_now)
    returning * into incident;
  end if;

  insert into internal.factory_monitoring_signals(
    binding_id, workspace_id, factory_id, sentry_event_id, occurred_at, recorded_at, body_digest, incident_id
  ) values (binding.id, binding.workspace_id, binding.factory_id, p_event_id, p_event_at, recorded_now, p_body_digest, incident.id);
  return jsonb_build_object('status', case when incident.first_event_id = p_event_id then 'queued' else 'suppressed' end,
    'incidentId', incident.id);
end;
$$;

create or replace function internal.assert_session_mutation_actor(
  p_actor internal.session_mutation_actor, p_operation public.factory_session_mutation_operation
) returns void language plpgsql set search_path = '' as $$
declare approved public.factory_execution_grants;
begin
  if (p_actor.grant_id is null) <> (p_actor.grant_version is null) then
    raise exception 'An exact grant version is required.' using errcode = '42501';
  end if;
  if p_actor.member_id is not null then
    if p_actor.service_principal_id is not null or p_actor.admission_id is not null or p_actor.consenting_member_id is not null then
      raise exception 'The session request actor is invalid.' using errcode = '42501';
    end if;
    perform internal.assert_session_mutation_human_access(p_actor.workspace_id, p_actor.factory_id, p_actor.member_id);
  elsif not exists (
    select 1 from internal.factory_command_admissions admission
    join internal.factory_command_leases lease on lease.admission_id = admission.id
    where (admission.id, admission.workspace_id, admission.factory_id, admission.service_principal_id,
      admission.execution_grant_id, admission.execution_grant_version, admission.scope, lease.verified_transaction) =
      (p_actor.admission_id, p_actor.workspace_id, p_actor.factory_id, p_actor.service_principal_id,
        p_actor.grant_id, p_actor.grant_version, internal.session_mutation_scope(p_operation), pg_current_xact_id())
      and admission.consenting_member_id is not distinct from p_actor.consenting_member_id
  ) and (
    p_operation = 'create' and p_actor.consenting_member_id is null and (
      exists (
        select 1 from internal.factory_automation_admission_permits permit
        where (permit.occurrence_id, permit.workspace_id, permit.factory_id, permit.service_principal_id,
          permit.execution_grant_id, permit.execution_grant_version, permit.writer_repository_id, permit.transaction_id) =
          (p_actor.admission_id, p_actor.workspace_id, p_actor.factory_id, p_actor.service_principal_id,
            p_actor.grant_id, p_actor.grant_version, p_actor.writer_repository_id, pg_current_xact_id())
      ) or exists (
        select 1 from internal.factory_monitoring_admission_permits permit
        where (permit.incident_id, permit.workspace_id, permit.factory_id, permit.service_principal_id,
          permit.execution_grant_id, permit.execution_grant_version, permit.writer_repository_id, permit.transaction_id) =
          (p_actor.admission_id, p_actor.workspace_id, p_actor.factory_id, p_actor.service_principal_id,
            p_actor.grant_id, p_actor.grant_version, p_actor.writer_repository_id, pg_current_xact_id())
      )
    )
  ) is not true then
    raise exception 'The session command admission is unavailable.' using errcode = '42501';
  end if;

  if p_actor.grant_id is not null and (p_actor.service_principal_id is not null or p_operation <> 'cancel') then
    approved := internal.require_factory_machine_grant(
      p_actor.workspace_id, p_actor.factory_id, p_actor.grant_id, p_actor.grant_version);
    if approved.github_repository_id is distinct from p_actor.writer_repository_id
      or (p_actor.service_principal_id is not null and approved.service_principal_id <> p_actor.service_principal_id) then
      raise exception 'The session command does not match the approved execution grant.' using errcode = '42501';
    end if;
  end if;
end;
$$;

create function internal.create_factory_monitoring_session(
  p_incident internal.factory_monitoring_incidents, p_binding internal.factory_monitoring_bindings, p_environment text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  approved public.factory_execution_grants;
  actor internal.session_mutation_actor;
  intent jsonb;
  result jsonb;
begin
  perform internal.assert_factory_automation_target(p_incident.workspace_id, p_incident.factory_id, p_binding.assignment);
  approved := internal.require_factory_machine_grant(p_incident.workspace_id, p_incident.factory_id,
    (p_binding.assignment#>>'{executionGrant,id}')::uuid, (p_binding.assignment#>>'{executionGrant,version}')::bigint);
  if approved.github_repository_id is distinct from p_binding.repository_id
    or ('sessions:create'::public.factory_command_scope = any(approved.command_scopes)) is not true
    or not exists (select 1 from public.execution_policy_revisions policy
      where (policy.workspace_id, policy.id) = (approved.workspace_id, approved.execution_policy_revision_id)
        and internal.valid_execution_requirements(policy.requirements)) then
    raise exception 'Incident execution authority is unavailable.' using errcode = 'PT422';
  end if;
  actor := row(p_incident.workspace_id, p_incident.factory_id, null, approved.service_principal_id,
    null, approved.id, approved.version, approved.github_repository_id, p_incident.id)::internal.session_mutation_actor;
  perform internal.lock_session_mutation_key(p_incident.workspace_id, p_incident.factory_id, 'create', p_incident.id);
  perform internal.assert_no_legacy_machine_creation_key(actor, p_incident.id);
  intent := internal.normalize_factory_session_mutation('create', jsonb_build_object(
    'title', 'Investigate Sentry issue ' || p_incident.sentry_issue_id,
    'prompt', 'Investigate the monitoring evidence and propose the next step for human review.' || E'\n\n'
      || jsonb_build_object('deploymentId', p_incident.deployment_id,
        'deliveryCommandId', p_incident.delivery_command_id, 'observationId', p_incident.observation_id,
        'sourceRevision', p_incident.source_sha, 'environment', p_environment,
        'sentryProjectId', p_binding.sentry_project_id, 'sentryIssueId', p_incident.sentry_issue_id,
        'sentryEventId', p_incident.first_event_id, 'eventAt', p_incident.first_event_at)::text,
    'agentId', p_binding.assignment#>>'{target,agentId}', 'repositoryId', approved.github_repository_id,
    'draftSpecification', false));
  insert into internal.factory_monitoring_admission_permits(
    incident_id, workspace_id, factory_id, service_principal_id, execution_grant_id, execution_grant_version,
    writer_repository_id, transaction_id
  ) values (p_incident.id, p_incident.workspace_id, p_incident.factory_id, approved.service_principal_id,
    approved.id, approved.version, approved.github_repository_id, pg_current_xact_id());
  result := internal.create_machine_session(actor, intent);
  result := internal.record_session_mutation_receipt(
    actor, 'create', p_incident.id, intent, (result->>'sessionId')::uuid, result
  );
  delete from internal.factory_monitoring_admission_permits permit where permit.incident_id = p_incident.id;
  return result;
end;
$$;

create function public.admit_next_factory_monitoring_incident()
returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '500ms' as $$
declare
  candidate record;
  incident internal.factory_monitoring_incidents;
  binding internal.factory_monitoring_bindings;
  workspace_deleting boolean;
  factory_status text;
  environment text;
  proof record;
  now_at timestamptz := clock_timestamp();
  disposition text;
  reason text;
  attempt_count integer;
  result jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  for candidate in
    select due.id, due.workspace_id, due.factory_id, due.binding_id
    from internal.factory_monitoring_incidents due
    where due.status = 'pending' and due.next_attempt_at <= now_at
    order by due.next_attempt_at, due.id limit 24
  loop
    select workspace.deletion_requested_at is not null into workspace_deleting
    from public.workspaces workspace where workspace.id = candidate.workspace_id for share skip locked;
    if not found then continue; end if;
    select factory.status into factory_status from public.factories factory
    where (factory.workspace_id, factory.id) = (candidate.workspace_id, candidate.factory_id)
    for no key update skip locked;
    if not found then continue; end if;
    select target.* into binding from internal.factory_monitoring_bindings target
    where target.id = candidate.binding_id for share skip locked;
    if not found then continue; end if;
    select due.* into incident from internal.factory_monitoring_incidents due
    where due.id = candidate.id and due.status = 'pending' and due.next_attempt_at <= now_at
    for update skip locked;
    if not found then continue; end if;

    disposition := 'denied';
    reason := null;
    attempt_count := incident.attempts;
    if workspace_deleting or factory_status <> 'active' or binding.disabled_at is not null then
      reason := 'monitor_unavailable';
    elsif incident.opened_at < now_at - interval '30 minutes' then
      reason := 'incident_expired';
    elsif (
      select count(*) from internal.factory_monitoring_incidents active
      join public.sessions session on (session.id, session.workspace_id, session.factory_id) =
        (active.session_id, active.workspace_id, active.factory_id)
      where (active.workspace_id, active.factory_id) = (incident.workspace_id, incident.factory_id)
        and active.status = 'admitted' and internal.factory_automation_session_is_active(session)
    ) >= 4 then
      disposition := 'pending';
    else
      attempt_count := attempt_count + 1;
      begin
        select source.environment into environment from internal.factory_deployment_sources source
          where source.id = binding.deployment_source_id;
        select * into proof from internal.lock_factory_monitoring_deployment(
          binding, incident.delivery_command_id, environment, incident.source_sha, incident.first_event_at
        );
        if (proof.observation_id, proof.session_id) is distinct from (incident.observation_id, incident.causing_session_id)
          or not internal.factory_monitoring_cause_allowed(incident.workspace_id, incident.factory_id, incident.causing_session_id) then
          reason := 'deployment_changed';
        else
          result := internal.create_factory_monitoring_session(incident, binding, environment);
          disposition := 'admitted';
        end if;
      exception when lock_not_available or sqlstate 'PT409' then
        if attempt_count < 5 then disposition := 'pending';
        else reason := 'retry_exhausted'; end if;
      when sqlstate 'PT422' or sqlstate 'P0002' or insufficient_privilege then
        reason := 'incident_authority_unavailable';
      end;
    end if;

    update internal.factory_monitoring_incidents target
      set status = disposition, denial_reason = reason, attempts = attempt_count,
        next_attempt_at = clock_timestamp() + interval '30 seconds',
        session_id = (result->>'sessionId')::uuid, mutation_receipt_id = (result->>'receiptId')::uuid
      where target.id = incident.id returning * into incident;
    return jsonb_build_object('incidentId', incident.id, 'status', incident.status, 'sessionId', incident.session_id);
  end loop;
  return null;
end;
$$;

create function internal.read_factory_monitoring_incident(p_session_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'deploymentId', incident.deployment_id, 'deliveryCommandId', incident.delivery_command_id,
    'deploymentObservationId', incident.observation_id, 'sourceRevision', incident.source_sha,
    'approvedHeadRevision', command.approved_head_sha, 'environment', command.environment,
    'sourceSessionNumber', source.number, 'sentryProjectId', binding.sentry_project_id,
    'sentryIssueId', incident.sentry_issue_id, 'sentryEventId', incident.first_event_id, 'eventAt', incident.first_event_at)
  from internal.factory_monitoring_incidents incident
  join internal.factory_monitoring_bindings binding on binding.id = incident.binding_id
  join internal.factory_delivery_commands command on (command.workspace_id, command.factory_id, command.id) =
    (incident.workspace_id, incident.factory_id, incident.delivery_command_id)
  join public.sessions source on (source.workspace_id, source.factory_id, source.id) =
    (incident.workspace_id, incident.factory_id, incident.causing_session_id)
  where incident.session_id = p_session_id and auth.uid() is not null
    and internal.can_access_factory(incident.workspace_id, incident.factory_id)
$$;

revoke all on function internal.factory_monitoring_binding_summary(internal.factory_monitoring_bindings),
  internal.lock_factory_monitoring_deployment(internal.factory_monitoring_bindings,uuid,text,text,timestamptz),
  internal.factory_monitoring_cause_allowed(uuid,uuid,uuid),
  internal.create_factory_monitoring_session(internal.factory_monitoring_incidents,internal.factory_monitoring_bindings,text),
  public.approve_factory_monitoring_binding(uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer),
  public.disable_factory_monitoring_binding(uuid,uuid,uuid,uuid),
  public.list_factory_monitoring_bindings(uuid,uuid,uuid),
  public.read_factory_monitoring_secret(uuid),
  public.record_factory_monitoring_signal(uuid,uuid,text,text,text,uuid,text,text,timestamptz,text),
  public.admit_next_factory_monitoring_incident(), internal.read_factory_monitoring_incident(uuid)
from public, anon, authenticated, service_role;

grant execute on function public.approve_factory_monitoring_binding(uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer),
  public.disable_factory_monitoring_binding(uuid,uuid,uuid,uuid), public.list_factory_monitoring_bindings(uuid,uuid,uuid),
  public.read_factory_monitoring_secret(uuid),
  public.record_factory_monitoring_signal(uuid,uuid,text,text,text,uuid,text,text,timestamptz,text),
  public.admit_next_factory_monitoring_incident() to service_role;

create or replace function public.get_session_detail_page(target_workspace_slug text, target_session_number integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare detail jsonb; specification_stage uuid; monitoring jsonb; resolved_session_id uuid;
begin
  detail := internal.get_session_detail_page(target_workspace_slug, target_session_number);
  resolved_session_id := (detail#>>'{session,id}')::uuid;
  if resolved_session_id is null then return detail; end if;
  select session.specification_stage_id into specification_stage from public.sessions session
  where session.id = resolved_session_id and session.execution_purpose = 'production';
  if not found then return null; end if;
  detail := jsonb_set(detail, '{session,specificationStageId}', coalesce(to_jsonb(specification_stage), 'null'::jsonb));
  monitoring := internal.read_factory_monitoring_incident(resolved_session_id);
  if monitoring is not null then detail := jsonb_set(detail, '{session,monitoring}', monitoring); end if;
  return detail;
end;
$$;
