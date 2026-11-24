create table internal.slack_review_targets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  installation_id uuid not null,
  installation_generation bigint not null,
  mapping_revision bigint not null,
  team_id text not null,
  app_id text not null,
  channel_id text not null,
  thread_ts text not null check (thread_ts ~ '^[1-9][0-9]{0,11}[.][0-9]{6}$'),
  card_message_ts text check (card_message_ts ~ '^[1-9][0-9]{0,11}[.][0-9]{6}$'),
  session_id uuid not null,
  source_id uuid not null,
  stage_id uuid not null,
  artifact_id uuid not null,
  artifact_version integer not null check (artifact_version > 0),
  review_revision bigint not null check (review_revision >= 0),
  clarification_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  constraint slack_review_target_exact_key unique nulls not distinct (
    resource_id, installation_generation, mapping_revision, session_id, stage_id, artifact_id,
    artifact_version, review_revision, clarification_id
  ),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade,
  foreign key (installation_id) references internal.connector_installations(id) on delete cascade,
  foreign key (session_id, source_id) references public.session_conversation_sources(session_id, id) on delete cascade
);

create index slack_review_targets_resource_scope_idx on internal.slack_review_targets(workspace_id, factory_id, resource_id);
create index slack_review_targets_installation_idx on internal.slack_review_targets(installation_id);
create index slack_review_targets_source_idx on internal.slack_review_targets(session_id, source_id);

create table internal.slack_clarification_modal_contexts (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references internal.slack_review_targets(id) on delete cascade,
  actor_id text not null,
  actor_link_id uuid not null,
  view_id text unique check (view_id ~ '^V[A-Z0-9]{2,63}$'),
  expires_at timestamptz not null default (clock_timestamp() + interval '10 minutes')
);

create index slack_clarification_modal_contexts_target_idx
  on internal.slack_clarification_modal_contexts(target_id, expires_at);
create index slack_clarification_modal_contexts_expiry_idx
  on internal.slack_clarification_modal_contexts(expires_at, id);

create table internal.slack_review_actions (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references internal.slack_review_targets(id) on delete cascade,
  workspace_id uuid not null,
  team_id text not null,
  app_id text not null,
  actor_id text not null,
  actor_link_id uuid not null,
  member_id uuid not null,
  action text not null check (action in ('approve', 'answer')),
  delivery_key text not null,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  answer text check (length(answer) between 1 and 2000),
  result text check (result in ('applied', 'stale', 'denied', 'blocked', 'expired', 'attempt_limit')),
  approval_receipt_id uuid,
  feedback_batch_id uuid,
  attempt_count integer not null default 0 check (attempt_count between 0 and 6),
  lease_id uuid,
  lease_expires_at timestamptz,
  recorded_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null default (clock_timestamp() + interval '10 minutes'),
  next_attempt_at timestamptz default clock_timestamp(),
  settled_at timestamptz,
  unique (team_id, app_id, actor_id, delivery_key),
  check ((result is null) = (next_attempt_at is not null)),
  check ((result is null) = (settled_at is null)),
  check ((lease_id is null) = (lease_expires_at is null)),
  check ((answer is not null) = (result is null and action = 'answer')),
  check (result is null or lease_id is null),
  check (coalesce(result = 'applied' and action = 'approve', false) = (approval_receipt_id is not null)),
  check (coalesce(result = 'applied' and action = 'answer', false) = (feedback_batch_id is not null))
);

create index slack_review_actions_target_idx on internal.slack_review_actions(target_id);
create index slack_review_actions_due_idx on internal.slack_review_actions(next_attempt_at, id)
  where result is null;
create index slack_review_actions_workspace_due_idx on internal.slack_review_actions(workspace_id, next_attempt_at, id)
  where result is null;
create index slack_review_actions_retention_idx on internal.slack_review_actions(settled_at, id)
  where settled_at is not null;

alter table internal.slack_review_targets enable row level security;
alter table internal.slack_clarification_modal_contexts enable row level security;
alter table internal.slack_review_actions enable row level security;
revoke all on internal.slack_review_targets, internal.slack_clarification_modal_contexts, internal.slack_review_actions
  from public, anon, authenticated, service_role;

