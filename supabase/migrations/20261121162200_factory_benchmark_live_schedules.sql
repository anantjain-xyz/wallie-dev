create function internal.admit_factory_benchmark_live_trial(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_trial_id uuid, p_task_revision_id uuid,
  p_policy_revision_id uuid, p_policy_digest text, p_candidate_key text, p_sandbox_connection_revision uuid,
  p_inference_connection_revision uuid
) returns public.factory_benchmark_trials
language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  actor_member_id uuid;
  task_revision public.factory_benchmark_task_revisions;
  input public.factory_benchmark_task_inputs;
  source public.sessions;
  source_run public.agent_runs;
  anchor public.pipeline_stages;
  manifest_stage_id uuid;
  candidate public.factory_benchmark_experiment_candidates;
  definition jsonb;
  internal_session_id uuid := gen_random_uuid();
  internal_job_id uuid := gen_random_uuid();
  internal_run_id uuid := gen_random_uuid();
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_trial_id is null or coalesce(p_policy_digest !~ '^[a-f0-9]{64}$', true)
    or coalesce(p_candidate_key !~ '^[a-f0-9]{64}$', true) then
    raise exception 'Provide a trial identity and exact replay configuration pins.' using errcode = '22023';
  end if;
  -- Serialize a client-generated ID even if two different factories race to claim it.
  perform pg_advisory_xact_lock(hashtextextended(p_trial_id::text, 616));
  select * into trial from public.factory_benchmark_trials existing where existing.id = p_trial_id;
  if found then
    if (trial.workspace_id, trial.factory_id, trial.actor_user_id, trial.task_revision_id, trial.policy_revision_id,
        trial.policy_digest, trial.effective_execution_digest, trial.sandbox_connection_revision,
        trial.inference_connection_revision, trial.runner_revision)
      is distinct from (p_workspace_id, p_factory_id, p_actor_user_id, p_task_revision_id, p_policy_revision_id,
        p_policy_digest, p_candidate_key, p_sandbox_connection_revision, p_inference_connection_revision,
        'openai-responses-v1') then
      raise exception 'The trial identity already refers to different immutable inputs.' using errcode = 'PT409';
    end if;
    return trial;
  end if;

  perform public.assert_factory_benchmark_replay_access(p_workspace_id,p_factory_id,p_actor_user_id,p_task_revision_id);
  perform 1 from public.factory_benchmark_replay_policy_revisions policy
  where (policy.workspace_id,policy.factory_id,policy.id,policy.policy_digest,policy.profile) =
    (p_workspace_id,p_factory_id,p_policy_revision_id,p_policy_digest,'blocked')
    and not exists (select 1 from internal.factory_benchmark_replay_revocations revoked
      where revoked.policy_revision_id = policy.id);
  if not found then raise exception 'The blocked replay policy is unavailable.' using errcode = 'PT422'; end if;
  perform 1 from internal.factory_benchmark_inference_connections connection
  join public.workspace_vercel_sandbox_connections sandbox
    on (sandbox.workspace_id,sandbox.connection_revision,sandbox.status) =
      (connection.workspace_id,connection.sandbox_connection_revision,'connected')
  where (connection.workspace_id,connection.factory_id,connection.id,connection.sandbox_connection_revision) =
    (p_workspace_id,p_factory_id,p_inference_connection_revision,p_sandbox_connection_revision)
    and connection.revoked_at is null for share of connection,sandbox;
  if not found then raise exception 'The pinned inference profile is unavailable.' using errcode = 'PT422'; end if;
  select frozen.* into candidate from public.factory_benchmark_experiment_trials cell
  join public.factory_benchmark_experiment_candidates frozen using (workspace_id,factory_id,experiment_id,candidate_key)
  where (cell.workspace_id,cell.factory_id,cell.trial_id,cell.task_revision_id,cell.replay_eligibility,cell.candidate_key) =
    (p_workspace_id,p_factory_id,p_trial_id,p_task_revision_id,'eligible',p_candidate_key)
    and (frozen.worker_runtime,frozen.live_inference_connection_revision) = ('workerd',p_inference_connection_revision);
  if not found then raise exception 'The exact frozen live candidate is unavailable.' using errcode = 'PT422'; end if;
  select revision.definition_json::jsonb into definition from public.factory_definition_revisions revision
  where (revision.workspace_id,revision.factory_id,revision.id,revision.canonical_digest) =
    (p_workspace_id,p_factory_id,candidate.definition_revision_id,candidate.definition_digest);
  if not found then raise exception 'The frozen candidate definition is unavailable.' using errcode = 'PT422'; end if;
  select * into strict task_revision from public.factory_benchmark_task_revisions where id = p_task_revision_id;
  select * into strict input from public.factory_benchmark_task_inputs where task_id = task_revision.task_id;
  select * into strict source from public.sessions where id = input.source_session_id;
  select * into strict source_run from public.agent_runs where id = input.source_run_id;
  if input.checkout_sha is null then
    raise exception 'The trial requires an exact source checkout.' using errcode = 'PT422';
  end if;
  select manifest.stage_id into manifest_stage_id from public.session_attempt_manifests manifest
  where (manifest.workspace_id, manifest.session_id, manifest.run_id, manifest.job_id, manifest.attempt_count) =
    (input.workspace_id, input.source_session_id, input.source_run_id, input.source_job_id, input.source_attempt_count);
  if manifest_stage_id is not null and source_run.stage_id is not null
    and manifest_stage_id <> source_run.stage_id then
    raise exception 'The original trial stage does not match its attempt provenance.' using errcode = 'PT422';
  end if;
  select stage.* into anchor from public.pipeline_stages stage
  where (stage.workspace_id, stage.pipeline_id) = (source.workspace_id, source.pipeline_id)
    and stage.id = coalesce(manifest_stage_id, source_run.stage_id);
  if not found or definition->>'pipelineId' is distinct from source.pipeline_id::text
    or definition->>'repositoryId' is distinct from input.repository_id::text
    or not exists (select 1 from jsonb_array_elements(definition->'stages') stage where stage->>'id' = anchor.id::text)
    or exists (select 1 from jsonb_array_elements_text(coalesce(definition->'skillIds','[]'::jsonb)) selected_skill(id)
      where not exists (select 1 from public.factory_skill_revisions skill
        where (skill.workspace_id,skill.factory_id,skill.id::text) = (p_workspace_id,p_factory_id,selected_skill.id)
          and skill.revoked_at is null))
  then raise exception 'The candidate cannot replay the exact captured stage and repository.' using errcode = 'PT422'; end if;

  insert into public.sessions (
    id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id,
    phase_status, execution_purpose, factory_definition_provenance, factory_definition_revision_id,
    execution_policy_revision_id
  ) values (
    internal_session_id, p_workspace_id, p_factory_id, nextval('internal.factory_benchmark_session_number'),
    'Benchmark trial', actor_member_id, source.pipeline_id, anchor.id, 'in_progress', 'benchmark',
    'pinned', candidate.definition_revision_id, (definition->>'executionPolicyRevisionId')::uuid
  );
  insert into public.agent_jobs (
    id, workspace_id, session_id, requested_by_member_id, stage_id, stage_slug, stage_name, trigger_type
  ) values (
    internal_job_id, p_workspace_id, internal_session_id, actor_member_id, anchor.id, anchor.slug, anchor.name, 'manual_run'
  );
  insert into public.agent_runs (
    id, workspace_id, session_id, agent_job_id, triggered_by_member_id, stage_id, stage_slug, stage_name,
    run_type, model_provider, model_name
  ) values (
    internal_run_id, p_workspace_id, internal_session_id, internal_job_id, actor_member_id, anchor.id, anchor.slug, anchor.name,
    'project', 'benchmark', 'openai-responses-v1'
  );
  insert into public.factory_benchmark_trials (
    id, workspace_id, factory_id, actor_user_id, task_id, task_revision_id, policy_revision_id, policy_digest,
    sandbox_connection_revision, session_id, job_id, run_id, runner_revision, inference_connection_revision,
    effective_execution_digest
  ) values (
    p_trial_id, p_workspace_id, p_factory_id, p_actor_user_id, task_revision.task_id, p_task_revision_id,
    p_policy_revision_id, p_policy_digest, p_sandbox_connection_revision,
    internal_session_id, internal_job_id, internal_run_id, 'openai-responses-v1', p_inference_connection_revision,
    p_candidate_key
  ) returning * into trial;
  return trial;
