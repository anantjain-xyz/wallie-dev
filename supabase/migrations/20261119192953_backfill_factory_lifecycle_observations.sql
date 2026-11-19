-- A historical event is justified by its own retained source. Current session
-- phase, latest run status, and overwritten queue schedules are not history.
create view internal.factory_outcome_history_sources with (security_invoker = true) as
  select session.workspace_id, session.factory_id, 'session.created'::text as event_type,
    'session'::text as source_kind, session.id as source_id, session.id::text as source_key,
    session.created_at as occurred_at, session.id as session_id, null::uuid as job_id,
    null::uuid as run_id, null::integer as attempt_count, admission.selected_stage_ids[1] as stage_id,
    null::uuid as artifact_id,
    case when receipt.actor_service_principal_id is null and session.creator_service_principal_id is null
      then coalesce(receipt.actor_member_id, session.creator_member_id) end as actor_member_id,
    coalesce(receipt.actor_service_principal_id, session.creator_service_principal_id) as actor_service_principal_id,
    session.factory_definition_revision_id as definition_revision_id,
    admission.github_repository_id as repository_id, null::text as status, null::text as trigger_type
  from public.sessions session
  left join public.session_factory_admission_inputs admission on
    (admission.workspace_id, admission.factory_id, admission.session_id) =
    (session.workspace_id, session.factory_id, session.id)
  left join lateral (
    select mutation.actor_member_id, mutation.actor_service_principal_id
    from internal.session_mutation_receipts mutation
    where (mutation.workspace_id, mutation.factory_id, mutation.session_id, mutation.operation) =
      (session.workspace_id, session.factory_id, session.id, 'create')
    order by mutation.created_at, mutation.id
    limit 1
  ) receipt on true

  union all

  -- Creation time is an initial enqueue even after its mutable job has been
  -- requeued. Only recover jobs with an attributable requester, and never
  -- copy the mutable attempt counter or its latest scheduling timestamp.
  select session.workspace_id, session.factory_id, 'job.queued', 'job', job.id, job.id::text || ':1',
    job.created_at, session.id, job.id, null, 1, job.stage_id, null,
    case when coalesce(receipt.actor_service_principal_id, feedback.requested_by_service_principal_id) is null
      then coalesce(receipt.actor_member_id, feedback.requested_by_member_id, job.requested_by_member_id) end,
    coalesce(receipt.actor_service_principal_id, feedback.requested_by_service_principal_id),
    session.factory_definition_revision_id,
    admission.github_repository_id, 'queued', job.trigger_type::text
  from public.agent_jobs job
  join public.sessions session on (session.workspace_id, session.id) = (job.workspace_id, job.session_id)
  left join public.session_factory_admission_inputs admission on
    (admission.workspace_id, admission.factory_id, admission.session_id) =
    (session.workspace_id, session.factory_id, session.id)
  left join lateral (
    select mutation.actor_member_id, mutation.actor_service_principal_id
    from internal.session_mutation_receipts mutation
    where (mutation.workspace_id, mutation.factory_id, mutation.session_id, mutation.operation) =
      (session.workspace_id, session.factory_id, session.id, 'create')
      and mutation.result->>'jobId' = job.id::text
    order by mutation.created_at, mutation.id
    limit 1
  ) receipt on true
  left join public.artifact_feedback_batches feedback on
    (feedback.workspace_id, feedback.session_id, feedback.job_id) = (job.workspace_id, job.session_id, job.id)
    and feedback.job_created
  where num_nonnulls(receipt.actor_member_id, receipt.actor_service_principal_id,
    feedback.requested_by_member_id, feedback.requested_by_service_principal_id, job.requested_by_member_id) > 0

  union all

  -- The accepted checkpoint and canonical message identify the same exact
  -- review-ready artifact. Arbitrary messages and draft artifacts do not qualify.
  select session.workspace_id, session.factory_id, 'review.ready', 'artifact', artifact.id, artifact.id::text,
    coalesce(checkpoint.created_at, message.created_at), session.id, checkpoint.job_id,
    coalesce(checkpoint.run_id, message.run_id), coalesce(checkpoint.attempt_count, message.attempt_count), artifact.stage_id,
    artifact.id, null, null, session.factory_definition_revision_id,
    coalesce(checkpoint.repository_id, admission.github_repository_id), 'awaiting_review', null
  from public.session_artifacts artifact
  join public.sessions session on (session.workspace_id, session.id) = (artifact.workspace_id, artifact.session_id)
  left join internal.session_conversation_message_receipts receipt
    on (receipt.session_id, receipt.receipt_key) = (artifact.session_id, 'review_ready:' || artifact.id::text)
  left join public.session_conversation_messages message on
    (message.workspace_id, message.factory_id, message.session_id, message.sequence, message.artifact_id) =
    (session.workspace_id, session.factory_id, session.id, receipt.sequence, artifact.id)
    and message.kind = 'review_ready'
  left join public.session_git_checkpoints checkpoint on
    (checkpoint.workspace_id, checkpoint.session_id, checkpoint.artifact_id) = (session.workspace_id, session.id, artifact.id)
  left join public.session_factory_admission_inputs admission on
    (admission.workspace_id, admission.factory_id, admission.session_id) =
    (session.workspace_id, session.factory_id, session.id)
  where checkpoint.run_id is not null or message.sequence is not null

  union all

  select session.workspace_id, session.factory_id, 'review.approved', 'approval_receipt', receipt.id, receipt.id::text,
    receipt.approved_at, session.id, null, null, null, receipt.stage_id, receipt.artifact_id,
    receipt.approved_by_member_id, null, session.factory_definition_revision_id, admission.github_repository_id, null, null
  from public.session_stage_approval_receipts receipt
  join public.sessions session on (session.workspace_id, session.id) = (receipt.workspace_id, receipt.session_id)
  left join public.session_factory_admission_inputs admission on
    (admission.workspace_id, admission.factory_id, admission.session_id) =
    (session.workspace_id, session.factory_id, session.id)

  union all

  select session.workspace_id, session.factory_id, 'review.changes_requested', 'feedback_batch', batch.id, batch.id::text,
    batch.created_at, session.id, batch.job_id, batch.run_id, null, batch.stage_id, batch.artifact_id,
    batch.requested_by_member_id, batch.requested_by_service_principal_id, session.factory_definition_revision_id,
    admission.github_repository_id, null, null
  from public.artifact_feedback_batches batch
  join public.sessions session on (session.workspace_id, session.id) = (batch.workspace_id, batch.session_id)
  left join public.session_factory_admission_inputs admission on
    (admission.workspace_id, admission.factory_id, admission.session_id) =
    (session.workspace_id, session.factory_id, session.id)

  union all

  select session.workspace_id, session.factory_id, source.event_type, 'clarification',
    clarification.id, clarification.id::text, source.occurred_at, session.id, null,
    clarification.run_id, clarification.attempt_count, clarification.stage_id, clarification.artifact_id,
    source.actor_member_id, source.actor_service_principal_id, session.factory_definition_revision_id,
    admission.github_repository_id, null, null
  from public.session_specification_clarifications clarification
  join public.sessions session on (session.workspace_id, session.factory_id, session.id) =
    (clarification.workspace_id, clarification.factory_id, clarification.session_id)
  cross join lateral (values
    ('review.clarification_requested', clarification.created_at, null::uuid, null::uuid),
    ('review.clarification_answered', clarification.answered_at,
      clarification.answered_by_member_id, clarification.answered_by_service_principal_id)
  ) source(event_type, occurred_at, actor_member_id, actor_service_principal_id)
  left join public.session_factory_admission_inputs admission on
    (admission.workspace_id, admission.factory_id, admission.session_id) =
    (session.workspace_id, session.factory_id, session.id)
  where source.occurred_at is not null

  union all

  -- Legacy receipts name the guarded run. A unified receipt must prove which
  -- returned run matches its original cancellation intent.
  select session.workspace_id, session.factory_id, 'session.canceled', 'cancellation', receipt.run_id,
    session.id::text || ':' || receipt.run_id::text, receipt.created_at, session.id,
    null, receipt.run_id, null, null, null, receipt.actor_member_id, receipt.actor_service_principal_id,
    session.factory_definition_revision_id, admission.github_repository_id, 'canceled', null
  from (
    select workspace_id, factory_id, session_id, expected_run_id as run_id,
      actor_member_id, null::uuid as actor_service_principal_id, created_at
    from internal.session_cancellation_requests
    union all
    select mutation.workspace_id, mutation.factory_id, mutation.session_id, exact_run.id,
      mutation.actor_member_id, mutation.actor_service_principal_id, mutation.created_at
    from internal.session_mutation_receipts mutation
    cross join lateral (select internal.factory_outcome_canceled_run_id(mutation) as id) exact_run
    where mutation.operation = 'cancel' and exact_run.id is not null
  ) receipt
  join public.sessions session on (session.workspace_id, session.factory_id, session.id) =
    (receipt.workspace_id, receipt.factory_id, receipt.session_id)
  left join public.session_factory_admission_inputs admission on
    (admission.workspace_id, admission.factory_id, admission.session_id) =
    (session.workspace_id, session.factory_id, session.id);