create function internal.slack_review_target_is_current(p_target internal.slack_review_targets)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.sessions session
    where (session.id, session.workspace_id, session.factory_id, session.current_stage_id, session.current_artifact_id,
      session.current_artifact_version, session.artifact_review_revision) =
      (p_target.session_id, p_target.workspace_id, p_target.factory_id, p_target.stage_id, p_target.artifact_id,
        p_target.artifact_version, p_target.review_revision)
      and session.phase_status = 'awaiting_review' and session.archived_at is null
      and session.execution_purpose = 'production'
      and case when p_target.clarification_id is null then not exists (
        select 1 from public.session_specification_clarifications clarification
        where (clarification.session_id, clarification.artifact_id) = (session.id, p_target.artifact_id)
          and clarification.status = 'pending'
      ) else session.specification_stage_id = p_target.stage_id and exists (
        select 1 from public.session_specification_clarifications clarification
        where (clarification.workspace_id, clarification.factory_id, clarification.session_id, clarification.stage_id,
          clarification.artifact_id, clarification.artifact_version, clarification.id) =
          (p_target.workspace_id, p_target.factory_id, p_target.session_id, p_target.stage_id, p_target.artifact_id,
            p_target.artifact_version, p_target.clarification_id)
          and clarification.status = 'pending'
      ) end
  )
$$;

create function internal.slack_review_container_matches(
  p_target internal.slack_review_targets, p_team_id text, p_app_id text,
  p_channel_id text, p_message_ts text, p_thread_ts text
) returns boolean language sql immutable set search_path = '' as $$
  select (p_target.card_message_ts is not null
    and (p_target.team_id, p_target.app_id, p_target.channel_id, p_target.card_message_ts) =
      (p_team_id, p_app_id, p_channel_id, p_message_ts)
    and (p_thread_ts is null or p_thread_ts = p_target.thread_ts)) is true
$$;

create function internal.require_slack_review_human(p_target internal.slack_review_targets, p_actor_id text)
returns internal.connector_actor_links language plpgsql set search_path = '' as $$
declare linked internal.connector_actor_links;
begin
  if p_actor_id is null or p_actor_id = 'USLACKBOT' or p_actor_id !~ '^[UW][A-Z0-9]{2,31}$' then
    raise exception 'Slack review requires a verified human.' using errcode = '42501';
  end if;
  linked := internal.require_scoped_connector_actor(
    p_target.workspace_id, p_target.factory_id, p_target.resource_id, p_target.installation_generation,
    p_target.mapping_revision, 'slack', p_target.team_id, p_actor_id, 'human');
  if linked.installation_id <> p_target.installation_id or exists (
    select 1 from internal.slack_connector_credentials credential
    where credential.installation_id = p_target.installation_id and credential.bot_user_id = p_actor_id
  ) then
    raise exception 'Slack review requires a verified human.' using errcode = '42501';
  end if;
  return linked;
end;
$$;

