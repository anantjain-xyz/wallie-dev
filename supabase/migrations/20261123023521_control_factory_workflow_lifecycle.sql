alter table internal.factory_workflow_executions
  add column lifecycle_status text not null default 'running'
    check (lifecycle_status in ('running', 'paused', 'canceled'));

create table internal.factory_workflow_lifecycle_commands (
  root_session_id uuid not null references internal.factory_workflow_executions(root_session_id) on delete cascade,
  request_id uuid not null,
  expected_generation bigint not null,
  action text not null check (action in ('pause', 'resume', 'cancel')),
  applied_generation bigint not null check (applied_generation = expected_generation + 1),
  receipt jsonb not null check (jsonb_typeof(receipt) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, request_id),
  unique (root_session_id, applied_generation)
);
alter table internal.factory_workflow_lifecycle_commands enable row level security;
revoke all on table internal.factory_workflow_lifecycle_commands from public, anon, authenticated, service_role;

create function internal.find_factory_workflow_lifecycle_root(p_session_id uuid)
returns uuid language sql stable set search_path = '' as $$
  select execution.root_session_id
  from internal.factory_workflow_executions execution
  where execution.root_session_id = coalesce((
    select marker.root_session_id from internal.factory_workflow_delegations marker
    where marker.child_session_id = p_session_id
  ), p_session_id) and execution.graph_revision_id is not null
$$;
revoke all on function internal.find_factory_workflow_lifecycle_root(uuid)
  from public, anon, authenticated, service_role;

-- The session lock serializes direct enqueue and stage-approval paths with
-- fanout. The controller changes state before its own authorized resume inserts.
create function internal.guard_factory_workflow_job_lifecycle()
returns trigger language plpgsql security definer set search_path = '' as $$
declare workflow_root_id uuid;
begin
  workflow_root_id := internal.find_factory_workflow_lifecycle_root(new.session_id);
  if workflow_root_id is null then return new; end if;
  perform 1 from public.sessions session where (session.id, session.workspace_id) = (new.session_id, new.workspace_id)
  for no key update;
  if exists (select 1 from internal.factory_workflow_executions execution
    where (execution.root_session_id, execution.workspace_id) = (workflow_root_id, new.workspace_id)
      and execution.lifecycle_status <> 'running') then
    raise exception 'Workflow execution is paused or canceled.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_factory_workflow_job_lifecycle() from public, anon, authenticated, service_role;
create trigger guard_factory_workflow_job_lifecycle before insert on public.agent_jobs
  for each row execute function internal.guard_factory_workflow_job_lifecycle();

