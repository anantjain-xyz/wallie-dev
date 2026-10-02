-- Never retire work during rollout: unfenced legacy workers may still finish.
-- Keep the lock, guard, and index in one statement so both transaction-wrapped
-- migrations and autocommit psql runners enforce the invariant atomically.
do $$
begin
  lock table public.agent_jobs in share row exclusive mode;
  if exists (
    select 1 from public.agent_jobs
    where status in ('queued', 'started', 'running')
    group by workspace_id, session_id having count(*) > 1
  ) then
    raise exception 'Cannot enforce one active job per session while duplicate active jobs exist.'
      using errcode = '55000',
        hint = 'Pause enqueue producers and drain or explicitly resolve duplicate active jobs, then retry the migration. No work was canceled.';
  end if;

  CREATE UNIQUE INDEX agent_jobs_active_session_idx ON public.agent_jobs USING btree (workspace_id, session_id) WHERE (status = ANY (ARRAY['queued'::public.agent_job_status, 'started'::public.agent_job_status, 'running'::public.agent_job_status]));
end;
$$;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.enqueue_session_job_with_run(p_session_id uuid, p_workspace_id uuid, p_expected_stage_id uuid, p_requested_by_member_id uuid DEFAULT NULL::uuid, p_trigger_type public.agent_trigger_type DEFAULT 'assignment'::public.agent_trigger_type, p_agent_model_provider text DEFAULT NULL::text, p_agent_model_name text DEFAULT NULL::text, p_run_type text DEFAULT 'project'::text)
 RETURNS TABLE(job_id uuid, run_id uuid, created boolean)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  current_session public.sessions%rowtype;
  current_stage public.pipeline_stages%rowtype;
  active_job public.agent_jobs%rowtype;
  existing_run public.agent_runs%rowtype;
  queued_job_id uuid;
  queued_run_id uuid;
begin
  if nullif(btrim(p_agent_model_provider), '') is null
     or nullif(btrim(p_agent_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
  end if;
  if p_run_type is null or p_run_type not in ('project', 'code') then
    raise exception 'Run type must be project or code' using errcode = '22023';
  end if;

  select * into current_session from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
  if current_session.archived_at is not null then
    raise exception 'Session is archived.' using errcode = '55000';
  end if;
  if current_session.current_stage_id is distinct from p_expected_stage_id then
    raise exception 'Session stage changed.' using errcode = '55000';
  end if;
  if current_session.phase_status = 'approved' then
    raise exception 'Session is already complete.' using errcode = '55000';
  end if;
  if p_requested_by_member_id is not null and not exists (
    select 1 from public.workspace_members member
    where member.id = p_requested_by_member_id
      and member.workspace_id = p_workspace_id and member.is_active and member.kind = 'human'
  ) then
    raise exception 'Requester is not an active workspace member.' using errcode = '42501';
  end if;
  select * into current_stage from public.pipeline_stages
  where id = current_session.current_stage_id
    and pipeline_id = current_session.pipeline_id and workspace_id = p_workspace_id;
  if not found then raise exception 'Session references a missing stage.' using errcode = 'P0002'; end if;

  select * into active_job from public.agent_jobs
  where session_id = p_session_id and workspace_id = p_workspace_id
    and status in ('queued', 'started', 'running') for update;
  if not found then
    begin
      insert into public.agent_jobs(
        workspace_id, session_id, requested_by_member_id, stage_id, stage_slug, stage_name,
        trigger_type, status, dedupe_key
      ) values (
        p_workspace_id, p_session_id, p_requested_by_member_id,
        current_stage.id, current_stage.slug, current_stage.name, p_trigger_type, 'queued',
        'session:' || p_session_id::text || ':active'
      ) returning id into queued_job_id;
    exception when unique_violation then
      -- Direct legacy producers may insert after our initial lookup. The
      -- session's NO KEY UPDATE lock permits their FK KEY SHARE lock, so they
      -- can commit and we can adopt instead of deadlocking on the unique key.
      select * into active_job from public.agent_jobs
      where session_id = p_session_id and workspace_id = p_workspace_id
        and status in ('queued', 'started', 'running') for update;
      if not found then raise; end if;
    end;
  end if;
  if active_job.id is not null then
    if active_job.stage_id is not null and active_job.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000';
    end if;
    select * into existing_run from public.agent_runs
    where agent_job_id = active_job.id
    order by created_at desc, id desc limit 1;
    if existing_run.stage_id is not null and existing_run.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000';
    end if;
    -- Historical stage evidence above still matters when a previous attempt
    -- finished. Only an active execution can represent the adopted work.
    select * into existing_run from public.agent_runs
    where agent_job_id = active_job.id and status in ('queued', 'started', 'running')
    order by created_at desc, id desc limit 1;
    if existing_run.stage_id is not null and existing_run.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000';
    end if;
    return query select active_job.id, existing_run.id, false;
    return;
  end if;

  insert into public.agent_runs(
    workspace_id, session_id, agent_job_id, triggered_by_member_id,
    stage_id, stage_slug, stage_name, run_type, model_provider, model_name, status
  ) values (
    p_workspace_id, p_session_id, queued_job_id, p_requested_by_member_id,
    current_stage.id, current_stage.slug, current_stage.name, p_run_type,
    btrim(p_agent_model_provider), btrim(p_agent_model_name), 'queued'
  ) returning id into queued_run_id;
  return query select queued_job_id, queued_run_id, true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.reject_session_stage(p_session_id uuid, p_workspace_id uuid, p_artifact_version integer, p_feedback_text text, p_agent_model_provider text, p_agent_model_name text, p_run_type text DEFAULT 'project'::text, p_requested_by_member_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(session_id uuid, workspace_id uuid, current_stage_id uuid, current_artifact_version integer, phase_status public.pipeline_phase_status, rejection_count integer, archived_at timestamp with time zone, job_id uuid, run_id uuid, job_created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  for no key update;

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
      -- The per-session active-job index already holds an active job for this
      -- session (for example a manual retry that raced the review). Adopt it:
      -- the feedback recorded above is what its rerun will read. Losing the
      -- adopted job between the violation and this lookup re-raises so the
      -- caller sees the conflict instead of a phantom job id.
      select existing_job.id
      into created_job_id
      from public.agent_jobs existing_job
      where existing_job.workspace_id = p_workspace_id
        and existing_job.session_id = p_session_id
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
$function$
;



revoke all on function public.enqueue_session_job_with_run(uuid, uuid, uuid, uuid, public.agent_trigger_type, text, text, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_session_job_with_run(uuid, uuid, uuid, uuid, public.agent_trigger_type, text, text, text)
  to service_role;


revoke all on function public.reject_session_stage(
  uuid, uuid, integer, text, text, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.reject_session_stage(
  uuid, uuid, integer, text, text, text, text, uuid
) to service_role;
