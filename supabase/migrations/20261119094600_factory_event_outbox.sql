create type public.factory_outbound_delivery_status as enum ('queued','claimed','sending','delivered','failed','unknown','revoked');
create type public.factory_outbound_delivery_outcome as enum ('delivered','retryable_failure','permanent_failure','unknown');

create table internal.factory_outbound_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  writer_repository_id uuid not null,
  session_id uuid not null,
  event_type public.factory_outbound_event_type not null,
  anchor text not null check (length(anchor) between 1 and 160),
  occurred_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=4096),
  unique (workspace_id,factory_id,event_type,anchor),
  unique (id,workspace_id,factory_id,writer_repository_id),
  foreign key (workspace_id,factory_id) references public.factories(workspace_id,id) on delete cascade
);
create index factory_outbound_events_retention_idx on internal.factory_outbound_events(occurred_at,id);

create table internal.factory_outbound_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  writer_repository_id uuid not null,
  subscription_id uuid not null,
  event_id uuid not null,
  status public.factory_outbound_delivery_status not null default 'queued',
  created_at timestamptz not null,
  deadline_at timestamptz not null,
  next_attempt_at timestamptz,
  attempt_count integer not null default 0,
  attempt_limit integer not null default 6,
  manual_retries integer not null default 0 check (manual_retries between 0 and 3),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_outcome public.factory_outbound_delivery_outcome,
  has_unknown_outcome boolean not null default false,
  last_http_status integer check (last_http_status between 100 and 599),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  unique (subscription_id,event_id),
  foreign key (subscription_id,workspace_id,factory_id,writer_repository_id)
    references internal.factory_event_subscriptions(id,workspace_id,factory_id,writer_repository_id) on delete cascade,
  foreign key (event_id,workspace_id,factory_id,writer_repository_id)
    references internal.factory_outbound_events(id,workspace_id,factory_id,writer_repository_id) on delete cascade,
  check (deadline_at>created_at and attempt_count between 0 and attempt_limit and attempt_limit between 1 and 9),
  check ((lease_id is not null) = (status in ('claimed','sending'))),
  check ((lease_id is not null) = (lease_expires_at is not null)),
  check ((delivered_at is not null) = (status='delivered'))
);
create index factory_outbound_deliveries_ready_idx
  on internal.factory_outbound_deliveries(coalesce(next_attempt_at,lease_expires_at,deadline_at),id)
  where status in ('queued','claimed','sending','unknown');
create index factory_outbound_deliveries_list_idx
  on internal.factory_outbound_deliveries(subscription_id,created_at desc,id desc);
create index factory_outbound_deliveries_event_idx on internal.factory_outbound_deliveries(event_id);
create index factory_outbound_deliveries_retention_idx on internal.factory_outbound_deliveries(created_at,id);

create table internal.factory_outbound_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references internal.factory_outbound_deliveries(id) on delete cascade,
  lease_id uuid not null,
  number integer not null check (number between 1 and 9),
  claimed_at timestamptz not null,
  send_started_at timestamptz,
  settled_at timestamptz,
  outcome public.factory_outbound_delivery_outcome,
  http_status integer check (http_status between 100 and 599),
  unique (delivery_id,number),
  check ((settled_at is null) = (outcome is null))
);

alter table internal.factory_outbound_events enable row level security;
alter table internal.factory_outbound_deliveries enable row level security;
alter table internal.factory_outbound_delivery_attempts enable row level security;
revoke all on internal.factory_outbound_events,internal.factory_outbound_deliveries,internal.factory_outbound_delivery_attempts
  from public,anon,authenticated,service_role;

