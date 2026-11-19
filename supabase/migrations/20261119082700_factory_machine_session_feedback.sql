-- Keep the same immutable review generations when an authenticated factory
-- principal requests a revision or answers a specification clarification.
alter table public.artifact_feedback_batches
  alter column requested_by_member_id drop not null,
  add column requested_by_service_principal_id uuid,
  add constraint artifact_feedback_batches_actor_check check (
    num_nonnulls(requested_by_member_id, requested_by_service_principal_id) = 1
    and (requested_by_service_principal_id is null or cardinality(selected_thread_ids) = 0)
  );
create unique index artifact_feedback_batches_service_request_idx
  on public.artifact_feedback_batches(workspace_id, requested_by_service_principal_id, request_id)
  where requested_by_service_principal_id is not null;

alter table public.session_specification_clarifications
  add column answered_by_service_principal_id uuid,
  drop constraint session_specification_clarifications_check,
  add constraint session_specification_clarifications_answer_check check (
    (status = 'pending' and not execution_exhausted and answered_at is null
      and num_nonnulls(answered_by_member_id, answered_by_service_principal_id) = 0
      and answer_text is null and feedback_batch_id is null and successor_job_id is null and successor_run_id is null)
    or (status = 'answered' and answered_at is not null
      and num_nonnulls(answered_by_member_id, answered_by_service_principal_id) = 1 and answer_text is not null
      and feedback_batch_id is not null
      and ((execution_exhausted and successor_job_id is null and successor_run_id is null)
        or (not execution_exhausted and successor_job_id is not null and successor_run_id is not null)))
  );

create function internal.artifact_feedback_actor_label(
  p_session public.sessions, p_member_id uuid, p_service_principal_id uuid
) returns text language plpgsql set search_path = '' as $$
declare label text;
begin
  if num_nonnulls(p_member_id, p_service_principal_id) <> 1 then return null; end if;
  if p_member_id is not null then
    select internal.artifact_review_author_label(member) into label from public.workspace_members member
    where (member.workspace_id, member.id) = (p_session.workspace_id, p_member_id)
      and member.kind = 'human' and member.is_active for share;
  else
    select principal.name into label
    from public.session_factory_admission_inputs admission
    join public.service_principals principal on
      (principal.workspace_id, principal.factory_id, principal.id) =
      (admission.workspace_id, admission.factory_id, admission.credential_owner_service_principal_id)
    where p_session.execute_pinned_definition and admission.execution_grant_id is not null
      and (admission.workspace_id, admission.factory_id, admission.session_id,
        admission.definition_revision_id, admission.credential_owner_service_principal_id) =
      (p_session.workspace_id, p_session.factory_id, p_session.id,
        p_session.factory_definition_revision_id, p_service_principal_id);
  end if;
  return label;
