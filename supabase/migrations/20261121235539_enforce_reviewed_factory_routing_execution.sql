-- A routed claim binds the worker runtime until this attempt retires.
alter table public.agent_jobs add column claimed_worker_runtime text
  check (claimed_worker_runtime in ('node', 'workerd'));

create or replace function internal.pinned_session_execution_definition(p_session public.sessions)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  definition jsonb;
  routing jsonb;
  routed_agent jsonb;
begin
  if not p_session.execute_pinned_definition then return null; end if;
  select r.definition_json::jsonb into definition
  from public.factory_definition_revisions r
  where (r.workspace_id, r.id) = (p_session.workspace_id, p_session.factory_definition_revision_id);
  if not found
     or coalesce(definition->'schemaVersion' not in ('1'::jsonb, '2'::jsonb), true)
     or definition->>'kind' is distinct from 'serial'
     or definition->>'pipelineId' is distinct from p_session.pipeline_id::text then
    raise exception 'Pinned factory definition is unavailable.' using errcode = '55000';
  end if;
  if p_session.execution_purpose <> 'production' or not (definition ? 'modelRouting') then
    return definition;
  end if;
  routing := internal.effective_factory_routing_execution(p_session.workspace_id, p_session.factory_id, p_session.id);
  if routing is null then return definition; end if;

  select revision.definition_json::jsonb->'implementationAgent' into routed_agent
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
    (p_session.workspace_id, p_session.factory_id, (routing#>>'{configuration,definitionRevisionId}')::uuid,
      routing->>'definitionDigest');
  if not found or (routed_agent - 'promptMd') is distinct from routing->'implementationAgent'
    or definition->>'credentialBindingId' is distinct from routing->>'credentialBindingId'
    or (definition ? 'executionGrant' and definition#>>'{implementationAgent,agentId}' is distinct from routed_agent->>'agentId')
    or (jsonb_array_length(definition#>'{mcpManifest,servers}') > 0 and (
      definition#>>'{mcpManifest,agentId}' is distinct from routed_agent->>'agentId'
      or definition#>>'{agent,provider}' is distinct from routing#>>'{configuration,harness}'
    )) then
    raise exception 'The pinned routing execution identity is unavailable.' using errcode = '42501';
  end if;

  -- Workflow, review, grants, tools, and operational limits still belong to the
  -- admitted policy revision. Only the qualified execution identities change.
  return definition || jsonb_build_object(
    'agent', definition->'agent' || jsonb_build_object('provider', routing#>>'{configuration,harness}',
      'model', routing->>'modelName', 'effort', routing->'effort'),
    'sandboxProvider', routing->>'sandboxProvider', 'implementationAgent', routed_agent
  );
end;
$$;

create or replace function internal.pin_run_factory_agent()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare session_owner public.sessions; definition jsonb; snapshot jsonb; routing jsonb;
  selected_agent_id uuid; selected_revision_id uuid;
begin
  if tg_op = 'UPDATE' then
    if (new.workspace_id, new.session_id, new.agent_id, new.agent_prompt_revision_id)
      is distinct from (old.workspace_id, old.session_id, old.agent_id, old.agent_prompt_revision_id) then
      raise exception 'Run agent identity and prompt revision are immutable.' using errcode = '23514';
    end if;
  end if;
  select * into session_owner from public.sessions
  where (workspace_id, id) = (new.workspace_id, new.session_id);
  if not found then
    raise exception 'Run session is unavailable.' using errcode = '23514';
  end if;
  if session_owner.execution_purpose = 'production' and session_owner.execute_pinned_definition then
    routing := internal.effective_factory_routing_execution(session_owner.workspace_id, session_owner.factory_id, session_owner.id);
  end if;
  if routing is not null then
    if new.status = 'queued' and new.attempt_count is null
      and (tg_op = 'INSERT' or (old.status = 'queued' and old.attempt_count is null)) then
      -- A one-task override may complete the first queued identity in the same
      -- admission transaction. Every field is read from the effective pin.
      new.model_provider := routing#>>'{configuration,harness}';
      new.model_name := routing->>'modelName';
      new.agent_id := (routing#>>'{implementationAgent,agentId}')::uuid;
      new.agent_prompt_revision_id := (routing#>>'{implementationAgent,promptRevisionId}')::uuid;
    elsif (new.model_provider, new.model_name) is distinct from
      (routing#>>'{configuration,harness}', routing->>'modelName') then
      raise exception 'Run model must match the pinned routing configuration.' using errcode = '23514';
    end if;
  elsif tg_op = 'UPDATE' then
    return new;
  end if;
  definition := internal.pinned_session_execution_definition(session_owner);
  if definition ? 'implementationAgent' then
    snapshot := definition->'implementationAgent';
    perform internal.assert_factory_agent_snapshot(new.workspace_id, session_owner.factory_id, snapshot);
    selected_agent_id := (snapshot->>'agentId')::uuid;
    selected_revision_id := (snapshot->>'promptRevisionId')::uuid;
  else
    select agent.id, revision.id into selected_agent_id, selected_revision_id
    from public.factory_agents agent
    join public.factory_agent_prompt_revisions revision on revision.agent_id = agent.id and revision.revision_number = 1
    where (agent.workspace_id, agent.factory_id) = (new.workspace_id, session_owner.factory_id) and agent.is_default;
  end if;
  if selected_agent_id is null or selected_revision_id is null
    or (new.agent_id is not null and new.agent_id <> selected_agent_id)
    or (new.agent_prompt_revision_id is not null and new.agent_prompt_revision_id <> selected_revision_id) then
    raise exception 'Run agent must match the session implementation agent revision.' using errcode = '23514';
  end if;
  new.agent_id := selected_agent_id;
  new.agent_prompt_revision_id := selected_revision_id;
  return new;
end;
$$;

drop trigger pin_run_factory_agent on public.agent_runs;
create trigger pin_run_factory_agent before insert or update of workspace_id, session_id, agent_id,
  agent_prompt_revision_id, model_provider, model_name on public.agent_runs
  for each row execute function internal.pin_run_factory_agent();

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
  if execution_id is not null then perform internal.bind_manual_retry_feedback(p_job_id); end if;
  return execution_id;
end;
$$;

create or replace function internal.pin_attempt_model_routing_admission()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  factory_id uuid;
  routing jsonb;
  expected_effort text;
begin
  select admission.session_id, admission.factory_id into new.routing_decision_session_id, factory_id
  from public.session_factory_admission_inputs admission
  join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) =
    (admission.workspace_id, admission.factory_id, admission.session_id)
  where (admission.workspace_id, admission.session_id, admission.definition_revision_id, admission.definition_digest) =
    (new.workspace_id, new.session_id, new.definition_revision_id, new.definition_digest)
    and owner.execution_purpose = 'production' and owner.execute_pinned_definition
    and admission.routing_decision is not null;
  if new.routing_decision_session_id is null then return new; end if;
  routing := internal.effective_factory_routing_execution(new.workspace_id, factory_id, new.session_id);
  -- Codex replay and production both default to xhigh if the candidate omitted effort.
  expected_effort := case when routing#>>'{configuration,harness}' = 'codex'
    then coalesce(routing->>'effort', 'xhigh') end;
  if routing is not null and (
    (new.model_provider, new.model_name, new.worker_runtime, new.sandbox_provider, new.sandbox_connection_revision::text)
      is distinct from (routing#>>'{configuration,harness}', routing->>'modelName',
        routing#>>'{configuration,workerRuntime}', routing->>'sandboxProvider', routing->>'sandboxConnectionRevision')
    or new.agent_effort is distinct from expected_effort
    or internal.factory_connected_sandbox_revision(new.workspace_id, new.sandbox_provider)
      is distinct from new.sandbox_connection_revision
    or not exists (select 1 from public.agent_runs run
      join public.agent_jobs job on (job.workspace_id, job.session_id, job.id) = (run.workspace_id, run.session_id, run.agent_job_id)
      where (run.workspace_id, run.session_id, run.id, run.agent_job_id, run.attempt_count, run.stage_id) =
        (new.workspace_id, new.session_id, new.run_id, new.job_id, new.attempt_count, new.stage_id)
      and (run.agent_id::text, run.agent_prompt_revision_id::text, job.claimed_worker_runtime) =
        (routing#>>'{implementationAgent,agentId}', routing#>>'{implementationAgent,promptRevisionId}',
          routing#>>'{configuration,workerRuntime}'))
  ) then
    raise exception 'The attempt manifest does not match the pinned routing configuration.' using errcode = '23514';
  end if;
  return new;
end;
$$;
