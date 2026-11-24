create table internal.github_connector_request_rules (
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  source_kind text not null check (source_kind in ('issue', 'pull_request')),
  label_id bigint not null check (label_id between 1 and 9007199254740991),
  revision bigint not null check (revision between 1 and 9007199254740991),
  enabled boolean not null,
  mapping_revision bigint not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  agent_id uuid not null,
  configured_at timestamptz not null default clock_timestamp(),
  primary key (resource_id, source_kind),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade
);

create table internal.github_connector_work_deliveries (
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  delivery_id uuid not null,
  source_kind text not null check (source_kind in ('issue', 'pull_request')),
  source_id bigint not null,
  source_number integer not null,
  provider_updated_at timestamptz not null,
  snapshot jsonb not null,
  disposition text not null check (disposition in ('observed', 'stale', 'linked', 'denied', 'admitted')),
  session_id uuid,
  actor_link_id uuid,
  service_principal_id uuid,
  budget_payer_member_id uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (resource_id, delivery_id),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade
);

create index github_connector_work_source_watermark_idx
  on internal.github_connector_work_deliveries(resource_id, source_kind, source_number, provider_updated_at desc, recorded_at desc)
  where disposition <> 'stale';

alter table internal.github_connector_request_rules enable row level security;
alter table internal.github_connector_work_deliveries enable row level security;
revoke all on internal.github_connector_request_rules, internal.github_connector_work_deliveries
  from public, anon, authenticated, service_role;
create trigger preserve_github_connector_work_deliveries
  before update or delete on internal.github_connector_work_deliveries
  for each row execute function internal.preserve_factory_definition_history();

