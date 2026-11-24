create index github_connector_work_diagnostics_idx
  on internal.github_connector_work_deliveries(resource_id, recorded_at desc, delivery_id desc);
create index github_connector_comment_retry_diagnostics_idx
  on internal.github_connector_comment_retries(resource_id, recorded_at desc, delivery_id desc);
create index linear_issue_discovery_diagnostics_idx
  on internal.linear_issue_discovery_receipts(resource_id, recorded_at desc, issue_id desc);
create index connector_outbound_delivery_diagnostics_idx
  on internal.connector_outbound_deliveries(resource_id, created_at desc, id desc);

-- Store only the latest bounded scan error, never a synthetic issue receipt.
create table internal.linear_issue_discovery_failures (
  resource_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  config_revision bigint not null,
  installation_generation bigint not null,
  mapping_revision bigint not null,
  credential_ref uuid not null,
  credential_material_revision bigint not null,
  cursor_generation bigint not null,
  reason text not null check (reason in ('provider_unavailable', 'provider_access_denied', 'invalid_provider_response',
    'scope_mismatch', 'discovery_commit_failed')),
  recorded_at timestamptz not null,
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade
);
alter table internal.linear_issue_discovery_failures enable row level security;
revoke all on internal.linear_issue_discovery_failures from public, anon, authenticated, service_role;