create function public.create_slack_review_target(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_session_id uuid,
  p_stage_id uuid, p_artifact_id uuid, p_artifact_version integer, p_review_revision bigint,
  p_clarification_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare target internal.slack_review_targets; target_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  begin
    select gen_random_uuid(), resource.workspace_id, resource.factory_id, resource.id, installation.id,
      live.installation_generation, live.mapping_revision, installation.external_tenant_id,
      installation.external_installation_id, resource.external_resource_id, source.external_thread_id,
      null::text, source.session_id, source.id, p_stage_id, p_artifact_id, p_artifact_version, p_review_revision,
      p_clarification_id, clock_timestamp()
    into strict target
    from public.factory_connector_resources resource
    join internal.connector_installations installation on installation.id = resource.installation_id
    join public.session_conversation_sources source
      on (source.workspace_id, source.factory_id, source.provider, source.source_namespace, source.session_id) =
        (resource.workspace_id, resource.factory_id, 'slack', resource.id::text, p_session_id)
    cross join lateral public.read_connector_subscription(resource.workspace_id, resource.factory_id, resource.id) live
    where (resource.workspace_id, resource.factory_id, resource.id, resource.provider, resource.resource_kind) =
      (p_workspace_id, p_factory_id, p_resource_id, 'slack', 'channel')
      and live.credential_kind = 'slack_bot'
      and source.external_thread_id ~ '^[1-9][0-9]{0,11}[.][0-9]{6}$';
  exception when no_data_found or too_many_rows then
    raise exception 'An exact linked Slack thread is unavailable.' using errcode = 'P0002';
  end;
  if not internal.slack_review_target_is_current(target) then
    raise exception 'The Slack review target changed.' using errcode = 'PT409';
  end if;

  insert into internal.slack_review_targets select (target).*
  on conflict on constraint slack_review_target_exact_key do nothing returning id into target_id;
  if target_id is not null then return target_id; end if;
  select retained.id into strict target_id from internal.slack_review_targets retained
  where (retained.resource_id, retained.installation_generation, retained.mapping_revision, retained.session_id,
    retained.stage_id, retained.artifact_id, retained.artifact_version, retained.review_revision, retained.clarification_id)
    is not distinct from
    (target.resource_id, target.installation_generation, target.mapping_revision, target.session_id, target.stage_id,
      target.artifact_id, target.artifact_version, target.review_revision, target.clarification_id);
  return target_id;
end;
$$;

-- A future transport can record an observed successful write after review advances.
-- Only current targets can subsequently authorize an action.
create function public.register_slack_review_card(
  p_target_id uuid, p_team_id text, p_app_id text, p_channel_id text, p_thread_ts text, p_message_ts text
) returns boolean language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare target internal.slack_review_targets;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_message_ts is null or p_message_ts !~ '^[1-9][0-9]{0,11}[.][0-9]{6}$' then return false; end if;
  select stored.* into target from internal.slack_review_targets stored
  where (stored.id, stored.team_id, stored.app_id, stored.channel_id, stored.thread_ts) =
    (p_target_id, p_team_id, p_app_id, p_channel_id, p_thread_ts)
  for no key update;
  if not found or p_message_ts::numeric <= target.thread_ts::numeric then return false; end if;
  if target.card_message_ts is not null then return target.card_message_ts = p_message_ts; end if;
  update internal.slack_review_targets stored set card_message_ts = p_message_ts where stored.id = target.id;
  return true;
end;
$$;

create function public.prepare_slack_clarification_modal(
  p_target_id uuid, p_team_id text, p_app_id text, p_actor_id text,
  p_channel_id text, p_message_ts text, p_thread_ts text default null
) returns table(modal_context_id uuid, encrypted_token text)
language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare target internal.slack_review_targets; linked internal.connector_actor_links;
begin
  perform internal.assert_checkpoint_publication_service();
  select stored.* into target from internal.slack_review_targets stored where stored.id = p_target_id;
  if not found or target.clarification_id is null
    or not internal.slack_review_container_matches(target, p_team_id, p_app_id, p_channel_id, p_message_ts, p_thread_ts) then
    return;
  end if;
  linked := internal.require_slack_review_human(target, p_actor_id);
  if not internal.slack_review_target_is_current(target) then return; end if;

  select credential.encrypted_token into encrypted_token from internal.connector_installations installation
  join internal.slack_connector_credentials credential
    on (credential.installation_id, credential.credential_id) = (installation.id, installation.legacy_credential_id)
  where (installation.workspace_id, installation.id, installation.generation, installation.external_tenant_id,
    installation.external_installation_id) =
    (target.workspace_id, target.installation_id, target.installation_generation, target.team_id, target.app_id)
    and installation.disconnected_at is null and credential.encrypted_token is not null;
  if not found then return; end if;

  delete from internal.slack_clarification_modal_contexts prior where prior.id in (
    select expired.id from internal.slack_clarification_modal_contexts expired
    where expired.target_id = target.id and expired.expires_at <= clock_timestamp()
    order by expired.expires_at limit 16
  );
  insert into internal.slack_clarification_modal_contexts(target_id, actor_id, actor_link_id)
  values (target.id, p_actor_id, linked.id) returning id into modal_context_id;
  return next;
exception when insufficient_privilege or sqlstate 'PT404' or sqlstate 'PT409' or sqlstate 'P0002' then
  return;
end;
$$;

create function public.register_slack_clarification_view(p_modal_context_id uuid, p_view_id text)
returns boolean language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare context internal.slack_clarification_modal_contexts;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_view_id is null or p_view_id !~ '^V[A-Z0-9]{2,63}$' then return false; end if;
  select stored.* into context from internal.slack_clarification_modal_contexts stored
  where stored.id = p_modal_context_id and stored.expires_at > clock_timestamp() for no key update;
  if not found then return false; end if;
  if context.view_id is not null then return context.view_id = p_view_id; end if;
  update internal.slack_clarification_modal_contexts stored set view_id = p_view_id where stored.id = context.id;
  return true;
exception when unique_violation then
  return false;
end;
$$;

create function public.queue_slack_review_action(
  p_action text, p_context_id uuid, p_team_id text, p_app_id text, p_actor_id text, p_delivery_key text,
  p_channel_id text default null, p_message_ts text default null, p_thread_ts text default null,
  p_view_id text default null, p_answer text default null
) returns text language plpgsql security definer set search_path = '' set lock_timeout = '1s' as $$
declare
  target internal.slack_review_targets;
  context internal.slack_clarification_modal_contexts;
  linked internal.connector_actor_links;
  member public.workspace_members;
  prior internal.slack_review_actions;
  input_hash text;
  answer text;
  queued_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_action = 'approve' then
    if p_view_id is not null or p_answer is not null
      or (p_delivery_key ~ '^approve:[1-9][0-9]{0,11}[.][0-9]{6}$') is not true then return 'denied'; end if;
    select stored.* into target from internal.slack_review_targets stored where stored.id = p_context_id;
    if not found or target.clarification_id is not null
      or not internal.slack_review_container_matches(target, p_team_id, p_app_id, p_channel_id, p_message_ts, p_thread_ts) then
      return 'denied';
    end if;
  elsif p_action = 'answer' then
    answer := btrim(p_answer, E' \t\r\n');
    if num_nonnulls(p_channel_id, p_message_ts, p_thread_ts) <> 0 or p_view_id is null
      or p_delivery_key is distinct from 'answer:' || p_view_id
      or (length(answer) between 1 and 2000) is not true then return 'denied'; end if;
    select stored.* into context from internal.slack_clarification_modal_contexts stored
    where (stored.id, stored.view_id, stored.actor_id) = (p_context_id, p_view_id, p_actor_id);
    if not found then return 'denied'; end if;
    select stored.* into target from internal.slack_review_targets stored
    where (stored.id, stored.team_id, stored.app_id) = (context.target_id, p_team_id, p_app_id)
      and stored.clarification_id is not null;
    if not found then return 'denied'; end if;
  else
    return 'denied';
  end if;

  linked := internal.require_slack_review_human(target, p_actor_id);
  if p_action = 'answer' and linked.id <> context.actor_link_id then return 'denied'; end if;
  input_hash := encode(sha256(convert_to(jsonb_build_array(
    p_action, p_context_id, target.id, linked.id, p_view_id, answer
  )::text, 'UTF8')), 'hex');
  select receipt.* into prior from internal.slack_review_actions receipt
  where (receipt.team_id, receipt.app_id, receipt.actor_id, receipt.delivery_key) =
    (p_team_id, p_app_id, p_actor_id, p_delivery_key);
  if found then return case when prior.input_hash = input_hash then 'replayed' else 'denied' end; end if;
  if (p_action = 'answer' and context.expires_at <= clock_timestamp())
    or not internal.slack_review_target_is_current(target) then return 'stale'; end if;

  if p_action = 'approve' then
    select actor.* into member from public.workspace_members actor
    where (actor.workspace_id, actor.id) = (target.workspace_id, linked.member_id);
    if not internal.can_review_session_stage(target.session_id, target.workspace_id, target.stage_id, member) then
      return 'denied';
    end if;
  end if;

  insert into internal.slack_review_actions(
    target_id, workspace_id, team_id, app_id, actor_id, actor_link_id, member_id, action, delivery_key, input_hash, answer
  ) values (target.id, target.workspace_id, p_team_id, p_app_id, p_actor_id, linked.id, linked.member_id,
    p_action, p_delivery_key, input_hash, answer)
  on conflict (team_id, app_id, actor_id, delivery_key) do nothing returning id into queued_id;
  if queued_id is not null then return 'queued'; end if;
  select receipt.* into strict prior from internal.slack_review_actions receipt
  where (receipt.team_id, receipt.app_id, receipt.actor_id, receipt.delivery_key) =
    (p_team_id, p_app_id, p_actor_id, p_delivery_key);
  return case when prior.input_hash = input_hash then 'replayed' else 'denied' end;
exception when insufficient_privilege or sqlstate 'PT404' or sqlstate 'P0002' then
  return 'denied';
when sqlstate 'PT409' then
  return 'stale';
end;
$$;

create function internal.finish_slack_review_action(
  p_action_id uuid, p_result text, p_approval_receipt_id uuid default null, p_feedback_batch_id uuid default null
) returns text language sql set search_path = '' as $$
  update internal.slack_review_actions receipt
  set result = p_result, approval_receipt_id = p_approval_receipt_id, feedback_batch_id = p_feedback_batch_id,
    answer = null, lease_id = null, lease_expires_at = null, next_attempt_at = null, settled_at = clock_timestamp()
  where receipt.id = p_action_id
  returning receipt.result
$$;

create function public.claim_slack_review_action(p_workspace_id uuid default null)
returns table(kind text, action_id uuid, lease_id uuid, workspace_id uuid, factory_id uuid, session_id uuid, action text)
language plpgsql security definer set search_path = '' as $$
declare
  scan_cutoff timestamptz := clock_timestamp();
  pending internal.slack_review_actions;
  target internal.slack_review_targets;
  next_lease uuid;
  claim_deadline timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  delete from internal.slack_clarification_modal_contexts context where context.id in (
    select expired.id from internal.slack_clarification_modal_contexts expired
    join internal.slack_review_targets target_scope on target_scope.id = expired.target_id
    where expired.expires_at < scan_cutoff - interval '10 minutes'
      and (p_workspace_id is null or p_workspace_id = target_scope.workspace_id)
    order by expired.expires_at, expired.id for update of expired skip locked limit 16
  );
  delete from internal.slack_review_actions receipt where receipt.id in (
    select prior.id from internal.slack_review_actions prior
    where prior.settled_at < scan_cutoff - interval '30 days'
      and (p_workspace_id is null or p_workspace_id = prior.workspace_id)
    order by prior.settled_at, prior.id for update skip locked limit 16
  );
  for ignored in 1..8 loop
    select receipt.* into pending from internal.slack_review_actions receipt
    where receipt.result is null and receipt.next_attempt_at <= scan_cutoff
      and (p_workspace_id is null or p_workspace_id = receipt.workspace_id)
    order by receipt.next_attempt_at, receipt.id for update skip locked limit 1;
    if not found then return; end if;
    if pending.deadline_at <= clock_timestamp() or pending.attempt_count >= 6 then
      perform internal.finish_slack_review_action(pending.id,
        case when pending.deadline_at <= clock_timestamp() then 'expired' else 'attempt_limit' end);
      continue;
    end if;
    select stored.* into target from internal.slack_review_targets stored where stored.id = pending.target_id;
    if not found or not internal.slack_review_target_is_current(target) then
      perform internal.finish_slack_review_action(pending.id, 'stale');
      continue;
    end if;
    next_lease := gen_random_uuid();
    claim_deadline := least(pending.deadline_at, clock_timestamp() + interval '30 seconds');
    update internal.slack_review_actions receipt
    set lease_id = next_lease, lease_expires_at = claim_deadline, next_attempt_at = claim_deadline,
      attempt_count = receipt.attempt_count + 1 where receipt.id = pending.id;
    return query select 'action'::text, pending.id, next_lease, target.workspace_id, target.factory_id, target.session_id, pending.action;
    return;
  end loop;
  return query select 'cleanup'::text, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::text;
end;
$$;

create function public.complete_slack_review_action(
  p_action_id uuid, p_lease_id uuid, p_agent_model_provider text, p_agent_model_name text, p_run_type text default 'project'
) returns text language plpgsql security definer set search_path = '' set lock_timeout = '2s' as $$
declare
  pending internal.slack_review_actions;
  target internal.slack_review_targets;
  linked internal.connector_actor_links;
  verdict text;
  decision record;
  approval_receipt_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  select receipt.* into pending from internal.slack_review_actions receipt
  where (receipt.id, receipt.lease_id) = (p_action_id, p_lease_id) and receipt.result is null
    and receipt.lease_expires_at > clock_timestamp();
  if not found then return 'stale'; end if;
  select stored.* into target from internal.slack_review_targets stored where stored.id = pending.target_id;
  if not found then return 'stale'; end if;

  -- Actor and installation locks precede the receipt and canonical session locks.
  -- Authorization cannot race a revocation through the review transaction.
  if not exists (
    select 1 from public.read_connector_subscription(target.workspace_id, target.factory_id, target.resource_id) live
    where (live.installation_id, live.installation_generation, live.mapping_revision, live.credential_kind) =
      (target.installation_id, target.installation_generation, target.mapping_revision, 'slack_bot')
  ) then
    verdict := 'stale';
  else
    begin
      linked := internal.require_slack_review_human(target, pending.actor_id);
      if (linked.id, linked.member_id) is distinct from (pending.actor_link_id, pending.member_id) then
        verdict := 'denied';
      end if;
    exception when insufficient_privilege or sqlstate 'PT404' or sqlstate 'P0002' then
      verdict := 'denied';
    end;
  end if;

  select receipt.* into pending from internal.slack_review_actions receipt
  where (receipt.id, receipt.lease_id) = (p_action_id, p_lease_id) and receipt.result is null
    and receipt.lease_expires_at > clock_timestamp() for update;
  if not found or pending.lease_expires_at <= clock_timestamp() then return 'stale'; end if;
  if verdict is not null then return internal.finish_slack_review_action(pending.id, verdict); end if;

  perform 1 from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) = (target.workspace_id, target.factory_id, target.session_id)
  for no key update;
  if pending.lease_expires_at <= clock_timestamp() then return 'stale'; end if;
  if not found or not internal.slack_review_target_is_current(target) then
    return internal.finish_slack_review_action(pending.id, 'stale');
  end if;
  if pending.deadline_at <= clock_timestamp() then
    return internal.finish_slack_review_action(pending.id, 'expired');
  end if;
  begin
    if pending.action = 'approve' then
      select * into decision from public.approve_session_stage(
        target.session_id, target.workspace_id, target.stage_id, target.artifact_id, target.artifact_version,
        linked.member_id, p_agent_model_provider, p_agent_model_name, p_run_type, target.review_revision);
      if not found then return internal.finish_slack_review_action(pending.id, 'stale'); end if;
      select approval.id into strict approval_receipt_id from public.session_stage_approval_receipts approval
      where (approval.workspace_id, approval.session_id, approval.stage_id, approval.artifact_id,
        approval.artifact_version, approval.approved_by_member_id) =
        (target.workspace_id, target.session_id, target.stage_id, target.artifact_id, target.artifact_version, linked.member_id)
      order by approval.approval_number desc limit 1;
      return internal.finish_slack_review_action(pending.id, 'applied', approval_receipt_id);
    end if;

    select * into strict decision from public.answer_session_specification_clarification_once(
      target.workspace_id, target.factory_id, target.session_id, linked.member_id, target.clarification_id,
      target.artifact_id, target.artifact_version, target.review_revision, pending.id, pending.answer,
      p_agent_model_provider, p_agent_model_name, p_run_type);
    return internal.finish_slack_review_action(pending.id, 'applied', null, decision.feedback_batch_id);
  exception when insufficient_privilege then
    return internal.finish_slack_review_action(pending.id, 'denied');
  when sqlstate 'PT428' or sqlstate 'PT409' or sqlstate 'PT422' or sqlstate 'PT423' then
    return internal.finish_slack_review_action(pending.id, 'blocked');
  when sqlstate 'P0003' or sqlstate 'PT404' or sqlstate 'PT412' or sqlstate '55000' then
    return internal.finish_slack_review_action(pending.id, 'stale');
  end;
