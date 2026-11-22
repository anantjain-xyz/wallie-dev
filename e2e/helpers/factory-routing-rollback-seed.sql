begin;
set local request.jwt.claim.role = 'service_role';

-- Fail closed before writing fixtures. This script only runs for the local
-- workspace, its synthetic owner, and the exact canary created through the API.
create temp table rollback_scope as
select workspace.id as workspace_id, canary.factory_id, actor.id as user_id, member.id as member_id,
  canary.id as canary_id, canary.activation_number, canary.baseline_activation_number,
  candidate.canonical_digest as candidate_digest, baseline.canonical_digest as baseline_digest,
  baseline.id as baseline_revision_id, repository.id as repository_id, repository.default_branch,
  (candidate.definition_json::jsonb->>'pipelineId')::uuid as pipeline_id,
  (candidate.definition_json::jsonb#>>'{stages,0,id}')::uuid as stage_id
from public.workspaces workspace
join public.workspace_members member on member.workspace_id = workspace.id
join auth.users actor on actor.id = member.user_id
join public.factory_routing_canaries canary on canary.workspace_id = workspace.id
join public.factories factory on (factory.workspace_id, factory.id) = (canary.workspace_id, canary.factory_id)
join public.factory_definition_revisions candidate on candidate.id = canary.candidate_revision_id
join public.factory_definition_revisions baseline on baseline.id = canary.baseline_revision_id
join public.github_repositories repository on (repository.workspace_id, repository.factory_id, repository.id) =
  (canary.workspace_id, canary.factory_id, (candidate.definition_json::jsonb->>'repositoryId')::uuid)
where (workspace.id, workspace.slug, factory.id, canary.id, actor.id) =
  (:'workspace_id'::uuid, :'workspace_slug', :'factory_id'::uuid, :'canary_id'::uuid, :'owner_id'::uuid)
  and workspace.slug ~ '^analytics-proof-[a-f0-9]{12}$'
  and actor.email = workspace.slug || '-owner@example.test'
  and member.kind = 'human' and member.role = 'owner' and member.is_active
  and factory.slug = 'product-delivery' and factory.is_default
  and canary.task_class_slug = 'delivery' and canary.candidate_bps = 5000
  and canary.activation_number = (
    select max(head.activation_number) from public.factory_definition_activations head
    where (head.workspace_id, head.factory_id) = (workspace.id, factory.id)
  );

create function pg_temp.seed_canary_attempts(p_keep_running boolean)
returns jsonb language plpgsql as $$
declare
  scope rollback_scope;
  admitted record;
  receipt public.session_factory_admission_inputs;
  execution jsonb;
  run_id uuid;
  runtime text;
  sandbox_revision uuid;
  started timestamptz;
  finished timestamptz;
  baseline_count integer := 0;
  candidate_count integer := 0;
begin
  select * into strict scope from rollback_scope;
  sandbox_revision := internal.factory_connected_sandbox_revision(scope.workspace_id, 'vercel');
  if sandbox_revision is null then raise exception 'The fixture sandbox is unavailable.'; end if;

  for sample in 1..64 loop
    select * into strict admitted from public.create_session_command_once(
      scope.workspace_id, scope.member_id, gen_random_uuid(), repeat('a', 64), scope.candidate_digest,
      case when p_keep_running then 'Keep this invoice run during rollback'
        else 'Measure invoice spend ' || sample end,
      'Verify the exact reviewed routing profile.', 'codex', 'gpt-4.1-2025-04-14', '{}'::uuid[],
      session_github_repository_id => scope.repository_id,
      selected_pipeline_id => scope.pipeline_id, selected_stage_ids => array[scope.stage_id],
      target_factory_id => scope.factory_id, draft_specification => false);
    select * into strict receipt from public.session_factory_admission_inputs pinned
    where (pinned.workspace_id, pinned.factory_id, pinned.session_id) =
      (scope.workspace_id, scope.factory_id, admitted.session_id);
    if receipt.routing_canary_id is distinct from scope.canary_id or not receipt.routing_canary_eligible then
      raise exception 'The fixture admission did not receive the exact canary assignment.';
    end if;
    if (receipt.routing_canary_arm = 'baseline' and (p_keep_running or baseline_count = 5))
       or (receipt.routing_canary_arm = 'candidate' and candidate_count = 5) then
      continue;
    end if;

    execution := internal.effective_factory_routing_execution(scope.workspace_id, scope.factory_id, admitted.session_id);
    if execution is null or execution->>'sandboxProvider' is distinct from 'vercel' then
      raise exception 'The fixture must use a reviewed Vercel configuration in both arms.';
    end if;
    runtime := execution#>>'{configuration,workerRuntime}';
    -- Model one worker claim for the scoped session without enabling global dispatch.
    update public.agent_jobs set status = 'running', attempt_count = 1, started_at = clock_timestamp(),
      claimed_worker_runtime = runtime where id = admitted.job_id;
    run_id := internal.start_session_job_attempt_before_release(admitted.job_id, 1, scope.stage_id, 0,
      execution#>>'{configuration,harness}', execution->>'modelName', 'project', 'wallie/rollback-proof');
    if run_id is null then raise exception 'The exact fixture attempt did not start.'; end if;
    perform public.pin_session_job_git_input(admitted.job_id, 1, run_id, scope.repository_id,
      scope.default_branch, repeat('a', 40));
    update public.agent_runs set sandbox_provider = 'vercel', sandbox_connection_revision = sandbox_revision,
      sandbox_id = 'sbx_rollback_proof', sandbox_vercel_team_id = 'team_live', sandbox_vercel_project_id = 'prj_live',
      agent_id = (execution#>>'{implementationAgent,agentId}')::uuid,
      agent_prompt_revision_id = (execution#>>'{implementationAgent,promptRevisionId}')::uuid
    where id = run_id;
    if not public.pin_session_attempt_manifest(admitted.job_id, run_id, 1, repeat('b', 64), 24, 3,
      repeat('a', 40), '[]', runtime, null, coalesce(execution->>'effort', 'xhigh'), scope.member_id) then
      raise exception 'The exact fixture attempt manifest was not retained.';
    end if;
    if p_keep_running then
      return jsonb_build_object('runId', run_id, 'sessionId', admitted.session_id);
    end if;

    -- Seed only observed settlement facts. The real report groups immutable
    -- admissions and attempt manifests and independently computes the alert.
    finished := clock_timestamp();
    started := finished - interval '1 second';
    update public.agent_runs run set status = 'success', started_at = started, finished_at = finished,
      total_cost_usd = case when receipt.routing_canary_arm = 'baseline' then 0.20 else 0.40 end,
      cost_provenance = 'measured', usage_recorded_at = finished, usage_finalized_at = finished
    where run.id = run_id;
    update public.agent_jobs set status = 'success', started_at = started, finished_at = finished
    where id = admitted.job_id;
    update public.sessions set phase_status = 'approved' where id = admitted.session_id;
    if receipt.routing_canary_arm = 'baseline' then
      baseline_count := baseline_count + 1;
    else
      candidate_count := candidate_count + 1;
    end if;
    if baseline_count = 5 and candidate_count = 5 then
      return jsonb_build_object('baselineSessions', baseline_count, 'candidateSessions', candidate_count);
    end if;
  end loop;
  raise exception 'The fixture did not reach both canary samples.';
end;
$$;

insert into public.factory_definition_smoke_tests(workspace_id, factory_id,
  target_kind, target_id, definition_digest, base_activation_number, sandbox_connection_revision,
  created_by, lease_expires_at, finished_at, status, evidence)
select scope.workspace_id, scope.factory_id, 'revision', scope.baseline_revision_id, scope.baseline_digest,
  scope.activation_number, internal.factory_connected_sandbox_revision(scope.workspace_id, 'vercel'),
  scope.user_id, clock_timestamp() + interval '5 minutes', clock_timestamp(), 'passed',
  '{"runtimeProfile":"vercel","stageCount":1,"completedStageCount":1,"cleanupPending":false}'
from rollback_scope scope;

create temp table observed_spend as select pg_temp.seed_canary_attempts(false) as coverage;
create temp table evaluated_alert as select public.process_factory_routing_canary_alerts(8) as result;
create temp table running_attempt as select pg_temp.seed_canary_attempts(true) as proof;

select jsonb_build_object('coverage', observed_spend.coverage, 'evaluation', evaluated_alert.result,
  'active', running_attempt.proof, 'alertId', alert.id)
from rollback_scope scope cross join observed_spend cross join evaluated_alert cross join running_attempt
join public.factory_routing_canary_alerts alert
  on (alert.workspace_id, alert.factory_id, alert.canary_id) = (:'workspace_id'::uuid, :'factory_id'::uuid, :'canary_id'::uuid)
  and alert.metric = 'spend';
commit;
