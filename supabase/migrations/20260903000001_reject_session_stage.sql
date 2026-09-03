-- Reject a stage artifact in one transaction.
--
-- The TypeScript rejection path used to be a compensated multi-step workflow:
-- CAS-increment `rejection_count`, insert feedback, enqueue the rerun job and
-- run, then an unguarded `phase_status = 'rejected'` write. A failure between
-- any two steps left the session wedged in `awaiting_review` with a bumped
-- rejection count and nothing queued, and the final unguarded write could
-- overwrite a concurrent approval. This RPC locks the session row, validates
-- workspace, archive state, phase, and version, records the reviewer feedback,
-- enqueues the rerun job plus its queued run in the shape
-- `create_session_with_first_job` produces, and moves the session to
-- `rejected` — all or nothing. A concurrent approval or second rejection
-- serializes behind the row lock and re-validates the phase, so it observes
-- `rejected` and returns empty instead of racing.
--
-- Validation failures raise so the whole transaction rolls back. Messages match
-- the strings the application already surfaces to reviewers:
--   P0002 Session not found.                   (id/workspace mismatch)
--   55000 Session is archived.
--   55000 Session is not awaiting review.
--   55000 Version mismatch: a newer version exists.
--   42501 Reviewer is not an active member of the workspace.
--
-- Note on `public.agent_job_status`: the enum still carries the legacy
-- `started` value. Nothing writes it any more — jobs and runs are inserted
-- `queued` and become `running` when a worker claims them — but Postgres cannot
-- drop an enum value once it may be referenced by rows or by the
-- `agent_jobs_active_dedupe_key_idx` partial-index predicate, so it remains a
-- legal, inert member of the "active" set. Application code treats it as active
-- through the shared ACTIVE_AGENT_JOB_STATUSES / ACTIVE_AGENT_RUN_STATUSES
-- constants in src/lib/pipeline/cancel.ts rather than through inline literals.

