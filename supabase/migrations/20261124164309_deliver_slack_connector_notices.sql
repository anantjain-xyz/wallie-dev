create table internal.slack_connector_notice_actions (
  delivery_id uuid primary key references internal.connector_outbound_deliveries(id) on delete cascade,
  target_id uuid not null references internal.slack_review_targets(id) on delete cascade,
  reserving_lease_id uuid not null references internal.connector_outbound_attempts(lease_id) on delete cascade
);
alter table internal.slack_connector_notice_actions enable row level security;
revoke all on internal.slack_connector_notice_actions from public, anon, authenticated, service_role;

-- The lifecycle transaction already owns the session row. Capture the notice
-- without acquiring installation locks. The outbox claim rechecks them.
create function internal.queue_slack_connector_notice(
  p_session public.sessions, p_key text, p_kind text, p_body text, p_review_target jsonb default null
) returns void language sql security definer set search_path = '' as $$
  insert into internal.connector_outbound_deliveries (
    workspace_id, factory_id, resource_id, installation_id, session_id, source_id,
    provider, logical_key, operation, content, deadline_at, next_action_at
  )
  select source.workspace_id, source.factory_id, resource.id, resource.installation_id,
    source.session_id, source.id, 'slack', p_key, 'reply',
    jsonb_build_object('kind', p_kind, 'body', p_body, 'sessionId', p_session.id,
      'workspaceSlug', workspace.slug, 'sessionNumber', p_session.number)
      || case when p_review_target is null then '{}'::jsonb
        else jsonb_build_object('reviewTarget', p_review_target) end,
    clock_timestamp() + interval '24 hours', clock_timestamp()
  from public.session_conversation_sources source
  join public.factory_connector_resources resource
    on (resource.workspace_id, resource.factory_id, resource.id::text, resource.provider, resource.resource_kind) =
      (source.workspace_id, source.factory_id, source.source_namespace, 'slack', 'channel')
  join public.workspaces workspace on workspace.id = source.workspace_id
  where (source.workspace_id, source.factory_id, source.session_id, source.provider) =
    (p_session.workspace_id, p_session.factory_id, p_session.id, 'slack')
    and source.external_thread_id ~ '^[1-9][0-9]{0,11}[.][0-9]{6}$'
    and workspace.deletion_requested_at is null
  on conflict (workspace_id, factory_id, resource_id, source_id, logical_key) do nothing;
$$;

create function internal.queue_slack_closed_review_card(p_session public.sessions, p_artifact_id uuid)
returns void language sql security definer set search_path = '' as $$
  insert into internal.connector_outbound_deliveries (
    workspace_id, factory_id, resource_id, installation_id, session_id, source_id,
    provider, logical_key, operation, edited_delivery_id, edit_target, content, deadline_at, next_action_at
  )
  select prior.workspace_id, prior.factory_id, prior.resource_id, prior.installation_id, prior.session_id,
    prior.source_id, prior.provider, 'slack:close-card:' || prior.id::text, 'edit', prior.id, prior.provider_reply_id,
    jsonb_build_object('kind', 'card_closed', 'body', 'This Wallie review is no longer active.',
      'sessionId', p_session.id, 'workspaceSlug', prior.content->>'workspaceSlug', 'sessionNumber', p_session.number),
    clock_timestamp() + interval '24 hours', clock_timestamp()
  from internal.connector_outbound_deliveries prior
  where (prior.workspace_id, prior.factory_id, prior.session_id, prior.provider, prior.status) =
    (p_session.workspace_id, p_session.factory_id, p_session.id, 'slack', 'delivered')
    and prior.content->>'kind' in ('review_ready', 'clarification')
    and prior.content#>>'{reviewTarget,artifactId}' = p_artifact_id::text
  on conflict do nothing;
$$;

-- Whichever transaction finishes second observes the other's committed change.
-- Neither path needs to lock the session row and outbox row in reverse order.
create function internal.lock_slack_review_card_closure(p_session_id uuid)
returns void language sql set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'slack-review-card-closure:' || p_session_id::text, 0));
$$;

create function internal.capture_delivered_slack_review_card()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target public.sessions;
  reviewed_artifact_id uuid;
