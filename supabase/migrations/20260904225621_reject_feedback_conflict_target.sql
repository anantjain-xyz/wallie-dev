-- The RETURNS TABLE output parameter session_id shadows the unqualified
-- ON CONFLICT column name in PL/pgSQL. Name the existing unique constraint
-- explicitly so both fresh feedback and partial-rejection recovery can save.
-- Preserve the RPC signature, row locks, transaction, and service-role grants.

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
  adopted_run_status public.agent_run_status;
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
  on conflict on constraint session_artifact_feedback_unique_target
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
    select existing_run.id, existing_run.status
    into created_run_id, adopted_run_status
    from public.agent_runs existing_run
    where existing_run.agent_job_id = created_job_id
      and existing_run.status in ('queued', 'started', 'running')
    order by existing_run.created_at desc
    limit 1;

    -- Adopt only a queued rerun (manual retry that raced review). A started
    -- or running run is the generation that just published — adopting it
    -- lets that worker mark the run/job successful while the session stays
    -- `rejected` with no work to apply the feedback. A missing live run is
    -- the success-run / still-running-job crash cut.
    if created_run_id is null or adopted_run_status is distinct from 'queued' then
      if created_run_id is not null then
        update public.agent_runs existing_run
        set status = 'canceled',
            finished_at = coalesce(existing_run.finished_at, now())
        where existing_run.id = created_run_id
          and existing_run.status in ('queued', 'started', 'running');
      end if;

      if created_run_id is not null
         or exists (
           select 1
           from public.agent_runs existing_run
           where existing_run.agent_job_id = created_job_id
             and existing_run.status = 'success'
         )
      then
        update public.agent_jobs existing_job
        set status = 'success',
            finished_at = coalesce(existing_job.finished_at, now())
        where existing_job.id = created_job_id
          and existing_job.status in ('queued', 'started', 'running');
      else
        update public.agent_jobs existing_job
        set status = 'error',
            finished_at = coalesce(existing_job.finished_at, now()),
            last_error = coalesce(
              existing_job.last_error,
              'Rejected while the active job had no live run.'
            )
        where existing_job.id = created_job_id
          and existing_job.status in ('queued', 'started', 'running');
      end if;

      adopted_existing_job := false;
      created_run_id := null;

      insert into public.agent_jobs as replacement_job (
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
      returning replacement_job.id into created_job_id;
    end if;
  end if;

  if not adopted_existing_job then
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