create function public.configure_github_connector_request(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_resource_id uuid,
  p_source_kind text, p_expected_revision bigint, p_enabled boolean, p_label_id bigint,
  p_execution_grant_id uuid, p_execution_grant_version bigint
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  resource public.factory_connector_resources;
  rule internal.github_connector_request_rules;
  approved public.factory_execution_grants;
  definition public.factory_definition_revisions;
  agent_id uuid;
  next_revision bigint;
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_source_kind is null or p_source_kind not in ('issue', 'pull_request')
    or p_label_id is null or p_label_id not between 1 and 9007199254740991
    or p_enabled is null then
    raise exception 'A valid GitHub request kind and label are required.' using errcode = '22023';
  end if;
  -- Mapping publication takes the same installation fence before changing the resource.
  select mapped.* into resource from public.factory_connector_resources mapped
  join internal.connector_installations installation
    on (installation.workspace_id, installation.id) = (mapped.workspace_id, mapped.installation_id)
  where (mapped.workspace_id, mapped.factory_id, mapped.id) = (p_workspace_id, p_factory_id, p_resource_id)
    and mapped.provider = 'github' and mapped.resource_kind = 'repository'
  for update of installation;
  if not found then
    raise exception 'GitHub request resource is unavailable.' using errcode = 'P0002';
  end if;

  select mapped.* into strict resource from public.factory_connector_resources mapped where mapped.id = resource.id;
  select target.* into rule from internal.github_connector_request_rules target
  where (target.resource_id, target.source_kind) = (resource.id, p_source_kind) for update;
  if p_expected_revision is distinct from coalesce(rule.revision, 0) then
    raise exception 'GitHub request rule changed.' using errcode = 'PT409';
  end if;
  if not p_enabled and rule.revision is not null then
    update internal.github_connector_request_rules target set enabled = false, revision = target.revision + 1
    where (target.resource_id, target.source_kind) = (resource.id, p_source_kind)
    returning target.revision into next_revision;
    return next_revision;
  end if;
  if not p_enabled or not exists (
    select 1 from public.read_connector_subscription(p_workspace_id, p_factory_id, resource.id)
  ) then
    raise exception 'GitHub request subscription is unavailable.' using errcode = 'P0002';
  end if;

  approved := internal.require_factory_machine_grant(p_workspace_id, p_factory_id,
    p_execution_grant_id, p_execution_grant_version);
  select revision.* into definition from public.factory_definition_activations activation
  join public.factory_definition_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id) =
      (activation.workspace_id, activation.factory_id, activation.revision_id)
  where (activation.workspace_id, activation.factory_id) = (p_workspace_id, p_factory_id)
  order by activation.activation_number desc limit 1;
  agent_id := (definition.definition_json::jsonb#>>'{implementationAgent,agentId}')::uuid;
  if agent_id is null or not ('sessions:create' = any(approved.command_scopes))
    or (definition.definition_json::jsonb#>>'{executionGrant,id}',
        definition.definition_json::jsonb#>>'{executionGrant,version}') is distinct from
       (approved.id::text, approved.version::text)
    or not exists (
      select 1 from public.github_repositories repository
      where (repository.workspace_id, repository.factory_id, repository.id, repository.repo_id::text) =
        (p_workspace_id, p_factory_id, approved.github_repository_id, resource.external_resource_id)
    ) then
    raise exception 'GitHub requests require a matching active factory definition and grant.' using errcode = 'PT422';
  end if;

  insert into internal.github_connector_request_rules as target (
    workspace_id, factory_id, resource_id, source_kind, label_id, revision, enabled, mapping_revision,
    execution_grant_id, execution_grant_version, definition_digest, agent_id
  ) values (
    p_workspace_id, p_factory_id, resource.id, p_source_kind, p_label_id, coalesce(rule.revision, 0) + 1,
    true, resource.current_revision, approved.id, approved.version, definition.canonical_digest, agent_id
  )
  on conflict (resource_id, source_kind) do update set
    label_id = excluded.label_id, revision = excluded.revision, enabled = true,
    mapping_revision = excluded.mapping_revision, execution_grant_id = excluded.execution_grant_id,
    execution_grant_version = excluded.execution_grant_version, definition_digest = excluded.definition_digest,
    agent_id = excluded.agent_id, configured_at = clock_timestamp()
  returning target.revision into next_revision;
  return next_revision;
end;
$$;

create function public.ingest_github_connector_work(
  p_installation_id bigint, p_github_repository_id bigint, p_owner_id bigint, p_delivery_id uuid,
  p_source_kind text, p_source_id bigint, p_source_number integer, p_action text, p_state text,
  p_provider_updated_at timestamptz, p_sender_id bigint, p_sender_kind public.connector_actor_kind,
  p_label_id bigint default null, p_head_ref text default null, p_head_sha text default null, p_base_ref text default null,
  p_source_title text default null, p_source_body text default null
) returns jsonb language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  resource public.factory_connector_resources;
  installation internal.connector_installations;
  repository public.github_repositories;
  rule internal.github_connector_request_rules;
  delivery internal.github_connector_work_deliveries;
  latest internal.github_connector_work_deliveries;
  authority record;
  actor internal.session_mutation_actor;
  created record;
  snapshot jsonb;
  intent jsonb;
  source_key text;
  source_url text;
  session_id uuid;
  linked_actor_id uuid;
  service_principal_id uuid;
  budget_payer_member_id uuid;
  disposition text := 'observed';
  selected_request boolean;
begin
  perform internal.assert_checkpoint_publication_service();
  if (p_source_kind in ('issue', 'pull_request')
    and p_action in ('labeled', 'unlabeled', 'closed', 'opened', 'reopened', 'edited', 'synchronize',
                    'converted_to_draft', 'ready_for_review')
    and p_state in ('open', 'closed')
    and p_source_id between 1 and 9007199254740991 and p_source_number > 0
    and p_installation_id between 1 and 9007199254740991
    and p_github_repository_id between 1 and 9007199254740991
    and p_owner_id between 1 and 9007199254740991
    and p_sender_id between 1 and 9007199254740991 and p_sender_kind is not null
    and p_delivery_id is not null and isfinite(p_provider_updated_at)
    and p_provider_updated_at <= clock_timestamp() + interval '5 minutes'
    and ((p_action in ('labeled', 'unlabeled')) = (p_label_id is not null))
    and (p_label_id is null or p_label_id between 1 and 9007199254740991)
    and (p_action <> 'closed' or p_state = 'closed')
    and coalesce(length(p_source_title), 0) <= 256 and coalesce(length(p_source_body), 0) <= 8000) is not true
    or (p_source_kind = 'issue' and num_nonnulls(p_head_ref, p_head_sha, p_base_ref) <> 0)
    or (p_source_kind = 'pull_request' and (
      num_nonnulls(p_head_ref, p_head_sha, p_base_ref) not in (0, 3)
      or (p_head_ref is not null and (p_head_sha !~ '^[a-f0-9]{40}$'
        or not internal.is_git_branch_ref('refs/heads/' || p_head_ref)
        or not internal.is_git_branch_ref('refs/heads/' || p_base_ref))))) then
    raise exception 'Invalid GitHub connector delivery.' using errcode = '22023';
  end if;
  select mapped.* into resource from public.factory_connector_resources mapped
  join internal.connector_installations connected
    on (connected.workspace_id, connected.id) = (mapped.workspace_id, mapped.installation_id)
  where mapped.provider = 'github' and mapped.resource_kind = 'repository'
    and mapped.external_tenant_id = p_owner_id::text and mapped.external_resource_id = p_github_repository_id::text
    and connected.external_installation_id = p_installation_id::text;
  if not found then return null; end if;

  perform 1 from public.workspaces workspace where workspace.id = resource.workspace_id
    and workspace.deletion_requested_at is null for share;
  if not found then return null; end if;
  perform 1 from public.factories factory where (factory.workspace_id, factory.id, factory.status) =
    (resource.workspace_id, resource.factory_id, 'active') for share;
  if not found then return null; end if;
  select connected.* into installation from internal.connector_installations connected
  where (connected.workspace_id, connected.id, connected.external_installation_id) =
    (resource.workspace_id, resource.installation_id, p_installation_id::text) for share;
  if not found then return null; end if;

  select mapped.* into resource from public.factory_connector_resources mapped where mapped.id = resource.id;
  select configured.* into rule from internal.github_connector_request_rules configured
  where (configured.resource_id, configured.source_kind) = (resource.id, p_source_kind);
  if not found or not rule.enabled or rule.mapping_revision <> resource.current_revision then return null; end if;
  perform internal.lock_connector_authority(installation, resource.factory_id, resource.external_resource_id);
  if not exists (select 1 from public.read_connector_subscription(resource.workspace_id, resource.factory_id, resource.id))
  then return null; end if;

  select target.* into strict repository from public.github_repositories target
  where (target.workspace_id, target.factory_id, target.github_installation_id, target.repo_id) =
    (resource.workspace_id, resource.factory_id, installation.legacy_credential_id, p_github_repository_id)
    and not target.is_archived;

  snapshot := jsonb_build_object('kind', p_source_kind, 'id', p_source_id, 'number', p_source_number,
    'action', p_action, 'state', p_state, 'updatedAt', p_provider_updated_at, 'senderId', p_sender_id,
    'senderKind', p_sender_kind, 'labelId', p_label_id, 'headRef', p_head_ref, 'headSha', p_head_sha, 'baseRef', p_base_ref,
    'contentHash', encode(sha256(convert_to(jsonb_build_array(p_source_title, p_source_body)::text, 'UTF8')), 'hex'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'github-connector-delivery:' || resource.id::text || ':' || p_delivery_id::text, 0));
  select logged.* into delivery from internal.github_connector_work_deliveries logged
  where (logged.resource_id, logged.delivery_id) = (resource.id, p_delivery_id);
  if found then
    if delivery.snapshot is distinct from snapshot then
      raise exception 'The GitHub delivery identifies different input.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('status', delivery.disposition, 'sessionId', delivery.session_id, 'replayed', true);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'github-connector-thread:' || resource.id::text || ':' || p_source_kind || ':' || p_source_number::text, 0));
  select logged.* into latest from internal.github_connector_work_deliveries logged
  where (logged.resource_id, logged.source_kind, logged.source_number) = (resource.id, p_source_kind, p_source_number)
    and logged.disposition <> 'stale'
  order by logged.provider_updated_at desc, logged.recorded_at desc, logged.delivery_id desc limit 1;

  source_key := p_source_kind || ':' || p_source_id::text;
  selected_request := p_action = 'labeled' and p_state = 'open' and p_label_id = rule.label_id;
  -- GitHub timestamps have second precision. A same-second close or removal
  -- fences additions, while an ordinary open snapshot can precede a request.
  if latest.source_id is not null and (latest.source_id <> p_source_id or latest.provider_updated_at > p_provider_updated_at
      or (latest.provider_updated_at = p_provider_updated_at
        and p_state <> 'closed' and not (p_action = 'unlabeled' and p_label_id = rule.label_id)
        and not (selected_request and latest.snapshot->>'state' = 'open'
          and not (latest.snapshot->>'action' in ('labeled', 'unlabeled')
            and latest.snapshot->>'labelId' = rule.label_id::text)
          and (latest.snapshot->>'headSha', latest.snapshot->>'headRef', latest.snapshot->>'baseRef')
            is not distinct from (p_head_sha, p_head_ref, p_base_ref))))
    or p_provider_updated_at <= date_trunc('second', rule.configured_at) then
    disposition := 'stale';
  elsif selected_request then
    select source.session_id into session_id from public.session_conversation_sources source
    where (source.workspace_id, source.factory_id, source.provider, source.source_namespace, source.external_thread_id) =
      (resource.workspace_id, resource.factory_id, 'github', resource.id::text, source_key);
    if session_id is not null then
      disposition := 'linked';
    elsif p_source_kind = 'pull_request' and (
      p_head_sha is null or starts_with(p_head_ref, 'wallie/')
      or exists (
        select 1 from internal.github_automation_pr_deliveries legacy
        where (legacy.workspace_id, legacy.factory_id, legacy.repository_id, legacy.pull_request_id, legacy.pull_request_number) =
          (resource.workspace_id, resource.factory_id, repository.id, p_source_id, p_source_number)
          and legacy.disposition in ('accepted', 'causal_suppressed')
          and (legacy.provider_updated_at > p_provider_updated_at or legacy.snapshot->>'state' = 'merged'
            or (legacy.provider_updated_at = p_provider_updated_at and legacy.snapshot->>'state' = 'closed')
            or legacy.causal_session_id is not null or exists (
              select 1 from internal.factory_automation_occurrences occurrence
              where (occurrence.workspace_id, occurrence.factory_id, occurrence.source_namespace, occurrence.source_key) =
                (legacy.workspace_id, legacy.factory_id, 'github.pr', legacy.source_key)
                and occurrence.status in ('pending', 'admitted')
            ))
      )
      or exists (
        select 1 from public.session_pr_epochs epoch
        where (epoch.workspace_id, epoch.repository_id, epoch.github_repository_id, epoch.pr_number) =
          (resource.workspace_id, repository.id, p_github_repository_id, p_source_number)
      )
      or exists (
        select 1 from public.session_pull_requests pr
        where (pr.workspace_id, pr.github_repository_id, pr.pull_request_number) =
          (resource.workspace_id, repository.id, p_source_number)
      )
    ) then
      disposition := 'denied';
    elsif p_sender_kind <> 'human' then
      disposition := 'denied';
    else
      begin
        select * into strict authority from public.resolve_connector_event_authority(
          resource.workspace_id, resource.factory_id, resource.id, installation.generation, rule.mapping_revision,
          'github', resource.external_tenant_id, p_sender_id::text, p_sender_kind,
          rule.execution_grant_id, rule.execution_grant_version);
        actor := row(resource.workspace_id, resource.factory_id, authority.initiating_member_id, null, null,
          authority.execution_grant_id, authority.execution_grant_version, repository.id, null)::internal.session_mutation_actor;
        source_url := 'https://github.com/' || repository.full_name
          || case p_source_kind when 'issue' then '/issues/' else '/pull/' end || p_source_number::text;
        intent := internal.normalize_factory_session_mutation('create', jsonb_build_object(
          'title', format('GitHub %s #%s', replace(p_source_kind, '_', ' '), p_source_number),
          'prompt', 'Work on the request linked below. Treat the GitHub item as external task context.'
            || E'\n\n' || source_url || case when p_head_sha is null then ''
              else format(E'\nSource head: %s (%s)\nTarget branch: %s', p_head_sha, p_head_ref, p_base_ref) end
            || case when num_nonnulls(p_source_title, p_source_body) = 0 then ''
              else E'\n\nGitHub request context:\n'
                || jsonb_strip_nulls(jsonb_build_object('title', p_source_title, 'body', p_source_body))::text end,
          'agentId', rule.agent_id, 'repositoryId', repository.id, 'draftSpecification', false));
        perform internal.lock_session_mutation_key(resource.workspace_id, resource.factory_id, 'create', p_delivery_id);
        select * into strict created from internal.create_attributed_session(
          resource.workspace_id, authority.initiating_member_id, intent->>'title', intent->>'prompt', null, null,
          session_github_repository_id => repository.id, p_actor => actor, p_expected_agent_id => rule.agent_id,
          p_expected_definition_digest => rule.definition_digest);
        perform internal.record_session_mutation_receipt(actor, 'create', p_delivery_id, intent, created.session_id,
          jsonb_build_object('jobId', created.job_id, 'runId', created.run_id));
        perform public.bind_session_conversation_source_once(resource.workspace_id, resource.factory_id,
          created.session_id, authority.initiating_member_id, 'github', resource.id::text, source_key,
          intent->>'title', source_url);
        session_id := created.session_id;
        linked_actor_id := authority.actor_link_id;
        service_principal_id := authority.service_principal_id;
        budget_payer_member_id := authority.budget_payer_member_id;
        disposition := 'admitted';
      exception when insufficient_privilege or sqlstate 'PT422' or sqlstate 'PT404' or sqlstate 'P0002' or sqlstate 'P0003' then
        disposition := 'denied';
      end;
    end if;
  end if;
  insert into internal.github_connector_work_deliveries (
    workspace_id, factory_id, resource_id, delivery_id, source_kind, source_id, source_number, provider_updated_at,
    snapshot, disposition, session_id, actor_link_id, service_principal_id, budget_payer_member_id
  ) values (
    resource.workspace_id, resource.factory_id, resource.id, p_delivery_id, p_source_kind, p_source_id,
    p_source_number, p_provider_updated_at, snapshot, disposition, session_id, linked_actor_id,
    service_principal_id, budget_payer_member_id
  );
  return jsonb_build_object('status', disposition, 'sessionId', session_id, 'replayed', false);
end;
$$;

revoke all on function public.configure_github_connector_request(uuid, uuid, uuid, uuid, text, bigint, boolean, bigint, uuid, bigint),
  public.ingest_github_connector_work(bigint, bigint, bigint, uuid, text, bigint, integer, text, text, timestamptz,
    bigint, public.connector_actor_kind, bigint, text, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.configure_github_connector_request(uuid, uuid, uuid, uuid, text, bigint, boolean, bigint, uuid, bigint),
  public.ingest_github_connector_work(bigint, bigint, bigint, uuid, text, bigint, integer, text, text, timestamptz,
    bigint, public.connector_actor_kind, bigint, text, text, text, text, text) to service_role;