begin
  select card.artifact_id into reviewed_artifact_id
  from internal.slack_connector_notice_actions notice
  join internal.slack_review_targets card on card.id = notice.target_id
  where notice.delivery_id = new.id;
  if not found then return new; end if;

  perform internal.lock_slack_review_card_closure(new.session_id);
  select session.* into target from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) =
    (new.workspace_id, new.factory_id, new.session_id);
  -- Restoring an archived session can reactivate the same review and its card.
  if found and (target.phase_status <> 'awaiting_review'
    or target.current_artifact_id is distinct from reviewed_artifact_id) then
    perform internal.queue_slack_closed_review_card(target, reviewed_artifact_id);
  end if;
  return new;
end;
$$;

create function internal.capture_slack_connector_notice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target public.sessions;
  artifact public.session_artifacts;
  target_fields jsonb;
begin
  if tg_table_name = 'session_conversation_sources' then
    select session.* into target from public.sessions session where session.id = new.session_id;
    if found then
      perform internal.queue_slack_connector_notice(target, 'slack:accepted', 'progress',
        'Wallie accepted this request.');
    end if;
    return new;
  end if;

  if tg_table_name = 'session_specification_clarifications' then
    select session.* into target from public.sessions session where session.id = new.session_id;
    if found and target.archived_at is null and target.phase_status = 'awaiting_review'
      and (target.current_artifact_id, target.current_artifact_version) = (new.artifact_id, new.artifact_version) then
      select current_artifact.* into artifact from public.session_artifacts current_artifact where current_artifact.id = new.artifact_id;
      target_fields := jsonb_build_object('stageId', artifact.stage_id, 'stageSlug', artifact.stage_slug,
        'artifactId', artifact.id, 'artifactVersion', artifact.version,
        'reviewRevision', target.artifact_review_revision, 'clarificationId', new.id);
      perform internal.queue_slack_connector_notice(target, 'slack:clarification:' || new.id::text,
        'clarification', 'Wallie asked a question before it can continue.', target_fields);
    end if;
    return new;
  end if;

  if old.phase_status = 'awaiting_review' and old.current_artifact_id is not null
    and (new.phase_status, new.current_artifact_id) is distinct from
      (old.phase_status, old.current_artifact_id)
    and exists (select 1 from public.session_conversation_sources source
      where (source.workspace_id, source.factory_id, source.session_id, source.provider) =
        (new.workspace_id, new.factory_id, new.id, 'slack')) then
    perform internal.lock_slack_review_card_closure(new.id);
    perform internal.queue_slack_closed_review_card(new, old.current_artifact_id);
  end if;
  if new.phase_status = 'awaiting_review' and new.archived_at is null then
    select current_artifact.* into artifact from public.session_artifacts current_artifact
    where (current_artifact.id, current_artifact.session_id, current_artifact.stage_id, current_artifact.version) =
      (new.current_artifact_id, new.id, new.current_stage_id, new.current_artifact_version);
    if found then
      target_fields := jsonb_build_object('stageId', artifact.stage_id, 'stageSlug', artifact.stage_slug,
        'artifactId', artifact.id, 'artifactVersion', artifact.version,
        'reviewRevision', new.artifact_review_revision, 'clarificationId', null);
      perform internal.queue_slack_connector_notice(new, 'slack:review:' || artifact.id::text,
        'review_ready', 'Wallie published an artifact for review.', target_fields);
    end if;
  elsif new.phase_status = 'approved' and old.phase_status is distinct from new.phase_status then
    perform internal.queue_slack_connector_notice(new, 'slack:approved', 'outcome',
      'Wallie completed this session. The final stage was approved.');
  elsif new.phase_status = 'rejected' and new.execution_exhaustion_code is not null then
    perform internal.queue_slack_connector_notice(new, 'slack:budget-exhausted', 'outcome',
      'Wallie stopped work because of the session execution budget.');
  end if;
  return new;
end;
$$;

create trigger capture_slack_connector_acceptance after insert on public.session_conversation_sources
  for each row when (new.provider = 'slack') execute function internal.capture_slack_connector_notice();
create trigger capture_slack_connector_clarification after insert on public.session_specification_clarifications
  for each row when (new.status = 'pending') execute function internal.capture_slack_connector_notice();
create trigger capture_delivered_slack_review_card after update of status on internal.connector_outbound_deliveries
  for each row when (new.provider = 'slack' and new.status = 'delivered' and old.status <> 'delivered'
    and new.content->>'kind' in ('review_ready', 'clarification'))
  execute function internal.capture_delivered_slack_review_card();