-- Narrow, committed event facts only. The event and its bounded fan-out
-- commit with the lifecycle transition, or none are visible to dispatch.
create function internal.emit_factory_outbound_event(
  p_workspace_id uuid,p_session_id uuid,p_type public.factory_outbound_event_type,p_anchor text,
  p_run_id uuid default null,p_attempt_count integer default null,p_stage_id uuid default null,p_artifact_id uuid default null,
  p_artifact_version integer default null,p_message_sequence integer default null,p_run_status public.agent_run_status default null,
  p_clarification_id uuid default null,p_occurred_at timestamptz default null
) returns void language plpgsql set search_path='' as $$
declare
  target internal.factory_session_read_owners;
  event_id uuid:=gen_random_uuid();
  now_at timestamptz:=clock_timestamp();
  occurred_at timestamptz:=coalesce(p_occurred_at,now_at);
  recipients uuid[];
begin
  select owner.* into target from internal.factory_session_read_owners owner
  where (owner.workspace_id,owner.id)=(p_workspace_id,p_session_id);
  if not found then return; end if;
  select array_agg(subscription.id) into recipients from internal.factory_event_subscriptions subscription
  where (subscription.workspace_id,subscription.factory_id,subscription.writer_repository_id)=
    (target.workspace_id,target.factory_id,target.github_repository_id)
    and subscription.status='active' and p_type=any(subscription.event_types)
    and subscription.verified_at<=occurred_at
    and internal.factory_event_subscription_has_authority(subscription);
  if recipients is null then return; end if;

  insert into internal.factory_outbound_events(id,workspace_id,factory_id,writer_repository_id,session_id,event_type,anchor,occurred_at,payload)
  values (event_id,target.workspace_id,target.factory_id,target.github_repository_id,target.id,p_type,p_anchor,occurred_at,
    jsonb_strip_nulls(jsonb_build_object('version',1,'eventId',event_id,'type',p_type,'occurredAt',occurred_at,
      'workspaceId',target.workspace_id,'factoryId',target.factory_id,'sessionId',target.id,'sessionNumber',target.number,
      'runId',p_run_id,'attemptCount',p_attempt_count,'stageId',p_stage_id,'artifactId',p_artifact_id,
      'artifactVersion',p_artifact_version,'messageSequence',p_message_sequence,'runStatus',p_run_status,
      'clarificationId',p_clarification_id)))
  on conflict (workspace_id,factory_id,event_type,anchor) do nothing;
  if not found then return; end if;
  insert into internal.factory_outbound_deliveries(workspace_id,factory_id,writer_repository_id,subscription_id,event_id,
    created_at,deadline_at,next_attempt_at)
  select target.workspace_id,target.factory_id,target.github_repository_id,recipient,event_id,now_at,now_at+interval '24 hours',now_at
  from unnest(recipients) recipient;
end;
$$;

create function internal.capture_factory_outbound_event()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  stage_id uuid;
  artifact_version integer;
  session_created_at timestamptz;
  started_run public.agent_runs;
  review_ready boolean:=false;