create or replace function public.claim_linear_issue_discovery(p_workspace_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  task record;
  scan_at timestamptz := clock_timestamp();
  claim_expires_at timestamptz;
begin
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
  where config.enabled and config.next_scan_at <= scan_at
    and (p_workspace_id is null or config.workspace_id = p_workspace_id)
    and subscription.credential_kind = 'workspace_secret'
    and not exists (
      select 1 from internal.linear_issue_discovery_cooldowns cooldown
      where (cooldown.workspace_id, cooldown.credential_ref, cooldown.credential_material_revision) =
        (secret.workspace_id, secret.id, secret.material_revision)
        and cooldown.retry_at > scan_at
    )
  order by config.next_scan_at, config.resource_id
  limit 1 for update of config skip locked;
  if not found then return null; end if;

  update internal.linear_issue_discovery_config config
  set next_scan_at = clock_timestamp() + interval '60 seconds' where config.resource_id = task.resource_id
  returning config.next_scan_at into claim_expires_at;
  return jsonb_build_object(
    'workspaceId', task.workspace_id, 'factoryId', task.factory_id, 'resourceId', task.resource_id,
    'configRevision', task.revision, 'stateIds', task.state_ids, 'labelId', task.label_id,
    'serviceActorId', task.service_actor_id,
    'resourceKind', task.resource_kind, 'externalResourceId', task.external_resource_id,
    'externalTenantId', task.external_tenant_id, 'installationGeneration', task.installation_generation,
    'mappingRevision', task.mapping_revision, 'cursorGeneration', task.cursor_generation,
    'cursorPosition', task.cursor_position, 'encryptedApiKey', task.encrypted_value,
    'credentialRef', task.credential_ref, 'credentialMaterialRevision', task.credential_material_revision,
    'claimExpiresAt', claim_expires_at
  );
end;
$$;

create function public.record_linear_issue_discovery_failure(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_config_revision bigint,
  p_installation_generation bigint, p_mapping_revision bigint, p_credential_ref uuid,
  p_credential_material_revision bigint, p_cursor_generation bigint, p_claim_expires_at timestamptz, p_reason text
) returns boolean language plpgsql security definer set search_path = '' set lock_timeout = '250ms' as $$
declare
  authority record;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_reason is null or p_reason not in ('provider_unavailable','provider_access_denied','invalid_provider_response',
    'scope_mismatch','discovery_commit_failed') then
    raise exception 'Invalid Linear discovery failure reason.' using errcode = '22023';
  end if;
  if p_claim_expires_at is null or p_claim_expires_at <= clock_timestamp() then return false; end if;

  select connected as installation, resource.external_resource_id into authority
  from public.factory_connector_resources resource
  join internal.connector_installations connected
    on (connected.workspace_id, connected.id) = (resource.workspace_id, resource.installation_id)
  where (resource.workspace_id, resource.factory_id, resource.id, resource.provider) =
    (p_workspace_id, p_factory_id, p_resource_id, 'linear')
  for share of connected nowait;
  if not found then return false; end if;
  perform internal.lock_connector_authority(authority.installation, p_factory_id, authority.external_resource_id);

  perform 1 from internal.linear_issue_discovery_config config
  where (config.workspace_id, config.factory_id, config.resource_id, config.revision, config.next_scan_at, config.enabled) =
    (p_workspace_id, p_factory_id, p_resource_id, p_config_revision, p_claim_expires_at, true)
  for update nowait;
  if not found then return false; end if;

  if p_claim_expires_at <= clock_timestamp() or not exists (
    select 1 from public.read_connector_subscription(p_workspace_id, p_factory_id, p_resource_id, 'linear-discovery') subscription
    where (subscription.installation_generation, subscription.mapping_revision, subscription.credential_ref,
      subscription.credential_material_revision, subscription.cursor_generation) =
      (p_installation_generation, p_mapping_revision, p_credential_ref, p_credential_material_revision, p_cursor_generation)
  ) then return false; end if;

  insert into internal.linear_issue_discovery_failures (
    workspace_id, factory_id, resource_id, config_revision, installation_generation, mapping_revision,
    credential_ref, credential_material_revision, cursor_generation, reason, recorded_at
  ) values (
    p_workspace_id, p_factory_id, p_resource_id, p_config_revision, p_installation_generation, p_mapping_revision,
    p_credential_ref, p_credential_material_revision, p_cursor_generation, p_reason, clock_timestamp()
  ) on conflict (resource_id) do update set config_revision = excluded.config_revision,
    installation_generation = excluded.installation_generation, mapping_revision = excluded.mapping_revision,
    credential_ref = excluded.credential_ref, credential_material_revision = excluded.credential_material_revision,
    cursor_generation = excluded.cursor_generation, reason = excluded.reason, recorded_at = excluded.recorded_at;
  return true;
exception when lock_not_available then
  return false;
end;
$$;
revoke all on function public.record_linear_issue_discovery_failure(uuid,uuid,uuid,bigint,bigint,bigint,uuid,bigint,bigint,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.record_linear_issue_discovery_failure(uuid,uuid,uuid,bigint,bigint,bigint,uuid,bigint,bigint,timestamptz,text)
  to service_role;

create function public.list_factory_connector_resources(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  workspace_admin boolean;
  can_configure boolean;
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select member.role in ('owner', 'admin'), member.role in ('owner', 'admin') and factory.status = 'active'
  into strict workspace_admin, can_configure
  from public.workspace_members member join public.factories factory on factory.workspace_id = member.workspace_id
  where (member.workspace_id, member.id, factory.id) = (p_workspace_id, actor_member_id, p_factory_id);

  return (
    with installations as (
      select installation as authority, installation.id, installation.provider, installation.generation,
        installation.external_tenant_id, installation.external_installation_id,
        case when installation.disconnected_at is not null then 'disconnected'
          when internal.connector_installation_is_available(installation) then 'connected'
          else 'credential_unavailable' end as connection_status
      from internal.connector_installations installation
      where installation.workspace_id = p_workspace_id
        and (workspace_admin or exists (
          select 1 from public.factory_connector_resources resource
          where (resource.workspace_id, resource.factory_id, resource.installation_id) =
            (p_workspace_id, p_factory_id, installation.id)
        ))
    )
    select jsonb_build_object(
      'canConfigure', can_configure,
      'installations', coalesce((
        select jsonb_agg(jsonb_build_object('id', installation.id, 'provider', installation.provider,
          'generation', installation.generation, 'status', installation.connection_status,
          'externalTenantId', installation.external_tenant_id,
          'externalInstallationId', installation.external_installation_id)
          order by installation.provider, installation.id)
        from installations installation
      ), '[]'::jsonb),
      'resources', coalesce((
        select jsonb_agg(jsonb_build_object('id', resource.id, 'installationId', resource.installation_id,
          'provider', resource.provider, 'kind', resource.resource_kind, 'externalId', resource.external_resource_id,
          'label', repository.full_name,
          'mappingRevision', mapping.revision, 'enabled', mapping.enabled, 'connectionStatus',
          case when installation.connection_status = 'connected'
            and not internal.connector_repository_is_available(installation.authority,
              resource.factory_id, resource.external_resource_id) then 'credential_unavailable'
            else installation.connection_status end,
          'githubRequests', coalesce((
            select jsonb_agg(jsonb_build_object('sourceKind', rule.source_kind, 'revision', rule.revision,
              'enabled', rule.enabled and rule.mapping_revision = resource.current_revision, 'labelId', rule.label_id)
              order by rule.source_kind)
            from internal.github_connector_request_rules rule where resource.provider = 'github'
              and (rule.workspace_id, rule.factory_id, rule.resource_id) =
                (resource.workspace_id, resource.factory_id, resource.id)
          ), '[]'::jsonb))
          order by resource.provider, resource.resource_kind, resource.external_resource_id, resource.id)
        from public.factory_connector_resources resource
        join public.factory_connector_mapping_revisions mapping
          on (mapping.workspace_id, mapping.factory_id, mapping.resource_id, mapping.revision) =
            (resource.workspace_id, resource.factory_id, resource.id, resource.current_revision)
        join installations installation on installation.id = resource.installation_id
        left join public.github_repositories repository on resource.provider = 'github'
          and (repository.workspace_id, repository.factory_id, repository.repo_id::text) =
            (resource.workspace_id, resource.factory_id, resource.external_resource_id)
          and repository.github_installation_id = (installation.authority).legacy_credential_id
        where (resource.workspace_id, resource.factory_id) = (p_workspace_id, p_factory_id)
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- These predicates are shared by diagnostics and the exact-row scheduling
-- command. The existing workers still own every credential and send gate.
create function internal.can_retry_github_connector_comment(
  p_retry internal.github_connector_comment_retries, p_now timestamptz
) returns boolean language sql stable set search_path = '' as $$
  select (p_retry.status = 'pending' and p_retry.next_attempt_at is not null
    and p_retry.deadline_at > p_now and p_retry.attempt_count < 8
    and (p_retry.body is not null or p_retry.action = 'deleted')
    and (p_retry.source_kind <> 'issue' or not exists (
      select 1 from internal.github_connector_work_deliveries tombstone
      where (tombstone.resource_id, tombstone.source_kind, tombstone.source_id, tombstone.disposition) =
        (p_retry.resource_id, 'issue', p_retry.issue_id, 'deleted')
    ))
    and exists (
      select 1 from public.factory_connector_resources resource
      join internal.connector_installations installation
        on (installation.workspace_id, installation.id) = (resource.workspace_id, resource.installation_id)
      join internal.connector_actor_links link on link.installation_id = installation.id
        and link.actor_kind = 'human' and link.external_actor_id = p_retry.actor_id::text and link.revoked_at is null
      join public.workspace_members member on (member.workspace_id, member.id) = (resource.workspace_id, link.member_id)
        and member.kind = 'human' and member.is_active
      where (resource.workspace_id, resource.factory_id, resource.id, resource.provider,
        resource.external_tenant_id, resource.external_resource_id, installation.external_installation_id) =
        (p_retry.workspace_id, p_retry.factory_id, p_retry.resource_id, 'github',
          p_retry.owner_id::text, p_retry.github_repository_id::text, p_retry.github_installation_id::text)
        and (member.role in ('owner','admin') or exists (
          select 1 from public.factory_members membership
          where (membership.workspace_id, membership.factory_id, membership.member_id) =
            (resource.workspace_id, resource.factory_id, member.id) and membership.revoked_at is null
        ))
        and exists (select 1 from public.read_connector_subscription(resource.workspace_id, resource.factory_id, resource.id))
    )) is true
$$;

create function internal.can_retry_connector_outbound_delivery(
  p_delivery internal.connector_outbound_deliveries, p_now timestamptz
) returns boolean language sql stable set search_path = '' as $$
  select (p_delivery.status in ('queued', 'unknown', 'blocked') and p_delivery.lease_id is null
    and p_delivery.next_action_at is not null and p_delivery.deadline_at > p_now + interval '10 seconds'
    and (case when p_delivery.uncertain then p_delivery.observation_attempts < 8 else p_delivery.send_attempts < 6 end)
    and not exists (
      select 1 from internal.connector_outbound_cooldowns cooldown
      where cooldown.installation_id = p_delivery.installation_id and cooldown.retry_at > p_now
    )
    and exists (
      select 1 from public.read_connector_subscription(p_delivery.workspace_id, p_delivery.factory_id, p_delivery.resource_id) subscription
      where subscription.installation_id = p_delivery.installation_id
        and subscription.installation_generation is distinct from p_delivery.blocked_generation
    )) is true
$$;

revoke all on function internal.can_retry_github_connector_comment(internal.github_connector_comment_retries,timestamptz),
  internal.can_retry_connector_outbound_delivery(internal.connector_outbound_deliveries,timestamptz)
  from public, anon, authenticated, service_role;

create function public.list_factory_connector_deliveries(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_resource_id uuid,
  p_lane text default 'all', p_limit integer default 25, p_before_at timestamptz default null,
  p_before_kind text default null, p_before_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  resource public.factory_connector_resources;
  linear_discovery jsonb;
  now_at timestamptz := clock_timestamp();
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_lane is null or p_lane not in ('all','ingress','outbound') or p_limit is null or p_limit not between 1 and 50
    or num_nonnulls(p_before_at,p_before_kind,p_before_id) not in (0, 3)
    or (p_before_at is not null and (not isfinite(p_before_at)
      or p_before_kind not in ('github_admission','github_comment','linear_intake','outbound'))) then
    raise exception 'Invalid connector delivery pagination.' using errcode = '22023';
  end if;

  select mapped.* into resource from public.factory_connector_resources mapped
  where (mapped.workspace_id, mapped.factory_id, mapped.id) = (p_workspace_id, p_factory_id, p_resource_id);
  if not found then raise exception 'Connector resource is unavailable.' using errcode = 'P0002'; end if;

  if resource.provider = 'linear' then
    select jsonb_build_object('status', case when not coalesce(config.enabled, false) then 'disabled'
        when subscription.installation_id is null then 'unavailable'
        when cooldown.retry_at is not null then 'rate_limited'
        when failure.recorded_at is not null then 'failed' else 'scheduled' end,
      'nextScanAt', case when config.enabled then config.next_scan_at end, 'retryAt', cooldown.retry_at,
      'lastFailureAt', failure.recorded_at, 'lastFailureReason', failure.reason)
    into linear_discovery
    from (values (p_resource_id)) selected(resource_id)
    left join internal.linear_issue_discovery_config config on config.resource_id = selected.resource_id
    left join lateral public.read_connector_subscription(p_workspace_id, p_factory_id, p_resource_id, 'linear-discovery')
      subscription on config.enabled
    left join internal.linear_issue_discovery_cooldowns cooldown
      on (cooldown.workspace_id, cooldown.credential_ref, cooldown.credential_material_revision) =
        (p_workspace_id, subscription.credential_ref, subscription.credential_material_revision)
        and cooldown.retry_at > now_at
    left join internal.linear_issue_discovery_failures failure
      on (failure.workspace_id, failure.factory_id, failure.resource_id, failure.config_revision,
        failure.installation_generation, failure.mapping_revision, failure.credential_ref,
        failure.credential_material_revision, failure.cursor_generation) =
        (p_workspace_id, p_factory_id, p_resource_id, config.revision, subscription.installation_generation,
          subscription.mapping_revision, subscription.credential_ref, subscription.credential_material_revision,
          subscription.cursor_generation);
  end if;

  return (
    with records(id, kind, status, reason, recorded_at, next_attempt_at, deadline_at, attempts,
      observation_attempts, uncertain, session_id, operation, source_reference) as (
      select delivery.delivery_id, 'github_admission', delivery.disposition,
        case when delivery.disposition = 'denied' and delivery.snapshot->>'senderKind' <> 'human' then 'actor_not_allowed'
          when delivery.disposition = 'denied' then 'admission_denied' else delivery.disposition end,
        delivery.recorded_at, null::timestamptz, null::timestamptz, 0, 0, false, delivery.session_id, null::text,
        case delivery.source_kind when 'pull_request' then 'PR #' else 'Issue #' end || delivery.source_number::text
      from internal.github_connector_work_deliveries delivery
      where p_lane <> 'outbound' and resource.provider = 'github'
        and (delivery.workspace_id, delivery.factory_id, delivery.resource_id) = (p_workspace_id, p_factory_id, p_resource_id)
      union all
      select deferred.delivery_id, 'github_comment', deferred.status,
        case when deferred.status = 'failed' and deferred.attempt_count >= 8 then 'attempt_limit'
          when deferred.status = 'failed' and (deferred.settled_at < deferred.deadline_at
            or deferred.last_sqlstate not in ('55P03','40P01','40001')) then 'processing_failed'
          when deferred.status = 'failed' or (deferred.status = 'pending' and deferred.deadline_at <= now_at) then 'expired'
          when deferred.status = 'pending' and deferred.last_sqlstate in ('55P03','40P01','40001') then 'contention'
          else coalesce(deferred.result,'retry_pending') end,
        deferred.recorded_at, deferred.next_attempt_at, deferred.deadline_at, deferred.attempt_count, 0, false,
        null::uuid, null::text,
        case deferred.source_kind when 'pull_request' then 'PR #' else 'Issue #' end || deferred.source_number::text
      from internal.github_connector_comment_retries deferred
      where p_lane <> 'outbound' and resource.provider = 'github'
        and (deferred.workspace_id, deferred.factory_id, deferred.resource_id) = (p_workspace_id, p_factory_id, p_resource_id)
      union all
      select receipt.issue_id, 'linear_intake', 'admitted', 'admitted', receipt.recorded_at,
        null::timestamptz, null::timestamptz, 0, 0, false, receipt.session_id, null::text,
        case when source.label ~ '^[A-Z][A-Z0-9]*-[0-9]+$' then source.label end
      from internal.linear_issue_discovery_receipts receipt
      join public.session_conversation_sources source on (source.session_id, source.id) = (receipt.session_id, receipt.source_id)
      where p_lane <> 'outbound' and resource.provider = 'linear'
        and (receipt.workspace_id, receipt.factory_id, receipt.resource_id) = (p_workspace_id, p_factory_id, p_resource_id)
      union all
      select delivery.id, 'outbound', delivery.status::text,
        case when delivery.status = 'failed' and delivery.last_result = 'rejected' then 'rejected'
          when delivery.status not in ('delivered','sending','observing')
            and (case when delivery.uncertain then delivery.observation_attempts >= 8 else delivery.send_attempts >= 6 end)
            then 'attempt_limit'
          when delivery.status not in ('delivered','sending','observing') and delivery.deadline_at <= now_at then 'expired'
          else coalesce(delivery.last_result::text, delivery.status::text) end,
        delivery.created_at, delivery.next_action_at, delivery.deadline_at,
        delivery.send_attempts, delivery.observation_attempts, delivery.uncertain, delivery.session_id,
        delivery.operation::text, null::text
      from internal.connector_outbound_deliveries delivery
      where p_lane <> 'ingress'
        and (delivery.workspace_id, delivery.factory_id, delivery.resource_id) = (p_workspace_id, p_factory_id, p_resource_id)
    ), bounded as materialized (
      select * from records
      where p_before_at is null or (recorded_at, kind, id) < (p_before_at,p_before_kind,p_before_id)
      order by recorded_at desc, kind desc, id desc limit p_limit + 1
    ), page as (
      select * from bounded order by recorded_at desc, kind desc, id desc limit p_limit
    )
    select jsonb_build_object(
      'linearDiscovery', linear_discovery,
      'deliveries', coalesce((
        select jsonb_agg(jsonb_build_object('id', item.id, 'kind', item.kind, 'status', item.status,
          'reason', item.reason, 'recordedAt', item.recorded_at, 'nextAttemptAt', item.next_attempt_at,
          'deadlineAt', item.deadline_at, 'attempts', item.attempts, 'observationAttempts', item.observation_attempts,
          'uncertain', item.uncertain, 'sessionId', item.session_id, 'sessionNumber', session.number, 'operation', item.operation,
          'sourceReference', item.source_reference, 'canRetry',
          case item.kind
            when 'github_comment' then internal.can_retry_github_connector_comment(deferred, now_at)
            when 'outbound' then internal.can_retry_connector_outbound_delivery(outbound, now_at)
            else false end)
          order by item.recorded_at desc, item.kind desc, item.id desc)
        from page item
        left join public.sessions session on (session.id, session.workspace_id, session.factory_id) =
          (item.session_id, p_workspace_id, p_factory_id)
        left join internal.github_connector_comment_retries deferred on item.kind = 'github_comment'
          and (deferred.resource_id, deferred.delivery_id) = (p_resource_id, item.id)
        left join internal.connector_outbound_deliveries outbound on item.kind = 'outbound'
          and (outbound.resource_id, outbound.id) = (p_resource_id, item.id)
      ), '[]'::jsonb),
      'nextCursor', case when (select count(*) from bounded) > p_limit then (
        select jsonb_build_object('recordedAt', item.recorded_at, 'kind', item.kind, 'id', item.id)
        from page item order by item.recorded_at, item.kind, item.id limit 1
      ) end
    )
  );
end;
$$;

create function public.retry_factory_connector_delivery(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_resource_id uuid,
  p_kind text, p_delivery_id uuid, p_mode text
) returns boolean language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  deferred internal.github_connector_comment_retries;
  outbound internal.connector_outbound_deliveries;
  now_at timestamptz;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_kind is null or p_kind not in ('github_comment','outbound') or p_delivery_id is null
    or p_mode is null or p_mode not in ('retry','observe')
    or (p_kind = 'github_comment' and p_mode <> 'retry') then
    raise exception 'An exact retry delivery is required.' using errcode = '22023';
  end if;
  perform 1 from public.factory_connector_resources resource
  where (resource.workspace_id, resource.factory_id, resource.id) = (p_workspace_id, p_factory_id, p_resource_id);
  if not found then raise exception 'Connector resource is unavailable.' using errcode = 'P0002'; end if;

  if p_kind = 'github_comment' then
    select retry.* into deferred from internal.github_connector_comment_retries retry
    where (retry.workspace_id, retry.factory_id, retry.resource_id, retry.delivery_id) =
      (p_workspace_id, p_factory_id, p_resource_id, p_delivery_id)
    for update nowait;
    if not found then return false; end if;
    now_at := clock_timestamp();
    if not internal.can_retry_github_connector_comment(deferred, now_at) then return false; end if;
    update internal.github_connector_comment_retries retry set next_attempt_at = least(retry.next_attempt_at, now_at)
    where (retry.resource_id, retry.delivery_id) = (deferred.resource_id, deferred.delivery_id)
      and retry.next_attempt_at > now_at;
  else
    select delivery.* into outbound from internal.connector_outbound_deliveries delivery
    where (delivery.workspace_id, delivery.factory_id, delivery.resource_id, delivery.id) =
      (p_workspace_id, p_factory_id, p_resource_id, p_delivery_id)
    for update nowait;
    if not found then return false; end if;
    now_at := clock_timestamp();
    if outbound.uncertain is distinct from (p_mode = 'observe') then return false; end if;
    if not internal.can_retry_connector_outbound_delivery(outbound, now_at) then return false; end if;
    update internal.connector_outbound_deliveries delivery set next_action_at = least(delivery.next_action_at, now_at)
    where delivery.id = outbound.id and delivery.next_action_at > now_at;
  end if;

  return true;
exception when lock_not_available then
  return false;
end;
$$;

create function public.disable_github_connector_request(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_resource_id uuid,
  p_source_kind text, p_expected_revision bigint
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  label_id bigint;
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_source_kind is null or p_source_kind not in ('issue', 'pull_request') then
    raise exception 'A valid GitHub request kind is required.' using errcode = '22023';
  end if;
  select rule.label_id into label_id from internal.github_connector_request_rules rule
  where (rule.workspace_id, rule.factory_id, rule.resource_id, rule.source_kind) =
    (p_workspace_id, p_factory_id, p_resource_id, p_source_kind);
  if not found then raise exception 'GitHub request rule is unavailable.' using errcode = 'P0002'; end if;

  return public.configure_github_connector_request(p_workspace_id, p_factory_id, p_actor_user_id, p_resource_id,
    p_source_kind, p_expected_revision, false, label_id, null, null);
end;
$$;

revoke all on function public.list_factory_connector_resources(uuid,uuid,uuid),
  public.list_factory_connector_deliveries(uuid,uuid,uuid,uuid,text,integer,timestamptz,text,uuid),
  public.retry_factory_connector_delivery(uuid,uuid,uuid,uuid,text,uuid,text),
  public.disable_github_connector_request(uuid,uuid,uuid,uuid,text,bigint) from public, anon, authenticated;
grant execute on function public.list_factory_connector_resources(uuid,uuid,uuid),
  public.list_factory_connector_deliveries(uuid,uuid,uuid,uuid,text,integer,timestamptz,text,uuid),
  public.retry_factory_connector_delivery(uuid,uuid,uuid,uuid,text,uuid,text),
  public.disable_github_connector_request(uuid,uuid,uuid,uuid,text,bigint) to service_role;
