alter table internal.linear_issue_discovery_receipts
  add column origin_span_id text,
  add column origin_span_started_at timestamptz,
  add column origin_issue_updated_at timestamptz,
  add constraint linear_discovery_consistent_origin_span check (
    num_nonnulls(origin_span_id, origin_span_started_at, origin_issue_updated_at) = 0
    or (
      num_nonnulls(origin_span_id, origin_span_started_at, origin_issue_updated_at) = 3
      and length(origin_span_id) between 1 and 160 and origin_span_id !~ '[[:space:][:cntrl:]]'
      and isfinite(origin_span_started_at) and isfinite(origin_issue_updated_at)
      and origin_span_started_at <= origin_issue_updated_at
    )
  );

create table internal.linear_connector_outbound_policies (
  resource_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  mapping_revision bigint not null,
  comments_enabled boolean not null,
  status_team_id uuid,
  status_from_state_id uuid,
  status_to_state_id uuid,
  check (num_nonnulls(status_team_id, status_from_state_id, status_to_state_id) in (0, 3)),
  check (status_from_state_id is distinct from status_to_state_id or status_team_id is null),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade
);

create table internal.linear_connector_notice_targets (
  delivery_id uuid primary key references internal.connector_outbound_deliveries(id) on delete cascade,
  policy_revision bigint not null,
  mapping_revision bigint not null,
  kind text not null check (kind in ('progress', 'review_ready', 'outcome', 'linear_status')),
  expected_phase public.pipeline_phase_status not null,
  artifact_id uuid,
  from_state_id uuid,
  to_state_id uuid,
  check ((kind = 'review_ready') = (artifact_id is not null)),
  check (num_nonnulls(from_state_id, to_state_id) = case when kind = 'linear_status' then 2 else 0 end)
);

alter table internal.linear_connector_outbound_policies enable row level security;
alter table internal.linear_connector_notice_targets enable row level security;
revoke all on internal.linear_connector_outbound_policies, internal.linear_connector_notice_targets
  from public, anon, authenticated, service_role;