end;
$$;

revoke all on function internal.admit_factory_benchmark_live_trial(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid,uuid)
  from public, anon, authenticated, service_role;

create function public.configure_factory_benchmark_live_schedule(
  p_workspace_id uuid,p_factory_id uuid,p_experiment_id uuid,p_actor_user_id uuid,
  p_inference_connection_revision uuid,
  p_execution_reserve_usd numeric,p_evaluation_reserve_usd numeric,p_budget_limit_usd numeric,
  p_factory_concurrency_limit integer,p_max_admitted_trials integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  schedule public.factory_benchmark_schedules;
  sandbox_revision uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id,p_factory_id);
  if not coalesce(p_budget_limit_usd between 0 and 1000000 and p_budget_limit_usd = round(p_budget_limit_usd,6),false)
    or not coalesce(p_execution_reserve_usd > 0 and p_execution_reserve_usd <= p_budget_limit_usd
      and p_execution_reserve_usd = round(p_execution_reserve_usd,6),false)
    or not coalesce(p_evaluation_reserve_usd between 0 and 1000000
      and p_evaluation_reserve_usd = round(p_evaluation_reserve_usd,6),false)
    or not coalesce(p_factory_concurrency_limit between 1 and 100,false)
    or not coalesce(p_max_admitted_trials between 1 and 10000,false)
  then raise exception 'Provide a valid live schedule with a positive per-trial reserve.' using errcode = '22023'; end if;
  select * into schedule from public.factory_benchmark_schedules existing
  where (existing.workspace_id,existing.factory_id,existing.experiment_id) =
    (p_workspace_id,p_factory_id,p_experiment_id) for update;
  if found then
    if (schedule.runner_revision,schedule.inference_connection_revision,schedule.execution_reserve_usd,
      schedule.evaluation_reserve_usd,schedule.budget_limit_usd,schedule.factory_concurrency_limit,schedule.max_admitted_trials)
      is distinct from ('openai-responses-v1',p_inference_connection_revision,p_execution_reserve_usd,
        p_evaluation_reserve_usd,p_budget_limit_usd,p_factory_concurrency_limit,p_max_admitted_trials)
    then raise exception 'The experiment already has a different schedule.' using errcode = 'PT409'; end if;
    return internal.factory_benchmark_schedule_snapshot(schedule);
  end if;
  select connection.sandbox_connection_revision into sandbox_revision
  from internal.factory_benchmark_inference_connections connection
  join public.workspace_vercel_sandbox_connections sandbox
    on (sandbox.workspace_id,sandbox.connection_revision,sandbox.status) =
      (connection.workspace_id,connection.sandbox_connection_revision,'connected')
  where (connection.workspace_id,connection.factory_id,connection.id) =
    (p_workspace_id,p_factory_id,p_inference_connection_revision) and connection.revoked_at is null;
  if not found then raise exception 'The pinned inference connection is unavailable.' using errcode = 'PT422'; end if;
  perform 1 from public.factory_benchmark_experiments experiment
  join public.factory_benchmark_replay_policy_revisions policy
    on (policy.workspace_id,policy.factory_id,policy.id,policy.policy_digest) =
      (experiment.workspace_id,experiment.factory_id,experiment.policy_revision_id,experiment.policy_digest)
  where (experiment.workspace_id,experiment.factory_id,experiment.id) = (p_workspace_id,p_factory_id,p_experiment_id)
    and policy.profile = 'blocked' and experiment.eligible_trial_count > 0
    and not exists (select 1 from internal.factory_benchmark_replay_revocations revoked
      where revoked.policy_revision_id = policy.id);
  if not found then raise exception 'A frozen eligible matrix and blocked replay policy are required.' using errcode = 'PT422'; end if;
  if exists (select 1 from public.factory_benchmark_experiment_candidates candidate
    where (candidate.workspace_id,candidate.factory_id,candidate.experiment_id) = (p_workspace_id,p_factory_id,p_experiment_id)
      and (candidate.worker_runtime,candidate.live_inference_connection_revision,candidate.sandbox_connection_revision)
        is distinct from ('workerd',p_inference_connection_revision,sandbox_revision))
  then raise exception 'Every candidate must pin this live runner and connection.' using errcode = 'PT422'; end if;
  insert into public.factory_benchmark_schedules (
    workspace_id,factory_id,experiment_id,actor_user_id,runner_revision,sandbox_connection_revision,
    task_fixtures,execution_reserve_usd,evaluation_reserve_usd,budget_limit_usd,factory_concurrency_limit,
    max_admitted_trials,inference_connection_revision
  ) values (
    p_workspace_id,p_factory_id,p_experiment_id,p_actor_user_id,'openai-responses-v1',sandbox_revision,
    '{}'::jsonb,p_execution_reserve_usd,p_evaluation_reserve_usd,p_budget_limit_usd,p_factory_concurrency_limit,
    p_max_admitted_trials,p_inference_connection_revision
  ) returning * into schedule;
  return internal.factory_benchmark_schedule_snapshot(schedule);