begin
  case tg_table_name
    when 'sessions' then
      perform internal.emit_factory_outbound_event(new.workspace_id,new.id,'session.created',new.id::text);
    when 'session_git_roots' then
      -- Legacy sessions become eligible only after an immutable writer is known.
      select session.created_at into session_created_at from public.sessions session
      where (session.workspace_id,session.id,session.github_repository_id)=(new.workspace_id,new.session_id,new.repository_id)
        and not session.execute_pinned_definition;
      if found then
        perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'session.created',new.session_id::text,
          p_occurred_at=>session_created_at);
      end if;
    when 'session_job_git_inputs' then
      -- The lineage guard locks the session, job and exact running attempt before
      -- binding the input. Starts after the root already use the normal trigger.
      select run.* into started_run from public.agent_runs run
      join public.session_git_roots root on (root.workspace_id,root.session_id,root.repository_id)=
        (run.workspace_id,run.session_id,new.repository_id)
      join public.sessions session on (session.workspace_id,session.id,session.github_repository_id)=
        (root.workspace_id,root.session_id,root.repository_id)
      where (run.workspace_id,run.session_id,run.agent_job_id,run.id,run.attempt_count)=
        (new.workspace_id,new.session_id,new.job_id,new.pinned_run_id,new.pinned_attempt_count)
        and not session.execute_pinned_definition and run.status='running' and run.started_at<=root.created_at;
      if found then
        perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'run.started',
          started_run.id::text || ':' || started_run.attempt_count::text,started_run.id,started_run.attempt_count,
          started_run.stage_id,p_run_status=>started_run.status,p_occurred_at=>started_run.started_at);
      end if;
    when 'session_mutation_receipts' then
      if new.operation='cancel' then
        perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'session.canceled',new.id::text);
      end if;
    when 'session_cancellation_requests' then
      perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'session.canceled',
        new.session_id::text || ':' || new.expected_run_id::text,p_run_id=>new.expected_run_id);
    when 'agent_runs' then
      if tg_op='UPDATE' and (old.status,old.attempt_count) is not distinct from (new.status,new.attempt_count) then return new; end if;
      if new.status='running' and new.attempt_count>0 then
        perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'run.started',
          new.id::text || ':' || new.attempt_count::text,new.id,new.attempt_count,new.stage_id,p_run_status=>new.status);
      elsif new.status in ('success','error','canceled') then
        perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'run.completed',
          new.id::text || ':' || coalesce(new.attempt_count,0)::text,new.id,new.attempt_count,new.stage_id,p_run_status=>new.status);
      end if;
    when 'session_conversation_messages' then
      perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'conversation.message_added',
        new.session_id::text || ':' || new.sequence::text,new.run_id,new.attempt_count,p_artifact_id=>new.artifact_id,
        p_message_sequence=>new.sequence);
      review_ready:=new.kind='review_ready';
    when 'session_git_checkpoints' then
      review_ready:=true;
    when 'session_stage_approval_receipts' then
      perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'review.approved',new.id::text,
        p_stage_id=>new.stage_id,p_artifact_id=>new.artifact_id,p_artifact_version=>new.artifact_version);
    when 'artifact_feedback_batches' then
      perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'review.changes_requested',new.id::text,
        p_stage_id=>new.stage_id,p_artifact_id=>new.artifact_id,p_artifact_version=>new.artifact_version);
    when 'session_specification_clarifications' then
      if tg_op='INSERT' and new.status='pending' then
        perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'review.clarification_requested',
          new.id::text,new.run_id,new.attempt_count,new.stage_id,new.artifact_id,new.artifact_version,p_clarification_id=>new.id);
      elsif tg_op='UPDATE' and old.status='pending' and new.status='answered' then
        perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'review.clarification_answered',
          new.id::text,new.run_id,new.attempt_count,new.stage_id,new.artifact_id,new.artifact_version,p_clarification_id=>new.id);
      end if;
  end case;
  -- Both publication paths identify the same immutable artifact. A checkpoint
  -- and its canonical conversation marker collapse to one ready event.
  if review_ready then
    select artifact.stage_id,artifact.version into stage_id,artifact_version from public.session_artifacts artifact
    where (artifact.id,artifact.workspace_id,artifact.session_id)=(new.artifact_id,new.workspace_id,new.session_id);
    if found then
      perform internal.emit_factory_outbound_event(new.workspace_id,new.session_id,'review.ready',
        new.artifact_id::text,new.run_id,new.attempt_count,stage_id,new.artifact_id,artifact_version);
    end if;
  end if;
  return new;
end;
$$;

create trigger capture_factory_session_created after insert on public.sessions
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_rooted_session_created after insert on public.session_git_roots
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_rooted_run_started after insert or update of pinned_run_id on public.session_job_git_inputs
  for each row when (new.pinned_run_id is not null) execute function internal.capture_factory_outbound_event();
create trigger capture_factory_session_canceled after insert on internal.session_mutation_receipts
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_browser_session_canceled after insert on internal.session_cancellation_requests
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_run_lifecycle after insert or update of status,attempt_count on public.agent_runs
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_conversation_message after insert on public.session_conversation_messages
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_review_ready after insert on public.session_git_checkpoints
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_review_approved after insert on public.session_stage_approval_receipts
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_review_changes_requested after insert on public.artifact_feedback_batches
  for each row execute function internal.capture_factory_outbound_event();
