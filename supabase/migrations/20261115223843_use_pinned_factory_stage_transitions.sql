-- An authoritative session uses its immutable compiled revision. The older
-- provenance flag also covers observational pins, which continue to use live
-- pipeline behavior during the drain.
create function internal.pinned_session_execution_definition(p_session public.sessions)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare definition jsonb;
begin
  if not p_session.execute_pinned_definition then return null; end if;
  select r.definition_json::jsonb into definition
  from public.factory_definition_revisions r
  where (r.workspace_id, r.id) = (p_session.workspace_id, p_session.factory_definition_revision_id);
  if not found
     or definition->>'schemaVersion' is distinct from '1'
     or definition->>'kind' is distinct from 'serial'
     or definition->>'pipelineId' is distinct from p_session.pipeline_id::text then
    raise exception 'Pinned factory definition is unavailable.' using errcode = '55000';
  end if;
  return definition;
end;
$$;
revoke all on function internal.pinned_session_execution_definition(public.sessions)
  from public, anon, authenticated, service_role;
grant execute on function internal.pinned_session_execution_definition(public.sessions) to service_role;

-- A compiled stage has the same durable id as its pipeline FK anchor. Read its
-- editable fields and array position from the compiled revision.
create function internal.session_execution_stages(p_session public.sessions)
returns setof public.pipeline_stages language plpgsql stable security invoker set search_path = '' as $$
begin
  if not p_session.execute_pinned_definition then
    return query select stage.* from public.pipeline_stages stage
    where (stage.workspace_id, stage.pipeline_id) = (p_session.workspace_id, p_session.pipeline_id);
    return;
  end if;

  return query
  select stage.* from jsonb_array_elements(internal.pinned_session_execution_definition(p_session)->'stages')
    with ordinality as compiled(value, position)
  cross join lateral jsonb_populate_record(null::public.pipeline_stages, jsonb_build_object(
    'id', compiled.value->>'id',
    'pipeline_id', p_session.pipeline_id,
    'workspace_id', p_session.workspace_id,
    'position', compiled.position,
    'slug', compiled.value->>'slug',
    'name', compiled.value->>'name',
    'description', compiled.value->>'description',
    'prompt_template_md', compiled.value->>'promptTemplateMd',
    'approver_member_ids', compiled.value->'approverMemberIds',
    'anyone_can_approve', compiled.value->'anyoneCanApprove'
  )) stage;
end;
$$;
revoke all on function internal.session_execution_stages(public.sessions)
  from public, anon, authenticated, service_role;
grant execute on function internal.session_execution_stages(public.sessions) to service_role;

-- Keep queued runs and fallback jobs on the same admitted stage and model.
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
  agent jsonb;