end;
$$;
revoke all on function internal.artifact_feedback_actor_label(public.sessions, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function internal.guard_artifact_feedback_batch()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare owner_session public.sessions; job public.agent_jobs; run public.agent_runs;
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.workspaces where id = old.workspace_id)
    or not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.session_artifacts where id = old.artifact_id)
    or not exists (select 1 from public.agent_jobs where id = old.job_id)
    or not exists (select 1 from public.agent_runs where id = old.run_id)
  ) then return old; end if;
  if tg_op <> 'INSERT' then raise exception 'Submitted artifact feedback is immutable.' using errcode = '23514'; end if;
  select * into owner_session from public.sessions
    where id = new.session_id and workspace_id = new.workspace_id;
  if not found or owner_session.current_artifact_id is distinct from new.artifact_id
    or owner_session.current_stage_id is distinct from new.stage_id
    or owner_session.current_artifact_version is distinct from new.artifact_version
    or owner_session.artifact_review_revision is distinct from new.review_revision
    or owner_session.rejection_count is distinct from new.rejection_count
    or owner_session.phase_status <> 'rejected' then
    raise exception 'Feedback batch does not match its reviewed transition.' using errcode = '23514';
  end if;
  if internal.artifact_feedback_actor_label(owner_session, new.requested_by_member_id,
    new.requested_by_service_principal_id) is distinct from new.actor_label then
    raise exception 'Feedback batch does not match its review actor.' using errcode = '23514';
  end if;
  if new.job_id is null or new.run_id is null then
    if new.job_id is not null or new.run_id is not null or new.job_created
      or owner_session.execution_exhausted_at is null
      or not exists (select 1 from public.session_artifacts a
        where a.id = new.artifact_id and a.session_id = new.session_id
          and a.workspace_id = new.workspace_id and a.stage_id = new.stage_id and a.version = new.artifact_version)
      or (new.checkpoint_run_id is not null and not exists(select 1 from public.session_git_checkpoints c
        where c.run_id = new.checkpoint_run_id and c.artifact_id = new.artifact_id
          and c.session_id = new.session_id and c.workspace_id = new.workspace_id)) then
      raise exception 'Exhausted feedback must retain its review without a fabricated execution.' using errcode = '23514';
    end if;
    return new;
  end if;
  select * into job from public.agent_jobs where id = new.job_id;
  select * into run from public.agent_runs where id = new.run_id;
  if job.id is null or run.id is null or job.session_id <> new.session_id
    or job.workspace_id <> new.workspace_id or job.stage_id is distinct from new.stage_id
    or (new.job_created and job.requested_by_member_id is distinct from new.requested_by_member_id)
    or job.status <> 'queued' or run.agent_job_id is distinct from job.id
    or run.session_id <> new.session_id or run.workspace_id <> new.workspace_id
    or run.stage_id is distinct from new.stage_id or run.status <> 'queued'
    or not exists (select 1 from public.session_artifacts a
      where a.id = new.artifact_id and a.session_id = new.session_id
        and a.workspace_id = new.workspace_id and a.stage_id = new.stage_id
        and a.version = new.artifact_version) then
    raise exception 'Feedback batch does not match its revision generation.' using errcode = '23514';
  end if;
  if new.checkpoint_run_id is not null and not exists (
    select 1 from public.session_git_checkpoints c
    join public.session_job_git_inputs i on i.job_id = new.job_id
    where c.run_id = new.checkpoint_run_id and c.artifact_id = new.artifact_id
      and c.session_id = new.session_id and c.workspace_id = new.workspace_id
      and i.source_checkpoint_run_id = c.run_id and i.input_sha = c.output_sha
      and i.session_id = c.session_id and i.workspace_id = c.workspace_id
  ) then
    raise exception 'Feedback batch does not match its reviewed checkpoint.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create function internal.apply_artifact_feedback_batch(
  p_session_id uuid, p_workspace_id uuid, p_artifact_version integer,
  p_expected_stage_id uuid, p_expected_artifact_id uuid, p_expected_review_revision bigint,
  p_request_id uuid, p_selected_thread_ids uuid[], p_feedback_text text,
  p_agent_model_provider text, p_agent_model_name text, p_run_type text,
  p_requested_by_member_id uuid, p_requested_by_service_principal_id uuid
) returns table(
  session_id uuid, workspace_id uuid, current_stage_id uuid, current_artifact_version integer,
  phase_status public.pipeline_phase_status, rejection_count integer, archived_at timestamptz,
  job_id uuid, run_id uuid, job_created boolean, feedback_batch_id uuid
) language plpgsql set search_path = '' as $$
declare
  reviewed_session public.sessions;
  label text;
  prior public.artifact_feedback_batches;
  new_batch public.artifact_feedback_batches;
  thread public.artifact_review_threads;
  snapshots jsonb := '[]'::jsonb;
  snapshot jsonb;
  selected_ids uuid[];
  whole_feedback text := btrim(coalesce(p_feedback_text, ''));
  rendered_feedback text;
  checkpoint_run uuid;
  successor record;
  comment_count bigint;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_request_id is null or p_expected_review_revision is null or p_expected_review_revision < 0
    or p_artifact_version is null or p_artifact_version <= 0
    or p_expected_stage_id is null or p_expected_artifact_id is null then
    raise exception 'A request id and expected artifact, stage, version and review revision are required.' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_selected_thread_ids, '{}'::uuid[])) > 20 then
    raise exception 'Select no more than 20 inline threads per feedback batch.' using errcode = '22001';
  end if;
  if exists (select 1 from unnest(p_selected_thread_ids) id where id is null)
    or (select count(*) from unnest(p_selected_thread_ids)) <>
      (select count(distinct id) from unnest(p_selected_thread_ids) id) then
    raise exception 'Selected inline thread ids must be unique and non-null.' using errcode = '22023';
  end if;
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into selected_ids
    from unnest(p_selected_thread_ids) id;
  if char_length(whole_feedback) > 4000 then
    raise exception 'Whole-stage feedback is limited to 4000 characters.' using errcode = '22001';
  end if;
  if cardinality(selected_ids) = 0 and nullif(btrim(whole_feedback, E' \t\r\n\f'), '') is null then
    raise exception 'Add whole-stage feedback or select at least one inline thread.' using errcode = '22023';
  end if;

  -- Match comment writers and lifecycle mutations: session is the shared
  -- serialization point, followed by actor, jobs and runs. No comment write
  -- can change the selected snapshot while this transaction holds the session.
  select s.* into reviewed_session from public.sessions s
    where s.id = p_session_id and s.workspace_id = p_workspace_id for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
  label := internal.artifact_feedback_actor_label(
    reviewed_session, p_requested_by_member_id, p_requested_by_service_principal_id);
  if label is null then
    if p_requested_by_service_principal_id is null then
      raise exception 'Active human workspace membership is required.' using errcode = '42501';
    end if;
    raise exception 'Service review actor is unavailable.' using errcode = '42501';
  end if;
  if p_requested_by_service_principal_id is not null and cardinality(selected_ids) <> 0 then
    raise exception 'Service feedback cannot select human review threads.' using errcode = '42501';
  end if;
  select b.* into prior from public.artifact_feedback_batches b
    where b.workspace_id = p_workspace_id and b.request_id = p_request_id and (
      b.requested_by_member_id = p_requested_by_member_id
      or b.requested_by_service_principal_id = p_requested_by_service_principal_id
    ) for share;
  if found then
    if prior.session_id is distinct from p_session_id or prior.artifact_id is distinct from p_expected_artifact_id
      or prior.stage_id is distinct from p_expected_stage_id or prior.artifact_version is distinct from p_artifact_version
      or prior.review_revision is distinct from p_expected_review_revision
      or prior.selected_thread_ids is distinct from selected_ids
      or prior.whole_stage_feedback is distinct from whole_feedback then
      raise exception 'Feedback request id was already used with different content.' using errcode = '23505';
    end if;
    return query select prior.session_id, prior.workspace_id, prior.stage_id, prior.artifact_version,
      'rejected'::public.pipeline_phase_status, prior.rejection_count, null::timestamptz,
      prior.job_id, prior.run_id, prior.job_created, prior.id;
    return;
  end if;

  if reviewed_session.archived_at is not null or reviewed_session.phase_status <> 'awaiting_review'
    or reviewed_session.current_stage_id is distinct from p_expected_stage_id
    or reviewed_session.current_artifact_id is distinct from p_expected_artifact_id
    or reviewed_session.current_artifact_version is distinct from p_artifact_version
    or reviewed_session.artifact_review_revision is distinct from p_expected_review_revision then
    raise exception 'Artifact or inline review changed. Refresh the review before submitting feedback.' using errcode = '40001';
  end if;
  if (select count(*) from public.artifact_review_threads t
    where t.id = any(selected_ids) and t.workspace_id = p_workspace_id and t.session_id = p_session_id
      and t.stage_id = p_expected_stage_id
      and (t.artifact_id = p_expected_artifact_id or t.artifact_version < p_artifact_version) and t.status = 'open') <> cardinality(selected_ids) then
    raise exception 'Selected inline threads must be open comments on this artifact or an earlier version of the same stage.' using errcode = '22023';
  end if;
  select count(*) into comment_count from public.artifact_review_comments c
    where c.workspace_id = p_workspace_id and c.thread_id = any(selected_ids);
  if comment_count > 100 then
    raise exception 'Selected threads contain more than 100 comments. Submit fewer threads.' using errcode = '22001';
  end if;
  for thread in select t.* from public.artifact_review_threads t
    where t.id = any(selected_ids) order by t.id loop
    snapshot := jsonb_build_object('thread_id', thread.id, 'thread_revision', thread.revision,
      'kind', thread.kind, 'anchor', thread.anchor,
      'source_artifact_id', thread.artifact_id, 'source_version', thread.artifact_version,
      'comments', internal.artifact_feedback_comment_snapshot(thread.id, p_workspace_id));
    snapshots := snapshots || jsonb_build_array(snapshot);
  end loop;
  rendered_feedback := internal.render_artifact_feedback_batch(whole_feedback, snapshots);
  if char_length(rendered_feedback) > 40000 then
    raise exception 'Combined feedback is limited to 40000 characters. Submit fewer threads or shorter notes.' using errcode = '22001';
  end if;
  checkpoint_run := internal.assert_reviewed_git_checkpoint(p_session_id, p_workspace_id, p_expected_artifact_id);
  select * into strict successor from public.reject_session_stage(
    p_session_id, p_workspace_id, p_artifact_version, rendered_feedback,
    p_agent_model_provider, p_agent_model_name, p_expected_stage_id, p_expected_artifact_id,
    p_run_type, p_requested_by_member_id
  );
  insert into public.artifact_feedback_batches (
    workspace_id, session_id, requested_by_member_id, requested_by_service_principal_id, actor_label, request_id,
    artifact_id, stage_id, artifact_version, review_revision, selected_thread_ids,
    whole_stage_feedback, rendered_feedback_text, checkpoint_run_id,
    job_id, run_id, rejection_count, job_created
  ) values (
    p_workspace_id, p_session_id, p_requested_by_member_id, p_requested_by_service_principal_id, label, p_request_id,
    p_expected_artifact_id, p_expected_stage_id, p_artifact_version, p_expected_review_revision, selected_ids,
    whole_feedback, rendered_feedback, checkpoint_run,
    successor.job_id, successor.run_id, successor.rejection_count, successor.job_created
  ) returning * into new_batch;
  for snapshot in select value from jsonb_array_elements(snapshots) loop
    insert into public.artifact_feedback_batch_threads (
      batch_id, workspace_id, session_id, artifact_id, thread_id, thread_revision, kind, anchor, comments
    ) values (
      new_batch.id, p_workspace_id, p_session_id, (snapshot->>'source_artifact_id')::uuid,
      (snapshot->>'thread_id')::uuid, (snapshot->>'thread_revision')::integer,
      snapshot->>'kind', snapshot->'anchor', snapshot->'comments'
    );
  end loop;
  return query select successor.session_id, successor.workspace_id, successor.current_stage_id,
    successor.current_artifact_version, successor.phase_status, successor.rejection_count,
    successor.archived_at, successor.job_id, successor.run_id, successor.job_created, new_batch.id;
