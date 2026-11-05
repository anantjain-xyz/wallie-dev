-- Carry unresolved feedback without rewriting its original source identity.
-- Submission still locks the exact current session/review and pins its checkpoint;
-- only the explicitly selected open source threads may come from prior versions.

create or replace function internal.guard_artifact_feedback_batch_thread()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare batch public.artifact_feedback_batches; thread public.artifact_review_threads;
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.artifact_feedback_batches where id = old.batch_id)
    or not exists (select 1 from public.workspaces where id = old.workspace_id)
    or not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.session_artifacts where id = old.artifact_id)
  ) then return old; end if;
  if tg_op <> 'INSERT' then
    raise exception 'Submitted inline feedback is immutable.' using errcode = '23514';
  end if;
  select * into batch from public.artifact_feedback_batches where id = new.batch_id;
  select * into thread from public.artifact_review_threads where id = new.thread_id;
  if batch.id is null or thread.id is null or new.workspace_id <> batch.workspace_id
    or new.session_id <> batch.session_id or new.artifact_id <> thread.artifact_id
    or not (new.thread_id = any(batch.selected_thread_ids))
    or thread.workspace_id <> batch.workspace_id or thread.session_id <> batch.session_id
    or thread.stage_id <> batch.stage_id
    or not (thread.artifact_id = batch.artifact_id or thread.artifact_version < batch.artifact_version)
    or thread.status <> 'open'
    or thread.revision <> new.thread_revision or thread.anchor is distinct from new.anchor
    or thread.kind <> new.kind or new.comments is distinct from
      internal.artifact_feedback_comment_snapshot(thread.id, thread.workspace_id) then
    raise exception 'Inline feedback does not match its submitted snapshot.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.render_artifact_feedback_batch(p_whole_feedback text, p_threads jsonb)
returns text language plpgsql immutable security invoker set search_path = '' as $$
declare result text := ''; thread jsonb; comment jsonb;
begin
  if p_whole_feedback <> '' then
    result := 'Whole-stage feedback:' || E'\n' || p_whole_feedback;
  end if;
  for thread in select value from jsonb_array_elements(p_threads) loop
    if result <> '' then result := result || E'\n\n'; end if;
    result := result || 'Inline thread ' || (thread->>'thread_id')
      || ' (' || (thread->>'kind') || ', revision ' || (thread->>'thread_revision') || ')'
      || case when thread ? 'source_version' then E'\nOriginal artifact ' || (thread->>'source_artifact_id')
        || ' version ' || (thread->>'source_version') else '' end
      || E'\nQuoted artifact text:\n' || (thread->'anchor'->>'quote');
    for comment in select value from jsonb_array_elements(thread->'comments') loop
      result := result || E'\n\nComment ' || (comment->>'id') || ' (revision '
        || (comment->>'revision') || ') by ' || (comment->>'author_label')
        || E':\n' || (comment->>'body');
    end loop;
  end loop;
  return result;
end;
$$;

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
) language plpgsql security definer set search_path = '' as $$
declare
  reviewed_session public.sessions;
  actor public.workspace_members;
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
  select m.* into actor from public.workspace_members m
    where m.id = p_requested_by_member_id and m.workspace_id = p_workspace_id
      and m.kind = 'human' and m.is_active for share;
  if not found then
    raise exception 'Active human workspace membership is required.' using errcode = '42501';
  end if;
  select b.* into prior from public.artifact_feedback_batches b
    where b.workspace_id = p_workspace_id and b.requested_by_member_id = actor.id
      and b.request_id = p_request_id for share;
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
    p_run_type, actor.id
  );
  insert into public.artifact_feedback_batches (
    workspace_id, session_id, requested_by_member_id, actor_label, request_id,
    artifact_id, stage_id, artifact_version, review_revision, selected_thread_ids,
    whole_stage_feedback, rendered_feedback_text, checkpoint_run_id,
    job_id, run_id, rejection_count, job_created
  ) values (
    p_workspace_id, p_session_id, actor.id, internal.artifact_review_author_label(actor), p_request_id,
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

comment on column public.artifact_feedback_batch_threads.artifact_id is
  'Original source artifact of this immutable thread snapshot. The parent batch identifies the reviewed artifact/checkpoint used for the revision.';