create trigger capture_factory_review_clarification after insert or update of status on public.session_specification_clarifications
  for each row execute function internal.capture_factory_outbound_event();

create function internal.settle_locked_factory_event_attempt(
  p_delivery internal.factory_outbound_deliveries,p_outcome public.factory_outbound_delivery_outcome,
  p_http_status integer,p_retry_after_seconds integer,p_revoked boolean default false
) returns void language plpgsql set search_path='' as $$
declare
  now_at timestamptz:=clock_timestamp();
  retry_at timestamptz;
  target_status public.factory_outbound_delivery_status;
  uncertain boolean:=p_delivery.has_unknown_outcome or p_outcome='unknown';
begin
  if not p_revoked and p_outcome in ('unknown','retryable_failure') and p_delivery.attempt_count<p_delivery.attempt_limit then
    retry_at:=now_at+make_interval(secs=>greatest(15*(2^least(p_delivery.attempt_count,8))::integer,
      least(greatest(coalesce(p_retry_after_seconds,0),0),3600)));
    if retry_at>=p_delivery.deadline_at then retry_at:=null; end if;
  end if;
  target_status:=case when p_revoked then 'revoked' when p_outcome='delivered' then 'delivered'
    when uncertain then 'unknown' when retry_at is not null then 'queued' else 'failed' end;
  update internal.factory_outbound_delivery_attempts attempt set settled_at=now_at,outcome=p_outcome,http_status=p_http_status
  where (attempt.delivery_id,attempt.number,attempt.lease_id)=(p_delivery.id,p_delivery.attempt_count,p_delivery.lease_id)
    and attempt.settled_at is null;
  update internal.factory_outbound_deliveries delivery set status=target_status,
    next_attempt_at=retry_at,last_outcome=p_outcome,last_http_status=p_http_status,has_unknown_outcome=uncertain,
    delivered_at=case when target_status='delivered' then now_at end,lease_id=null,lease_expires_at=null
  where delivery.id=p_delivery.id;
end;
$$;

create function public.claim_factory_event_delivery()
returns table(delivery_id uuid,lease_id uuid,endpoint_url text,subscription_revision bigint)
language plpgsql security definer set search_path='' as $$
declare
  candidate internal.factory_outbound_deliveries;
  subscription internal.factory_event_subscriptions;
  now_at timestamptz:=clock_timestamp();
  next_lease uuid;
begin
  for candidate in
    select delivery.* from internal.factory_outbound_deliveries delivery
    where delivery.status in ('queued','claimed','sending','unknown')
      and (delivery.status<>'unknown' or delivery.next_attempt_at is not null)
      and coalesce(delivery.next_attempt_at,delivery.lease_expires_at,delivery.deadline_at)<=now_at
    order by coalesce(delivery.next_attempt_at,delivery.lease_expires_at,delivery.deadline_at),delivery.id
    limit 25 for update of delivery skip locked
  loop
    if candidate.status in ('claimed','sending') then
      perform internal.settle_locked_factory_event_attempt(candidate,
        case when candidate.status='sending' then 'unknown'::public.factory_outbound_delivery_outcome else 'retryable_failure' end,
        null,null);
      continue;
    end if;
    if candidate.attempt_count>=candidate.attempt_limit or candidate.deadline_at<=now_at+interval '10 seconds' then
      update internal.factory_outbound_deliveries delivery set status=case when candidate.has_unknown_outcome then 'unknown' else 'failed' end,
        next_attempt_at=null where delivery.id=candidate.id;
      continue;
    end if;
    select target.* into strict subscription from internal.factory_event_subscriptions target where target.id=candidate.subscription_id;
    if subscription.status<>'active' or not internal.factory_event_subscription_has_authority(subscription) then
      update internal.factory_outbound_deliveries delivery set status='revoked',next_attempt_at=null where delivery.id=candidate.id;
      continue;
    end if;
    next_lease:=gen_random_uuid();
    update internal.factory_outbound_deliveries delivery set status='claimed',lease_id=next_lease,
      lease_expires_at=least(now_at+interval '45 seconds',candidate.deadline_at),next_attempt_at=null,
      attempt_count=candidate.attempt_count+1,last_attempt_at=now_at where delivery.id=candidate.id;
    insert into internal.factory_outbound_delivery_attempts(delivery_id,lease_id,number,claimed_at)
    values (candidate.id,next_lease,candidate.attempt_count+1,now_at);
    return query select candidate.id,next_lease,subscription.endpoint_url,subscription.revision;
    return;
  end loop;