end;
$$;

revoke all on function internal.slack_review_target_is_current(internal.slack_review_targets),
  internal.slack_review_container_matches(internal.slack_review_targets,text,text,text,text,text),
  internal.require_slack_review_human(internal.slack_review_targets,text),
  internal.finish_slack_review_action(uuid,text,uuid,uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.create_slack_review_target(uuid,uuid,uuid,uuid,uuid,uuid,integer,bigint,uuid),
  public.register_slack_review_card(uuid,text,text,text,text,text),
  public.prepare_slack_clarification_modal(uuid,text,text,text,text,text,text),
  public.register_slack_clarification_view(uuid,text),
  public.queue_slack_review_action(text,uuid,text,text,text,text,text,text,text,text,text),
  public.claim_slack_review_action(uuid),
  public.complete_slack_review_action(uuid,uuid,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_slack_review_target(uuid,uuid,uuid,uuid,uuid,uuid,integer,bigint,uuid),
  public.register_slack_review_card(uuid,text,text,text,text,text),
  public.prepare_slack_clarification_modal(uuid,text,text,text,text,text,text),
  public.register_slack_clarification_view(uuid,text),
  public.queue_slack_review_action(text,uuid,text,text,text,text,text,text,text,text,text),
  public.claim_slack_review_action(uuid),
  public.complete_slack_review_action(uuid,uuid,text,text,text)
  to service_role;
