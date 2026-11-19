-- Both worker runtimes and every command surface share these database
-- transitions. A rolled-back transition leaves no analytics fact.
create function internal.capture_factory_outcome_session_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Machine and human create commands pin the actual initiating actor.
  perform internal.record_factory_outcome_observation(
    new.workspace_id, new.factory_id, 'session.created', 'session', new.id::text, new.created_at,
    p_session_id => new.id,
    p_stage_id => new.current_stage_id,
    p_actor_member_id => case when new.creator_service_principal_id is null then new.creator_member_id end,
    p_actor_service_principal_id => new.creator_service_principal_id,
    p_definition_revision_id => new.factory_definition_revision_id,
    p_repository_id => new.github_repository_id,
    p_status => new.phase_status::text
  );
  return new;
end;
$$;
revoke all on function internal.capture_factory_outcome_session_created()
  from public, anon, authenticated, service_role;

create trigger capture_factory_outcome_session_created after insert on public.sessions
  for each row execute function internal.capture_factory_outcome_session_created();

create function internal.factory_outcome_canceled_run_id(p_receipt internal.session_mutation_receipts)
returns uuid language sql stable set search_path = '' as $$
  -- Other returned runs can be present only for sandbox cleanup. Match
  -- the canonical cancel intent hash to prove the requested generation.
  select run.id
  from public.agent_runs run
  where p_receipt.operation = 'cancel'
    and (run.workspace_id, run.session_id, run.status) =
      (p_receipt.workspace_id, p_receipt.session_id, 'canceled')
    and jsonb_typeof(p_receipt.result->'runIds') = 'array'
    and (p_receipt.result->'runIds') ? run.id::text
    and p_receipt.intent_hash = encode(extensions.digest(convert_to(
      jsonb_build_object('sessionId', p_receipt.session_id, 'expectedRunId', run.id)::text,
      'UTF8'), 'sha256'), 'hex')
$$;
revoke all on function internal.factory_outcome_canceled_run_id(internal.session_mutation_receipts)
  from public, anon, authenticated, service_role;

create function internal.factory_outcome_job_service_actor(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_job_id uuid
) returns uuid language sql stable set search_path = '' as $$
  select coalesce(
    (
      select batch.requested_by_service_principal_id from public.artifact_feedback_batches batch
      where (batch.job_id, batch.workspace_id, batch.session_id) =
        (p_job_id, p_workspace_id, p_session_id)
        and batch.job_created
    ),
    (
      select receipt.actor_service_principal_id from internal.session_mutation_receipts receipt
      where (receipt.session_id, receipt.workspace_id, receipt.factory_id, receipt.operation) =
        (p_session_id, p_workspace_id, p_factory_id, 'create')
        and receipt.result->>'jobId' = p_job_id::text
      order by receipt.created_at, receipt.id
      limit 1
    )
  )