end;
$$;

-- Align locked checks with the existing command and OAuth ordering. OAuth
-- rotates/revokes client -> family -> factory; token checks use factory -> token.
create function internal.lock_factory_outbound_authority(p_subscription internal.factory_event_subscriptions)
returns boolean language plpgsql set search_path='' as $$
declare
  token public.factory_machine_tokens;
  consent public.factory_oauth_grants;
  binding public.factory_oauth_grant_bindings;
  approved public.factory_execution_grants;
begin
  perform internal.assert_workspace_accepts_work(p_subscription.workspace_id);
  if p_subscription.credential_kind='machine_token' then
    perform internal.assert_factory_accepts_work(p_subscription.workspace_id,p_subscription.factory_id);
    select credential.* into token from public.factory_machine_tokens credential
    where (credential.workspace_id,credential.factory_id,credential.id)=
      (p_subscription.workspace_id,p_subscription.factory_id,p_subscription.credential_id) for key share;
    if not found or token.revoked_at is not null or token.expires_at<=clock_timestamp()
      or not ('sessions:read'=any(token.scopes)) then return false; end if;
    approved:=internal.require_factory_machine_grant(p_subscription.workspace_id,p_subscription.factory_id,
      token.execution_grant_id,token.execution_grant_version);
  else
    select target.* into consent from public.factory_oauth_grants target
    where (target.workspace_id,target.id)=(p_subscription.workspace_id,p_subscription.credential_id);
    if not found then return false; end if;
    perform 1 from public.factory_oauth_clients client
    where (client.workspace_id,client.id)=(consent.workspace_id,consent.client_id) and client.revoked_at is null for share;
    if not found then return false; end if;
    select target.* into consent from public.factory_oauth_grants target
    where (target.workspace_id,target.id)=(p_subscription.workspace_id,p_subscription.credential_id) for share;
    if not found or consent.revoked_at is not null or consent.expires_at<=clock_timestamp() then return false; end if;
    select pinned.* into binding from public.factory_oauth_grant_bindings pinned
    where (pinned.workspace_id,pinned.factory_id,pinned.grant_id)=
      (p_subscription.workspace_id,p_subscription.factory_id,consent.id);
    if not found or not ('sessions:read'=any(binding.scopes)) then return false; end if;
    approved:=internal.require_factory_oauth_binding(binding.workspace_id,binding.factory_id,binding.service_principal_id,
      binding.execution_grant_id,binding.execution_grant_version,consent.consenting_member_id, array['sessions:read']::public.factory_command_scope[]);
  end if;
  return (approved.id,approved.version,approved.service_principal_id,approved.github_repository_id)=
    (p_subscription.execution_grant_id,p_subscription.execution_grant_version,p_subscription.service_principal_id,
      p_subscription.writer_repository_id)
    and internal.factory_event_subscription_has_authority(p_subscription)
    and approved.expires_at>clock_timestamp()
    and case when p_subscription.credential_kind='machine_token' then
      token.expires_at is null or token.expires_at>clock_timestamp()
    else consent.expires_at>clock_timestamp()
      and exists(select 1 from internal.factory_oauth_token_pairs pair
        where pair.grant_id=consent.id and pair.replaced_at is null and pair.refresh_expires_at>clock_timestamp()
          and 'sessions:read'=any(pair.scopes)) end;
exception when insufficient_privilege or foreign_key_violation or sqlstate 'P0010' or sqlstate 'P0011' then
  return false;