-- Explicit service control is scoped and generation-bound. It need not know a
-- dead worker's capability. No capability is returned from the command receipt.
create function public.control_factory_workflow_lifecycle(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid,
  p_expected_generation bigint, p_request_id uuid, p_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  prior internal.factory_workflow_lifecycle_commands;
  owner public.sessions;
  parent_id uuid;
  member_ids uuid[];
  prior_state text;
  next_state text;
  pause_receipt jsonb;
  retired jsonb := '[]'::jsonb;
  resumed jsonb := '[]'::jsonb;
  retirement record;
  restart record;
  resume_input jsonb;
  receipt jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_request_id is null or coalesce(p_action, '') not in ('pause', 'resume', 'cancel')
    or p_expected_generation is null or p_expected_generation not between 1 and 9007199254740990 then
    raise exception 'Invalid workflow lifecycle command.' using errcode = '22023';
  end if;

  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select workflow.* into execution from internal.factory_workflow_executions workflow
  where (workflow.root_session_id, workflow.workspace_id, workflow.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id) and workflow.graph_revision_id is not null
  for no key update;
  if not found then raise exception 'Workflow graph is unavailable.' using errcode = 'PT404'; end if;
  select command.* into prior from internal.factory_workflow_lifecycle_commands command
  where (command.root_session_id, command.request_id) = (p_root_session_id, p_request_id);
  if found then
    if (prior.expected_generation, prior.action) is distinct from (p_expected_generation, p_action) then
      raise exception 'The workflow request was already used with different intent.' using errcode = 'PT409';
    end if;
    return prior.receipt;
  end if;
  if execution.generation is distinct from p_expected_generation then
    raise exception 'Workflow generation is stale.' using errcode = 'PT409';
  end if;
  prior_state := execution.lifecycle_status;
  if prior_state = 'canceled' or (p_action = 'pause' and prior_state <> 'running')
    or (p_action = 'resume' and prior_state <> 'paused') then
    raise exception 'The workflow lifecycle transition is unavailable.' using errcode = 'PT409';
  end if;
  next_state := case p_action when 'pause' then 'paused' when 'resume' then 'running' else 'canceled' end;

  select array_prepend(p_root_session_id, coalesce(array_agg(marker.child_session_id order by marker.child_session_id), '{}'::uuid[]))
  into member_ids from internal.factory_workflow_delegations marker
  where (marker.root_session_id, marker.workspace_id, marker.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id);
  perform 1 from public.sessions session
  where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id) and session.id = any(member_ids)
  order by session.id <> p_root_session_id, session.id for no key update;

  if p_action = 'resume' then
    select root.* into owner from public.sessions root
    join public.session_factory_admission_inputs pin
      on (pin.session_id, pin.workspace_id, pin.factory_id, pin.definition_revision_id) =
        (root.id, root.workspace_id, root.factory_id, root.factory_definition_revision_id)
    where (root.id, root.workspace_id, root.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id)
      and (pin.definition_revision_id, pin.definition_digest) =
        (execution.definition_revision_id, execution.definition_digest)
      and root.execute_pinned_definition and (root.archived_at is null or root.phase_status = 'approved')
      and root.execution_policy_revision_id is not distinct from pin.execution_policy_revision_id;
    if not found then
      raise exception 'The workflow root cannot resume its pinned execution.' using errcode = 'PT409';
    end if;
    perform internal.recheck_session_execution_grant(owner);
    if not internal.session_execution_admissible(owner.id, owner.workspace_id) then
      raise exception 'The workflow root execution budget is exhausted.' using errcode = 'PT409';
    end if;

    select command.receipt into strict pause_receipt from internal.factory_workflow_lifecycle_commands command
    where (command.root_session_id, command.applied_generation, command.action) =
      (p_root_session_id, p_expected_generation, 'pause');
  end if;

  update internal.factory_workflow_executions workflow
  set lifecycle_status = next_state, generation = workflow.generation + 1, ownership_token = gen_random_uuid()
  where workflow.root_session_id = p_root_session_id returning * into execution;

  if p_action = 'resume' then
    for resume_input in select value from jsonb_array_elements(pause_receipt->'retired')
      where value->'restartRequired' = 'true'::jsonb
    loop
      select session.* into owner from public.sessions session
      where (session.id::text, session.workspace_id, session.factory_id, session.current_stage_id::text,
        session.current_artifact_version) = (resume_input->>'sessionId', p_workspace_id, p_factory_id,
        resume_input->>'stageId', (resume_input->>'artifactVersion')::integer)
        and session.id = any(member_ids) and session.archived_at is null
        and session.current_artifact_id::text is not distinct from resume_input->>'artifactId'
        and session.phase_status in ('in_progress', 'rejected');
      if not found or not internal.session_execution_admissible(owner.id, owner.workspace_id) then continue; end if;

      if owner.id <> p_root_session_id then
        select marker.parent_session_id into parent_id from internal.factory_workflow_delegations marker
        where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.child_session_id) =
          (p_root_session_id, p_workspace_id, p_factory_id, owner.id);
        if not found or not internal.recheck_factory_workflow_delegation_lineage(
          p_root_session_id, p_workspace_id, p_factory_id, parent_id
        ) then continue; end if;
      end if;
      perform internal.recheck_session_execution_grant(owner);

      select * into strict restart from public.enqueue_session_job_with_run(owner.id, owner.workspace_id,
        owner.current_stage_id, p_run_type => case when owner.github_repository_id is null then 'project' else 'code' end);
      if restart.created then
        if execution.workflow_json::jsonb ? 'delegationPolicy'
          and not internal.reserve_factory_workflow_attempt(execution, owner.id, restart.job_id, 1) then
          raise exception 'The workflow budget cannot restart the paused attempt.' using errcode = 'PT409';
        end if;
        resumed := resumed || jsonb_build_array(jsonb_build_object(
          'sessionId', owner.id, 'jobId', restart.job_id, 'runId', restart.run_id));
      end if;
    end loop;
  else
    for owner in select session.* from public.sessions session
      where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
        and session.id = any(member_ids)
        and exists (select 1 from public.agent_jobs job
          where (job.session_id, job.workspace_id) = (session.id, session.workspace_id)
            and (job.status in ('started', 'running') or (p_action = 'cancel' and job.status = 'queued')))
      order by session.id <> p_root_session_id, session.id
    loop
      select * into strict retirement from public.cancel_session_job_attempts(owner.id, owner.workspace_id,
        case p_action when 'pause' then 'Workflow paused.' else 'Workflow canceled.' end,
        null, p_action = 'cancel');
      if cardinality(retirement.job_ids) > 0 then
        retired := retired || jsonb_build_array(jsonb_build_object(
          'sessionId', owner.id, 'jobIds', retirement.job_ids, 'runIds', retirement.run_ids,
          'jobs', (select jsonb_agg(jsonb_build_object('jobId', job.id, 'attemptCount', job.attempt_count) order by job.id)
            from public.agent_jobs job where job.id = any(retirement.job_ids)),
          'stageId', owner.current_stage_id, 'artifactId', owner.current_artifact_id,
          'artifactVersion', owner.current_artifact_version,
          'restartRequired', p_action = 'pause' and owner.phase_status in ('in_progress', 'rejected')
        ));
      end if;
    end loop;
  end if;

  receipt := jsonb_build_object('requestId', p_request_id, 'action', p_action,
    'generation', execution.generation, 'lifecycleStatus', execution.lifecycle_status, 'retired', retired, 'resumed', resumed);
  insert into internal.factory_workflow_lifecycle_commands(root_session_id, request_id, expected_generation, action, applied_generation, receipt)
  values (p_root_session_id, p_request_id, p_expected_generation, p_action, execution.generation, receipt);
  return receipt;