create function public.configure_linear_connector_outbound(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_resource_id uuid,
  p_expected_revision bigint, p_expected_mapping_revision bigint, p_comments_enabled boolean,
  p_status_team_id uuid default null, p_status_from_state_id uuid default null,
  p_status_to_state_id uuid default null
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  resource public.factory_connector_resources;
  installation internal.connector_installations;
  policy internal.linear_connector_outbound_policies;
  next_revision bigint;
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_comments_enabled is null
    or num_nonnulls(p_status_team_id, p_status_from_state_id, p_status_to_state_id) not in (0, 3)
    or (p_status_team_id is not null and p_status_from_state_id = p_status_to_state_id) then
    raise exception 'Linear writes require an explicit access and status mapping choice.' using errcode = '22023';
  end if;
  if p_comments_enabled or p_status_team_id is not null then
    perform internal.assert_workspace_accepts_work(p_workspace_id);
    perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  end if;

  select connected.* into installation from public.factory_connector_resources mapped
  join internal.connector_installations connected
    on (connected.workspace_id, connected.id) = (mapped.workspace_id, mapped.installation_id)
  where (mapped.workspace_id, mapped.factory_id, mapped.id, mapped.provider) =
    (p_workspace_id, p_factory_id, p_resource_id, 'linear')
  for update of connected;
  if not found then raise exception 'Linear connector resource is unavailable.' using errcode = 'P0002'; end if;

  select mapped.* into strict resource from public.factory_connector_resources mapped where mapped.id = p_resource_id;
  if p_expected_mapping_revision is distinct from resource.current_revision then
    raise exception 'Linear connector mapping changed.' using errcode = 'PT409';
  end if;
  if not pg_catalog.pg_input_is_valid(resource.external_resource_id, 'uuid')
    or not pg_catalog.pg_input_is_valid(resource.external_tenant_id, 'uuid')
    or (p_status_team_id is not null and resource.resource_kind = 'team'
      and resource.external_resource_id <> p_status_team_id::text) then
    raise exception 'Linear writes require an exact team or project identity.' using errcode = '22023';
  end if;
  if p_comments_enabled or p_status_team_id is not null then
    perform internal.lock_connector_authority(installation, p_factory_id, resource.external_resource_id);
    if not exists (select 1 from public.read_connector_subscription(p_workspace_id, p_factory_id, p_resource_id)) then
      raise exception 'Live Linear connector authority is unavailable.' using errcode = 'P0002';
    end if;
  end if;

  select current_policy.* into policy from internal.linear_connector_outbound_policies current_policy
  where current_policy.resource_id = p_resource_id for update;
  if p_expected_revision is distinct from coalesce(policy.revision, 0) then
    raise exception 'Linear connector write configuration changed.' using errcode = 'PT409';
  end if;

  insert into internal.linear_connector_outbound_policies as current_policy (
    workspace_id, factory_id, resource_id, revision, mapping_revision, comments_enabled,
    status_team_id, status_from_state_id, status_to_state_id
  ) values (
    p_workspace_id, p_factory_id, p_resource_id, coalesce(policy.revision, 0) + 1, resource.current_revision,
    p_comments_enabled, p_status_team_id, p_status_from_state_id, p_status_to_state_id
  )
  on conflict (resource_id) do update set revision = excluded.revision, mapping_revision = excluded.mapping_revision,
    comments_enabled = excluded.comments_enabled, status_team_id = excluded.status_team_id,
    status_from_state_id = excluded.status_from_state_id, status_to_state_id = excluded.status_to_state_id
  returning current_policy.revision into next_revision;
  return next_revision;
end;
$$;

create function public.read_linear_connector_outbound_config(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_resource_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  configuration jsonb;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select jsonb_build_object('revision', coalesce(policy.revision, 0), 'mappingRevision', resource.current_revision,
    'commentsEnabled', coalesce(policy.comments_enabled and policy.mapping_revision = resource.current_revision, false),
    'statusMapping', case when policy.status_team_id is not null and policy.mapping_revision = resource.current_revision
      then jsonb_build_object('teamId', policy.status_team_id, 'fromStateId', policy.status_from_state_id,
        'toStateId', policy.status_to_state_id) end)
  into configuration
  from public.factory_connector_resources resource
  left join internal.linear_connector_outbound_policies policy on policy.resource_id = resource.id
  where (resource.workspace_id, resource.factory_id, resource.id, resource.provider) =
    (p_workspace_id, p_factory_id, p_resource_id, 'linear');
  if not found then raise exception 'Linear connector resource is unavailable.' using errcode = 'P0002'; end if;
  return configuration;
end;
$$;

revoke all on function public.configure_linear_connector_outbound(uuid, uuid, uuid, uuid, bigint, bigint, boolean, uuid, uuid, uuid),
  public.read_linear_connector_outbound_config(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.configure_linear_connector_outbound(uuid, uuid, uuid, uuid, bigint, bigint, boolean, uuid, uuid, uuid),
  public.read_linear_connector_outbound_config(uuid, uuid, uuid, uuid) to service_role;

create or replace function public.commit_linear_issue_discovery_page(
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
  retain_origin_span boolean;
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
      state_id uuid, label_ids uuid[], creator_id uuid, previous_identifiers text[],
      origin_span_id text, origin_span_started_at timestamptz, origin_issue_updated_at timestamptz
    ) order by observation.id
  loop
    if issue.id is null or coalesce(configuration.service_actor_id, issue.creator_id) is null or issue.identifier is null
      or issue.identifier !~ '^[A-Z][A-Z0-9]*-[0-9]+$' or length(issue.identifier) > 80
      or issue.previous_identifiers is null or exists (
        select 1 from unnest(issue.previous_identifiers) prior(identifier)
        where (prior.identifier ~ '^[A-Z][A-Z0-9]*-[0-9]+$' and length(prior.identifier) <= 80) is not true
      )
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
        and session.linear_issue_id = any(array[issue.identifier, issue.id::text] || issue.previous_identifiers)
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
    -- A caller may omit history when the provider cannot prove a coherent open
    -- span. That admission remains commentable but cannot authorize status writes.
    retain_origin_span := coalesce(length(issue.origin_span_id) between 1 and 160
      and issue.origin_span_id !~ '[[:space:][:cntrl:]]'
      and isfinite(issue.origin_span_started_at) and isfinite(issue.origin_issue_updated_at)
      and issue.origin_span_started_at <= issue.origin_issue_updated_at
      and issue.origin_issue_updated_at <= clock_timestamp() + interval '5 minutes', false);
    insert into internal.linear_issue_discovery_receipts(
      workspace_id, external_tenant_id, issue_id, factory_id, resource_id, session_id, source_id, actor_link_id, source_event,
      origin_span_id, origin_span_started_at, origin_issue_updated_at
    ) values (
      p_workspace_id, p_external_tenant_id, issue.id, p_factory_id, p_resource_id,
      accepted.session_id, retained_source_id, authority.actor_link_id,
      internal.normalize_factory_automation_event(jsonb_build_object(
        'kind', 'issue-state', 'stateId', issue.state_id, 'teamId', issue.team_id, 'projectId', issue.project_id
      )),
      case when retain_origin_span then issue.origin_span_id end,
      case when retain_origin_span then issue.origin_span_started_at end,
      case when retain_origin_span then issue.origin_issue_updated_at end
    );
    admitted := admitted + 1;
  end loop;
  return admitted;
end;
$$;

-- Write the shared outbox from the owning lifecycle transaction without
-- acquiring connector or policy locks under an existing session row lock.
create function internal.queue_linear_connector_notice(
  p_session public.sessions, p_key text, p_kind text, p_body text, p_artifact public.session_artifacts default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  context record;
  notice_id uuid;
  now_at timestamptz := clock_timestamp();
begin
  select admitted.issue_id, admitted.origin_span_id, admitted.source_event, source.id as source_id,
    resource.id as resource_id, resource.installation_id, policy.revision, policy.mapping_revision,
    policy.comments_enabled, policy.status_team_id, policy.status_from_state_id, policy.status_to_state_id,
    workspace.slug into context
  from internal.linear_issue_discovery_receipts admitted
  join public.session_conversation_sources source
    on (source.session_id, source.id, source.workspace_id, source.factory_id, source.provider, source.source_namespace,
      source.external_thread_id) = (admitted.session_id, admitted.source_id, admitted.workspace_id, admitted.factory_id,
      'linear', admitted.resource_id::text, admitted.issue_id::text)
  join public.factory_connector_resources resource
    on (resource.workspace_id, resource.factory_id, resource.id, resource.provider, resource.external_tenant_id) =
      (admitted.workspace_id, admitted.factory_id, admitted.resource_id, 'linear', admitted.external_tenant_id::text)
  join internal.linear_connector_outbound_policies policy
    on (policy.resource_id, policy.mapping_revision) = (resource.id, resource.current_revision)
  join public.workspaces workspace on workspace.id = admitted.workspace_id
  where (admitted.session_id, admitted.workspace_id, admitted.factory_id) = (p_session.id, p_session.workspace_id, p_session.factory_id)
    and workspace.deletion_requested_at is null;
  if not found then return; end if;

  if context.comments_enabled then
    insert into internal.connector_outbound_deliveries (
      workspace_id, factory_id, resource_id, installation_id, session_id, source_id,
      provider, logical_key, operation, content, deadline_at, next_action_at
    ) values (
      p_session.workspace_id, p_session.factory_id, context.resource_id, context.installation_id, p_session.id, context.source_id,
      'linear', p_key, 'reply', jsonb_build_object('kind', p_kind, 'body', p_body, 'sessionId', p_session.id,
        'workspaceSlug', context.slug, 'sessionNumber', p_session.number)
        || case when p_artifact.id is null then '{}'::jsonb
          else jsonb_build_object('reviewTarget', jsonb_build_object('stageId', p_artifact.stage_id,
            'stageSlug', p_artifact.stage_slug, 'artifactId', p_artifact.id, 'artifactVersion', p_artifact.version,
            'reviewRevision', p_session.artifact_review_revision, 'clarificationId', null)) end,
      now_at + interval '24 hours', now_at
    )
    on conflict (workspace_id, factory_id, resource_id, source_id, logical_key) do nothing
    returning id into notice_id;
    if found then
      insert into internal.linear_connector_notice_targets(delivery_id, policy_revision, mapping_revision,
        kind, expected_phase, artifact_id)
      values (notice_id, context.revision, context.mapping_revision, p_kind, p_session.phase_status, p_artifact.id);
    end if;
  end if;

  if p_key = 'linear:approved' and context.origin_span_id is not null and context.status_team_id is not null
    and (context.source_event->>'teamId', context.source_event->>'stateId') =
      (context.status_team_id::text, context.status_from_state_id::text) then
    insert into internal.connector_outbound_deliveries (
      workspace_id, factory_id, resource_id, installation_id, session_id, source_id,
      provider, logical_key, operation, content, deadline_at, next_action_at
    ) values (
      p_session.workspace_id, p_session.factory_id, context.resource_id, context.installation_id, p_session.id, context.source_id,
      'linear', 'linear:approved-status', 'linear_status',
      jsonb_build_object('kind', 'linear_status', 'policyRevision', context.revision), now_at + interval '24 hours', now_at
    )
    on conflict (workspace_id, factory_id, resource_id, source_id, logical_key) do nothing
    returning id into notice_id;
    if found then
      insert into internal.linear_connector_notice_targets(delivery_id, policy_revision, mapping_revision,
        kind, expected_phase, from_state_id, to_state_id)
      values (notice_id, context.revision, context.mapping_revision, 'linear_status', p_session.phase_status,
        context.status_from_state_id, context.status_to_state_id);
    end if;
  end if;
end;
$$;

create function internal.capture_linear_connector_notice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target public.sessions;
  artifact public.session_artifacts;
begin
  if tg_table_name = 'linear_issue_discovery_receipts' then
    select session.* into target from public.sessions session where session.id = new.session_id;
    if found then
      perform internal.queue_linear_connector_notice(target, 'linear:accepted', 'progress',
        'Wallie accepted this request.');
    end if;
    return new;
  end if;

  if new.phase_status = 'awaiting_review' and new.archived_at is null then
    select current_artifact.* into artifact from public.session_artifacts current_artifact
    where (current_artifact.id, current_artifact.session_id, current_artifact.workspace_id,
      current_artifact.stage_id, current_artifact.version) =
      (new.current_artifact_id, new.id, new.workspace_id, new.current_stage_id, new.current_artifact_version);
    if found then
      perform internal.queue_linear_connector_notice(new, 'linear:review:' || artifact.id::text, 'review_ready',
        'Wallie published an artifact for review.', artifact);
    end if;
  elsif new.phase_status = 'approved' and old.phase_status is distinct from new.phase_status then
    perform internal.queue_linear_connector_notice(new, 'linear:approved', 'outcome',
      'Wallie completed this session. The final stage was approved.');
  elsif new.phase_status = 'rejected' and new.execution_exhaustion_code is not null then
    perform internal.queue_linear_connector_notice(new, 'linear:budget-exhausted', 'outcome',
      'Wallie stopped work because of the session execution budget.');
  end if;
  return new;
end;
$$;

revoke all on function internal.queue_linear_connector_notice(public.sessions, text, text, text, public.session_artifacts),
  internal.capture_linear_connector_notice() from public, anon, authenticated, service_role;

create trigger capture_linear_connector_acceptance after insert on internal.linear_issue_discovery_receipts
  for each row execute function internal.capture_linear_connector_notice();
create trigger capture_linear_connector_review_or_outcome after update of phase_status, current_artifact_id,
  execution_exhaustion_code on public.sessions
  for each row when (
    (new.phase_status in ('awaiting_review', 'approved') and
      (new.phase_status, new.current_artifact_id) is distinct from (old.phase_status, old.current_artifact_id))
    or (new.phase_status = 'rejected' and new.execution_exhaustion_code is not null
      and (new.phase_status, new.execution_exhaustion_code) is distinct from (old.phase_status, old.execution_exhaustion_code)))
  execute function internal.capture_linear_connector_notice();

create function public.resolve_linear_connector_delivery(
  p_delivery_id uuid, p_lease_id uuid, p_credential_ref uuid, p_credential_material_revision bigint
) returns table (
  issue_id uuid, external_tenant_id uuid, resource_kind text, resource_external_id uuid,
  origin_state_id uuid, origin_team_id uuid, origin_project_id uuid, origin_span_id text,
  origin_span_started_at timestamptz, encrypted_api_key text, may_send boolean,
  from_state_id uuid, to_state_id uuid, credential_material_revision bigint
) language plpgsql security definer set search_path = '' set lock_timeout = '100ms' as $$
declare
  target internal.connector_outbound_deliveries;
  attempt internal.connector_outbound_attempts;
  authority record;
begin
  perform internal.assert_checkpoint_publication_service();
  select delivery.* into target from internal.connector_outbound_deliveries delivery
  where (delivery.id, delivery.lease_id, delivery.provider) = (p_delivery_id, p_lease_id, 'linear')
    and delivery.lease_expires_at > clock_timestamp() for share;
  if not found then return; end if;

  select recorded.* into attempt from internal.connector_outbound_attempts recorded
  where (recorded.lease_id, recorded.delivery_id) = (p_lease_id, p_delivery_id)
    and recorded.authorized_at is not null and recorded.settled_at is null;
  if not found then return; end if;

  select * into authority from internal.lock_connector_outbound_authority(target);
  if not found or (authority.installation_generation, authority.mapping_revision, authority.credential_ref,
      authority.credential_material_revision) is distinct from (attempt.installation_generation, attempt.mapping_revision,
        p_credential_ref, p_credential_material_revision)
    or target.lease_expires_at <= clock_timestamp() then return; end if;

  -- An older maybe-written operation remains observable after a state or
  -- policy change. Current lifecycle and policy authorize only fresh sends.
  return query
    select admitted.issue_id, admitted.external_tenant_id, resource.resource_kind::text, resource.external_resource_id::uuid,
      (admitted.source_event->>'stateId')::uuid, (admitted.source_event->>'teamId')::uuid,
      (admitted.source_event->>'projectId')::uuid, admitted.origin_span_id, admitted.origin_span_started_at,
      secret.encrypted_value, coalesce(
        session.phase_status = notice.expected_phase
        and (session.archived_at is null or notice.kind in ('outcome', 'linear_status'))
        and (notice.artifact_id is null or notice.artifact_id = session.current_artifact_id)
        and (notice.policy_revision, notice.mapping_revision) = (policy.revision, policy.mapping_revision)
        and notice.mapping_revision = authority.mapping_revision
        and case notice.kind when 'linear_status' then
          (policy.status_team_id::text, policy.status_from_state_id, policy.status_to_state_id) =
            (admitted.source_event->>'teamId', notice.from_state_id, notice.to_state_id)
          and admitted.origin_span_id is not null
        else policy.comments_enabled end, false),
      notice.from_state_id, notice.to_state_id, secret.material_revision
    from internal.linear_connector_notice_targets notice
    join internal.linear_issue_discovery_receipts admitted
      on (admitted.session_id, admitted.source_id, admitted.workspace_id, admitted.factory_id, admitted.resource_id) =
        (target.session_id, target.source_id, target.workspace_id, target.factory_id, target.resource_id)
    join public.sessions session on (session.id, session.workspace_id, session.factory_id) =
      (admitted.session_id, admitted.workspace_id, admitted.factory_id)
    join public.session_conversation_sources source
      on (source.session_id, source.id, source.provider, source.source_namespace, source.external_thread_id) =
        (admitted.session_id, admitted.source_id, 'linear', target.resource_id::text, admitted.issue_id::text)
    join public.factory_connector_resources resource
      on (resource.id, resource.installation_id, resource.external_tenant_id, resource.external_resource_id) =
        (target.resource_id, target.installation_id, admitted.external_tenant_id::text, authority.external_resource_id)
    join public.workspace_secrets secret on (secret.workspace_id, secret.id, secret.material_revision) =
      (target.workspace_id, p_credential_ref, p_credential_material_revision) and secret.key = 'LINEAR_API_KEY'
    left join internal.linear_connector_outbound_policies policy on policy.resource_id = resource.id
    where notice.delivery_id = target.id;
end;
$$;

revoke all on function public.resolve_linear_connector_delivery(uuid, uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.resolve_linear_connector_delivery(uuid, uuid, uuid, bigint) to service_role;