$$;
revoke all on function internal.factory_outcome_job_service_actor(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function internal.capture_factory_outcome_lifecycle()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  owner record;
  event_type text;
  source_kind text;
  source_key text;
  occurred_at timestamptz;
  job_id uuid;
  run_id uuid;
  attempt_count integer;
  stage_id uuid;
  artifact_id uuid;
  member_id uuid;
  principal_id uuid;
  lifecycle_status text;
  job_trigger text;
begin
  select session.id, session.workspace_id, session.factory_id, session.phase_status,
    session.factory_definition_revision_id, session.github_repository_id
  into owner
  from public.sessions session
  where (session.id, session.workspace_id) = (new.session_id, new.workspace_id);
  if not found then return new; end if;

  case tg_table_name
    when 'agent_jobs' then
      if tg_op = 'UPDATE' and old.status = new.status then return new; end if;
      source_kind := 'job';
      job_id := new.id;
      stage_id := new.stage_id;
      lifecycle_status := new.status::text;
      job_trigger := new.trigger_type::text;
      member_id := new.requested_by_member_id;
      if new.status = 'queued' then
        event_type := 'job.queued';
        attempt_count := new.attempt_count + 1;
        source_key := new.id::text || ':' || attempt_count::text;
        -- scheduled_at is future eligibility, not when the retry was queued.
        occurred_at := case when tg_op = 'INSERT' then new.created_at else clock_timestamp() end;
      elsif new.status in ('success', 'error', 'canceled') then
        event_type := 'job.finished';
        attempt_count := nullif(new.attempt_count, 0);
        source_key := new.id::text || ':' || new.attempt_count::text;
        occurred_at := new.finished_at;
      end if;
    when 'agent_runs' then
      if tg_op = 'UPDATE' and (old.status, old.attempt_count)
        is not distinct from (new.status, new.attempt_count) then return new; end if;
      source_kind := 'run';
      source_key := new.id::text || ':' || coalesce(new.attempt_count, 0)::text;
      run_id := new.id;
      job_id := new.agent_job_id;
      attempt_count := nullif(new.attempt_count, 0);
      stage_id := new.stage_id;
      lifecycle_status := new.status::text;
      member_id := new.triggered_by_member_id;
      if new.status = 'running' and attempt_count is not null then
        event_type := 'run.started';
        occurred_at := new.started_at;
      elsif new.status in ('success', 'error', 'canceled') then
        event_type := 'run.finished';
        occurred_at := new.finished_at;
      end if;
    when 'session_git_checkpoints', 'session_conversation_messages' then
      -- A retained checkpoint and the canonical review-ready message identify
      -- the same artifact even if only one publication path produces a marker.
      select artifact.stage_id into stage_id
      from public.session_artifacts artifact
      where (artifact.id, artifact.workspace_id, artifact.session_id) =
        (new.artifact_id, owner.workspace_id, owner.id);
      if not found then return new; end if;
      event_type := 'review.ready';
      source_kind := 'artifact';
      source_key := new.artifact_id::text;
      occurred_at := new.created_at;
      artifact_id := new.artifact_id;
      run_id := new.run_id;
      attempt_count := new.attempt_count;
      if tg_table_name = 'session_git_checkpoints' then
        job_id := new.job_id;
      end if;
      lifecycle_status := 'awaiting_review';
    when 'session_stage_approval_receipts' then
      event_type := 'review.approved';
      source_kind := 'approval_receipt';
      source_key := new.id::text;
      occurred_at := new.approved_at;
      artifact_id := new.artifact_id;
      stage_id := new.stage_id;
      member_id := new.approved_by_member_id;
      -- The receipt is inserted after advancing or completing the session.
      lifecycle_status := owner.phase_status::text;
    when 'artifact_feedback_batches' then
      event_type := 'review.changes_requested';
      source_kind := 'feedback_batch';
      source_key := new.id::text;
      occurred_at := new.created_at;
      artifact_id := new.artifact_id;
      stage_id := new.stage_id;
      job_id := new.job_id;
      run_id := new.run_id;
      member_id := new.requested_by_member_id;
      principal_id := new.requested_by_service_principal_id;
    when 'session_specification_clarifications' then
      if (tg_op = 'INSERT' and new.status = 'pending') then
        event_type := 'review.clarification_requested';
        occurred_at := new.created_at;
      elsif (tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'answered') then
        event_type := 'review.clarification_answered';
        occurred_at := new.answered_at;
        member_id := new.answered_by_member_id;
        principal_id := new.answered_by_service_principal_id;
      end if;
      source_kind := 'clarification';
      source_key := new.id::text;
      artifact_id := new.artifact_id;
      stage_id := new.stage_id;
      run_id := new.run_id;
      attempt_count := new.attempt_count;
    when 'session_cancellation_requests', 'session_mutation_receipts' then
      if new.factory_id is distinct from owner.factory_id then return new; end if;
      event_type := 'session.canceled';
      source_kind := 'cancellation';
      occurred_at := new.created_at;
      lifecycle_status := 'canceled';
      if tg_table_name = 'session_cancellation_requests' then
        run_id := new.expected_run_id;
        member_id := new.actor_member_id;
      else
        run_id := internal.factory_outcome_canceled_run_id(new);
        member_id := new.actor_member_id;
        principal_id := new.actor_service_principal_id;
      end if;
      source_key := owner.id::text || ':' || coalesce(run_id, new.request_id)::text;
    else
      raise exception 'Unexpected outcome lifecycle trigger source.' using errcode = '23514';
  end case;

  if event_type is not null and occurred_at is not null then
    if member_id is null and job_id is not null and source_kind in ('job', 'run') then
      principal_id := internal.factory_outcome_job_service_actor(
        owner.workspace_id, owner.factory_id, owner.id, job_id
      );
    end if;
    perform internal.record_factory_outcome_observation(
      owner.workspace_id, owner.factory_id, event_type, source_kind, source_key, occurred_at,
      p_session_id => owner.id,
      p_job_id => job_id,
      p_run_id => run_id,
      p_attempt_count => attempt_count,
      p_stage_id => stage_id,
      p_artifact_id => artifact_id,
      p_actor_member_id => member_id,
      p_actor_service_principal_id => principal_id,
      p_definition_revision_id => owner.factory_definition_revision_id,
      p_repository_id => owner.github_repository_id,
      p_status => lifecycle_status,
      p_trigger_type => job_trigger
    );
  end if;
  return new;
end;
$$;
revoke all on function internal.capture_factory_outcome_lifecycle()
  from public, anon, authenticated, service_role;

create trigger capture_factory_outcome_job after update of status on public.agent_jobs
  for each row execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_job_insert after insert on public.agent_jobs
  for each row when (new.status <> 'queued' or new.requested_by_member_id is not null)
  execute function internal.capture_factory_outcome_lifecycle();
-- Machine create and review commands record the exact job's actor later in
-- the same transaction. Resolve that persisted attribution before commit.
create constraint trigger capture_factory_outcome_machine_job_queued
  after insert on public.agent_jobs deferrable initially deferred
  for each row when (new.status = 'queued' and new.requested_by_member_id is null)
  execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_run
  after insert or update of status, attempt_count on public.agent_runs
  for each row execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_review_checkpoint after insert on public.session_git_checkpoints
  for each row execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_review_message after insert on public.session_conversation_messages
  for each row when (new.kind = 'review_ready') execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_approval after insert on public.session_stage_approval_receipts
  for each row execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_feedback after insert on public.artifact_feedback_batches
  for each row execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_clarification
  after insert or update of status on public.session_specification_clarifications
  for each row execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_legacy_cancel after insert on internal.session_cancellation_requests
  for each row execute function internal.capture_factory_outcome_lifecycle();
create trigger capture_factory_outcome_cancel after insert on internal.session_mutation_receipts
  for each row when (new.operation = 'cancel') execute function internal.capture_factory_outcome_lifecycle();

-- DDL locks keep lifecycle writers from slipping between installation and the
-- explicit boundary that future projections use for complete coverage.
insert into internal.factory_outcome_capture_coverage (source, live_from)
values ('lifecycle', clock_timestamp());
