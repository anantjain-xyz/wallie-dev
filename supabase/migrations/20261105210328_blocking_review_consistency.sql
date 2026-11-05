-- Require an inspected review token on the only service approval entry point.
-- The obsolete signature is removed so old clients cannot bypass this gate.
drop function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text);

CREATE OR REPLACE FUNCTION public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid, expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text, p_agent_model_name text, p_run_type text DEFAULT 'project'::text, p_expected_review_revision bigint DEFAULT NULL::bigint)
 RETURNS TABLE(id uuid, pipeline_id uuid, current_stage_id uuid, current_stage_slug text, phase_status public.pipeline_phase_status, workspace_id uuid, linear_issue_url text, archived_at timestamp with time zone, current_artifact_version integer, rejection_count integer, job_id uuid, run_id uuid, job_created boolean)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  reviewed_session public.sessions%rowtype;
  reviewed_stage public.pipeline_stages%rowtype;
  reviewer public.workspace_members%rowtype;
  next_stage public.pipeline_stages%rowtype;
  active_job public.agent_jobs%rowtype;
  published_run public.agent_runs%rowtype;
  queued_job_id uuid;
  queued_run_id uuid;
  queued_job_created boolean := false;
  approved_at_now timestamptz := now();
  reviewed_checkpoint uuid;
begin
  -- This lock serializes review, publication, rejection, and canonical enqueue.
  -- NO KEY UPDATE also permits a legacy producer's session FK KEY SHARE lock.
  select s.* into reviewed_session from public.sessions s
  where s.id = target_session_id and s.workspace_id = expected_workspace_id
  for no key update;
  if not found or reviewed_session.archived_at is not null
     or reviewed_session.phase_status <> 'awaiting_review'
     or reviewed_session.current_stage_id is distinct from expected_stage_id
     or reviewed_session.current_artifact_version is distinct from expected_version then
    return;
  end if;

  if reviewed_session.current_artifact_id is null then
    raise exception 'Review artifact identity is unavailable. Run this stage again before reviewing.' using errcode = '55000';
  end if;
  if reviewed_session.current_artifact_id is distinct from expected_artifact_id then return; end if;

  select stage.* into reviewed_stage from public.pipeline_stages stage
  where stage.id = expected_stage_id and stage.workspace_id = expected_workspace_id
    and stage.pipeline_id = reviewed_session.pipeline_id;
  if not found or not exists (
    select 1 from public.session_selected_stages selection
    where selection.session_id = reviewed_session.id
      and selection.workspace_id = reviewed_session.workspace_id
      and selection.stage_id = reviewed_stage.id
  ) then return; end if;
  -- Stage/version values can recur after an external reroute. The immutable
  -- artifact identity binds the decision to the markdown the reviewer saw.
  -- Slugs are editable labels; stored artifact slugs remain publication history.
  if not exists (
    select 1 from public.session_artifacts artifact
    where artifact.id = expected_artifact_id
      and artifact.session_id = reviewed_session.id
      and artifact.workspace_id = reviewed_session.workspace_id
      and artifact.stage_id = reviewed_stage.id
      and artifact.version = expected_version
  ) then return; end if;

  select member.* into reviewer from public.workspace_members member
  where member.id = approver_member_id and member.workspace_id = expected_workspace_id
    and member.is_active and member.kind = 'human';
  if not found then return; end if;
  if coalesce(reviewed_stage.anyone_can_approve, false) then
    null;
  elsif coalesce(array_length(reviewed_stage.approver_member_ids, 1), 0) > 0 then
    if not (reviewer.id = any(reviewed_stage.approver_member_ids)) then return; end if;
  elsif reviewer.role not in ('owner', 'admin') then
    return;
  end if;

  -- Every review writer takes the same session lock. Never obtain a fresh
  -- token here on behalf of a stale client; the caller must inspect the review.
  if p_expected_review_revision is null or p_expected_review_revision < 0
     or reviewed_session.artifact_review_revision is distinct from p_expected_review_revision then
    raise exception 'Review changed. Refresh the review before approving.' using errcode='PT412';
  end if;
  -- Include original requests carried across revisions, and legacy requests
  -- on earlier stages. Producing output never changes their human disposition.
  if exists (select 1 from public.artifact_review_threads thread
    where thread.session_id=reviewed_session.id and thread.workspace_id=expected_workspace_id
      and thread.kind='blocking' and thread.status='open') then
    raise exception 'Resolve or supersede open blocking requests before approving.' using errcode='PT409';
  end if;

  reviewed_checkpoint:=internal.assert_reviewed_git_checkpoint(reviewed_session.id,expected_workspace_id,expected_artifact_id);

  -- A publishing worker may still own the session's active queue key during
  -- PR delivery. Only its exact successful attempt is safe to complete here;
  -- queued/unpublished work is a competing intent, never silently canceled.
  select job.* into active_job from public.agent_jobs job
  where job.session_id = reviewed_session.id and job.workspace_id = expected_workspace_id
    and job.status in ('queued', 'started', 'running')
  for update;
  if found then
    select run.* into published_run from public.agent_runs run
    where run.agent_job_id = active_job.id
      and run.attempt_count = active_job.attempt_count
      and run.session_id = reviewed_session.id and run.workspace_id = expected_workspace_id
      and run.stage_id = reviewed_stage.id and run.status = 'success'
    for update;
    if not found or active_job.stage_id is distinct from reviewed_stage.id
       or not public.complete_session_job_attempt(active_job.id, active_job.attempt_count, published_run.id) then
      raise exception 'Session has active work that has not published the reviewed artifact.' using errcode = '55000';
    end if;
  end if;

  -- The session lock above also serializes this existence check with approval
  -- and Linear invalidation. Retain the first valid fact for the stable stage,
  -- including its original label, without discarding legacy decision history.
  insert into public.session_phase_completions (
    session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id
  )
  select reviewed_session.id, expected_workspace_id, reviewed_stage.id, reviewed_stage.slug,
    approved_at_now, reviewer.id
  where not exists (
    select 1 from public.session_phase_completions completion
    where completion.session_id = reviewed_session.id and completion.stage_id = reviewed_stage.id
  );

  select stage.* into next_stage from public.pipeline_stages stage
  join public.session_selected_stages selection
    on selection.stage_id = stage.id and selection.session_id = reviewed_session.id
      and selection.workspace_id = expected_workspace_id
  where stage.pipeline_id = reviewed_session.pipeline_id
    and stage.workspace_id = expected_workspace_id and stage.position > reviewed_stage.position
  order by stage.position asc limit 1;

  if next_stage.id is null then
    update public.sessions s set phase_status = 'approved',
      archived_at = case when s.linear_issue_id is null or not exists (
        select 1 from public.workspace_linear_routing routing
        where routing.workspace_id = expected_workspace_id and routing.land_stage_slug is null
      ) then approved_at_now else s.archived_at end
    where s.id = reviewed_session.id;
  else
    update public.sessions s set current_stage_id = next_stage.id, current_artifact_id = null, phase_status = 'in_progress',
      current_artifact_version = coalesce((
        select max(artifact.version) from public.session_artifacts artifact
        where artifact.session_id = reviewed_session.id and artifact.stage_id = next_stage.id
      ), 0), rejection_count = 0
    where s.id = reviewed_session.id;

    select queued.job_id, queued.run_id, queued.created
    into queued_job_id, queued_run_id, queued_job_created
    from public.enqueue_session_job_with_run(
      reviewed_session.id, expected_workspace_id, next_stage.id, reviewer.id, 'assignment',
      p_agent_model_provider, p_agent_model_name, p_run_type
    ) queued;
    if reviewed_checkpoint is not null then
      perform internal.prepare_session_job_git_input(queued_job_id,reviewed_checkpoint);
    end if;
    if queued_run_id is null then
      -- A concurrent legacy producer can win the queue-key INSERT without a
      -- run. The canonical helper holds its job lock; only queued work can be
      -- given a placeholder safely, before any worker claim/bootstrap.
      select job.* into active_job from public.agent_jobs job
      where job.id = queued_job_id and job.session_id = reviewed_session.id
        and job.workspace_id = expected_workspace_id for update;
      if not found or active_job.status <> 'queued' then
        raise exception 'Next stage job has no queued execution.' using errcode = '55000';
      end if;
      insert into public.agent_runs(
        workspace_id, session_id, agent_job_id, triggered_by_member_id,
        stage_id, stage_slug, stage_name, run_type, model_provider, model_name, status
      ) values (
        expected_workspace_id, reviewed_session.id, queued_job_id, reviewer.id,
        next_stage.id, next_stage.slug, next_stage.name, p_run_type,
        btrim(p_agent_model_provider), btrim(p_agent_model_name), 'queued'
      ) returning agent_runs.id into queued_run_id;
    end if;
  end if;

  return query select s.id, s.pipeline_id, s.current_stage_id, stage.slug, s.phase_status,
    s.workspace_id, s.linear_issue_url, s.archived_at, s.current_artifact_version, s.rejection_count,
    queued_job_id, queued_run_id, queued_job_created
  from public.sessions s join public.pipeline_stages stage on stage.id = s.current_stage_id
  where s.id = reviewed_session.id;