create trigger capture_slack_connector_review_or_outcome after update of phase_status, current_artifact_id,
  execution_exhaustion_code on public.sessions
  for each row when (
    (new.phase_status, new.current_artifact_id, new.execution_exhaustion_code) is distinct from
      (old.phase_status, old.current_artifact_id, old.execution_exhaustion_code)
  ) execute function internal.capture_slack_connector_notice();

revoke all on function internal.queue_slack_connector_notice(public.sessions, text, text, text, jsonb),
  internal.queue_slack_closed_review_card(public.sessions, uuid), internal.lock_slack_review_card_closure(uuid),
  internal.capture_delivered_slack_review_card(), internal.capture_slack_connector_notice()
  from public, anon, authenticated, service_role;

create function public.resolve_slack_connector_delivery(p_delivery_id uuid, p_lease_id uuid)
returns table (
  session_id uuid, session_number integer, workspace_slug text, team_id text, app_id text, bot_user_id text,
  channel_id text, thread_ts text, encrypted_token text, original_write_authorized_at timestamptz,
  deadline_at timestamptz, action_target_id uuid, review_revision bigint, previous_correlation_id uuid,
  superseded boolean
) language plpgsql security definer set search_path = '' set lock_timeout = '100ms' as $$
declare
  delivery internal.connector_outbound_deliveries;
  attempt internal.connector_outbound_attempts;
  authority record;
  source public.session_conversation_sources;
  target public.sessions;
  installation internal.connector_installations;
  credential internal.slack_connector_credentials;
  association internal.slack_connector_notice_actions;
  action_target internal.slack_review_targets;
  new_action_target_id uuid;
  current_revision bigint;
  pending_clarification_id uuid;
  previous_write timestamptz;
  notice_kind text;
  obsolete boolean := false;
  can_reserve boolean := false;