end;
$$;
revoke all on function public.configure_factory_benchmark_live_schedule(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.configure_factory_benchmark_live_schedule(uuid,uuid,uuid,uuid,uuid,numeric,numeric,numeric,integer,integer)
  to service_role;

create or replace function public.reconcile_factory_benchmark_schedules(p_limit integer)
returns integer language plpgsql security definer set search_path = '' set lock_timeout = '100ms' as $$
declare
  schedule public.factory_benchmark_schedules;
  scoped record;
  cell record;
  execution public.factory_benchmark_trials;
  snapshot jsonb;
  issue text;
  admitted integer := 0;
begin
  perform internal.assert_checkpoint_publication_service();
  if not coalesce(p_limit between 1 and 100, false) then
    raise exception 'Invalid benchmark scheduling batch size.' using errcode = '22023';
  end if;
  -- Node and workerd use the same bounded maintenance pass. Sorting by last
  -- attempt lets a blocked or budget-exhausted schedule yield to other factories.
  if not pg_try_advisory_xact_lock(hashtextextended('wallie/benchmark-schedule-reconcile/v1', 0)) then return 0; end if;
  for scoped in
    select control.workspace_id, control.factory_id, control.experiment_id, control.actor_user_id,
      frozen.policy_revision_id, frozen.policy_digest, frozen.eligible_trial_count
    from public.factory_benchmark_schedules control
    join public.factory_benchmark_experiments frozen on (frozen.workspace_id, frozen.factory_id, frozen.id) =
      (control.workspace_id, control.factory_id, control.experiment_id)
    where (
      control.state = 'active' and frozen.eligible_trial_count > 0 and (select count(*)
        from public.factory_benchmark_schedule_trials scheduled where
        (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
        (control.workspace_id, control.factory_id, control.experiment_id)) <
        least(control.max_admitted_trials, frozen.eligible_trial_count)
    ) or exists (
      select 1 from public.factory_benchmark_schedule_trials scheduled
      where (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
        (control.workspace_id, control.factory_id, control.experiment_id)
        and (scheduled.accounted_at is null or exists (select 1 from public.factory_benchmark_schedule_evaluations scoring
          where scoring.trial_id = scheduled.trial_id and scoring.accounted_at is null))
    )
    order by control.last_reconciled_at asc nulls first, control.created_at, control.experiment_id
    limit p_limit
  loop
    begin
      -- Lock factory authority before the schedule, matching configure and control.
      issue := null;
      begin
        perform internal.assert_factory_manager(scoped.workspace_id, scoped.factory_id, scoped.actor_user_id);
      exception when insufficient_privilege or no_data_found then
        issue := 'pinned-input-unavailable';
      end;
      select * into schedule from public.factory_benchmark_schedules control
      where (control.workspace_id, control.factory_id, control.experiment_id) =
        (scoped.workspace_id, scoped.factory_id, scoped.experiment_id) for update;
      if not found then continue; end if;

      perform internal.refresh_factory_benchmark_schedule_costs(schedule);
      snapshot := internal.factory_benchmark_schedule_snapshot(schedule);
      if schedule.state = 'active' and issue is null and schedule.actor_user_id = scoped.actor_user_id
        and (snapshot->>'admittedTrialCount')::integer < least(schedule.max_admitted_trials, scoped.eligible_trial_count)
        and (snapshot->>'queuedTrialCount')::integer + (snapshot->>'runningTrialCount')::integer < schedule.factory_concurrency_limit
        and schedule.execution_reserve_usd <= internal.factory_benchmark_schedule_available_usd(snapshot)
      then
        select frozen.trial_id, frozen.task_revision_id, frozen.candidate_key into strict cell
        from public.factory_benchmark_experiment_trials frozen
        where (frozen.workspace_id, frozen.factory_id, frozen.experiment_id) =
          (scoped.workspace_id, scoped.factory_id, scoped.experiment_id)
          and frozen.replay_eligibility = 'eligible'
          and not exists (select 1 from public.factory_benchmark_schedule_trials known where known.trial_id = frozen.trial_id)
        order by frozen.repetition, frozen.candidate_key, frozen.task_revision_id
        limit 1;

        begin
          perform pg_advisory_xact_lock(hashtextextended(cell.trial_id::text, 616));
          if exists (select 1 from public.factory_benchmark_trials existing where existing.id = cell.trial_id) then
            raise exception 'Frozen trial identity is already in use.' using errcode = '23505';
          end if;
          if schedule.runner_revision = 'openai-responses-v1' then
            execution := internal.admit_factory_benchmark_live_trial(scoped.workspace_id,scoped.factory_id,schedule.actor_user_id,
              cell.trial_id,cell.task_revision_id,scoped.policy_revision_id,scoped.policy_digest,cell.candidate_key,
              schedule.sandbox_connection_revision,schedule.inference_connection_revision);
          else
            execution := internal.admit_factory_benchmark_trial(scoped.workspace_id, scoped.factory_id, schedule.actor_user_id,
              cell.trial_id, cell.task_revision_id, scoped.policy_revision_id, scoped.policy_digest,
              schedule.task_fixtures->>cell.task_revision_id::text, schedule.sandbox_connection_revision);
          end if;
          insert into public.factory_benchmark_schedule_trials(trial_id, workspace_id, factory_id, experiment_id, run_id, reserve_usd)
          values (cell.trial_id, scoped.workspace_id, scoped.factory_id, scoped.experiment_id, execution.run_id, schedule.execution_reserve_usd);
          admitted := admitted + 1;
        exception
          when insufficient_privilege or no_data_found or sqlstate 'PT422' or sqlstate 'PT409' or sqlstate 'P0011' then
            issue := 'pinned-input-unavailable';
          when unique_violation then issue := 'trial-identity-conflict';
        end;
      end if;
      update public.factory_benchmark_schedules control
      set last_reconciled_at = clock_timestamp(), admission_issue = case when schedule.state = 'active' then issue end
      where (control.workspace_id, control.factory_id, control.experiment_id) =
        (scoped.workspace_id, scoped.factory_id, scoped.experiment_id);
    exception when lock_not_available then
      -- Yield contended scopes without rolling back progress in other factories.
      continue;
    end;
  end loop;
  return admitted;
end;
$$;