end;
$function$
;


revoke all on function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)
  from public,anon,authenticated;
grant execute on function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)
  to service_role;

-- Actor admission remains the common session-first lock for every review RPC.
create or replace function internal.artifact_review_actor(p_workspace_id uuid, p_session_id uuid)
returns public.workspace_members language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; reviewed public.sessions;
begin
  if auth.uid() is null then raise exception 'Active human membership required.' using errcode='42501'; end if;
  select * into reviewed from public.sessions s where s.id=p_session_id and s.workspace_id=p_workspace_id
    and s.archived_at is null for no key update;
  if not found then raise exception 'Review session is unavailable.' using errcode='42501'; end if;
  if reviewed.phase_status='approved' then
    raise exception 'This session is closed for review changes.' using errcode='PT409';
  end if;
  select m.* into actor from public.workspace_members m where m.workspace_id=p_workspace_id
    and m.user_id=auth.uid() and m.kind='human' and m.is_active for share;
  if not found then raise exception 'Active human membership required.' using errcode='42501'; end if;
  return actor;
end;
$$;

-- Creation and reopening share this guard. If approval wins the lock, a new
-- blocker cannot be accepted against a stage that has already completed.
create function internal.guard_open_artifact_blocker()
returns trigger language plpgsql security definer set search_path='' as $$
declare reviewed public.sessions;
begin
  if new.kind<>'blocking' or new.status<>'open' then return new; end if;
  if TG_OP='UPDATE' and old.status='open' then return new; end if;
  select * into reviewed from public.sessions s where s.id=new.session_id
    and s.workspace_id=new.workspace_id for no key update;
  if not found or reviewed.archived_at is not null
    or reviewed.phase_status not in ('awaiting_review','in_progress')
    or reviewed.current_stage_id is distinct from new.stage_id then
    raise exception 'This stage is closed for blocking requests.' using errcode='PT409';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_open_artifact_blocker() from public,anon,authenticated,service_role;
create trigger guard_open_artifact_blocker before insert or update of status on public.artifact_review_threads
for each row execute function internal.guard_open_artifact_blocker();