create or replace function public.reject_session_stage(
  p_session_id uuid,
  p_workspace_id uuid,
  p_artifact_version integer,
  p_feedback_text text,
  p_agent_model_provider text,
  p_agent_model_name text,
  p_run_type text default 'project',
  p_requested_by_member_id uuid default null
)
returns table (
  session_id uuid,
  workspace_id uuid,
  current_stage_id uuid,
  current_artifact_version integer,
  phase_status public.pipeline_phase_status,
  rejection_count integer,
  archived_at timestamptz,
  job_id uuid,
  run_id uuid,
  job_created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_session public.sessions%rowtype;
  reviewed_stage public.pipeline_stages%rowtype;
  active_dedupe_key text;
  created_job_id uuid;
  created_run_id uuid;
  adopted_existing_job boolean := false;
begin
  if nullif(btrim(p_feedback_text), '') is null then
    raise exception 'Feedback is required' using errcode = '23514';
  end if;

  if nullif(btrim(p_agent_model_provider), '') is null
     or nullif(btrim(p_agent_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
  end if;

  if p_run_type is null or p_run_type not in ('project', 'code') then
    raise exception 'Run type must be project or code' using errcode = '22023';
  end if;

  -- Hold the session row for the rest of the transaction. Approval's guarded
  -- update and any second rejection block here and re-check the phase after
  -- this transaction commits.
  select s.*
  into locked_session
  from public.sessions s
  where s.id = p_session_id
    and s.workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'Session not found.' using errcode = 'P0002';
  end if;

  if locked_session.archived_at is not null then
    raise exception 'Session is archived.' using errcode = '55000';
  end if;

  if locked_session.phase_status <> 'awaiting_review' then
    raise exception 'Session is not awaiting review.' using errcode = '55000';
  end if;

  if locked_session.current_artifact_version <> p_artifact_version then
    raise exception 'Version mismatch: a newer version exists.' using errcode = '55000';
  end if;

  if p_requested_by_member_id is not null
     and not exists (
       select 1
       from public.workspace_members wm
       where wm.id = p_requested_by_member_id
         and wm.workspace_id = p_workspace_id
         and wm.is_active = true
     ) then
    raise exception 'Reviewer is not an active member of workspace %', p_workspace_id
      using errcode = '42501';
  end if;

  select ps.*
  into reviewed_stage
  from public.pipeline_stages ps
  where ps.id = locked_session.current_stage_id;

  if not found then
    raise exception 'Session references a missing stage.' using errcode = 'P0002';
  end if;

  -- Feedback is keyed on the immutable stage id plus the reviewed version so a
  -- stage rename between generation and review cannot orphan it. Now that the
  -- rejection is atomic, an existing row can only come from a pre-RPC partial
  -- rejection (feedback landed, enqueue failed); the feedback that actually
  -- triggers the rerun replaces it so the prompt's {{attempt.feedback}} and
  -- the review history agree.
  insert into public.session_artifact_feedback (
    workspace_id,
    session_id,
    stage_id,
    stage_slug,
    target_version,
    feedback_text
  )
  values (
    p_workspace_id,
    p_session_id,
    reviewed_stage.id,
    reviewed_stage.slug,
    p_artifact_version,
    p_feedback_text
  )
  on conflict (session_id, stage_id, target_version)
  do update set feedback_text = excluded.feedback_text;

  active_dedupe_key := 'session:' || p_session_id::text || ':active';

  begin
    insert into public.agent_jobs as queued_job (
      workspace_id,
      session_id,
      requested_by_member_id,
      stage_id,
      stage_slug,
      stage_name,
      trigger_type,
      status,
      dedupe_key
    )
    values (
      p_workspace_id,
      p_session_id,
      p_requested_by_member_id,
      reviewed_stage.id,
      reviewed_stage.slug,
      reviewed_stage.name,
      'comment_retry',
      'queued',
      active_dedupe_key
    )
    returning queued_job.id into created_job_id;
  exception
    when unique_violation then
      -- agent_jobs_active_dedupe_key_idx already holds an active job for this
      -- session (for example a manual retry that raced the review). Adopt it:
      -- the feedback recorded above is what its rerun will read. Losing the
      -- adopted job between the violation and this lookup re-raises so the
      -- caller sees the conflict instead of a phantom job id.
      select existing_job.id
      into created_job_id
      from public.agent_jobs existing_job
      where existing_job.workspace_id = p_workspace_id
        and existing_job.dedupe_key = active_dedupe_key
        and existing_job.status in ('queued', 'started', 'running')
      order by existing_job.created_at desc
      limit 1;

      if created_job_id is null then
        raise;
      end if;

      adopted_existing_job := true;
  end;

  if adopted_existing_job then
    select existing_run.id
    into created_run_id
    from public.agent_runs existing_run
    where existing_run.agent_job_id = created_job_id
      and existing_run.status in ('queued', 'started', 'running')
    order by existing_run.created_at desc
    limit 1;
  else
    insert into public.agent_runs as queued_run (
      workspace_id,
      session_id,
      agent_job_id,
      triggered_by_member_id,
      stage_id,
      stage_slug,
      stage_name,
      run_type,
      model_provider,
      model_name,
      status
    )
    values (
      p_workspace_id,
      p_session_id,
      created_job_id,
      p_requested_by_member_id,
      reviewed_stage.id,
      reviewed_stage.slug,
      reviewed_stage.name,
      p_run_type,
      btrim(p_agent_model_provider),
      btrim(p_agent_model_name),
      'queued'
    )
    returning queued_run.id into created_run_id;
  end if;

  update public.sessions s
  set phase_status = 'rejected',
      rejection_count = s.rejection_count + 1
  where s.id = p_session_id;

  return query
  select
    s.id,
    s.workspace_id,
    s.current_stage_id,
    s.current_artifact_version,
    s.phase_status,
    s.rejection_count,
    s.archived_at,
    created_job_id,
    created_run_id,
    not adopted_existing_job
  from public.sessions s
  where s.id = p_session_id;
end;
$$;

-- Service-role only, like approve_session_stage and
-- create_session_with_first_job: the function runs as its definer and trusts
-- p_requested_by_member_id, so the Vercel route handler that already verified
-- workspace membership and rate limits is the only legitimate caller. Exposing
-- it to `authenticated` would let any signed-in user reject any session by id.
revoke all on function public.reject_session_stage(
  uuid, uuid, integer, text, text, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.reject_session_stage(
  uuid, uuid, integer, text, text, text, text, uuid
) to service_role;
