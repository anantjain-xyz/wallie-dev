create table internal.linear_issue_discovery_config (
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid primary key,
  revision bigint not null check (revision between 1 and 9007199254740991),
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  state_ids uuid[] not null check (cardinality(state_ids) between 1 and 20),
  label_id uuid,
  service_actor_id uuid,
  enabled boolean not null,
  next_scan_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade
);
create index linear_issue_discovery_due_idx
  on internal.linear_issue_discovery_config(next_scan_at, resource_id) where enabled;

create table internal.linear_issue_discovery_receipts (
  workspace_id uuid not null,
  external_tenant_id uuid not null,
  issue_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  session_id uuid not null unique,
  source_id uuid not null,
  actor_link_id uuid not null,
  source_event jsonb not null check (jsonb_typeof(source_event) = 'object'),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, external_tenant_id, issue_id),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade,
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  foreign key (session_id, source_id)
    references public.session_conversation_sources(session_id, id) on delete cascade
);
create index linear_issue_discovery_receipts_resource_idx
  on internal.linear_issue_discovery_receipts(workspace_id, factory_id, resource_id);

alter table internal.linear_issue_discovery_config enable row level security;
alter table internal.linear_issue_discovery_receipts enable row level security;
revoke all on internal.linear_issue_discovery_config, internal.linear_issue_discovery_receipts
  from public, anon, authenticated, service_role;