end;
$$;

create function public.begin_factory_event_send(p_delivery_id uuid,p_lease_id uuid,p_subscription_revision bigint)
returns table(outcome text,attempt_id uuid,event_id uuid,event_type public.factory_outbound_event_type,payload jsonb,signing_secret_encrypted text)
language plpgsql security definer set search_path='' as $$
declare
  subscription internal.factory_event_subscriptions;
  target internal.factory_outbound_deliveries;
  event internal.factory_outbound_events;
  chosen_attempt uuid;
  authorized boolean;
  now_at timestamptz;
begin
  select candidate.* into target from internal.factory_outbound_deliveries candidate
  where (candidate.id,candidate.lease_id)=(p_delivery_id,p_lease_id) and candidate.status='claimed';
  if not found then return query select 'stale',null::uuid,null::uuid,null::public.factory_outbound_event_type,null::jsonb,null::text; return; end if;
  select current_subscription.* into subscription from internal.factory_event_subscriptions current_subscription
  where current_subscription.id=target.subscription_id;
  if not found then return query select 'stale',null::uuid,null::uuid,null::public.factory_outbound_event_type,null::jsonb,null::text; return; end if;
  authorized:=subscription.status='active' and internal.lock_factory_outbound_authority(subscription);
  select current_subscription.* into subscription from internal.factory_event_subscriptions current_subscription
  where current_subscription.id=target.subscription_id for share;
  if not found then return query select 'stale',null::uuid,null::uuid,null::public.factory_outbound_event_type,null::jsonb,null::text; return; end if;
  select candidate.* into target from internal.factory_outbound_deliveries candidate
  where (candidate.id,candidate.lease_id,candidate.status)=(p_delivery_id,p_lease_id,'claimed') for update;
  now_at:=clock_timestamp();
  if not found or target.lease_expires_at<=now_at or target.deadline_at<=now_at+interval '10 seconds' then
    return query select 'stale',null::uuid,null::uuid,null::public.factory_outbound_event_type,null::jsonb,null::text; return;
  end if;
  select canonical.* into strict event from internal.factory_outbound_events canonical where canonical.id=target.event_id;
  if authorized is not true or subscription.status<>'active'
    or not internal.factory_event_subscription_has_authority(subscription) or not exists (
    select 1 from internal.factory_session_read_owners owner
    where (owner.id,owner.workspace_id,owner.factory_id,owner.github_repository_id)=
      (event.session_id,event.workspace_id,event.factory_id,event.writer_repository_id)
  ) then
    perform internal.settle_locked_factory_event_attempt(target,'permanent_failure',null,null,true);
    return query select 'revoked',null::uuid,null::uuid,null::public.factory_outbound_event_type,null::jsonb,null::text; return;
  end if;
  if subscription.revision is distinct from p_subscription_revision then
    return query select 'stale',null::uuid,null::uuid,null::public.factory_outbound_event_type,null::jsonb,null::text; return;
  end if;
  update internal.factory_outbound_delivery_attempts attempt set send_started_at=now_at
  where (attempt.delivery_id,attempt.number,attempt.lease_id)=(target.id,target.attempt_count,p_lease_id)
    and attempt.send_started_at is null and attempt.settled_at is null
  returning attempt.id into strict chosen_attempt;
  update internal.factory_outbound_deliveries delivery set status='sending',
    lease_expires_at=least(now_at+interval '45 seconds',target.deadline_at) where delivery.id=target.id;
  return query select 'authorized',chosen_attempt,event.id,event.event_type,event.payload,subscription.signing_secret_encrypted;
end;
$$;

