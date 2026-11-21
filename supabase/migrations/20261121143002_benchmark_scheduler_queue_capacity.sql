alter function public.start_factory_benchmark_trial(uuid, integer, timestamptz) set schema internal;
revoke all on function internal.start_factory_benchmark_trial(uuid, integer, timestamptz)
  from public, anon, authenticated, service_role;

create function public.start_factory_benchmark_trial(
  p_job_id uuid, p_attempt_count integer, p_deadline_at timestamptz default null
) returns public.factory_benchmark_trials language plpgsql security definer set search_path = '' as $$
declare timeout_ms integer;
begin
  perform internal.assert_checkpoint_publication_service();
  select frozen.timeout_ms into timeout_ms
  from public.factory_benchmark_trials trial
  join public.factory_benchmark_schedule_trials scheduled on (scheduled.trial_id, scheduled.run_id) = (trial.id, trial.run_id)
  join public.factory_benchmark_experiment_trials frozen on frozen.trial_id = scheduled.trial_id
  where trial.job_id = p_job_id;
  return internal.start_factory_benchmark_trial(p_job_id, p_attempt_count,
    least(p_deadline_at, clock_timestamp() + timeout_ms * interval '1 millisecond'));
end;
$$;
revoke all on function public.start_factory_benchmark_trial(uuid, integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.start_factory_benchmark_trial(uuid, integer, timestamptz) to service_role;

create or replace function public.claim_next_agent_job(
  accept_benchmark_trials boolean,
  default_concurrency_limit int default 2
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
  select * into strict release_state from internal.git_continuity_release_control where singleton for share;
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();

  for candidate in
    select ready.* from public.agent_jobs ready
    join public.sessions owner on (owner.workspace_id, owner.id) = (ready.workspace_id, ready.session_id)
    where ready.status = 'queued' and (ready.scheduled_at is null or ready.scheduled_at <= now())
      and (
        (owner.execution_purpose = 'production' and (owner.pipeline_id is null or (release_state.enabled
          and exists (select 1 from public.session_git_continuity_enrollments enrolled
            where (enrolled.workspace_id, enrolled.session_id) = (owner.workspace_id, owner.id)))))
        or (accept_benchmark_trials is true and owner.execution_purpose = 'benchmark'
          and ready.attempt_count = 0 and exists (select 1 from public.factory_benchmark_trials trial
            where (trial.workspace_id, trial.session_id, trial.job_id, trial.status) =
              (owner.workspace_id, owner.id, ready.id, 'queued')))
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
        and schedule.state = 'active';
      if factory_limit is not null and (select count(*)
        from public.factory_benchmark_trials trial join public.agent_jobs running on running.id = trial.job_id
        where (trial.workspace_id, trial.factory_id) = (candidate.workspace_id, session_owner.factory_id)
          and running.status in ('started', 'running')) >= factory_limit
      then continue; end if;
    end if;

    return query
    update public.agent_jobs
    set status = 'running', attempt_count = attempt_count + 1, last_error = null,
        started_at = now(), scheduled_at = null,
        git_continuity_release_revision=case when pipeline_job then release_state.revision else null end
    where id = candidate.id and status = 'queued'
    returning *;
    return;
  end loop;
  return;
end;
$$;

create or replace function public.claim_next_worker_dispatch(
  accept_benchmark_trials boolean,
  p_max_concurrent integer default 10,
  p_default_workspace_limit integer default 2,
  p_timeout_ms integer default 1800000
) returns setof public.worker_dispatches
language plpgsql security definer set search_path = '' as $$
declare
  claimed public.agent_jobs%rowtype;
  running_count integer;
begin
  if p_max_concurrent is null or p_default_workspace_limit is null or p_timeout_ms is null
    or p_max_concurrent < 1 or p_default_workspace_limit < 1
    or p_timeout_ms < 1 or p_timeout_ms > 1800000 then
    raise exception 'Invalid worker dispatch limits';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallie/cloudflare/dispatch', 0));
  select count(*) into running_count from public.agent_jobs where status in ('started', 'running');
  if running_count >= p_max_concurrent then return; end if;
  select * into claimed from public.claim_next_agent_job(
    accept_benchmark_trials and (p_max_concurrent = 1 or running_count < p_max_concurrent - 1),
    p_default_workspace_limit
  );
  if claimed.id is null then return; end if;
  return query insert into public.worker_dispatches(job_id, attempt_count, workspace_id, workflow_id, deadline_at)
  values (claimed.id, claimed.attempt_count, claimed.workspace_id,
    'job-' || claimed.id::text || '-' || claimed.attempt_count::text,
    now() + p_timeout_ms * interval '1 millisecond') returning *;
end;
$$;
