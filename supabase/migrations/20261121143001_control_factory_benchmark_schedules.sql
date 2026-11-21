-- Preserve standalone fixture admission while making a frozen trial's ID
-- available exclusively to the reservation transaction below.
alter function public.admit_factory_benchmark_trial(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid)
  set schema internal;
revoke all on function internal.admit_factory_benchmark_trial(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;

create function public.admit_factory_benchmark_trial(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_trial_id uuid, p_task_revision_id uuid,
  p_policy_revision_id uuid, p_policy_digest text, p_fixture_key text, p_sandbox_connection_revision uuid
) returns public.factory_benchmark_trials language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform pg_advisory_xact_lock(hashtextextended(p_trial_id::text, 616));
  if exists (select 1 from public.factory_benchmark_experiment_trials cell where cell.trial_id = p_trial_id) then
    raise exception 'Frozen benchmark trials require a schedule reservation.' using errcode = 'PT409';
  end if;
  return internal.admit_factory_benchmark_trial(p_workspace_id, p_factory_id, p_actor_user_id, p_trial_id,
    p_task_revision_id, p_policy_revision_id, p_policy_digest, p_fixture_key, p_sandbox_connection_revision);
end;
$$;

create function public.configure_factory_benchmark_schedule(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid,
  p_runner_revision text, p_sandbox_connection_revision uuid, p_task_fixtures jsonb,
  p_execution_reserve_usd numeric, p_evaluation_reserve_usd numeric, p_budget_limit_usd numeric,
  p_factory_concurrency_limit integer, p_max_admitted_trials integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  schedule public.factory_benchmark_schedules;
  experiment public.factory_benchmark_experiments;
  fixture record;
  fixtures jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into experiment from public.factory_benchmark_experiments frozen
  where (frozen.workspace_id, frozen.factory_id, frozen.id) = (p_workspace_id, p_factory_id, p_experiment_id);
  if not found then raise exception 'Benchmark experiment is unavailable.' using errcode = 'P0002'; end if;

  if p_runner_revision is distinct from 'recorded-fixture-v1' or p_sandbox_connection_revision is null
    or not coalesce(p_budget_limit_usd between 0 and 1000000 and p_budget_limit_usd = round(p_budget_limit_usd,6), false)
    or not coalesce(p_execution_reserve_usd between 0 and p_budget_limit_usd
      and p_execution_reserve_usd = round(p_execution_reserve_usd,6), false)
    or not coalesce(p_evaluation_reserve_usd between 0 and 1000000
      and p_evaluation_reserve_usd = round(p_evaluation_reserve_usd,6), false)
    or not coalesce(p_factory_concurrency_limit between 1 and 100, false)
    or not coalesce(p_max_admitted_trials between 1 and 10000, false)
    or jsonb_typeof(p_task_fixtures) is distinct from 'array'
  then raise exception 'Invalid benchmark schedule configuration.' using errcode = '22023'; end if;

  if jsonb_array_length(p_task_fixtures) not between 1 and 10000
    or exists (select 1 from jsonb_array_elements(p_task_fixtures) as selection(item)
      where jsonb_typeof(item) is distinct from 'object'
        or not coalesce(item->>'taskRevisionId' ~ '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$', false)
        or not coalesce(item->>'fixtureKey' ~ '^[a-f0-9]{64}$', false))
  then raise exception 'Each eligible task requires an exact fixture.' using errcode = '22023'; end if;

  select jsonb_object_agg(lower(item->>'taskRevisionId'), item->>'fixtureKey') into fixtures
  from jsonb_array_elements(p_task_fixtures) as selection(item);
  if (select count(*) from jsonb_object_keys(fixtures)) <> jsonb_array_length(p_task_fixtures)
    or exists (
      select 1
      from (select distinct cell.task_revision_id::text as id from public.factory_benchmark_experiment_trials cell
        where (cell.workspace_id, cell.factory_id, cell.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id)
          and cell.replay_eligibility = 'eligible') eligible
      full join jsonb_object_keys(fixtures) selected(id) using (id)
      where eligible.id is null or selected.id is null
    )
  then raise exception 'Select one fixture for each eligible frozen task.' using errcode = 'PT422'; end if;

  select * into schedule from public.factory_benchmark_schedules existing
  where (existing.workspace_id, existing.factory_id, existing.experiment_id) =
    (p_workspace_id, p_factory_id, p_experiment_id) for update;
  if found then
    if (schedule.runner_revision, schedule.sandbox_connection_revision, schedule.task_fixtures, schedule.execution_reserve_usd,
        schedule.evaluation_reserve_usd, schedule.budget_limit_usd, schedule.factory_concurrency_limit, schedule.max_admitted_trials)
      is distinct from (p_runner_revision, p_sandbox_connection_revision, fixtures, p_execution_reserve_usd,
        p_evaluation_reserve_usd, p_budget_limit_usd, p_factory_concurrency_limit, p_max_admitted_trials)
    then raise exception 'The experiment already has a different schedule.' using errcode = 'PT409'; end if;
    return internal.factory_benchmark_schedule_snapshot(schedule);
  end if;

  for fixture in select key::uuid as task_revision_id, value as fixture_key from jsonb_each_text(fixtures) loop
    perform internal.assert_factory_benchmark_trial_pin(p_workspace_id, p_factory_id, p_actor_user_id,
      fixture.task_revision_id, experiment.policy_revision_id, experiment.policy_digest, fixture.fixture_key,
      p_sandbox_connection_revision);
  end loop;
  insert into public.factory_benchmark_schedules (
    workspace_id, factory_id, experiment_id, actor_user_id, runner_revision, sandbox_connection_revision, task_fixtures,
    execution_reserve_usd, evaluation_reserve_usd, budget_limit_usd, factory_concurrency_limit, max_admitted_trials
  ) values (
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, p_runner_revision, p_sandbox_connection_revision, fixtures,
    p_execution_reserve_usd, p_evaluation_reserve_usd, p_budget_limit_usd, p_factory_concurrency_limit, p_max_admitted_trials
  ) returning * into schedule;
  return internal.factory_benchmark_schedule_snapshot(schedule);
end;
$$;

create function public.read_factory_benchmark_schedule(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare schedule public.factory_benchmark_schedules;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into schedule from public.factory_benchmark_schedules existing
  where (existing.workspace_id, existing.factory_id, existing.experiment_id) =
    (p_workspace_id, p_factory_id, p_experiment_id);
  if not found then raise exception 'Benchmark schedule is unavailable.' using errcode = 'P0002'; end if;
  return internal.factory_benchmark_schedule_snapshot(schedule);
end;
$$;

create function public.control_factory_benchmark_schedule(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid, p_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  schedule public.factory_benchmark_schedules;
  target_state text;
  execution record;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  target_state := case p_action when 'pause' then 'paused' when 'resume' then 'active' when 'cancel' then 'canceled' end;
  if target_state is null then raise exception 'Invalid benchmark schedule action.' using errcode = '22023'; end if;
  select * into schedule from public.factory_benchmark_schedules existing
  where (existing.workspace_id, existing.factory_id, existing.experiment_id) =
    (p_workspace_id, p_factory_id, p_experiment_id) for update;
  if not found then raise exception 'Benchmark schedule is unavailable.' using errcode = 'P0002'; end if;
  if schedule.state = 'canceled' and target_state <> 'canceled' then
    raise exception 'A canceled benchmark schedule is terminal.' using errcode = 'PT409';
  end if;

  update public.factory_benchmark_schedules existing set state = target_state,
    actor_user_id = case when target_state = 'active' then p_actor_user_id else existing.actor_user_id end,
    admission_issue = case when target_state = 'active' then null else existing.admission_issue end
  where (existing.workspace_id, existing.factory_id, existing.experiment_id) =
    (p_workspace_id, p_factory_id, p_experiment_id) returning * into schedule;
  if target_state = 'canceled' then
    for execution in
      select trial.id, trial.run_id
      from public.factory_benchmark_schedule_trials scheduled
      join public.factory_benchmark_trials trial on (trial.id, trial.run_id) = (scheduled.trial_id, scheduled.run_id)
      where (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
        (p_workspace_id, p_factory_id, p_experiment_id) and trial.status in ('queued', 'running')
      order by trial.id
    loop
      perform public.cancel_factory_benchmark_trial(p_workspace_id, p_factory_id, p_actor_user_id, execution.id, execution.run_id);
    end loop;
  end if;

  perform internal.refresh_factory_benchmark_schedule_costs(schedule);
  return internal.factory_benchmark_schedule_snapshot(schedule);
end;
$$;

create function public.reconcile_factory_benchmark_schedules(p_limit integer)
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
        select frozen.trial_id, frozen.task_revision_id into strict cell
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
          execution := internal.admit_factory_benchmark_trial(scoped.workspace_id, scoped.factory_id, schedule.actor_user_id,
            cell.trial_id, cell.task_revision_id, scoped.policy_revision_id, scoped.policy_digest,
            schedule.task_fixtures->>cell.task_revision_id::text, schedule.sandbox_connection_revision);
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

revoke all on function
  public.admit_factory_benchmark_trial(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid),
  public.configure_factory_benchmark_schedule(uuid, uuid, uuid, uuid, text, uuid, jsonb, numeric, numeric, numeric, integer, integer),
  public.read_factory_benchmark_schedule(uuid, uuid, uuid, uuid),
  public.control_factory_benchmark_schedule(uuid, uuid, uuid, uuid, text),
  public.reconcile_factory_benchmark_schedules(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.admit_factory_benchmark_trial(uuid, uuid, uuid, uuid, uuid, uuid, text, text, uuid),
  public.configure_factory_benchmark_schedule(uuid, uuid, uuid, uuid, text, uuid, jsonb, numeric, numeric, numeric, integer, integer),
  public.read_factory_benchmark_schedule(uuid, uuid, uuid, uuid),
  public.control_factory_benchmark_schedule(uuid, uuid, uuid, uuid, text),
  public.reconcile_factory_benchmark_schedules(integer)
  to service_role;
