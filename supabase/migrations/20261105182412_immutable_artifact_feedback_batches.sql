-- A submitted review is an immutable input to one rejection generation. Mutable
-- comment rows remain separate: edits and later replies are never silently sent.
create table public.artifact_feedback_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  requested_by_member_id uuid not null,
  actor_label text not null,
  request_id uuid not null,
  artifact_id uuid not null references public.session_artifacts(id) on delete cascade,
  stage_id uuid not null,
  artifact_version integer not null check (artifact_version > 0),
  review_revision bigint not null check (review_revision >= 0),
  selected_thread_ids uuid[] not null check (cardinality(selected_thread_ids) <= 20),
  whole_stage_feedback text not null check (char_length(whole_stage_feedback) <= 4000),
  rendered_feedback_text text not null check (
    char_length(rendered_feedback_text) between 1 and 40000
  ),
  checkpoint_run_id uuid references public.session_git_checkpoints(run_id) on delete cascade,
  job_id uuid not null unique references public.agent_jobs(id) on delete cascade,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  rejection_count integer not null check (rejection_count > 0),
  job_created boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, requested_by_member_id, request_id)
);
create index artifact_feedback_batches_session_idx
  on public.artifact_feedback_batches(session_id, created_at, id);
create index artifact_feedback_batches_artifact_idx
  on public.artifact_feedback_batches(artifact_id, workspace_id);

create table public.artifact_feedback_batch_threads (
  batch_id uuid not null references public.artifact_feedback_batches(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  artifact_id uuid not null references public.session_artifacts(id) on delete cascade,
  -- These are historical source identities, not cascading mutable review rows.
  thread_id uuid not null,
  thread_revision integer not null check (thread_revision > 0),
  kind text not null check (kind in ('discussion', 'blocking')),
  anchor jsonb not null check (jsonb_typeof(anchor) = 'object'),
  comments jsonb not null check (
    jsonb_typeof(comments) = 'array' and jsonb_array_length(comments) between 1 and 100
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (batch_id, thread_id)
);
create index artifact_feedback_batch_threads_artifact_idx
  on public.artifact_feedback_batch_threads(artifact_id, workspace_id, thread_id, thread_revision);
create index artifact_feedback_batch_threads_session_idx
  on public.artifact_feedback_batch_threads(session_id);
create index artifact_feedback_batch_threads_workspace_idx
  on public.artifact_feedback_batch_threads(workspace_id);

alter table public.artifact_feedback_batches enable row level security;
alter table public.artifact_feedback_batch_threads enable row level security;
revoke all on public.artifact_feedback_batches, public.artifact_feedback_batch_threads
  from public, anon, authenticated, service_role;
grant select on public.artifact_feedback_batches, public.artifact_feedback_batch_threads
  to authenticated, service_role;
create policy artifact_feedback_batches_read on public.artifact_feedback_batches
  for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));
create policy artifact_feedback_batch_threads_read on public.artifact_feedback_batch_threads
  for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));

create function internal.artifact_feedback_comment_snapshot(p_thread_id uuid, p_workspace_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'revision', c.revision, 'author_member_id', c.author_member_id,
    'author_label', c.author_label, 'body', c.body,
    'created_at', c.created_at, 'updated_at', c.updated_at
  ) order by c.created_at, c.id), '[]'::jsonb)
  from public.artifact_review_comments c
  where c.thread_id = p_thread_id and c.workspace_id = p_workspace_id;
$$;
revoke all on function internal.artifact_feedback_comment_snapshot(uuid, uuid)
  from public, anon, authenticated, service_role;

-- This renderer never produces trusted prompt control text. The worker must
-- classify the complete saved result with untrustedPromptValue at consumption.
create function internal.render_artifact_feedback_batch(p_whole_feedback text, p_threads jsonb)
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
revoke all on function internal.render_artifact_feedback_batch(text, jsonb)
  from public, anon, authenticated, service_role;

create function internal.guard_artifact_feedback_batch()
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
  if tg_op <> 'INSERT' then
    raise exception 'Submitted artifact feedback is immutable.' using errcode = '23514';
  end if;
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
        and a.version = new.artifact_version)
    or not exists (select 1 from public.workspace_members m
      where m.id = new.requested_by_member_id and m.workspace_id = new.workspace_id
        and m.kind = 'human' and m.is_active
        and internal.artifact_review_author_label(m) = new.actor_label) then
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
revoke all on function internal.guard_artifact_feedback_batch()
  from public, anon, authenticated, service_role;