begin
  if p_run_type is null or p_run_type not in ('project', 'code') then
    raise exception 'Run type must be project or code' using errcode = '22023';
  end if;
  select * into current_session from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
  if current_session.execute_pinned_definition then
    agent := internal.pinned_session_execution_definition(current_session)->'agent';
    p_agent_model_provider := agent->>'provider';
    p_agent_model_name := agent->>'model';
  end if;
  if nullif(btrim(p_agent_model_provider), '') is null
     or nullif(btrim(p_agent_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
  end if;
  if current_session.archived_at is not null then raise exception 'Session is archived.' using errcode = '55000'; end if;
  if current_session.current_stage_id is distinct from p_expected_stage_id then
    raise exception 'Session stage changed.' using errcode = '55000'; end if;
  if current_session.phase_status = 'approved' then raise exception 'Session is already complete.' using errcode = '55000'; end if;
  if p_requested_by_member_id is not null and not exists (
    select 1 from public.workspace_members member
    where member.id = p_requested_by_member_id and member.workspace_id = p_workspace_id
      and member.is_active and member.kind = 'human') then
    raise exception 'Requester is not an active workspace member.' using errcode = '42501';
  end if;
  select stage.* into current_stage from internal.session_execution_stages(current_session) stage
  where stage.id = current_session.current_stage_id;
  if not found then raise exception 'Session references a missing stage.' using errcode = 'P0002'; end if;
  select * into active_job from public.agent_jobs
  where session_id = p_session_id and workspace_id = p_workspace_id and status in ('queued', 'started', 'running') for update;
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
      select * into active_job from public.agent_jobs
      where session_id = p_session_id and workspace_id = p_workspace_id
        and status in ('queued', 'started', 'running') for update;
      if not found then raise; end if;
    end;
  end if;
  if active_job.id is null and queued_job_id is null then
    return query select null::uuid,null::uuid,false;
    return;
  end if;
  if active_job.id is not null then
    if active_job.stage_id is not null and active_job.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000'; end if;
    select * into existing_run from public.agent_runs where agent_job_id = active_job.id
      order by created_at desc, id desc limit 1;
    if existing_run.stage_id is not null and existing_run.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000'; end if;
    select * into existing_run from public.agent_runs
    where agent_job_id = active_job.id and status in ('queued', 'started', 'running')
    order by created_at desc, id desc limit 1;
    if existing_run.stage_id is not null and existing_run.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000'; end if;
    if active_job.status='queued' then perform internal.prepare_session_job_git_input(active_job.id); end if;
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
  perform internal.prepare_session_job_git_input(queued_job_id);
  return query select queued_job_id, queued_run_id, true;
end;
$function$;

-- The outer release, budget and retry wrappers still own start admission.
-- Keep the labels they retain on the job and run aligned with execution.
CREATE OR REPLACE FUNCTION internal.start_session_job_attempt_before_release(p_job_id uuid, p_attempt_count integer, p_expected_stage_id uuid, p_expected_artifact_version integer, p_model_provider text, p_model_name text, p_run_type text, p_branch_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  s public.sessions%rowtype;
  j public.agent_jobs%rowtype;
  stage public.pipeline_stages%rowtype;
  historical_stage_id uuid;
  execution_id uuid;
begin
  if nullif(btrim(p_model_provider), '') is null or nullif(btrim(p_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
  end if;
  if p_run_type is null or p_run_type not in ('project', 'code') then
    raise exception 'Run type must be project or code' using errcode = '22023';
  end if;
  select owner.* into s from public.sessions owner
  join public.agent_jobs candidate on candidate.session_id = owner.id
  where candidate.id = p_job_id for no key update of owner;
  if not found then return null; end if;
  select * into j from public.agent_jobs where id = p_job_id for update;
  if not found or p_attempt_count is null or p_attempt_count <= 0
     or j.attempt_count <> p_attempt_count or j.status not in ('started', 'running')
     or j.session_id <> s.id or j.workspace_id <> s.workspace_id or s.archived_at is not null
     or s.current_stage_id is distinct from p_expected_stage_id
     or p_expected_artifact_version is null or s.current_artifact_version <> p_expected_artifact_version
     or s.phase_status not in ('in_progress', 'rejected', 'awaiting_review')
     or (j.stage_id is not null and j.stage_id <> s.current_stage_id) then return null; end if;
  select effective.* into stage from internal.session_execution_stages(s) effective
  where effective.id = s.current_stage_id;
  if not found then return null; end if;

  perform 1 from public.agent_runs where agent_job_id = j.id order by id for update;
  select stage_id into historical_stage_id from public.agent_runs
  where agent_job_id = j.id order by created_at desc, id desc limit 1;
  if historical_stage_id is not null and historical_stage_id <> stage.id then return null; end if;
  if exists (
    select 1 from public.agent_runs r where r.agent_job_id = j.id
      and (r.attempt_count = p_attempt_count
        or (r.status in ('queued', 'started', 'running')
            and (r.session_id <> s.id or r.workspace_id <> s.workspace_id
              or (r.stage_id is not null and r.stage_id <> stage.id)
              or (r.attempt_count is null and r.status <> 'queued')
              or r.attempt_count > p_attempt_count)))
  ) then return null; end if;
  -- Retrying a previously published job is not a new review request. Explicit
  -- reruns use a new job ID; a fresh job may legitimately start awaiting_review.
  if s.phase_status = 'awaiting_review' and exists (
    select 1 from public.agent_runs where agent_job_id = j.id and status = 'success'
  ) then return null; end if;
  if (select count(*) from public.agent_runs where agent_job_id = j.id
      and attempt_count is null and status = 'queued') > 1 then return null; end if;

  -- Older bound attempts have lost authority because the queue claimed a newer
  -- attempt. Never reuse their run ID or sandbox identity for the replacement.
  update public.agent_runs set status = 'error', finished_at = coalesce(finished_at, now())
  where agent_job_id = j.id and attempt_count < p_attempt_count
    and status in ('queued', 'started', 'running');
  select id into execution_id from public.agent_runs
  where agent_job_id = j.id and attempt_count is null and status = 'queued';
  update public.agent_jobs set stage_id = stage.id, stage_slug = stage.slug, stage_name = stage.name
  where id = j.id;
  if execution_id is null then
    insert into public.agent_runs(
      workspace_id, session_id, agent_job_id, triggered_by_member_id, attempt_count,
      stage_id, stage_slug, stage_name, model_provider, model_name, run_type,
      branch_name, status, started_at, last_activity_at
    ) values (
      s.workspace_id, s.id, j.id, j.requested_by_member_id, p_attempt_count,
      stage.id, stage.slug, stage.name, btrim(p_model_provider), btrim(p_model_name), p_run_type,
      p_branch_name, 'running', now(), now()
    ) returning id into execution_id;
  else
    update public.agent_runs set attempt_count = p_attempt_count,
      stage_id = stage.id, stage_slug = stage.slug, stage_name = stage.name,
      model_provider = btrim(p_model_provider), model_name = btrim(p_model_name), run_type = p_run_type,
      branch_name = p_branch_name, status = 'running', started_at = now(), last_activity_at = now()
    where id = execution_id;
  end if;
  update public.sessions set phase_status = 'in_progress' where id = s.id;
  return execution_id;
end;
$function$;

create or replace function internal.prepare_session_job_git_input(p_job_id uuid,p_checkpoint_run_id uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; prior public.session_job_git_inputs%rowtype; selected record; stage public.pipeline_stages%rowtype;
begin
  perform internal.assert_checkpoint_publication_service();
  select owner.* into s from public.sessions owner join public.agent_jobs candidate on candidate.session_id=owner.id
    where candidate.id=p_job_id for no key update of owner;
  if not found then raise exception 'Session not found.' using errcode='P0002'; end if;
  select * into j from public.agent_jobs where id=p_job_id for update;
  if j.workspace_id<>s.workspace_id or j.session_id<>s.id or (j.stage_id is not null and j.stage_id<>s.current_stage_id)
    or s.archived_at is not null then raise exception 'Git input does not match the current execution.' using errcode='23514'; end if;
  select * into prior from public.session_job_git_inputs where job_id=j.id;
  if found then
    if p_checkpoint_run_id is not null and prior.source_checkpoint_run_id is distinct from p_checkpoint_run_id then
      raise exception 'Git execution input is already selected for this job.' using errcode='23514';
    end if;
    return;
  end if;
  if j.status<>'queued' then raise exception 'Active execution has no pinned Git input.' using errcode='55000'; end if;
  select * into selected from internal.session_execution_input(s.id,s.workspace_id);
  if not found then return; end if; -- First execution resolves the initial root.
  if p_checkpoint_run_id is not null and selected.source_checkpoint_run_id is distinct from p_checkpoint_run_id then
    raise exception 'Reviewed Git checkpoint is not the current session head.' using errcode='55000';
  end if;
  -- A legacy producer may have a live run despite its queued job status.
  -- Known Git selection must precede execution; never retarget such work.
  perform 1 from public.agent_runs where agent_job_id=j.id order by id for update;
  if exists(select 1 from public.agent_runs where agent_job_id=j.id and status in ('started','running')) then
    raise exception 'Active execution has no pinned Git input.' using errcode='55000';
  end if;
  if j.stage_id is null then
    -- Canonical enqueue also adopts bare legacy queued jobs without making a
    -- synthetic run. Bind their missing stage only when Git selection exists;
    -- no-lineage legacy adoption remains completely unchanged.
    select effective.* into stage from internal.session_execution_stages(s) effective
    where effective.id=s.current_stage_id;
    if not found then raise exception 'Session references a missing stage.' using errcode='P0002'; end if;
    update public.agent_jobs set stage_id=stage.id,stage_slug=stage.slug,stage_name=stage.name
      where id=j.id and status='queued' and stage_id is null returning * into j;
    if not found then raise exception 'Git input does not match the current execution.' using errcode='23514'; end if;
  end if;
  insert into public.session_job_git_inputs(job_id,workspace_id,session_id,repository_id,repository_full_name,
    base_branch,initial_base_sha,input_sha,input_ref,source_checkpoint_run_id,pinned_run_id,pinned_attempt_count)
  values(j.id,s.workspace_id,s.id,selected.repository_id,selected.repository_full_name,selected.base_branch,
    selected.initial_base_sha,selected.input_sha,selected.input_ref,selected.source_checkpoint_run_id,null,null);
end;
$$;

-- Retain the exact review/checkpoint/receipt transaction with pinned progression.
create or replace function internal.approve_session_stage_before_execution_budget(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid, expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text, p_agent_model_name text, p_run_type text DEFAULT 'project'::text, p_expected_review_revision bigint DEFAULT NULL::bigint)
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
  agent jsonb;
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

  select stage.* into reviewed_stage from internal.session_execution_stages(reviewed_session) stage
  where stage.id = expected_stage_id;
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

  select stage.* into next_stage from internal.session_execution_stages(reviewed_session) stage
  join public.session_selected_stages selection
    on selection.stage_id = stage.id and selection.session_id = reviewed_session.id
      and selection.workspace_id = expected_workspace_id
  where stage.position > reviewed_stage.position
  order by stage.position asc limit 1;

  if next_stage.id is null then
    -- Final delivery approval validates the current artifact and, when the
    -- policy requires artifact approval for delivery, independently verified
    -- current PR readiness. The session lock above already serializes this
    -- gate with every refresh enqueue/finish and review writer, so a racing
    -- new head/base, policy or review revision cannot slip a stale Ready.
    perform internal.assert_delivery_readiness_gate(reviewed_session.id, expected_workspace_id);
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

    if reviewed_session.execute_pinned_definition then
      agent := internal.pinned_session_execution_definition(reviewed_session)->'agent';
      p_agent_model_provider := agent->>'provider';
      p_agent_model_name := agent->>'model';
    end if;

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
  from public.sessions s join lateral internal.session_execution_stages(s) stage on stage.id = s.current_stage_id
  where s.id = reviewed_session.id;
end;
$function$;

create or replace function internal.approve_session_stage_before_receipts(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid,
  expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text,
  p_agent_model_name text, p_run_type text default 'project',p_expected_review_revision bigint default null)
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,phase_status public.pipeline_phase_status,
  workspace_id uuid,linear_issue_url text,archived_at timestamptz,current_artifact_version integer,rejection_count integer,
  job_id uuid,run_id uuid,job_created boolean)
language plpgsql security invoker set search_path='' as $$
declare s public.sessions; code text; has_later_stage boolean;
begin
  select * into s from public.sessions owner where owner.id=target_session_id and owner.workspace_id=expected_workspace_id for no key update;
  if not found then return; end if;
  with stages as materialized (select * from internal.session_execution_stages(s))
  select exists(select 1 from stages later
    join public.session_selected_stages selected on selected.stage_id=later.id and selected.session_id=s.id
    join stages current on current.id=s.current_stage_id
    where later.position>current.position)
    into has_later_stage;
  code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
  if code is not null and has_later_stage then return; end if;
  if not has_later_stage then
    return query select * from internal.approve_session_stage_before_execution_budget(target_session_id,expected_workspace_id,
      expected_stage_id,expected_artifact_id,expected_version,approver_member_id,p_agent_model_provider,p_agent_model_name,
      p_run_type,p_expected_review_revision);
    return;
  end if;
  begin
    return query select * from internal.approve_session_stage_before_execution_budget(target_session_id,expected_workspace_id,
      expected_stage_id,expected_artifact_id,expected_version,approver_member_id,p_agent_model_provider,p_agent_model_name,
      p_run_type,p_expected_review_revision);
  exception when others then
    -- A refusal in the nested enqueue rolls back only the approval attempt.
    -- Recompute after that rollback so a same-transaction deadline crossing is
    -- still durable without advancing the stage or losing the prior review.
    code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
    if code is null then raise; end if;
    return;
  end;
end;
$$;

-- Review feedback reruns the same admitted stage and engine.
CREATE OR REPLACE FUNCTION internal.reject_session_stage(p_session_id uuid, p_workspace_id uuid, p_artifact_version integer, p_feedback_text text, p_agent_model_provider text, p_agent_model_name text, p_run_type text DEFAULT 'project'::text, p_requested_by_member_id uuid DEFAULT NULL::uuid)
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
  agent jsonb;
begin
  if nullif(btrim(p_feedback_text), '') is null then
    raise exception 'Feedback is required' using errcode = '23514';
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

  if locked_session.execute_pinned_definition then
    agent := internal.pinned_session_execution_definition(locked_session)->'agent';
    p_agent_model_provider := agent->>'provider';
    p_agent_model_name := agent->>'model';
  end if;
  if nullif(btrim(p_agent_model_provider), '') is null
     or nullif(btrim(p_agent_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
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
  from internal.session_execution_stages(locked_session) ps
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
$function$;

create or replace function public.reject_session_stage(p_session_id uuid,p_workspace_id uuid,p_artifact_version integer,
  p_feedback_text text,p_agent_model_provider text,p_agent_model_name text,p_expected_stage_id uuid,
  p_expected_artifact_id uuid,p_run_type text default 'project',p_requested_by_member_id uuid default null)
returns table(session_id uuid,workspace_id uuid,current_stage_id uuid,current_artifact_version integer,
  phase_status public.pipeline_phase_status,rejection_count integer,archived_at timestamptz,job_id uuid,run_id uuid,job_created boolean)
language plpgsql security definer set search_path='' as $$
declare s public.sessions; active public.agent_jobs; policy public.execution_policy_revisions; code text; max_repairs integer;
begin
  select * into s from public.sessions owner where owner.id=p_session_id and owner.workspace_id=p_workspace_id for no key update;
  if not found then raise exception 'Session not found.' using errcode='P0002'; end if;
  select * into active from public.agent_jobs active_job where active_job.session_id=s.id and active_job.workspace_id=s.workspace_id
    and active_job.status in('queued','started','running') for update;
  if (active.id is null or active.status<>'queued') and s.archived_at is null
    and s.phase_status='awaiting_review' and s.current_stage_id is not distinct from p_expected_stage_id
    and s.current_artifact_id is not distinct from p_expected_artifact_id
    and s.current_artifact_version=p_artifact_version then
    code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
    if code is null and s.execution_policy_revision_id is not null then
      select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
      max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
      if s.execution_repair_attempts>=max_repairs then
        code:=internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
      end if;
    end if;
    if code is not null then
      insert into public.session_artifact_feedback(workspace_id,session_id,stage_id,stage_slug,target_version,feedback_text)
      select s.workspace_id,s.id,stage.id,stage.slug,p_artifact_version,p_feedback_text
        from internal.session_execution_stages(s) stage where stage.id=s.current_stage_id
      on conflict on constraint session_artifact_feedback_unique_target
      do update set feedback_text=excluded.feedback_text;
      update public.sessions owner set phase_status='rejected',rejection_count=owner.rejection_count+1
        where owner.id=s.id and owner.phase_status='awaiting_review';
      return query select s.id,s.workspace_id,s.current_stage_id,s.current_artifact_version,
        'rejected'::public.pipeline_phase_status,s.rejection_count+1,s.archived_at,null::uuid,null::uuid,false;
      return;
    end if;
  end if;
  return query select * from internal.reject_session_stage_before_execution_budget(p_session_id,p_workspace_id,
    p_artifact_version,p_feedback_text,p_agent_model_provider,p_agent_model_name,p_expected_stage_id,
    p_expected_artifact_id,p_run_type,p_requested_by_member_id);
end;
$$;

-- Linear can still cancel and reroute; target and downstream order are pinned.
CREATE OR REPLACE FUNCTION public.apply_linear_session_transition(p_session_id uuid, p_workspace_id uuid, p_linear_issue_id text, p_expected_session_updated_at timestamp with time zone, p_expected_routing_updated_at timestamp with time zone, p_source_span_id text, p_source_started_at timestamp with time zone, p_source_state_id text, p_source_issue_updated_at timestamp with time zone, p_status_name text, p_agent_model_provider text DEFAULT NULL::text, p_agent_model_name text DEFAULT NULL::text, p_run_type text DEFAULT 'project'::text)
 RETURNS TABLE(outcome text, job_ids uuid[], run_ids uuid[], job_id uuid, run_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  s public.sessions%rowtype;
  config public.workspace_linear_routing%rowtype;
  receipt internal.session_linear_transition_receipts%rowtype;
  target public.pipeline_stages%rowtype;
  pipeline_id uuid;
  config_key jsonb;
  route_key text;
  candidate text;
  target_slug text;
  live_target_id uuid;
  normalized_name text := lower(regexp_replace(btrim(p_status_name), '\s+', ' ', 'g'));
  canceled_jobs uuid[] := '{}';
  canceled_runs uuid[] := '{}';
  queued_job uuid;
  queued_run uuid;
  result text := 'observed';
  initial_baseline boolean;
  code text;
  policy public.execution_policy_revisions;
  max_repairs integer;
begin
  if nullif(btrim(p_source_span_id), '') is null or nullif(btrim(p_source_state_id), '') is null
     or nullif(normalized_name, '') is null or p_source_started_at is null or p_source_issue_updated_at is null
     or p_source_started_at > p_source_issue_updated_at then
    raise exception 'A coherent Linear state span is required' using errcode = '22023';
  end if;
  select session.pipeline_id into pipeline_id from public.sessions session
  where session.id = p_session_id and session.workspace_id = p_workspace_id;
  if not found then return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return; end if;
  perform 1 from public.pipelines pipeline where pipeline.id = pipeline_id and pipeline.workspace_id = p_workspace_id for share;
  select * into config from public.workspace_linear_routing where workspace_id = p_workspace_id for share;
  if not found then raise exception 'Linear routing configuration is missing' using errcode = '55000'; end if;
  if config.updated_at is distinct from p_expected_routing_updated_at then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  foreach candidate in array array['backlog','todo','in_progress','in_review','rework','merging','done','canceled'] loop
    if jsonb_typeof(config.status_mappings -> candidate) is distinct from 'array'
       or jsonb_array_length(config.status_mappings -> candidate) = 0 then
      raise exception 'Linear routing configuration is invalid' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(config.status_mappings -> candidate) value
      where jsonb_typeof(value) <> 'string' or btrim(value #>> '{}') = '') then
      raise exception 'Linear routing configuration is invalid' using errcode = '22023';
    end if;
    if route_key is null and exists (
      select 1 from jsonb_array_elements_text(config.status_mappings -> candidate) name
      where lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = normalized_name
    ) then route_key := candidate; end if;
  end loop;
  config_key := jsonb_build_object('route', route_key, 'target', case
    when route_key = 'rework' then config.rework_stage_slug
    when route_key in ('merging','done') then config.land_stage_slug else null end);
  select * into s from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if s.pipeline_id is distinct from pipeline_id or s.linear_issue_id is distinct from p_linear_issue_id
     or ((s.updated_at is distinct from p_expected_session_updated_at or s.archived_at is not null)
         and not (s.archived_at is not null and route_key = 'done')) then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  insert into internal.session_linear_transition_receipts(session_id, baseline_at)
  values(s.id, s.created_at) on conflict do nothing;
  select * into receipt from internal.session_linear_transition_receipts where session_id = s.id;
  if receipt.source_started_at is not null and (
      p_source_started_at < receipt.source_started_at
      or p_source_issue_updated_at < receipt.issue_updated_at
      or (p_source_started_at = receipt.source_started_at and p_source_span_id <> receipt.source_span_id
          and p_source_issue_updated_at <= receipt.issue_updated_at)
    ) then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  if receipt.source_span_id = p_source_span_id and (receipt.source_state_id is distinct from p_source_state_id
      or receipt.source_started_at is distinct from p_source_started_at) then
    raise exception 'Linear state span identity changed' using errcode = '22023';
  end if;
  if receipt.source_span_id = p_source_span_id and receipt.routing_config = config_key then
    update internal.session_linear_transition_receipts set issue_updated_at = p_source_issue_updated_at,
      observed_at = now() where session_id = s.id;
    return query select 'duplicate', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  initial_baseline := receipt.source_span_id is null and p_source_started_at <= receipt.baseline_at;
  if route_key = 'rework' then target_slug := config.rework_stage_slug;
  elsif route_key in ('merging','done') then target_slug := config.land_stage_slug; end if;
  if target_slug is not null then
    if s.execute_pinned_definition then
      -- Linear routing refers to a live pipeline label. Resolve its stable
      -- anchor first, then route through that stage's admitted configuration.
      select stage.id into live_target_id from public.pipeline_stages stage
      where stage.workspace_id = s.workspace_id and stage.pipeline_id = s.pipeline_id
        and stage.slug = target_slug for share;
      select stage.* into target from internal.session_execution_stages(s) stage
      join public.session_selected_stages selected on selected.stage_id = stage.id and selected.session_id = s.id
      where case when live_target_id is not null then stage.id = live_target_id else stage.slug = target_slug end;
    else
      select stage.* into target from public.pipeline_stages stage
      join public.session_selected_stages selected on selected.stage_id = stage.id and selected.session_id = s.id
      where stage.workspace_id = s.workspace_id and stage.pipeline_id = s.pipeline_id
        and stage.slug = target_slug for share of stage;
    end if;
    if not found and route_key <> 'done' then
      return query select 'missing_stage', canceled_jobs, canceled_runs, queued_job, queued_run; return;
    end if;
  end if;
  if s.archived_at is not null and target.id is not null then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  -- Refuse exhausted work before canceling jobs or deleting review history.
  if not initial_baseline and (target.id is not null or (route_key in('todo','in_progress') and s.phase_status in('in_progress','rejected'))) then
    code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
    if code is null and route_key='rework' and s.execution_policy_revision_id is not null then
      select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
      max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
      if s.execution_repair_attempts>=max_repairs then
        code:=internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
      end if;
    end if;
    if code is not null then
      update internal.session_linear_transition_receipts set source_span_id=p_source_span_id,
        source_started_at=p_source_started_at,source_state_id=p_source_state_id,
        issue_updated_at=p_source_issue_updated_at,routing_config=config_key,observed_at=now()
      where session_id=s.id;
      return query select 'exhausted',canceled_jobs,canceled_runs,queued_job,queued_run;
      return;
    end if;
  end if;
  if route_key = 'canceled' or (route_key = 'done' and target.id is null) then
    select archived.job_ids, archived.run_ids into canceled_jobs, canceled_runs
    from public.archive_session_job_attempts(s.id, s.workspace_id,
      'Linear issue moved to "' || p_status_name || '".', route_key = 'done') archived;
    result := case when route_key = 'done' then 'completed' else 'archived' end;
  elsif not initial_baseline and target.id is not null then
    begin
      select canceled.job_ids, canceled.run_ids into canceled_jobs, canceled_runs
      from public.cancel_session_job_attempts(s.id, s.workspace_id,
        'Linear issue moved to "' || p_status_name || '".', null, false) canceled;
      delete from public.session_artifact_feedback feedback using internal.session_execution_stages(s) stage
      where feedback.session_id = s.id and feedback.stage_id = stage.id
        and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
      delete from public.session_phase_completions completion using internal.session_execution_stages(s) stage
      where completion.session_id = s.id and completion.stage_id = stage.id
        and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
      update public.sessions set current_stage_id = target.id, current_artifact_id = null,
        current_artifact_version = coalesce((select max(version) from public.session_artifacts
          where session_id = s.id and stage_id = target.id), 0),
        phase_status = 'rejected', rejection_count = 0 where id = s.id;
      select queued.job_id, queued.run_id into queued_job, queued_run
      from public.enqueue_session_job_with_run(s.id,s.workspace_id,target.id,null,
        case when route_key='rework' then 'manual_retry'::public.agent_trigger_type else 'assignment'::public.agent_trigger_type end,
        p_agent_model_provider,p_agent_model_name,p_run_type) queued;
      if queued_job is null then raise exception 'Linear execution budget admission refused' using errcode='P429B'; end if;
      if queued_run is null then raise exception 'Linear replacement needs an atomic queued run' using errcode = '55000'; end if;
      result := 'routed';
    exception when sqlstate 'P429B' then
      -- The inner subtransaction restores the original stage, feedback,
      -- completions and active work. Recompute and persist the reason outside it.
      canceled_jobs:='{}'; canceled_runs:='{}'; queued_job:=null; queued_run:=null;
      code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
      if code is null and route_key='rework' and s.execution_policy_revision_id is not null then
        select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
        max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
        if s.execution_repair_attempts>=max_repairs then
          code:=internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
        end if;
      end if;
      if code is null then raise; end if;
      result := 'exhausted';
    end;
  elsif not initial_baseline and route_key in ('todo','in_progress')
      and s.phase_status in ('in_progress','rejected') then
    select queued.job_id, queued.run_id into queued_job, queued_run
    from public.enqueue_session_job_with_run(s.id,s.workspace_id,s.current_stage_id,null,'manual_retry',
      p_agent_model_provider,p_agent_model_name,p_run_type) queued;
    result := case when queued_job is null then 'exhausted' else 'queued' end;
  end if;
  update internal.session_linear_transition_receipts set source_span_id = p_source_span_id,
    source_started_at = p_source_started_at, source_state_id = p_source_state_id,
    issue_updated_at = p_source_issue_updated_at, routing_config = config_key, observed_at = now()
  where session_id = s.id;
  return query select result, canceled_jobs, canceled_runs, queued_job, queued_run;
end;
$function$;

-- Exact approval receipts retain their captured rendering labels and order.
create or replace function public.load_attempt_predecessor_approvals(p_session_id uuid)
returns table(completion_id uuid, stage_id uuid, stage_slug text, current_stage_slug text,
  approval_receipt_id uuid, artifact_id uuid, artifact_version integer, artifact_digest text, artifact_text text)
language sql stable security definer set search_path = '' as $$
  select c.id, c.stage_id, c.stage_slug, stage.slug, approval.id, approval.artifact_id, approval.artifact_version,
    approval.artifact_digest, internal.approved_predecessor_artifact_text(a.artifact_json)
  from public.sessions owner
  join public.session_phase_completions c on (c.workspace_id, c.session_id) = (owner.workspace_id, owner.id)
  left join lateral internal.session_execution_stages(owner) stage on stage.id = c.stage_id
  left join lateral (
    select current.position from internal.session_execution_stages(owner) current
    where owner.execute_pinned_definition and current.id = owner.current_stage_id
  ) active on true
  left join lateral (
    select receipt.* from public.session_stage_approval_receipts receipt
    where (receipt.workspace_id, receipt.session_id, receipt.completion_id, receipt.stage_id) =
      (c.workspace_id, c.session_id, c.id, c.stage_id)
    order by receipt.approval_number desc limit 1
  ) approval on true
  left join public.session_artifacts a on (a.workspace_id, a.session_id, a.stage_id, a.id, a.version) =
    (approval.workspace_id, approval.session_id, approval.stage_id, approval.artifact_id, approval.artifact_version)
  where owner.id = p_session_id and c.stage_id is distinct from owner.current_stage_id
    and (not owner.execute_pinned_definition or stage.position < active.position)
  order by stage.position nulls last, approval.approval_number desc nulls last, c.completed_at desc, c.id desc;
$$;

-- Artifact review authorization pairs the recorded policy with the actor's
-- current active human membership. Legacy policies still take their stage lock.
create function internal.can_review_session_stage(
  p_session_id uuid, p_workspace_id uuid, p_stage_id uuid, p_actor public.workspace_members
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare s public.sessions; stage public.pipeline_stages;
begin
  select owner.* into s from public.sessions owner
  where (owner.workspace_id, owner.id) = (p_workspace_id, p_session_id);
  if not found then return false; end if;
  if s.execute_pinned_definition then
    select effective.* into stage from internal.session_execution_stages(s) effective where effective.id = p_stage_id;
  else
    select live.* into stage from public.pipeline_stages live
    where (live.id, live.workspace_id, live.pipeline_id) = (p_stage_id, p_workspace_id, s.pipeline_id)
    for share;
  end if;
  if not found then return false; end if;
  return coalesce(stage.anyone_can_approve or case when cardinality(stage.approver_member_ids) > 0
    then p_actor.id = any(stage.approver_member_ids) else p_actor.role in ('owner','admin') end, false);
end;
$$;
revoke all on function internal.can_review_session_stage(uuid,uuid,uuid,public.workspace_members)
  from public, anon, authenticated, service_role;

create or replace function public.transition_artifact_review_thread(
  p_workspace_id uuid, p_thread_id uuid, p_expected_revision integer, p_status text, p_reason text
) returns public.artifact_review_threads language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; thread public.artifact_review_threads; can_review boolean; token bigint; old_status text;
begin
  select * into thread from public.artifact_review_threads where id=p_thread_id and workspace_id=p_workspace_id;
  actor := internal.artifact_review_actor(p_workspace_id,thread.session_id);
  select * into thread from public.artifact_review_threads where id=p_thread_id and workspace_id=p_workspace_id for update;
  if thread.revision is distinct from p_expected_revision then
    raise exception 'Review thread revision is stale.' using errcode='40001';
  end if;
  can_review := internal.can_review_session_stage(thread.session_id, p_workspace_id, thread.stage_id, actor);
  if not coalesce(can_review,false) and (thread.kind='blocking' or actor.id <> thread.author_member_id) then
    raise exception 'Authorized human reviewer required.' using errcode='42501';
  end if;
  if p_status not in ('open','resolved','superseded') or p_status is null or p_status=thread.status
    or (thread.status <> 'open' and p_status <> 'open')
    or char_length(btrim(coalesce(p_reason,'')))=0 or char_length(p_reason)>10000 then
    raise exception 'Invalid review lifecycle transition.' using errcode='23514';
  end if;
  old_status := thread.status;
  update public.artifact_review_threads set status=p_status,revision=revision+1,updated_at=clock_timestamp()
    where id=p_thread_id returning * into thread;
  update public.sessions set artifact_review_revision=artifact_review_revision+1 where id=thread.session_id
    returning artifact_review_revision into token;
  insert into public.artifact_review_events(workspace_id,thread_id,actor_member_id,actor_label,event_type,detail,review_revision)
    values(p_workspace_id,p_thread_id,actor.id,internal.artifact_review_author_label(actor),
      case when p_status='open' then 'reopened' else p_status end,
      jsonb_build_object('previousStatus',old_status,'status',p_status,'reason',p_reason),token);
  return thread;
end;
$$;

create or replace function public.transition_artifact_review_thread_once(
  p_request_id uuid,p_workspace_id uuid,p_thread_id uuid,p_expected_revision integer,p_status text,p_reason text
) returns public.artifact_review_threads language plpgsql security definer set search_path='' as $$
declare actor public.workspace_members; target public.artifact_review_threads;
  receipt internal.artifact_review_requests; result public.artifact_review_threads; can_review boolean;
begin
  select * into target from public.artifact_review_threads where id=p_thread_id and workspace_id=p_workspace_id;
  receipt := internal.claim_artifact_review_request(p_workspace_id,target.session_id,p_request_id,
    jsonb_build_object('operation','transition','threadId',p_thread_id,'expectedRevision',p_expected_revision,
      'status',p_status,'reason',p_reason));
  if receipt.response is not null then
    -- Recovery never revives an authorization decision after access was revoked.
    -- CAS is deliberately not repeated: the receipt is the original accepted result.
    actor := internal.artifact_review_actor(p_workspace_id,target.session_id);
    can_review := internal.can_review_session_stage(target.session_id, p_workspace_id, target.stage_id, actor);
    if not coalesce(can_review,false) and (target.kind='blocking' or actor.id<>target.author_member_id) then
      raise exception 'Authorized human reviewer required.' using errcode='42501';
    end if;
    return jsonb_populate_record(null::public.artifact_review_threads,receipt.response);
  end if;
  result := public.transition_artifact_review_thread(p_workspace_id,p_thread_id,p_expected_revision,p_status,p_reason);
  update internal.artifact_review_requests set response=to_jsonb(result)
    where workspace_id=receipt.workspace_id and actor_member_id=receipt.actor_member_id and request_id=receipt.request_id;
  return result;
end;
$$;

-- Keep the current session timeline and artifacts on the execution labels.
CREATE OR REPLACE FUNCTION public.get_session_detail_page(target_workspace_slug text, target_session_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_workspace_id uuid;
  v_has_any_workspace boolean;
  v_session public.sessions%rowtype;
  v_current_stage public.pipeline_stages%rowtype;
  v_creator_display_name text;
  v_stages jsonb := '[]'::jsonb;
  v_phase_completions jsonb := '[]'::jsonb;
  v_artifacts jsonb := '[]'::jsonb;
  v_pull_requests jsonb := '[]'::jsonb;
  v_effective_repository_id uuid;
  v_repository jsonb := null;
begin
  select w.id
  into v_workspace_id
  from public.workspaces w
  join public.workspace_members wm
    on wm.workspace_id = w.id
  where w.slug = target_workspace_slug
    and wm.user_id = auth.uid()
    and wm.is_active
    and wm.kind = 'human'
  limit 1;

  if v_workspace_id is null then
    select exists (
      select 1
      from public.workspace_members wm
      where wm.user_id = auth.uid()
        and wm.is_active
        and wm.kind = 'human'
    )
    into v_has_any_workspace;

    return jsonb_build_object(
      'access', jsonb_build_object(
        'hasAnyWorkspace', v_has_any_workspace
      )
    );
  end if;

  select *
  into v_session
  from public.sessions s
  where s.workspace_id = v_workspace_id
    and s.number = target_session_number;

  if not found then
    return null;
  end if;

  select *
  into v_current_stage
  from internal.session_execution_stages(v_session) ps
  where ps.id = v_session.current_stage_id;

  select coalesce(
    nullif(btrim(wm.full_name), ''),
    nullif(btrim(wm.username), ''),
    nullif(btrim(wm.email), ''),
    'Unknown member'
  )
  into v_creator_display_name
  from public.workspace_members wm
  where wm.id = v_session.creator_member_id
    and wm.workspace_id = v_workspace_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'description', ps.description,
        'id', ps.id,
        'name', ps.name,
        'position', ps.position,
        'slug', ps.slug
      )
      order by ps.position asc
    ),
    '[]'::jsonb
  )
  into v_stages
  from internal.session_execution_stages(v_session) ps
  join public.session_selected_stages selection
    on selection.stage_id = ps.id
   and selection.session_id = v_session.id
   and selection.workspace_id = v_workspace_id
  where ps.pipeline_id = v_session.pipeline_id
    and ps.workspace_id = v_workspace_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'completedAt', spc.completed_at,
        'id', spc.id,
        'stageId', spc.stage_id,
        'stageSlug', spc.stage_slug
      )
      order by spc.completed_at asc
    ),
    '[]'::jsonb
  )
  into v_phase_completions
  from public.session_phase_completions spc
  where spc.session_id = v_session.id
    and spc.workspace_id = v_workspace_id;

  if v_current_stage.id is not null and v_session.current_artifact_version > 0 then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', sa.id,
          'createdAt', sa.created_at,
          'payload', sa.artifact_json,
          'stageSlug', v_current_stage.slug,
          'version', sa.version
        )
        order by sa.version desc
      ),
      '[]'::jsonb
    )
    into v_artifacts
    from public.session_artifacts sa
    where sa.session_id = v_session.id
      and sa.workspace_id = v_workspace_id
      and sa.stage_id = v_current_stage.id
      and sa.version = v_session.current_artifact_version
      and sa.id = v_session.current_artifact_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', spr.id,
        'pullRequestNumber', spr.pull_request_number,
        'pullRequestUrl', spr.pull_request_url
      )
      order by spr.created_at desc
    ),
    '[]'::jsonb
  )
  into v_pull_requests
  from public.session_pull_requests spr
  where spr.workspace_id = v_workspace_id
    and spr.session_id = v_session.id;

  with latest_pull_request_repository as (
    select spr.github_repository_id
    from public.session_pull_requests spr
    where spr.workspace_id = v_workspace_id
      and spr.session_id = v_session.id
      and spr.github_repository_id is not null
    order by spr.created_at desc
    limit 1
  ),
  expanded_candidates(priority, repository_id) as (
    values (1, case when v_session.execute_pinned_definition then
      (internal.pinned_session_execution_definition(v_session)->>'repositoryId')::uuid
      else v_session.github_repository_id end)
    union all
    select 2, github_repository_id
    from latest_pull_request_repository
    where not v_session.execute_pinned_definition
    union all
    select 3, wrp.github_repository_id
    from public.workspace_repository_profiles wrp
    where wrp.workspace_id = v_workspace_id
      and wrp.is_primary
      and not v_session.execute_pinned_definition
    union all
    select 4, wo.selected_github_repository_id
    from public.workspace_onboarding wo
    where wo.workspace_id = v_workspace_id
      and not v_session.execute_pinned_definition
  ),
  first_configured as (
    select repository_id
    from expanded_candidates
    where repository_id is not null
    order by priority
    limit 1
  ),
  resolved as (
    select gr.*
    from expanded_candidates ec
    join public.github_repositories gr
      on gr.id = ec.repository_id
     and gr.workspace_id = v_workspace_id
    where ec.repository_id is not null
    order by ec.priority
    limit 1
  )
  select
    coalesce((select id from resolved), (select repository_id from first_configured)),
    (
      select jsonb_build_object(
        'defaultBranch', default_branch,
        'defaultProgrammingLanguage', default_programming_language,
        'fullName', full_name,
        'htmlUrl', html_url,
        'id', id,
        'isArchived', is_archived,
        'isPrivate', private
      )
      from resolved
    )
  into v_effective_repository_id, v_repository;

  return jsonb_build_object(
    'activity', jsonb_build_object(
      'repository', v_repository,
      'sessionGithubRepositoryId', v_effective_repository_id,
      'sessionId', v_session.id,
      'workspaceId', v_workspace_id
    ),
    'creatorDisplayName', v_creator_display_name,
    'session', jsonb_build_object(
      'archivedAt', v_session.archived_at,
      'artifacts', v_artifacts,
      'createdAt', v_session.created_at,
      'currentArtifactId', v_session.current_artifact_id,
      'currentArtifactVersion', v_session.current_artifact_version,
      'currentStageId', v_session.current_stage_id,
      'currentStageSlug', coalesce(v_current_stage.slug, 'unknown'),
      'id', v_session.id,
      'linearIssueId', v_session.linear_issue_id,
      'linearIssueUrl', v_session.linear_issue_url,
      'number', v_session.number,
      'phaseCompletions', v_phase_completions,
      'phaseStatus', v_session.phase_status,
      'pipeline', jsonb_build_object('stages', v_stages),
      'promptMd', v_session.prompt_md,
      'pullRequests', v_pull_requests,
      'title', v_session.title,
      'updatedAt', v_session.updated_at
    ),
    'workspaceSlug', target_workspace_slug
  );
end;
$function$;