revoke all on internal.factory_outcome_history_sources from public, anon, authenticated, service_role;

-- Per-kind keyset paging bounds the number of sources read into each batch.
-- Repeat the same cursor after a failure. A null next cursor means the fixed
-- cutoff is exhausted for that event kind, not that historical coverage is complete.
create function internal.backfill_factory_outcome_observations(
  p_workspace_id uuid, p_factory_id uuid, p_event_type text, p_before timestamptz,
  p_after_source_id uuid default null, p_limit integer default 100
) returns table(next_source_id uuid, source_rows integer)
language plpgsql security invoker set search_path = '' as $$
declare
  capture_start timestamptz;
  event internal.factory_outcome_history_sources%rowtype;
begin
  select coverage.live_from into strict capture_start
    from internal.factory_outcome_capture_coverage coverage where coverage.source = 'lifecycle';
  if p_workspace_id is null or p_factory_id is null or p_event_type is null or p_before is null
    or not isfinite(p_before) or p_before > capture_start or p_limit is null or p_limit not between 1 and 250
    or p_event_type not in (
      'session.created', 'job.queued', 'review.ready', 'review.approved',
      'review.changes_requested', 'review.clarification_requested',
      'review.clarification_answered', 'session.canceled'
    ) then
    raise exception 'Invalid factory lifecycle backfill scope, event type, cutoff, or batch size.'
      using errcode = '22023';
  end if;

  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then
    raise exception 'The workspace is unavailable for factory lifecycle backfill.' using errcode = 'P0002';
  end if;
  perform 1 from public.factories factory where (factory.workspace_id, factory.id) =
    (p_workspace_id, p_factory_id) for key share;
  if not found then
    raise exception 'The factory is unavailable for lifecycle backfill.' using errcode = 'P0002';
  end if;

  source_rows := 0;
  next_source_id := null;
  for event in
    select source.*
    from internal.factory_outcome_history_sources source
    where (source.workspace_id, source.factory_id, source.event_type) =
      (p_workspace_id, p_factory_id, p_event_type)
      and source.occurred_at < p_before
      and (p_after_source_id is null or source.source_id > p_after_source_id)
    order by source.source_id, source.occurred_at, source.actor_member_id, source.actor_service_principal_id
    limit p_limit
  loop
    perform internal.record_factory_outcome_observation(
      event.workspace_id, event.factory_id, event.event_type, event.source_kind, event.source_key, event.occurred_at,
      p_session_id => event.session_id, p_job_id => event.job_id, p_run_id => event.run_id,
      p_attempt_count => event.attempt_count, p_stage_id => event.stage_id, p_artifact_id => event.artifact_id,
      p_actor_member_id => event.actor_member_id, p_actor_service_principal_id => event.actor_service_principal_id,
      p_definition_revision_id => event.definition_revision_id, p_repository_id => event.repository_id,
      p_status => event.status, p_trigger_type => event.trigger_type, p_capture_mode => 'backfill'
    );
    source_rows := source_rows + 1;
    next_source_id := event.source_id;
  end loop;
  if source_rows < p_limit then next_source_id := null; end if;
  return next;
end;
$$;
revoke all on function internal.backfill_factory_outcome_observations(uuid, uuid, text, timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;

comment on function internal.backfill_factory_outcome_observations(uuid, uuid, text, timestamptz, uuid, integer) is
  'Operator-only replay of retained evidence for one workspace, factory and event kind. Keep the exclusive cutoff fixed at or before live capture began and continue from the returned UUID. Does not imply historical completeness.';