create trigger guard_artifact_feedback_batch before insert or update or delete
  on public.artifact_feedback_batches for each row execute function internal.guard_artifact_feedback_batch();

create function internal.guard_artifact_feedback_batch_thread()
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
    or new.session_id <> batch.session_id or new.artifact_id <> batch.artifact_id
    or not (new.thread_id = any(batch.selected_thread_ids))
    or thread.workspace_id <> batch.workspace_id or thread.session_id <> batch.session_id
    or thread.artifact_id <> batch.artifact_id or thread.stage_id <> batch.stage_id
    or thread.artifact_version <> batch.artifact_version or thread.status <> 'open'
    or thread.revision <> new.thread_revision or thread.anchor is distinct from new.anchor
    or thread.kind <> new.kind or new.comments is distinct from
      internal.artifact_feedback_comment_snapshot(thread.id, thread.workspace_id) then
    raise exception 'Inline feedback does not match its submitted snapshot.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_artifact_feedback_batch_thread()
  from public, anon, authenticated, service_role;
create trigger guard_artifact_feedback_batch_thread before insert or update or delete
  on public.artifact_feedback_batch_threads for each row execute function internal.guard_artifact_feedback_batch_thread();

create function internal.submit_artifact_feedback_batch(
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
      and t.artifact_id = p_expected_artifact_id and t.stage_id = p_expected_stage_id
      and t.artifact_version = p_artifact_version and t.status = 'open') <> cardinality(selected_ids) then
    raise exception 'Selected inline threads must be open comments on the reviewed artifact.' using errcode = '22023';
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
      new_batch.id, p_workspace_id, p_session_id, p_expected_artifact_id,
      (snapshot->>'thread_id')::uuid, (snapshot->>'thread_revision')::integer,
      snapshot->>'kind', snapshot->'anchor', snapshot->'comments'
    );
  end loop;
  return query select successor.session_id, successor.workspace_id, successor.current_stage_id,
    successor.current_artifact_version, successor.phase_status, successor.rejection_count,
    successor.archived_at, successor.job_id, successor.run_id, successor.job_created, new_batch.id;
end;
$$;
revoke all on function internal.submit_artifact_feedback_batch(
  uuid, uuid, integer, uuid, uuid, bigint, uuid, uuid[], text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function internal.submit_artifact_feedback_batch(
  uuid, uuid, integer, uuid, uuid, bigint, uuid, uuid[], text, text, text, text, uuid
) to service_role;

create function public.submit_artifact_feedback_batch(
  p_session_id uuid, p_workspace_id uuid, p_artifact_version integer,
  p_expected_stage_id uuid, p_expected_artifact_id uuid, p_expected_review_revision bigint,
  p_request_id uuid, p_selected_thread_ids uuid[], p_feedback_text text,
  p_agent_model_provider text default null, p_agent_model_name text default null,
  p_run_type text default null, p_requested_by_member_id uuid default null
) returns table(
  session_id uuid, workspace_id uuid, current_stage_id uuid, current_artifact_version integer,
  phase_status public.pipeline_phase_status, rejection_count integer, archived_at timestamptz,
  job_id uuid, run_id uuid, job_created boolean, feedback_batch_id uuid
) language sql security invoker set search_path = '' as $$
  select * from internal.submit_artifact_feedback_batch(
    p_session_id, p_workspace_id, p_artifact_version, p_expected_stage_id,
    p_expected_artifact_id, p_expected_review_revision, p_request_id, p_selected_thread_ids,
    p_feedback_text, p_agent_model_provider, p_agent_model_name, p_run_type, p_requested_by_member_id
  );
$$;
revoke all on function public.submit_artifact_feedback_batch(
  uuid, uuid, integer, uuid, uuid, bigint, uuid, uuid[], text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.submit_artifact_feedback_batch(
  uuid, uuid, integer, uuid, uuid, bigint, uuid, uuid[], text, text, text, text, uuid
) to service_role;

comment on table public.artifact_feedback_batches is
  'Immutable submitted review input and original rejection receipt. Exact request retries return the same batch/job/run even after later review or model changes. New requests must match current artifact and review revisions. Production continuity admission remains unchanged.';
comment on table public.artifact_feedback_batch_threads is
  'Immutable source thread/comment revisions included in one submitted feedback batch. Mutable later edits/replies remain unsent until explicitly submitted in a future eligible review.';