end;
$$;
revoke all on function public.control_factory_workflow_lifecycle(uuid, uuid, uuid, bigint, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.control_factory_workflow_lifecycle(uuid, uuid, uuid, bigint, uuid, text) to service_role;
create or replace function internal.lock_factory_workflow_generation(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint
) returns internal.factory_workflow_executions
language plpgsql set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
begin
  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select workflow.* into execution
    from internal.factory_workflow_executions workflow
   where workflow.root_session_id = p_root_session_id
   for no key update;
  if not found then
    raise exception 'Workflow execution is unavailable.' using errcode = 'PT404';
  end if;
  if execution.generation is distinct from p_expected_generation then
    raise exception 'Workflow generation is stale.' using errcode = 'PT409';
  end if;
  if execution.lifecycle_status <> 'running' then
    raise exception 'Workflow execution is paused or canceled.' using errcode = 'PT409';
  end if;
  return execution;
end;
$$;

create or replace function public.acquire_factory_workflow_ownership(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_candidate_ownership_token uuid
) returns table (execution_generation bigint, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare execution internal.factory_workflow_executions;
begin
  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  if p_candidate_ownership_token is null or p_expected_generation is null
    or p_expected_generation not between 1 and 9007199254740990 then return; end if;

  select workflow.* into execution from internal.factory_workflow_executions workflow
  where workflow.root_session_id = p_root_session_id for no key update;
  if not found or execution.lifecycle_status <> 'running' then return; end if;

  if execution.generation = p_expected_generation + 1 and execution.ownership_token = p_candidate_ownership_token then
    return query select execution.generation, execution.ownership_token;
  elsif execution.generation = p_expected_generation and execution.ownership_token <> p_candidate_ownership_token then
    return query
      update internal.factory_workflow_executions workflow
      set generation = workflow.generation + 1, ownership_token = p_candidate_ownership_token
      where workflow.root_session_id = p_root_session_id
      returning workflow.generation, workflow.ownership_token;
  end if;
end;
$$;

create or replace function public.read_factory_workflow_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'execution', jsonb_build_object(
      'root_session_id', execution.root_session_id,
      'workspace_id', execution.workspace_id,
      'factory_id', execution.factory_id,
      'definition_revision_id', execution.definition_revision_id,
      'definition_digest', execution.definition_digest,
      'workflow_json', execution.workflow_json,
      'workflow_digest', execution.workflow_digest,
      'generation', execution.generation,
      'created_at', execution.created_at
    ) || case when execution.graph_revision_id is null then '{}'::jsonb
      else jsonb_strip_nulls(jsonb_build_object(
        'graph_visit_limit_exhausted', visits.exhausted,
        'lifecycle_status', execution.lifecycle_status,
        'graph_route_blocker', case
          when root.archived_at is not null and root.phase_status <> 'approved' then 'root_unavailable'
          when root.execution_policy_revision_id is null then 'execution_policy_required'
          when root.execution_exhaustion_code is not null then 'execution_budget_exhausted'
        end
      )) || jsonb_build_object('graph_revision_id', execution.graph_revision_id,
        'graph_input_run_id', execution.graph_input_run_id) end,
    'occurrences', coalesce((
      select jsonb_agg(to_jsonb(occurrence) order by occurrence.admitted_at, occurrence.occurrence_id)
        from internal.factory_workflow_node_occurrences occurrence where occurrence.root_session_id = execution.root_session_id
    ), '[]'::jsonb),
    'results', coalesce((
      select jsonb_agg(to_jsonb(result) order by result.recorded_at, result.result_id)
        from internal.factory_workflow_node_results result where result.root_session_id = execution.root_session_id
    ), '[]'::jsonb),
    'transitions', coalesce((
      select jsonb_agg(to_jsonb(transition) order by transition.recorded_at, transition.transition_id)
        from internal.factory_workflow_transition_receipts transition where transition.root_session_id = execution.root_session_id
    ), '[]'::jsonb),
    'runnableTransitions', coalesce((
      select jsonb_agg(jsonb_build_object('sourceOccurrenceId', occurrence.occurrence_id, 'sourceResultId', result.result_id, 'edgeId', edge->>'id')
        order by occurrence.admitted_at, occurrence.occurrence_id, edge->>'id')
        from internal.factory_workflow_node_occurrences occurrence
        join internal.factory_workflow_node_results result
          on (result.root_session_id, result.occurrence_id) = (occurrence.root_session_id, occurrence.occurrence_id)
        cross join lateral jsonb_array_elements(execution.workflow_json::jsonb->'edges') edge
       where occurrence.root_session_id = execution.root_session_id and result.outcome = 'succeeded'
         and workspace.deletion_requested_at is null and factory.status = 'active'
         and execution.lifecycle_status = 'running'
         and (execution.graph_revision_id is null or (
           root.execution_exhaustion_code is null and (root.archived_at is null or root.phase_status = 'approved')
         ))
         and visits.exhausted is not true
         and edge->>'kind' = 'next' and edge->>'from' = occurrence.node_id
         and not exists (
           select 1 from internal.factory_workflow_transition_receipts transition
            where (transition.root_session_id, transition.source_occurrence_id, transition.edge_id) =
              (occurrence.root_session_id, occurrence.occurrence_id, edge->>'id')
         )
    ), '[]'::jsonb)
  )
  from internal.factory_workflow_executions execution
  join public.sessions root on (root.id, root.workspace_id, root.factory_id) =
    (execution.root_session_id, execution.workspace_id, execution.factory_id)
  join public.workspaces workspace on workspace.id = execution.workspace_id
  join public.factories factory on (factory.workspace_id, factory.id) = (execution.workspace_id, execution.factory_id)
  cross join lateral (
    select case when execution.graph_revision_id is not null and execution.workflow_json::jsonb ? 'routePolicy'
      and exists (select 1 from jsonb_array_elements(execution.workflow_json::jsonb->'nodes') node
        where node->>'kind' = 'route') then
      (select count(*) from internal.factory_workflow_node_occurrences visit where visit.root_session_id = execution.root_session_id)
        >= (execution.workflow_json::jsonb#>>'{routePolicy,maxNodeVisits}')::integer
    end as exhausted
  ) visits
  where (execution.root_session_id, execution.workspace_id, execution.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id);
$$;

create or replace function public.claim_next_agent_job(
  accept_benchmark_trials boolean,
  default_concurrency_limit int,
  p_worker_runtime text
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.agent_jobs%rowtype;
  configured_limit int;
  factory_limit int;
  scheduled_trial public.factory_benchmark_schedule_trials;
  effective_limit int;
  running_count int;
  selected_provider text;
  release_state internal.git_continuity_release_control%rowtype;
  pipeline_job boolean;
  session_owner public.sessions;
  definition jsonb;
  workflow_root_id uuid;
  budget_root_id uuid;
  budget_execution internal.factory_workflow_executions;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_worker_runtime not in ('node','workerd') or p_worker_runtime is null then
    raise exception 'A supported worker runtime is required.' using errcode = '22023';
  end if;
  select * into strict release_state from internal.git_continuity_release_control where singleton for share;
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();

  for candidate in
    select ready.* from public.agent_jobs ready
    join public.sessions owner on (owner.workspace_id, owner.id) = (ready.workspace_id, ready.session_id)
    where ready.status = 'queued' and (ready.scheduled_at is null or ready.scheduled_at <= now())
      and (
        (owner.execution_purpose = 'production'
          and (not owner.execute_pinned_definition or coalesce(internal.effective_factory_routing_execution(
            owner.workspace_id, owner.factory_id, owner.id)#>>'{configuration,workerRuntime}', p_worker_runtime) = p_worker_runtime)
          and (owner.pipeline_id is null or (release_state.enabled
          and exists (select 1 from public.session_git_continuity_enrollments enrolled
            where (enrolled.workspace_id, enrolled.session_id) = (owner.workspace_id, owner.id)))))
        or (accept_benchmark_trials is true and owner.execution_purpose = 'benchmark'
          and ready.attempt_count = 0 and exists (select 1 from public.factory_benchmark_trials trial
            where (trial.workspace_id, trial.session_id, trial.job_id, trial.status) =
              (owner.workspace_id, owner.id, ready.id, 'queued')
              and (trial.runner_revision = 'recorded-fixture-v1' or
                (trial.runner_revision = 'openai-responses-v1' and p_worker_runtime = 'workerd'))))
      )
    order by (owner.execution_purpose = 'benchmark'), ready.created_at, ready.id
  loop
    perform 1 from public.workspaces where id=candidate.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    select * into session_owner from public.sessions
      where (workspace_id, id) = (candidate.workspace_id, candidate.session_id);
    if not found then continue; end if;
    pipeline_job := session_owner.execution_purpose = 'production' and session_owner.pipeline_id is not null;

    -- A pause or cancel owns the schedule before changing any job. Standalone
    -- fixture trials, which have no experiment reservation, keep their old path.
    if session_owner.execution_purpose = 'benchmark' then
      select scheduled.* into scheduled_trial from public.factory_benchmark_schedule_trials scheduled
      join public.factory_benchmark_trials trial on trial.id = scheduled.trial_id
      where trial.job_id = candidate.id;
      if found then
        perform 1 from public.factory_benchmark_schedules schedule
        where (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
          (scheduled_trial.workspace_id, scheduled_trial.factory_id, scheduled_trial.experiment_id)
          and schedule.state = 'active' for share skip locked;
        if not found then continue; end if;
      end if;
    end if;

    workflow_root_id := internal.find_factory_workflow_lifecycle_root(session_owner.id);
    budget_root_id := null;
    if workflow_root_id is not null then
      perform 1 from public.factories factory
      where (factory.workspace_id, factory.id, factory.status) =
        (candidate.workspace_id, session_owner.factory_id, 'active')
      for share skip locked;
      if not found then continue; end if;
      perform 1 from public.sessions root
      where (root.id, root.workspace_id, root.factory_id) =
        (workflow_root_id, candidate.workspace_id, session_owner.factory_id)
        and (root.archived_at is null or root.phase_status = 'approved')
        and (root.id = candidate.session_id or root.phase_status <> 'rejected')
      for no key update skip locked;
      if not found then continue; end if;
      select workflow.* into budget_execution from internal.factory_workflow_executions workflow
      where workflow.root_session_id = workflow_root_id for no key update skip locked;
      if not found or budget_execution.lifecycle_status <> 'running' then continue; end if;
      if budget_execution.workflow_json::jsonb ? 'delegationPolicy' then budget_root_id := workflow_root_id; end if;
    end if;

    select * into candidate from public.agent_jobs where id = candidate.id and status = 'queued'
      and (scheduled_at is null or scheduled_at <= now()) for update skip locked;
    if not found then continue; end if;
    if not pg_try_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0)) then continue; end if;

    definition := internal.pinned_session_execution_definition(session_owner);
    if definition is not null then
      selected_provider := definition->>'sandboxProvider';
      configured_limit := (definition #>> '{agent,concurrencyLimit}')::integer;
    else
      select active_provider into selected_provider
      from public.workspace_sandbox_settings where workspace_id = candidate.workspace_id;
      selected_provider := coalesce(selected_provider, 'vercel');

      select value_json::integer into configured_limit
      from public.workspace_agent_config
      where workspace_id = candidate.workspace_id
        and key = 'concurrency_limit'
        and jsonb_typeof(value_json) = 'number';
    end if;

    if session_owner.execution_purpose = 'benchmark' then selected_provider := 'vercel'; end if;
    if exists (
      select 1 from public.workspace_sandbox_connection_mutations
      where workspace_id = candidate.workspace_id
        and provider = selected_provider
        and expires_at > now()
    ) then continue; end if;

    effective_limit := coalesce(configured_limit, default_concurrency_limit);
    select count(*) into running_count from public.agent_jobs
    where workspace_id = candidate.workspace_id and status in ('started', 'running');
    if running_count >= effective_limit then continue; end if;
    if session_owner.execution_purpose = 'benchmark' then
      if effective_limit > 1 and running_count >= effective_limit - 1 then continue; end if;

      -- A pinned production job can have a smaller limit than today's
      -- workspace default. Drain existing benchmark claims for that workspace.
      if exists (
        select 1 from public.agent_jobs waiting
        join public.sessions owner on (owner.workspace_id, owner.id) = (waiting.workspace_id, waiting.session_id)
        where waiting.workspace_id = candidate.workspace_id and waiting.status = 'queued'
          and (waiting.scheduled_at is null or waiting.scheduled_at <= now())
          and owner.execution_purpose = 'production'
          and (owner.pipeline_id is null or (release_state.enabled
            and exists (select 1 from public.session_git_continuity_enrollments enrolled
              where (enrolled.workspace_id, enrolled.session_id) = (owner.workspace_id, owner.id))))
      ) then continue; end if;

      select min(schedule.factory_concurrency_limit) into factory_limit
      from public.factory_benchmark_schedules schedule
      where (schedule.workspace_id, schedule.factory_id) = (candidate.workspace_id, session_owner.factory_id)
        and schedule.state = 'active'
        and exists (
          select 1 from public.factory_benchmark_schedule_trials scheduled
          join public.factory_benchmark_trials outstanding
            on (outstanding.id, outstanding.run_id) = (scheduled.trial_id, scheduled.run_id)
          where (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
            (schedule.workspace_id, schedule.factory_id, schedule.experiment_id)
            and outstanding.status in ('queued', 'running')
        );
      if factory_limit is not null and (select count(*)
        from public.factory_benchmark_trials trial join public.agent_jobs running on running.id = trial.job_id
        where (trial.workspace_id, trial.factory_id) = (candidate.workspace_id, session_owner.factory_id)
          and running.status in ('started', 'running')) >= factory_limit
      then continue; end if;
    end if;

    if budget_root_id is not null and not internal.reserve_factory_workflow_attempt(
      budget_execution, session_owner.id, candidate.id, candidate.attempt_count + 1
    ) then continue; end if;

    return query
    update public.agent_jobs
    set status = 'running', attempt_count = attempt_count + 1, last_error = null,
        started_at = now(), scheduled_at = null, claimed_worker_runtime = p_worker_runtime,
        git_continuity_release_revision=case when pipeline_job then release_state.revision else null end
    where id = candidate.id and status = 'queued'
    returning *;
    return;
  end loop;
  return;
end;
$$;

create or replace function internal.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control; job public.agent_jobs; session public.sessions; execution_id uuid; routing jsonb;
  workflow_root_id uuid;
  budget_root_id uuid;
  budget_parent_id uuid;
  budget_execution internal.factory_workflow_executions;
  budget_root public.sessions;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  select * into job from public.agent_jobs where id=p_job_id;
  if not found or p_attempt_count is null or p_attempt_count<=0 or job.attempt_count<>p_attempt_count
    or job.status not in('started','running') then return null; end if;
  select * into session from public.sessions where id=job.session_id and workspace_id=job.workspace_id;
  if not found then return null; end if;
  if session.pipeline_id is not null and (not control.enabled or job.git_continuity_release_revision is distinct from control.revision
    or not exists(select 1 from public.session_git_continuity_enrollments e where e.session_id=session.id and e.workspace_id=session.workspace_id)) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode='P499P';
  end if;
  perform 1 from public.workspaces where id=job.workspace_id for share;
  if not found then return null; end if;
  perform internal.assert_workspace_accepts_work(job.workspace_id);
  workflow_root_id := internal.find_factory_workflow_lifecycle_root(session.id);
  if workflow_root_id is not null then
    perform internal.lock_factory_workflow_root(workflow_root_id, session.workspace_id, session.factory_id);
    select workflow.* into budget_execution from internal.factory_workflow_executions workflow
    where workflow.root_session_id = workflow_root_id for no key update;
    if not found or budget_execution.lifecycle_status <> 'running' then return null; end if;
    if budget_execution.workflow_json::jsonb ? 'delegationPolicy' then budget_root_id := workflow_root_id; end if;
  end if;
  if budget_root_id is not null then
    select * into strict budget_root from public.sessions where id = budget_root_id;
    if budget_root.archived_at is not null and budget_root.phase_status <> 'approved' then return null; end if;
    if budget_root.id = session.id then
      perform internal.recheck_session_execution_grant(budget_root);
    else
      select marker.parent_session_id into budget_parent_id from internal.factory_workflow_delegations marker
      where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.child_session_id) =
        (budget_root_id, session.workspace_id, session.factory_id, session.id);
      if not found or not internal.recheck_factory_workflow_delegation_lineage(
        budget_root_id, session.workspace_id, session.factory_id, budget_parent_id
      ) then return null; end if;
    end if;
    if not internal.reserve_factory_workflow_attempt(
      budget_execution, session.id, p_job_id, p_attempt_count
    ) then return null; end if;
  end if;
  select owner.* into session from public.sessions owner
  where (owner.id, owner.workspace_id) = (job.session_id, job.workspace_id) for no key update;
  if not found then return null; end if;
  if session.execution_purpose = 'production' and session.execute_pinned_definition then
    routing := internal.effective_factory_routing_execution(session.workspace_id, session.factory_id, session.id);
    if routing is not null and (job.claimed_worker_runtime, p_model_provider, p_model_name) is distinct from
      (routing#>>'{configuration,workerRuntime}', routing#>>'{configuration,harness}', routing->>'modelName') then
      raise exception 'The claimed attempt does not match the pinned routing configuration.' using errcode = '23514';
    end if;
  end if;
  perform internal.recheck_session_execution_grant(session);
  if not internal.session_execution_admissible(session.id,session.workspace_id) then return null; end if;
  execution_id:=internal.start_session_job_attempt_before_release(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
    p_model_provider,p_model_name,p_run_type,p_branch_name);
  if execution_id is not null then
    if budget_root_id is not null and not internal.bind_factory_workflow_attempt(
      budget_root_id, p_job_id, p_attempt_count, execution_id
    ) then
      raise exception 'The workflow attempt reservation is unavailable.' using errcode = 'PT409';
    end if;
    perform internal.bind_manual_retry_feedback(p_job_id);
  end if;
  return execution_id;
end;
$$;
-- Provider work follows the durable cancellation receipt. An unbound handle
-- stays unresolved until the exact retired run's late callback identifies it.
create table internal.factory_workflow_sandbox_stops (
  obligation_id uuid primary key default gen_random_uuid(),
  root_session_id uuid not null references internal.factory_workflow_executions(root_session_id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  session_id uuid not null,
  job_id uuid not null,
  run_id uuid not null unique,
  attempt_count integer not null check (attempt_count > 0),
  sandbox_id text check (char_length(sandbox_id) between 1 and 256 and sandbox_id not like 'provisioning:%'),
  sandbox_provider text check (sandbox_provider in ('vercel', 'e2b', 'daytona')),
  sandbox_connection_revision uuid,
  sandbox_vercel_project_id text,
  sandbox_vercel_team_id text,
  lease_token uuid,
  lease_until timestamptz,
  confirmed_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (root_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  check ((lease_token is null) = (lease_until is null))
);
create index factory_workflow_sandbox_stops_ready_idx
  on internal.factory_workflow_sandbox_stops(next_attempt_at, created_at, obligation_id)
  where confirmed_at is null and sandbox_id is not null and sandbox_connection_revision is not null;
alter table internal.factory_workflow_sandbox_stops enable row level security;
revoke all on table internal.factory_workflow_sandbox_stops from public, anon, authenticated, service_role;

create function internal.enqueue_factory_workflow_sandbox_stops()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.factory_workflow_sandbox_stops (
    root_session_id, workspace_id, factory_id, session_id, job_id, run_id, attempt_count,
    sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_project_id, sandbox_vercel_team_id
  )
  select execution.root_session_id, execution.workspace_id, execution.factory_id, run.session_id,
    run.agent_job_id, run.id, run.attempt_count,
    case when char_length(run.sandbox_id) between 1 and 256 and run.sandbox_id not like 'provisioning:%' then run.sandbox_id end,
    case when run.sandbox_provider in ('vercel', 'e2b', 'daytona') then run.sandbox_provider end,
    run.sandbox_connection_revision, run.sandbox_vercel_project_id, run.sandbox_vercel_team_id
  from internal.factory_workflow_executions execution
  cross join lateral jsonb_array_elements(new.receipt->'retired') retired
  cross join lateral jsonb_array_elements_text(retired.value->'runIds') removed(id)
  join public.agent_runs run on run.id = removed.id::uuid
  join public.agent_jobs job on (job.workspace_id, job.session_id, job.id, job.attempt_count) =
    (run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count)
  where execution.root_session_id = new.root_session_id
    and (run.workspace_id, run.session_id) = (execution.workspace_id, (retired.value->>'sessionId')::uuid)
    and retired.value->'jobIds' ? job.id::text and job.status = 'canceled'
    and run.status in ('canceled', 'success') and run.attempt_count > 0
    and run.sandbox_provider is distinct from 'fake'
  on conflict (run_id) do nothing;
  return new;
end;
$$;
revoke all on function internal.enqueue_factory_workflow_sandbox_stops()
  from public, anon, authenticated, service_role;
create trigger enqueue_factory_workflow_sandbox_stops after insert on internal.factory_workflow_lifecycle_commands
  for each row execute function internal.enqueue_factory_workflow_sandbox_stops();

create function public.record_late_factory_workflow_sandbox(
  p_run_id uuid, p_attempt_count integer, p_sandbox_id text, p_sandbox_provider text, p_sandbox_connection_revision uuid,
  p_sandbox_vercel_project_id text default null, p_sandbox_vercel_team_id text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare obligation internal.factory_workflow_sandbox_stops;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_sandbox_id is null or char_length(p_sandbox_id) not between 1 and 256 or p_sandbox_id like 'provisioning:%'
    or coalesce(p_sandbox_provider, '') not in ('vercel', 'e2b', 'daytona') or p_sandbox_connection_revision is null then
    return false;
  end if;

  select stop.* into obligation from internal.factory_workflow_sandbox_stops stop
  join public.agent_runs run on (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
    (stop.run_id, stop.workspace_id, stop.session_id, stop.job_id, stop.attempt_count)
  where (stop.run_id, stop.attempt_count) = (p_run_id, p_attempt_count)
    and run.status in ('canceled', 'success')
  for update of stop;
  if not found then return false; end if;

  if (obligation.sandbox_id is not null and obligation.sandbox_id <> p_sandbox_id)
    or (obligation.sandbox_provider is not null and obligation.sandbox_provider <> p_sandbox_provider)
    or (obligation.sandbox_connection_revision is not null and obligation.sandbox_connection_revision <> p_sandbox_connection_revision)
    or (obligation.sandbox_vercel_project_id is not null and
      obligation.sandbox_vercel_project_id is distinct from p_sandbox_vercel_project_id)
    or (obligation.sandbox_vercel_team_id is not null and
      obligation.sandbox_vercel_team_id is distinct from p_sandbox_vercel_team_id) then
    return false;
  end if;

  if obligation.sandbox_id is null or obligation.sandbox_provider is null or obligation.sandbox_connection_revision is null then
    update internal.factory_workflow_sandbox_stops stop
    set sandbox_id = p_sandbox_id, sandbox_provider = p_sandbox_provider, sandbox_connection_revision = p_sandbox_connection_revision,
      sandbox_vercel_project_id = p_sandbox_vercel_project_id, sandbox_vercel_team_id = p_sandbox_vercel_team_id
    where stop.obligation_id = obligation.obligation_id;
  end if;
  return true;
end;
$$;

create function public.claim_factory_workflow_sandbox_stops(p_limit integer)
returns table (obligation_id uuid, lease_token uuid, run_id uuid, sandbox_id text, workspace_id uuid, sandbox_provider text,
  sandbox_connection_revision uuid, sandbox_vercel_project_id text, sandbox_vercel_team_id text)
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if p_limit is null or p_limit not between 1 and 20 then
    raise exception 'Invalid workflow sandbox stop claim size.' using errcode = '22023';
  end if;
  return query
    with ready as (
      select stop.obligation_id from internal.factory_workflow_sandbox_stops stop
      where stop.confirmed_at is null and stop.sandbox_id is not null and stop.sandbox_provider is not null
        and stop.sandbox_connection_revision is not null and stop.next_attempt_at <= clock_timestamp()
        and (stop.lease_until is null or stop.lease_until <= clock_timestamp())
      order by stop.next_attempt_at, stop.created_at, stop.obligation_id
      limit p_limit for update skip locked
    )
    update internal.factory_workflow_sandbox_stops stop
    set lease_token = gen_random_uuid(), lease_until = clock_timestamp() + interval '2 minutes'
    from ready where ready.obligation_id = stop.obligation_id
    returning stop.obligation_id, stop.lease_token, stop.run_id, stop.sandbox_id, stop.workspace_id,
      stop.sandbox_provider, stop.sandbox_connection_revision, stop.sandbox_vercel_project_id, stop.sandbox_vercel_team_id;
end;
$$;

create function public.settle_factory_workflow_sandbox_stop(
  p_obligation_id uuid, p_lease_token uuid, p_confirmed boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
declare obligation internal.factory_workflow_sandbox_stops; workspace_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_lease_token is null or p_confirmed is null then return false; end if;
  select stop.workspace_id into workspace_id from internal.factory_workflow_sandbox_stops stop
  where stop.obligation_id = p_obligation_id;
  if not found then return false; end if;
  -- Retained cleanup remains eligible inside an existing deletion fence.
  perform 1 from public.workspaces workspace where workspace.id = workspace_id for share;
  if not found then return false; end if;
  select stop.* into obligation from internal.factory_workflow_sandbox_stops stop
  where stop.obligation_id = p_obligation_id for update;
  if not found or obligation.lease_token is distinct from p_lease_token then return false; end if;
  if obligation.confirmed_at is not null then return p_confirmed; end if;
  if obligation.lease_until <= clock_timestamp() then return false; end if;

  if p_confirmed then
    insert into public.workspace_sandbox_cleanup_receipts(workspace_id, provider, connection_revision, sandbox_id)
    values (obligation.workspace_id, obligation.sandbox_provider, obligation.sandbox_connection_revision, obligation.sandbox_id)
    on conflict on constraint workspace_sandbox_cleanup_receipts_pkey do nothing;
    update internal.factory_workflow_sandbox_stops stop set confirmed_at = clock_timestamp()
    where stop.obligation_id = p_obligation_id;
  else
    update internal.factory_workflow_sandbox_stops stop set lease_token = null, lease_until = null,
      next_attempt_at = clock_timestamp() + interval '30 seconds'
    where stop.obligation_id = p_obligation_id;
  end if;
  return true;
end;
$$;
revoke all on function public.record_late_factory_workflow_sandbox(uuid, integer, text, text, uuid, text, text),
  public.claim_factory_workflow_sandbox_stops(integer), public.settle_factory_workflow_sandbox_stop(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.record_late_factory_workflow_sandbox(uuid, integer, text, text, uuid, text, text),
  public.claim_factory_workflow_sandbox_stops(integer), public.settle_factory_workflow_sandbox_stop(uuid, uuid, boolean)
  to service_role;
create function public.control_factory_workflow_lifecycle_for_user(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_expected_generation bigint, p_request_id uuid, p_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  return public.control_factory_workflow_lifecycle(
    p_root_session_id, p_workspace_id, p_factory_id, p_expected_generation, p_request_id, p_action
  );
end;
$$;
revoke all on function public.control_factory_workflow_lifecycle_for_user(uuid, uuid, uuid, uuid, bigint, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.control_factory_workflow_lifecycle_for_user(uuid, uuid, uuid, uuid, bigint, uuid, text)
  to service_role;