end;
$$;
revoke all on function internal.apply_artifact_feedback_batch(
  uuid, uuid, integer, uuid, uuid, bigint, uuid, uuid[], text, text, text, text, uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function internal.submit_artifact_feedback_batch(
  p_session_id uuid, p_workspace_id uuid, p_artifact_version integer,
  p_expected_stage_id uuid, p_expected_artifact_id uuid, p_expected_review_revision bigint,
  p_request_id uuid, p_selected_thread_ids uuid[], p_feedback_text text,
  p_agent_model_provider text default null, p_agent_model_name text default null,
  p_run_type text default null, p_requested_by_member_id uuid default null
) returns table(
  session_id uuid, workspace_id uuid, current_stage_id uuid, current_artifact_version integer,
  phase_status public.pipeline_phase_status, rejection_count integer, archived_at timestamptz,
  job_id uuid, run_id uuid, job_created boolean, feedback_batch_id uuid
) language sql security definer set search_path = '' as $$
  select * from internal.apply_artifact_feedback_batch(
    p_session_id, p_workspace_id, p_artifact_version, p_expected_stage_id, p_expected_artifact_id,
    p_expected_review_revision, p_request_id, p_selected_thread_ids, p_feedback_text,
    p_agent_model_provider, p_agent_model_name, p_run_type, p_requested_by_member_id, null);
$$;

create or replace function internal.capture_session_conversation_feedback()
returns trigger language plpgsql security definer set search_path = '' as $$
declare session public.sessions; message public.session_conversation_messages;
begin
  select owner.* into strict session from public.sessions owner
  where (owner.id, owner.workspace_id) = (new.session_id, new.workspace_id) for no key update;
  message.kind := 'artifact_feedback';
  if new.requested_by_service_principal_id is not null then
    message.author_kind := 'service';
    message.originating_service_principal_id := new.requested_by_service_principal_id;
  else
    message.author_kind := 'user';
    message.originating_member_id := new.requested_by_member_id;
  end if;
  message.author_label := new.actor_label;
  message.artifact_id := new.artifact_id;
  message.feedback_batch_id := new.id;
  -- Keep just the author's prose in the conversation. Inline snapshots remain
  -- attached to the immutable feedback batch.
  message.body_md := coalesce(nullif(btrim(new.whole_stage_feedback, E' \t\r\n'), ''), 'Submitted inline feedback.');
  message.body_truncated := false;
  perform internal.append_session_conversation_message(session, message, 'artifact_feedback:' || new.id::text);
  return new;
end;
$$;

create function internal.session_feedback_mutation_result(
  p_session_id uuid, p_job_id uuid, p_run_id uuid, p_batch_id uuid, p_clarification_id uuid default null
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'sessionId', p_session_id, 'jobId', p_job_id, 'runId', p_run_id, 'feedbackBatchId', p_batch_id,
    'executionExhausted', p_job_id is null and p_run_id is null
  ) || case when p_clarification_id is null then '{}'::jsonb
      else jsonb_build_object('clarificationId', p_clarification_id) end;
$$;
revoke all on function internal.session_feedback_mutation_result(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function internal.submit_machine_session_follow_up(
  p_actor internal.session_mutation_actor, p_intent jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare reviewed public.sessions; successor record;
begin
  reviewed := internal.lock_machine_session_mutation_target(p_actor, (p_intent->>'sessionId')::uuid);
  if exists (
    select 1 from public.session_specification_clarifications pending
    where (pending.session_id, pending.workspace_id, pending.factory_id, pending.stage_id,
        pending.artifact_id, pending.artifact_version) =
      (reviewed.id, reviewed.workspace_id, reviewed.factory_id, reviewed.current_stage_id,
        reviewed.current_artifact_id, reviewed.current_artifact_version)
      and pending.status = 'pending'
  ) then
    raise exception 'Answer the open specification clarification before requesting changes.' using errcode = 'PT423';
  end if;
  select * into strict successor from internal.apply_artifact_feedback_batch(
    reviewed.id, reviewed.workspace_id, (p_intent->>'artifactVersion')::integer,
    (p_intent->>'stageId')::uuid, (p_intent->>'artifactId')::uuid, (p_intent->>'reviewRevision')::bigint,
    p_actor.admission_id, '{}'::uuid[], p_intent->>'feedback', null, null, 'code', null,
    p_actor.service_principal_id);
  return internal.session_feedback_mutation_result(reviewed.id, successor.job_id, successor.run_id,
    successor.feedback_batch_id);
end;
$$;
revoke all on function internal.submit_machine_session_follow_up(internal.session_mutation_actor, jsonb)
  from public, anon, authenticated, service_role;

create function internal.apply_session_specification_answer(
  p_session public.sessions, p_actor internal.session_mutation_actor, p_clarification_id uuid,
  p_artifact_id uuid, p_artifact_version integer, p_review_revision bigint, p_request_id uuid, p_answer text,
  p_agent_model_provider text, p_agent_model_name text, p_run_type text
) returns jsonb language plpgsql set search_path = '' as $$
declare clarification public.session_specification_clarifications; successor record; failed_table text;
begin
  if p_request_id is null or p_clarification_id is null or p_artifact_id is null
    or p_artifact_version is null or p_artifact_version <= 0 or p_review_revision is null or p_review_revision < 0
    or p_answer is null or length(p_answer) not between 1 and 2000 then
    raise exception 'An exact clarification, review and bounded answer are required.' using errcode = '22023';
  end if;
  select target.* into clarification from public.session_specification_clarifications target
  where (target.workspace_id, target.factory_id, target.session_id, target.id) =
    (p_session.workspace_id, p_session.factory_id, p_session.id, p_clarification_id);
  if not found then raise exception 'Clarification not found.' using errcode = 'PT404'; end if;
  if clarification.status <> 'pending' or p_session.archived_at is not null
    or p_session.phase_status <> 'awaiting_review'
    or p_session.specification_stage_id is distinct from clarification.stage_id
    or (p_session.current_stage_id, p_session.current_artifact_id, p_session.current_artifact_version,
      p_session.artifact_review_revision) is distinct from
      (clarification.stage_id, p_artifact_id, p_artifact_version, p_review_revision)
    or (clarification.artifact_id, clarification.artifact_version) is distinct from (p_artifact_id, p_artifact_version) then
    raise exception 'The specification review changed. Refresh before answering.' using errcode = 'P0003';
  end if;
  begin
    select * into strict successor from internal.apply_artifact_feedback_batch(
      p_session.id, p_session.workspace_id, p_artifact_version, clarification.stage_id, p_artifact_id,
      p_review_revision, p_request_id, '{}'::uuid[],
      'Clarification question: ' || clarification.question || E'\n\nClarification answer: ' || p_answer,
      p_agent_model_provider, p_agent_model_name, p_run_type, p_actor.member_id, p_actor.service_principal_id);
  exception when unique_violation then
    get stacked diagnostics failed_table = table_name;
    if failed_table <> 'artifact_feedback_batches' then raise; end if;
    raise exception 'This clarification request was already used for different input.' using errcode = 'P0005';
  end;
  update public.session_specification_clarifications target
  set status = 'answered', answered_at = clock_timestamp(), answered_by_member_id = p_actor.member_id,
      answered_by_service_principal_id = p_actor.service_principal_id,
      answer_text = p_answer, feedback_batch_id = successor.feedback_batch_id, successor_job_id = successor.job_id,
      successor_run_id = successor.run_id, execution_exhausted = (successor.job_id is null and successor.run_id is null)
  where target.id = clarification.id;
  return internal.session_feedback_mutation_result(p_session.id, successor.job_id, successor.run_id,
    successor.feedback_batch_id, clarification.id);
end;
$$;
revoke all on function internal.apply_session_specification_answer(
  public.sessions, internal.session_mutation_actor, uuid, uuid, integer, bigint, uuid, text, text, text, text
) from public, anon, authenticated, service_role;

create function internal.answer_machine_session_clarification(
  p_actor internal.session_mutation_actor, p_intent jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare reviewed public.sessions;
begin
  reviewed := internal.lock_machine_session_mutation_target(p_actor, (p_intent->>'sessionId')::uuid);
  return internal.apply_session_specification_answer(
    reviewed, p_actor, (p_intent->>'clarificationId')::uuid, (p_intent->>'artifactId')::uuid,
    (p_intent->>'artifactVersion')::integer, (p_intent->>'reviewRevision')::bigint, p_actor.admission_id,
    btrim(p_intent->>'answer', E' \t\r\n'), null, null, 'code');
end;
$$;
revoke all on function internal.answer_machine_session_clarification(internal.session_mutation_actor, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.submit_session_follow_up_once(
  p_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_artifact_version integer,
  p_expected_stage_id uuid, p_expected_artifact_id uuid, p_feedback_text text,
  p_expected_review_revision bigint default null, p_request_id uuid default null,
  p_selected_thread_ids uuid[] default null, p_agent_model_provider text default null,
  p_agent_model_name text default null, p_run_type text default null, p_requested_by_member_id uuid default null
) returns table(
  session_id uuid, workspace_id uuid, current_stage_id uuid, current_artifact_version integer,
  phase_status public.pipeline_phase_status, rejection_count integer, archived_at timestamptz,
  job_id uuid, run_id uuid, job_created boolean, feedback_batch_id uuid
) language plpgsql security definer set search_path = '' as $$
declare
  reviewed public.sessions;
  actor internal.session_mutation_actor;
  intent jsonb;
  prior jsonb;
  successor record;
begin
  -- Thread selection is a human review operation and keeps its own exact
  -- batch receipt. Only whole-stage commands share the versioned identity.
  if p_request_id is not null and p_expected_review_revision is not null
    and coalesce(cardinality(p_selected_thread_ids), 0) = 0 then
    actor := internal.session_mutation_human_actor(p_workspace_id, p_factory_id, p_requested_by_member_id, p_session_id);
    intent := jsonb_build_object(
      'sessionId', p_session_id, 'stageId', p_expected_stage_id, 'artifactId', p_expected_artifact_id,
      'artifactVersion', p_artifact_version, 'reviewRevision', p_expected_review_revision,
      'feedback', btrim(coalesce(p_feedback_text, ''), E' \t\r\n'));
    begin
      prior := internal.find_session_mutation_receipt(actor, 'follow_up', p_request_id, intent);
    exception when sqlstate 'P0005' then
      raise exception 'Feedback request id was already used with different content.' using errcode = '23505';
    end;
    if prior is not null then
      return query select batch.session_id, batch.workspace_id, batch.stage_id, batch.artifact_version,
        'rejected'::public.pipeline_phase_status, batch.rejection_count, null::timestamptz,
        batch.job_id, batch.run_id, batch.job_created, batch.id
      from public.artifact_feedback_batches batch
      where (batch.workspace_id, batch.session_id, batch.id) =
        (p_workspace_id, p_session_id, (prior->>'feedbackBatchId')::uuid);
      if not found then raise exception 'Feedback batch not found.' using errcode = 'PT404'; end if;
      return;
    end if;
  end if;

  -- Thread-only and unkeyed submissions can also enqueue grant-backed work.
  -- Establish the same factory-before-member fence even without a shared key.
  if intent is null then
    perform internal.assert_session_mutation_human_access(p_workspace_id, p_factory_id, p_requested_by_member_id);
  end if;
  select session.* into reviewed from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) = (p_workspace_id, p_factory_id, p_session_id)
  for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
  if p_expected_review_revision is null and p_request_id is null and p_selected_thread_ids is null then
    if reviewed.current_stage_id = reviewed.specification_stage_id then
      raise exception 'Specification feedback requires an exact review receipt.' using errcode = '22023';
    end if;
    return query select rejected.*, null::uuid
    from public.reject_session_stage(
      p_session_id, p_workspace_id, p_artifact_version, p_feedback_text, p_agent_model_provider,
      p_agent_model_name, p_expected_stage_id, p_expected_artifact_id,
      coalesce(p_run_type, 'project'), p_requested_by_member_id) rejected;
    return;
  end if;

  select * into strict successor from public.submit_artifact_feedback_batch(
    p_session_id, p_workspace_id, p_artifact_version, p_expected_stage_id, p_expected_artifact_id,
    p_expected_review_revision, p_request_id, p_selected_thread_ids, coalesce(intent->>'feedback', p_feedback_text),
    p_agent_model_provider, p_agent_model_name, p_run_type, p_requested_by_member_id);
  if intent is not null then
    perform internal.record_session_mutation_receipt(actor, 'follow_up', p_request_id, intent, p_session_id,
      internal.session_feedback_mutation_result(p_session_id, successor.job_id, successor.run_id,
        successor.feedback_batch_id));
  end if;
  return query select successor.session_id, successor.workspace_id, successor.current_stage_id,
    successor.current_artifact_version, successor.phase_status, successor.rejection_count, successor.archived_at,
    successor.job_id, successor.run_id, successor.job_created, successor.feedback_batch_id;
end;
$$;

create or replace function public.answer_session_specification_clarification_once(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_actor_member_id uuid, p_clarification_id uuid,
  p_expected_artifact_id uuid, p_expected_artifact_version integer, p_expected_review_revision bigint,
  p_request_id uuid, p_answer_text text,
  p_agent_model_provider text default null, p_agent_model_name text default null, p_run_type text default null
) returns table(clarification_id uuid, feedback_batch_id uuid, job_id uuid, run_id uuid, execution_exhausted boolean, replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  session public.sessions;
  clarification public.session_specification_clarifications;
  receipt internal.session_specification_clarification_answers;
  actor internal.session_mutation_actor;
  answer text := btrim(p_answer_text, E' \t\r\n');
  intent jsonb;
  result jsonb;
  was_replayed boolean := false;
begin
  if p_request_id is null or p_clarification_id is null or p_expected_artifact_id is null
    or p_expected_artifact_version is null or p_expected_artifact_version <= 0
    or p_expected_review_revision is null or p_expected_review_revision < 0
    or answer is null or length(answer) not between 1 and 2000 then
    raise exception 'An exact clarification, review and bounded answer are required.' using errcode = '22023';
  end if;
  actor := internal.session_mutation_human_actor(p_workspace_id, p_factory_id, p_actor_member_id, p_session_id);
  intent := jsonb_build_object(
    'sessionId', p_session_id, 'clarificationId', p_clarification_id,
    'artifactId', p_expected_artifact_id, 'artifactVersion', p_expected_artifact_version,
    'reviewRevision', p_expected_review_revision, 'answer', answer);
  begin
    result := internal.find_session_mutation_receipt(actor, 'answer_clarification', p_request_id, intent);
  exception when sqlstate 'P0005' then
    raise exception 'This clarification request was already used for different input.' using errcode = 'P0005';
  end;
  if result is not null then
    was_replayed := true;
  else
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'specification-answer:' || p_workspace_id::text || ':' || p_actor_member_id::text || ':' || p_request_id::text, 0));
    session := internal.lock_session_conversation(p_workspace_id, p_factory_id, p_session_id, p_actor_member_id);
    select accepted.* into receipt from internal.session_specification_clarification_answers accepted
    where (accepted.workspace_id, accepted.actor_member_id, accepted.request_id) = (p_workspace_id, p_actor_member_id, p_request_id);
    if receipt.clarification_id is not null then
      select target.* into clarification from public.session_specification_clarifications target
      where (target.workspace_id, target.factory_id, target.session_id, target.id) =
        (p_workspace_id, p_factory_id, p_session_id, p_clarification_id);
      if receipt.clarification_id is distinct from clarification.id
        or receipt.expected_review_revision is distinct from p_expected_review_revision
        or (clarification.artifact_id, clarification.artifact_version, clarification.answer_text)
          is distinct from (p_expected_artifact_id, p_expected_artifact_version, answer) then
        raise exception 'This clarification request was already used for different input.' using errcode = 'P0005';
      end if;
      result := internal.session_feedback_mutation_result(session.id, clarification.successor_job_id,
        clarification.successor_run_id, clarification.feedback_batch_id, clarification.id);
      was_replayed := true;
    else
      result := internal.apply_session_specification_answer(session, actor, p_clarification_id,
        p_expected_artifact_id, p_expected_artifact_version, p_expected_review_revision, p_request_id, answer,
        p_agent_model_provider, p_agent_model_name, p_run_type);
      insert into internal.session_specification_clarification_answers (
        workspace_id, actor_member_id, request_id, clarification_id, expected_review_revision
      ) values (p_workspace_id, p_actor_member_id, p_request_id, p_clarification_id, p_expected_review_revision);
    end if;
    perform internal.record_session_mutation_receipt(actor, 'answer_clarification', p_request_id, intent, p_session_id, result);
  end if;
  return query select (result->>'clarificationId')::uuid, (result->>'feedbackBatchId')::uuid,
    (result->>'jobId')::uuid, (result->>'runId')::uuid, (result->>'executionExhausted')::boolean, was_replayed;
end;
$$;