create function public.settle_factory_event_delivery(p_delivery_id uuid,p_lease_id uuid,
  p_outcome public.factory_outbound_delivery_outcome,p_attempt_id uuid default null,
  p_http_status integer default null,p_retry_after_seconds integer default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare target internal.factory_outbound_deliveries;
begin
  if p_outcome is null or (p_http_status is not null and p_http_status not between 100 and 599)
    or (p_outcome='delivered' and (p_http_status is null or p_http_status not between 200 and 299))
    or (p_attempt_id is null and (p_http_status is not null or p_outcome not in ('permanent_failure','retryable_failure'))) then
    raise exception 'Invalid outbound delivery outcome.' using errcode='22023';
  end if;
  select delivery.* into target from internal.factory_outbound_deliveries delivery
  where (delivery.id,delivery.lease_id)=(p_delivery_id,p_lease_id)
    and delivery.status=case when p_attempt_id is null then 'claimed'::public.factory_outbound_delivery_status else 'sending' end
  for update;
  if not found or target.lease_expires_at<=clock_timestamp() then return false; end if;
  if p_attempt_id is not null and not exists (
    select 1 from internal.factory_outbound_delivery_attempts attempt
    where (attempt.id,attempt.delivery_id,attempt.number,attempt.lease_id)=(p_attempt_id,target.id,target.attempt_count,p_lease_id)
      and attempt.send_started_at is not null and attempt.settled_at is null
  ) then return false; end if;
  perform internal.settle_locked_factory_event_attempt(target,p_outcome,p_http_status,p_retry_after_seconds);
  return true;
end;
$$;

create function internal.can_retry_factory_event_delivery(
  p_delivery internal.factory_outbound_deliveries,p_subscription internal.factory_event_subscriptions
) returns boolean language sql stable set search_path='' as $$
  select p_subscription.status='active'
    and internal.factory_event_subscription_has_authority(p_subscription)
    and p_delivery.status in ('failed','unknown') and p_delivery.next_attempt_at is null
    and p_delivery.deadline_at>clock_timestamp()+interval '10 seconds'
    and p_delivery.manual_retries<3 and p_delivery.attempt_count<9
$$;

create function public.list_factory_event_deliveries(p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,
  p_subscription_id uuid,p_limit integer default 25,p_before_created_at timestamptz default null,p_before_id uuid default null)
returns table(id uuid,event_id uuid,event_type public.factory_outbound_event_type,status public.factory_outbound_delivery_status,
  attempt_count integer,last_outcome public.factory_outbound_delivery_outcome,last_http_status integer,created_at timestamptz,
  last_attempt_at timestamptz,next_attempt_at timestamptz,delivered_at timestamptz,
  has_unknown_outcome boolean,retryable boolean)
language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  if p_limit is null or p_limit not between 1 and 50 or (p_before_created_at is null)<>(p_before_id is null)
    or (p_before_created_at is not null and not isfinite(p_before_created_at)) then
    raise exception 'Invalid delivery pagination.' using errcode='22023';
  end if;
  if not exists (select 1 from internal.factory_event_subscriptions subscription
    where (subscription.id,subscription.workspace_id,subscription.factory_id)=(p_subscription_id,p_workspace_id,p_factory_id)) then
    raise exception 'Subscription not found.' using errcode='P0002';
  end if;
  return query select delivery.id,delivery.event_id,event.event_type,delivery.status,delivery.attempt_count,
    delivery.last_outcome,delivery.last_http_status,delivery.created_at,delivery.last_attempt_at,delivery.next_attempt_at,delivery.delivered_at,
    delivery.has_unknown_outcome,internal.can_retry_factory_event_delivery(delivery,subscription)
  from internal.factory_outbound_deliveries delivery join internal.factory_outbound_events event on event.id=delivery.event_id
  join internal.factory_event_subscriptions subscription on subscription.id=delivery.subscription_id
  where (delivery.subscription_id,delivery.workspace_id,delivery.factory_id)=(p_subscription_id,p_workspace_id,p_factory_id)
    and (p_before_created_at is null or (delivery.created_at,delivery.id)<(p_before_created_at,p_before_id))
  order by delivery.created_at desc,delivery.id desc limit p_limit;
end;
$$;

create function public.retry_factory_event_delivery(p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_delivery_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  update internal.factory_outbound_deliveries delivery set status='queued',next_attempt_at=clock_timestamp(),
    manual_retries=manual_retries+1,attempt_limit=attempt_count+1
  from internal.factory_event_subscriptions subscription
  where (delivery.id,delivery.workspace_id,delivery.factory_id)=(p_delivery_id,p_workspace_id,p_factory_id)
    and delivery.subscription_id=subscription.id
    and internal.can_retry_factory_event_delivery(delivery,subscription);
  return found;
end;
$$;

create function public.prune_factory_event_outbox(p_batch_size integer default 500)
returns table(deliveries_deleted integer,events_deleted integer,subscriptions_deleted integer)
language plpgsql security definer set search_path='' as $$
declare
  batch_size integer:=least(greatest(coalesce(p_batch_size,500),1),500);
  cutoff timestamptz:=clock_timestamp()-interval '7 days';
begin
  with expired as (
    select delivery.id from internal.factory_outbound_deliveries delivery
    where delivery.created_at<=cutoff and (delivery.lease_expires_at is null or delivery.lease_expires_at<=clock_timestamp())
    order by delivery.created_at,delivery.id limit batch_size for update skip locked
  )
  delete from internal.factory_outbound_deliveries delivery using expired where delivery.id=expired.id;
  get diagnostics deliveries_deleted=row_count;

  with expired as (
    select event.id from internal.factory_outbound_events event where event.occurred_at<=cutoff
      and not exists(select 1 from internal.factory_outbound_deliveries delivery where delivery.event_id=event.id)
    order by event.occurred_at,event.id limit batch_size for update of event skip locked
  )
  delete from internal.factory_outbound_events event using expired where event.id=expired.id;
  get diagnostics events_deleted=row_count;

  with expired as (
    select subscription.id from internal.factory_event_subscriptions subscription
    where subscription.status='revoked' and subscription.revoked_at<=cutoff
      and not exists(select 1 from internal.factory_outbound_deliveries delivery where delivery.subscription_id=subscription.id)
    order by subscription.revoked_at,subscription.id limit batch_size for update of subscription skip locked
  )
  delete from internal.factory_event_subscriptions subscription using expired where subscription.id=expired.id;
  get diagnostics subscriptions_deleted=row_count;
  return next;
end;
$$;

create index factory_event_subscriptions_retention_idx
  on internal.factory_event_subscriptions(revoked_at,id) where status='revoked';

revoke all on function internal.emit_factory_outbound_event(uuid,uuid,public.factory_outbound_event_type,text,uuid,integer,uuid,uuid,integer,integer,public.agent_run_status,uuid,timestamptz),
  internal.capture_factory_outbound_event(),
  internal.settle_locked_factory_event_attempt(internal.factory_outbound_deliveries,public.factory_outbound_delivery_outcome,integer,integer,boolean),
  internal.lock_factory_outbound_authority(internal.factory_event_subscriptions),
  internal.can_retry_factory_event_delivery(internal.factory_outbound_deliveries,internal.factory_event_subscriptions)
from public,anon,authenticated,service_role;

revoke all on function public.claim_factory_event_delivery(),
  public.begin_factory_event_send(uuid,uuid,bigint),
  public.settle_factory_event_delivery(uuid,uuid,public.factory_outbound_delivery_outcome,uuid,integer,integer),
  public.list_factory_event_deliveries(uuid,uuid,uuid,uuid,integer,timestamptz,uuid),
  public.retry_factory_event_delivery(uuid,uuid,uuid,uuid),
  public.prune_factory_event_outbox(integer) from public,anon,authenticated,service_role;
grant execute on function public.claim_factory_event_delivery(),
  public.begin_factory_event_send(uuid,uuid,bigint),
  public.settle_factory_event_delivery(uuid,uuid,public.factory_outbound_delivery_outcome,uuid,integer,integer),
  public.list_factory_event_deliveries(uuid,uuid,uuid,uuid,integer,timestamptz,uuid),
  public.retry_factory_event_delivery(uuid,uuid,uuid,uuid),
  public.prune_factory_event_outbox(integer) to service_role;