begin
  perform internal.assert_checkpoint_publication_service();
  select queued.* into delivery from internal.connector_outbound_deliveries queued
  where (queued.id, queued.lease_id, queued.provider) = (p_delivery_id, p_lease_id, 'slack')
    and queued.lease_expires_at > clock_timestamp() for share;
  if not found then return; end if;
  select recorded.* into attempt from internal.connector_outbound_attempts recorded
  where (recorded.lease_id, recorded.delivery_id) = (p_lease_id, p_delivery_id)
    and recorded.authorized_at is not null and recorded.settled_at is null;
  if not found then return; end if;

  select * into authority from internal.lock_connector_outbound_authority(delivery);
  if not found or (authority.installation_generation, authority.mapping_revision) is distinct from
    (attempt.installation_generation, attempt.mapping_revision) or delivery.lease_expires_at <= clock_timestamp()
  then return; end if;

  select bound.* into source from public.session_conversation_sources bound
  where (bound.id, bound.session_id, bound.workspace_id, bound.factory_id, bound.provider, bound.source_namespace) =
    (delivery.source_id, delivery.session_id, delivery.workspace_id, delivery.factory_id, 'slack', delivery.resource_id::text);
  if not found or exists (
    select 1 from internal.slack_connector_message_versions deleted
    where (deleted.resource_id, deleted.message_ts, deleted.deleted) = (delivery.resource_id, source.external_thread_id, true)
  ) then return; end if;
  select session.* into strict target from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) = (source.workspace_id, source.factory_id, source.session_id);
  select installed.* into strict installation from internal.connector_installations installed
  where (installed.workspace_id, installed.id, installed.provider) = (delivery.workspace_id, delivery.installation_id, 'slack');
  select token.* into credential from internal.slack_connector_credentials token
  where (token.installation_id, token.credential_id) = (installation.id, authority.credential_ref)
    and token.encrypted_token is not null;
  if not found then return; end if;

  notice_kind := delivery.content->>'kind';
  if notice_kind in ('review_ready', 'clarification') then
    select notice.* into association from internal.slack_connector_notice_actions notice where notice.delivery_id = delivery.id;
    if found then
      select stored.* into strict action_target from internal.slack_review_targets stored where stored.id = association.target_id;
    end if;
    select question.id into pending_clarification_id from public.session_specification_clarifications question
    where (question.workspace_id, question.factory_id, question.session_id, question.artifact_id, question.status) =
      (target.workspace_id, target.factory_id, target.id, target.current_artifact_id, 'pending');
    obsolete := target.archived_at is not null or target.phase_status <> 'awaiting_review'
      or (target.current_artifact_id::text, target.current_stage_id::text, target.current_artifact_version::text) is distinct from
        (delivery.content#>>'{reviewTarget,artifactId}', delivery.content#>>'{reviewTarget,stageId}',
          delivery.content#>>'{reviewTarget,artifactVersion}')
      or pending_clarification_id::text is distinct from (delivery.content#>>'{reviewTarget,clarificationId}');
    if action_target.id is not null then
      current_revision := action_target.review_revision;
      obsolete := obsolete or (authority.installation_generation, authority.mapping_revision) is distinct from
        (action_target.installation_generation, action_target.mapping_revision);
    end if;

    if not obsolete and attempt.operation = 'sending' and not delivery.uncertain then
      -- A safe new attempt must reserve its target even when the review revision stayed the same.
      -- Subsequent checks in that lease must keep the exact action already rendered for its write.
      can_reserve := action_target.id is null or (
        association.reserving_lease_id <> attempt.lease_id and action_target.card_message_ts is null
        and exists (select 1 from internal.connector_outbound_attempts prior
          where (prior.delivery_id, prior.lease_id, prior.operation) =
            (delivery.id, association.reserving_lease_id, 'sending')
            and prior.result in ('not_sent', 'rate_limited', 'credential_unavailable'))
        and not exists (select 1 from internal.connector_outbound_attempts prior
          where prior.delivery_id = delivery.id and prior.operation = 'sending' and prior.result = 'uncertain'));
      if can_reserve then
        new_action_target_id := action_target.id;
        if current_revision is distinct from target.artifact_review_revision then
          current_revision := target.artifact_review_revision;
          new_action_target_id := public.create_slack_review_target(delivery.workspace_id, delivery.factory_id,
            delivery.resource_id, target.id, target.current_stage_id, target.current_artifact_id,
            target.current_artifact_version, current_revision, pending_clarification_id);
        end if;
        insert into internal.slack_connector_notice_actions as notice (delivery_id, target_id, reserving_lease_id)
          values (delivery.id, new_action_target_id, attempt.lease_id)
          on conflict (delivery_id) do update set target_id = excluded.target_id, reserving_lease_id = excluded.reserving_lease_id
          where notice.reserving_lease_id = association.reserving_lease_id;
        if not found then return; end if;
      end if;
    end if;
    obsolete := obsolete or (current_revision is not null and current_revision is distinct from target.artifact_review_revision);
  end if;

  if attempt.operation = 'observing' then
    select max(recorded.authorized_at) into previous_write from internal.connector_outbound_attempts recorded
    where recorded.delivery_id = delivery.id and recorded.operation = 'sending' and recorded.result = 'uncertain';
    if previous_write is null then return; end if;
  else
    previous_write := attempt.authorized_at;
  end if;

  return query select target.id, target.number, workspace.slug,
    installation.external_tenant_id, installation.external_installation_id, credential.bot_user_id,
    authority.external_resource_id, source.external_thread_id, credential.encrypted_token,
    previous_write, delivery.deadline_at, coalesce(new_action_target_id, action_target.id), current_revision,
    delivery.edited_delivery_id, obsolete
  from public.workspaces workspace where workspace.id = target.workspace_id;
end;
$$;

revoke all on function public.resolve_slack_connector_delivery(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.resolve_slack_connector_delivery(uuid, uuid) to service_role;

create or replace function public.list_factory_connector_deliveries(
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
      or p_before_kind not in ('github_admission','github_comment','linear_intake','slack_ingress','outbound'))) then
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
      select event.id, 'slack_ingress',
        case when event.result is null then 'pending'
          when event.result in ('actor_denied','membership_denied','authority_unavailable') then 'denied'
          when event.result in ('expired','attempt_limit') then 'failed'
          when event.result in ('appended','ignored') then 'settled'
          else event.result end,
        case when event.result is null and event.deadline_at <= now_at then 'expired'
          when event.result is null then 'retry_pending'
          when event.result = 'actor_denied' then 'actor_not_allowed'
          when event.result = 'authority_unavailable' then 'credential_unavailable'
          else event.result end,
        event.recorded_at, event.next_attempt_at, event.deadline_at, event.attempt_count, 0, false,
        event.session_id, null::text, null::text
      from internal.slack_connector_event_receipts event
      where p_lane <> 'outbound' and resource.provider = 'slack'
        and (event.workspace_id, event.factory_id, event.resource_id) = (p_workspace_id, p_factory_id, p_resource_id)
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