-- Only an admitted discovery transaction may create on behalf of a linked
-- Linear service identity. Command and automation permits keep their scope.
create table internal.linear_issue_discovery_permits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null,
  writer_repository_id uuid not null,
  transaction_id xid8 not null
);
alter table internal.linear_issue_discovery_permits enable row level security;
revoke all on internal.linear_issue_discovery_permits from public, anon, authenticated, service_role;

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
      ) or exists (
        select 1 from internal.linear_issue_discovery_permits permit
        where (permit.id, permit.workspace_id, permit.factory_id, permit.service_principal_id,
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

create function public.configure_linear_issue_discovery(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_resource_id uuid,
  p_expected_revision bigint, p_expected_mapping_revision bigint, p_state_ids uuid[],
  p_enabled boolean, p_label_id uuid default null, p_service_actor_id uuid default null
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  resource public.factory_connector_resources;
  configuration internal.linear_issue_discovery_config;
  installation internal.connector_installations;
  base record;
  definition_digest text;
  approved public.factory_execution_grants;
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_enabled is null or cardinality(coalesce(p_state_ids, '{}')) not between 1 and 20
    or cardinality(p_state_ids) <> (select count(distinct state_id) from unnest(p_state_ids) state_id) then
    raise exception 'Select one to twenty exact Linear states.' using errcode = '22023';
  end if;
  select target.* into resource from public.factory_connector_resources target
  where (target.workspace_id, target.factory_id, target.id, target.provider) =
    (p_workspace_id, p_factory_id, p_resource_id, 'linear'::public.connector_provider);
  if not found then raise exception 'Linear resource is unavailable.' using errcode = 'P0002'; end if;
  select * into strict installation from internal.connector_installations target
  where (target.workspace_id, target.id) = (p_workspace_id, resource.installation_id) for update;
  if resource.current_revision is distinct from p_expected_mapping_revision then
    raise exception 'Linear resource mapping changed.' using errcode = 'PT409';
  end if;
  select * into configuration from internal.linear_issue_discovery_config target
  where target.resource_id = p_resource_id for update;
  if coalesce(configuration.revision, 0::bigint) is distinct from p_expected_revision then
    raise exception 'Linear discovery configuration changed.' using errcode = 'PT409';
  end if;
  if p_enabled then
    perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
    perform internal.lock_connector_authority(installation, p_factory_id, resource.external_resource_id);
    if not exists (select 1 from public.read_connector_subscription(p_workspace_id, p_factory_id, p_resource_id)) then
      raise exception 'Linear subscription is unavailable.' using errcode = '42501';
    end if;
    select * into base from internal.factory_workflow_authoring_base(p_workspace_id, p_factory_id);
    if base.digest is null or (base.definition#>>'{implementationAgent,agentId}') is null
      or not (base.definition ? 'executionGrant' and base.definition ? 'credentialBindingId') then
      raise exception 'Publish a service-backed factory definition before enabling Linear discovery.' using errcode = 'PT422';
    end if;
    definition_digest := base.digest;
    approved := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, base.definition,
      (base.definition->>'repositoryId')::uuid, (base.definition->>'executionPolicyRevisionId')::uuid);
    if ('sessions:create'::public.factory_command_scope = any(approved.command_scopes)) is not true then
      raise exception 'Linear discovery requires session creation authority.' using errcode = '42501';
    end if;
    perform internal.lock_definition_credential_binding(p_workspace_id, p_factory_id, base.definition,
      approved.id, approved.service_principal_id);
    if p_service_actor_id is not null then
      perform 1 from public.resolve_connector_event_authority(p_workspace_id, p_factory_id, p_resource_id,
        installation.generation, resource.current_revision, 'linear', resource.external_tenant_id,
        p_service_actor_id::text, 'service', approved.id, approved.version);
    end if;
  elsif configuration.resource_id is null then
    raise exception 'Linear discovery configuration is unavailable.' using errcode = 'P0002';
  else
    definition_digest := configuration.definition_digest;
  end if;

  insert into internal.linear_issue_discovery_config (
    workspace_id, factory_id, resource_id, revision, definition_digest, state_ids, label_id, service_actor_id, enabled
  ) values (
    p_workspace_id, p_factory_id, p_resource_id, p_expected_revision + 1,
    definition_digest, p_state_ids, p_label_id, p_service_actor_id, p_enabled
  ) on conflict (resource_id) do update set revision = excluded.revision,
    definition_digest = excluded.definition_digest, state_ids = excluded.state_ids, label_id = excluded.label_id,
    service_actor_id = excluded.service_actor_id, enabled = excluded.enabled, next_scan_at = clock_timestamp();
  update internal.connector_subscription_cursors cursor_state
  set generation = cursor_state.generation + 1, position = null, updated_at = clock_timestamp()
  where (cursor_state.workspace_id, cursor_state.factory_id, cursor_state.resource_id, cursor_state.stream) =
    (p_workspace_id, p_factory_id, p_resource_id, 'linear-discovery');
  return p_expected_revision + 1;
end;
$$;

create function public.read_linear_issue_discovery_config(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'revision', coalesce(config.revision, 0), 'mappingRevision', resource.current_revision,
    'enabled', coalesce(config.enabled, false), 'stateIds', coalesce(config.state_ids, '{}'),
    'labelId', config.label_id, 'serviceActorId', config.service_actor_id
  )
  from public.factory_connector_resources resource
  left join internal.linear_issue_discovery_config config on config.resource_id = resource.id
  where (resource.workspace_id, resource.factory_id, resource.id, resource.provider) =
    (p_workspace_id, p_factory_id, p_resource_id, 'linear'::public.connector_provider)
    and auth.uid() is not null and internal.can_manage_factory(p_workspace_id, p_factory_id)
$$;

revoke all on function public.read_linear_issue_discovery_config(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_linear_issue_discovery_config(uuid, uuid, uuid) to authenticated;

create function public.claim_linear_issue_discovery(
  p_workspace_id uuid default null, p_skip_workspace_ids uuid[] default '{}'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare task record;
begin
  if cardinality(p_skip_workspace_ids) > 4 then
    raise exception 'Linear discovery skip list is too large.' using errcode = '22023';
  end if;
  select config.workspace_id, config.factory_id, config.resource_id, config.revision, config.state_ids, config.label_id, config.service_actor_id,
    resource.resource_kind, resource.external_resource_id, resource.external_tenant_id, subscription.*,
    secret.encrypted_value into task
  from internal.linear_issue_discovery_config config
  join public.factory_connector_resources resource on resource.id = config.resource_id
  cross join lateral public.read_connector_subscription(
    config.workspace_id, config.factory_id, config.resource_id, 'linear-discovery'
  ) subscription
  join public.workspace_secrets secret on (secret.workspace_id, secret.id, secret.material_revision) =
    (config.workspace_id, subscription.credential_ref, subscription.credential_material_revision)
    and secret.key = 'LINEAR_API_KEY'
  where config.enabled and config.next_scan_at <= clock_timestamp()
    and (p_workspace_id is null or config.workspace_id = p_workspace_id)
    and not (config.workspace_id = any(coalesce(p_skip_workspace_ids, '{}')))
    and subscription.credential_kind = 'workspace_secret'
  order by config.next_scan_at, config.resource_id
  limit 1 for update of config skip locked;
  if not found then return null; end if;

  update internal.linear_issue_discovery_config config
  set next_scan_at = clock_timestamp() + interval '60 seconds' where config.resource_id = task.resource_id;
  return jsonb_build_object(
    'workspaceId', task.workspace_id, 'factoryId', task.factory_id, 'resourceId', task.resource_id,
    'configRevision', task.revision, 'stateIds', task.state_ids, 'labelId', task.label_id,
    'serviceActorId', task.service_actor_id,
    'resourceKind', task.resource_kind, 'externalResourceId', task.external_resource_id,
    'externalTenantId', task.external_tenant_id, 'installationGeneration', task.installation_generation,
    'mappingRevision', task.mapping_revision, 'cursorGeneration', task.cursor_generation,
    'cursorPosition', task.cursor_position, 'encryptedApiKey', task.encrypted_value
  );
end;
$$;

create function public.commit_linear_issue_discovery_page(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_config_revision bigint,
  p_installation_generation bigint, p_mapping_revision bigint, p_cursor_generation bigint,
  p_external_tenant_id uuid, p_external_viewer_id uuid, p_issues jsonb, p_next_position text default null
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  resource public.factory_connector_resources;
  configuration internal.linear_issue_discovery_config;
  base record;
  approved public.factory_execution_grants;
  issue record;
  authority record;
  actor internal.session_mutation_actor;
  agent_id uuid;
  intent jsonb;
  accepted record;
  conflict_constraint text;
  retained_source_id uuid;
  permit_id uuid;
  actor_kind public.connector_actor_kind;
  admitted integer := 0;
begin
  if jsonb_typeof(p_issues) is distinct from 'array' then
    raise exception 'A Linear discovery page is required.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_issues) > 20 or octet_length(p_issues::text) > 2200000 then
    raise exception 'Linear discovery page exceeds its bounds.' using errcode = '22023';
  end if;

  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.factories factory
  where (factory.workspace_id, factory.id, factory.status) = (p_workspace_id, p_factory_id, 'active')
  for no key update;
  if not found then raise exception 'Linear discovery factory is unavailable.' using errcode = '42501'; end if;
  -- The cursor write and all admissions roll back together. The cursor RPC
  -- also locks the current installation, mapping and exact native secret.
  perform public.advance_connector_subscription_cursor(p_workspace_id, p_factory_id, p_resource_id,
    p_installation_generation, p_mapping_revision, 'linear-discovery', p_cursor_generation, p_next_position);
  select * into resource from public.factory_connector_resources target
  where (target.workspace_id, target.factory_id, target.id, target.provider, target.external_tenant_id) =
    (p_workspace_id, p_factory_id, p_resource_id, 'linear'::public.connector_provider, p_external_tenant_id::text);
  if not found then raise exception 'Linear discovery tenant is unavailable.' using errcode = '42501'; end if;
  select * into configuration from internal.linear_issue_discovery_config target
  where target.resource_id = p_resource_id and target.enabled for update;
  if configuration.revision is distinct from p_config_revision or configuration.resource_id is null then
    raise exception 'Linear discovery configuration changed.' using errcode = 'PT409';
  end if;
  if configuration.service_actor_id is not null
    and configuration.service_actor_id is distinct from p_external_viewer_id then
    raise exception 'Linear discovery returned a different service actor.' using errcode = '42501';
  end if;
  actor_kind := case when configuration.service_actor_id is null then 'human' else 'service' end;
  select * into base from internal.factory_workflow_authoring_base(p_workspace_id, p_factory_id);
  if base.digest is distinct from configuration.definition_digest then
    raise exception 'Linear discovery requires confirmation of the active factory definition.' using errcode = 'PT409';
  end if;
  agent_id := (base.definition#>>'{implementationAgent,agentId}')::uuid;
  approved := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, base.definition,
    (base.definition->>'repositoryId')::uuid, (base.definition->>'executionPolicyRevisionId')::uuid);
  if ('sessions:create'::public.factory_command_scope = any(approved.command_scopes)) is not true then
    raise exception 'Linear discovery requires session creation authority.' using errcode = '42501';
  end if;

  for issue in
    select * from jsonb_to_recordset(p_issues) observation(
      id uuid, identifier text, title text, description text, url text, team_id uuid, project_id uuid,
      state_id uuid, label_ids uuid[], creator_id uuid
    ) order by observation.id
  loop
    if issue.id is null or coalesce(configuration.service_actor_id, issue.creator_id) is null or issue.identifier is null
      or issue.identifier !~ '^[A-Z][A-Z0-9]*-[0-9]+$' or length(issue.identifier) > 80
      or length(coalesce(btrim(issue.title), '')) not between 1 and 200
      or length(coalesce(issue.description, '')) > 19500 or length(coalesce(issue.url, '')) > 2048
      or issue.url is null or issue.url !~ '^https://([A-Za-z0-9-]+[.])*linear[.]app/[^[:space:][:cntrl:]]+$'
      or strpos(issue.url, chr(92)) > 0
      or upper(substring(issue.url from '(?i)/issue/([A-Z][A-Z0-9]*-[0-9]+)(?:[/?#]|$)'))
        is distinct from issue.identifier
      or (issue.state_id = any(configuration.state_ids)) is not true
      or (configuration.label_id is not null and (configuration.label_id = any(issue.label_ids)) is not true)
      or (resource.resource_kind = 'team' and issue.team_id::text is distinct from resource.external_resource_id)
      or (resource.resource_kind = 'project' and issue.project_id::text is distinct from resource.external_resource_id) then
      continue;
    end if;
    if resource.resource_kind = 'team' and exists (
      select 1 from public.factory_connector_resources project
      join internal.linear_issue_discovery_config project_config on project_config.resource_id = project.id
      where (project.workspace_id, project.provider, project.external_tenant_id, project.resource_kind,
        project.external_resource_id) = (p_workspace_id, 'linear'::public.connector_provider,
        resource.external_tenant_id, 'project'::public.connector_resource_kind, issue.project_id::text)
    ) then continue; end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'linear-issue-discovery:' || p_workspace_id || ':' || p_external_tenant_id || ':' || issue.id, 0));
    if exists (
      select 1 from internal.linear_issue_discovery_receipts receipt
      where (receipt.workspace_id, receipt.external_tenant_id, receipt.issue_id) =
        (p_workspace_id, p_external_tenant_id, issue.id)
    ) or exists (
      select 1 from public.sessions session where session.workspace_id = p_workspace_id
        and session.linear_issue_id in (issue.identifier, issue.id::text)
    ) or exists (
      select 1 from internal.issue_automation_span_watermarks watermark
      where (watermark.workspace_id, watermark.source_namespace, watermark.source_issue_id) =
        (p_workspace_id, 'linear.issue-state', issue.id::text)
    ) then continue; end if;

    begin
      select * into strict authority from public.resolve_connector_event_authority(p_workspace_id, p_factory_id,
        p_resource_id, p_installation_generation, p_mapping_revision, 'linear', p_external_tenant_id::text,
        coalesce(configuration.service_actor_id, issue.creator_id)::text, actor_kind, approved.id, approved.version);
    exception when insufficient_privilege then
      -- Unlinked or revoked authors cannot delegate the factory's credentials.
      continue;
    end;
    permit_id := null;
    actor := row(p_workspace_id, p_factory_id, authority.initiating_member_id, authority.initiating_service_principal_id,
      null, approved.id, approved.version, approved.github_repository_id, null)::internal.session_mutation_actor;
    perform internal.lock_session_mutation_key(p_workspace_id, p_factory_id, 'create', issue.id);
    intent := internal.normalize_factory_session_mutation('create', jsonb_build_object(
      'title', issue.title, 'prompt', 'Work on the linked Linear issue.' || E'\n\n' || issue.title
        || E'\n\n' || coalesce(issue.description, ''),
      'agentId', agent_id, 'repositoryId', approved.github_repository_id, 'draftSpecification', false
    ));
    begin
      if actor_kind = 'service' then
        insert into internal.linear_issue_discovery_permits(
          workspace_id, factory_id, service_principal_id, execution_grant_id, execution_grant_version,
          writer_repository_id, transaction_id
        ) values (p_workspace_id, p_factory_id, approved.service_principal_id, approved.id, approved.version,
          approved.github_repository_id, pg_current_xact_id())
        returning id into permit_id;
        actor.admission_id := permit_id;
      end if;
      select * into strict accepted from internal.create_attributed_session(
        p_workspace_id, actor.member_id, intent->>'title', intent->>'prompt', null, null,
        session_linear_issue_id => issue.identifier, session_linear_issue_url => issue.url,
        session_github_repository_id => approved.github_repository_id, p_actor => actor,
        p_expected_agent_id => agent_id, p_expected_definition_digest => configuration.definition_digest
      );
    exception when unique_violation then
      get stacked diagnostics conflict_constraint = constraint_name;
      if conflict_constraint = 'sessions_workspace_linear_issue_idx' then continue; end if;
      raise;
    end;
    perform internal.record_session_mutation_receipt(actor, 'create', issue.id, intent, accepted.session_id,
      jsonb_build_object('sessionId', accepted.session_id, 'jobId', accepted.job_id, 'runId', accepted.run_id));
    delete from internal.linear_issue_discovery_permits permit where permit.id = permit_id;
    insert into public.session_conversation_sources (
      session_id, workspace_id, factory_id, provider, source_namespace, external_thread_id, label, source_url
    ) values (
      accepted.session_id, p_workspace_id, p_factory_id, 'linear', p_resource_id::text, issue.id::text,
      issue.identifier, issue.url
    ) returning id into retained_source_id;
    insert into internal.linear_issue_discovery_receipts(
      workspace_id, external_tenant_id, issue_id, factory_id, resource_id, session_id, source_id, actor_link_id, source_event
    ) values (
      p_workspace_id, p_external_tenant_id, issue.id, p_factory_id, p_resource_id,
      accepted.session_id, retained_source_id, authority.actor_link_id,
      internal.normalize_factory_automation_event(jsonb_build_object(
        'kind', 'issue-state', 'stateId', issue.state_id, 'teamId', issue.team_id, 'projectId', issue.project_id
      ))
    );
    admitted := admitted + 1;
  end loop;
  return admitted;
end;
$$;

revoke all on function public.configure_linear_issue_discovery(uuid, uuid, uuid, uuid, bigint, bigint, uuid[], boolean, uuid, uuid),
  public.claim_linear_issue_discovery(uuid, uuid[]),
  public.commit_linear_issue_discovery_page(uuid, uuid, uuid, bigint, bigint, bigint, bigint, uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_linear_issue_discovery(uuid, uuid, uuid, uuid, bigint, bigint, uuid[], boolean, uuid, uuid),
  public.claim_linear_issue_discovery(uuid, uuid[]),
  public.commit_linear_issue_discovery_page(uuid, uuid, uuid, bigint, bigint, bigint, bigint, uuid, uuid, jsonb, text)
  to service_role;
