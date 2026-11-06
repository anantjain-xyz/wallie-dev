-- Server-owned PR readiness gates final delivery approval (OP-508).
-- Readiness stays independent of artifact approval: the evaluator records
-- decisions bound to repository + canonical PR + head/base SHA + policy and
-- artifact-review revision + the exact consumed GitHub observation, and the
-- final approval validates a current Ready decision inside its existing
-- session lock. No automatic merge is introduced.

-- The delivery gate. Runs inside approve_session_stage after its session lock,
-- so every readiness-invalidating writer (refresh enqueue/finish, publication,
-- review writers) serializes with this check. A configured final approval
-- validates the current artifact and readiness atomically; unconfigured
-- pipelines keep reviewing without a PR gate.
create function internal.assert_delivery_readiness_gate(p_session_id uuid, p_workspace_id uuid)
returns void language plpgsql stable security invoker set search_path='' as $$
declare reviewed public.sessions%rowtype;
  policy public.delivery_policies%rowtype;
  requirements jsonb;
  decision record;
begin
  select s.* into reviewed from public.sessions s
    where s.id=p_session_id and s.workspace_id=p_workspace_id;
  if reviewed.id is null then
    raise exception 'Delivery gate session is unavailable.' using errcode='42501';
  end if;
  select p.* into policy from public.delivery_policies p
    where p.pipeline_id=reviewed.pipeline_id and p.workspace_id=p_workspace_id;
  -- No configured policy: a review-only pipeline continues without a PR gate.
  if policy.pipeline_id is null then return; end if;
  select r.requirements into requirements from public.delivery_policy_revisions r
    where r.id=policy.current_revision_id;
  -- Analysis delivery is explicitly not applicable: no synthetic PR or merge.
  if requirements is null or requirements->>'deliveryMode' is distinct from 'code' then return; end if;
  -- Delivery without required artifact approval does not gate on readiness.
  if (requirements->>'requireArtifactApprovalForDelivery')::boolean is distinct from true then return; end if;

  -- The newest Ready decision must still be current for the exact repository,
  -- canonical PR epoch/number, head/base SHA, accepted checkpoint, policy
  -- revision and artifact-review revision it was bound to, within configured
  -- freshness. It must also consume the queue's latest completed GitHub
  -- observation: the evaluator records the observation id it actually read,
  -- so a decision evaluated from a superseded collection — a refresh that
  -- landed between the evaluator's read and its recording, with unchanged
  -- head/base SHAs — cannot pass here even though the currentness view's
  -- created_at ordering is satisfied.
  select c.id, c.observation_id, o.payload as readiness_payload,
      q.last_observation_id as consumed_observation_id
    into decision
    from public.session_pr_verification_currentness c
    join public.session_pr_verification_observations o on o.id=c.observation_id
    join public.session_pr_refresh_queue q on q.session_id=c.session_id
    where c.session_id=p_session_id and c.workspace_id=p_workspace_id
      and c.state='ready' and c.is_current and o.source='readiness'
    order by c.created_at desc, c.id desc limit 1;
  if decision.id is null then
    if exists (
      select 1 from public.session_pr_verification_results r
      join public.session_pr_verification_observations o on o.id=r.observation_id
      where r.session_id=p_session_id and r.workspace_id=p_workspace_id
        and r.state='ready' and o.source='readiness') then
      raise exception 'PR readiness decision is stale. Refresh PR verification and approve again.'
        using errcode='PT428';
    end if;
    raise exception 'PR readiness is not Ready. Resolve the reported delivery blockers before approving.'
      using errcode='PT428';
  end if;
  -- Bind the accepted decision to the exact observation it consumed. A null
  -- or absent sourceObservationId fails closed here.
  if (decision.readiness_payload->>'sourceObservationId')::uuid
      is distinct from decision.consumed_observation_id then
    raise exception 'PR readiness decision is stale. Refresh PR verification and approve again.'
      using errcode='PT428';
  end if;
end;
$$;
revoke all on function internal.assert_delivery_readiness_gate(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function internal.assert_delivery_readiness_gate(uuid,uuid) to service_role;

-- Same signature as 20261105210328; adds only the final-branch delivery gate.
create or replace function public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid, expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text, p_agent_model_name text, p_run_type text DEFAULT 'project'::text, p_expected_review_revision bigint DEFAULT NULL::bigint)
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