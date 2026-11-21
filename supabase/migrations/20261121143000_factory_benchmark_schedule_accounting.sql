-- The frozen matrix stays independent of its execution adapter and mutable controls.
create table public.factory_benchmark_schedules (
  workspace_id uuid not null,
  factory_id uuid not null,
  experiment_id uuid not null,
  actor_user_id uuid not null,
  runner_revision text not null check (runner_revision = 'recorded-fixture-v1'),
  sandbox_connection_revision uuid not null,
  task_fixtures jsonb not null check (jsonb_typeof(task_fixtures) = 'object'),
  execution_reserve_usd numeric(13,6) not null check (execution_reserve_usd between 0 and 1000000),
  evaluation_reserve_usd numeric(13,6) not null check (evaluation_reserve_usd between 0 and 1000000),
  budget_limit_usd numeric(13,6) not null check (budget_limit_usd between execution_reserve_usd and 1000000),
  factory_concurrency_limit integer not null check (factory_concurrency_limit between 1 and 100),
  max_admitted_trials integer not null check (max_admitted_trials between 1 and 10000),
  state text not null default 'active' check (state in ('active', 'paused', 'canceled')),
  admission_issue text check (admission_issue in ('pinned-input-unavailable', 'trial-identity-conflict')),
  created_at timestamptz not null default clock_timestamp(),
  last_reconciled_at timestamptz,
  primary key (workspace_id, factory_id, experiment_id),
  foreign key (workspace_id, factory_id, experiment_id)
    references public.factory_benchmark_experiments(workspace_id, factory_id, id) on delete cascade
);

create table public.factory_benchmark_schedule_trials (
  trial_id uuid primary key references public.factory_benchmark_experiment_trials(trial_id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  experiment_id uuid not null,
  run_id uuid not null unique references public.agent_runs(id) on delete cascade,
  reserve_usd numeric(13,6) not null check (reserve_usd >= 0),
  actual_usd numeric check (actual_usd >= 0 and actual_usd < 'Infinity'::numeric),
  cost_provenance text check (cost_provenance in ('measured', 'estimated', 'unavailable', 'never_started')),
  accounted_at timestamptz,
  check ((accounted_at is null) = (cost_provenance is null)),
  check ((actual_usd is not null) = coalesce(cost_provenance in ('measured', 'estimated'), false)),
  foreign key (workspace_id, factory_id, experiment_id)
    references public.factory_benchmark_schedules(workspace_id, factory_id, experiment_id) on delete cascade,
  foreign key (workspace_id, factory_id, trial_id)
    references public.factory_benchmark_trials(workspace_id, factory_id, id) on delete cascade
);
create index factory_benchmark_schedule_trials_scope_idx
  on public.factory_benchmark_schedule_trials(workspace_id, factory_id, experiment_id);

create table public.factory_benchmark_schedule_evaluations (
  attempt_id uuid primary key references public.factory_evaluation_attempts(id) on delete cascade,
  trial_id uuid not null references public.factory_benchmark_schedule_trials(trial_id) on delete cascade,
  reserve_usd numeric(13,6) not null check (reserve_usd >= 0),
  actual_usd numeric check (actual_usd >= 0 and actual_usd < 'Infinity'::numeric),
  cost_provenance text check (cost_provenance in ('measured', 'estimated', 'unavailable', 'never_started')),
  accounted_at timestamptz,
  check ((accounted_at is null) = (cost_provenance is null)),
  check ((actual_usd is not null) = coalesce(cost_provenance in ('measured', 'estimated'), false))
);
create index factory_benchmark_schedule_evaluations_trial_idx on public.factory_benchmark_schedule_evaluations(trial_id);

alter table public.factory_benchmark_schedules enable row level security;
alter table public.factory_benchmark_schedule_trials enable row level security;
alter table public.factory_benchmark_schedule_evaluations enable row level security;
revoke all on public.factory_benchmark_schedules, public.factory_benchmark_schedule_trials,
  public.factory_benchmark_schedule_evaluations from public, anon, authenticated, service_role;
grant select on public.factory_benchmark_schedules, public.factory_benchmark_schedule_trials,
  public.factory_benchmark_schedule_evaluations to service_role;

create function internal.refresh_factory_benchmark_schedule_costs(schedule public.factory_benchmark_schedules)
returns void language sql set search_path = '' as $$
  -- The caller owns the schedule row. A terminal receipt can settle a reservation once.
  update public.factory_benchmark_schedule_trials reservation
  set actual_usd = cost.actual_usd, cost_provenance = cost.provenance, accounted_at = clock_timestamp()
  from public.factory_benchmark_trials trial
  join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
    (trial.workspace_id, trial.session_id, trial.run_id)
  cross join lateral (
    select case
      when run.started_at is null then 'never_started'
      when run.usage_finalized_at is not null and run.cost_provenance in ('measured', 'estimated')
        and run.total_cost_usd >= 0 and run.total_cost_usd < 'Infinity'::numeric then run.cost_provenance
      else 'unavailable' end as provenance
  ) proof
  cross join lateral (
    select proof.provenance, case when proof.provenance in ('measured', 'estimated') then run.total_cost_usd end as actual_usd
  ) cost
  where (reservation.workspace_id, reservation.factory_id, reservation.experiment_id) =
    (schedule.workspace_id, schedule.factory_id, schedule.experiment_id)
    and (reservation.trial_id, reservation.run_id) = (trial.id, run.id)
    and reservation.accounted_at is null and trial.status in ('success', 'error', 'canceled')
    and run.status in ('success', 'error', 'canceled');

  update public.factory_benchmark_schedule_evaluations reservation
  set actual_usd = case when receipt.started_at is not null and receipt.cost_provenance in ('measured', 'estimated')
      then receipt.cost_usd end,
    cost_provenance = case when receipt.started_at is null then 'never_started' else receipt.cost_provenance end,
    accounted_at = clock_timestamp()
  from public.factory_benchmark_schedule_trials scheduled
  join public.factory_benchmark_trials trial on (trial.id, trial.run_id) = (scheduled.trial_id, scheduled.run_id)
  join public.factory_evaluation_receipts receipt on (receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.run_id) =
    (trial.workspace_id, trial.factory_id, trial.session_id, trial.run_id)
  where (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
    (schedule.workspace_id, schedule.factory_id, schedule.experiment_id)
    and (reservation.trial_id, reservation.attempt_id) = (scheduled.trial_id, receipt.attempt_id)
    and reservation.accounted_at is null;
$$;

create function internal.factory_benchmark_schedule_snapshot(schedule public.factory_benchmark_schedules)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'experimentId', schedule.experiment_id,
    'state', schedule.state,
    'runnerRevision', schedule.runner_revision,
    'sandboxConnectionRevision', schedule.sandbox_connection_revision,
    'budgetLimitUsd', schedule.budget_limit_usd,
    'executionReserveUsd', schedule.execution_reserve_usd,
    'evaluationReserveUsd', schedule.evaluation_reserve_usd,
    'factoryConcurrencyLimit', schedule.factory_concurrency_limit,
    'maxAdmittedTrials', schedule.max_admitted_trials,
    'plannedTrialCount', experiment.expected_trial_count,
    'eligibleTrialCount', experiment.eligible_trial_count,
    'admittedTrialCount', execution.admitted_count,
    'queuedTrialCount', execution.queued_count,
    'runningTrialCount', execution.running_count,
    'terminalTrialCount', execution.terminal_count,
    'executionSpentUsd', execution.spent_usd,
    'evaluationSpentUsd', evaluations.spent_usd,
    'reservedUsd', execution.reserved_usd + evaluations.reserved_usd,
    'unavailableExecutionCount', execution.unavailable_count,
    'unavailableEvaluationCount', evaluations.unavailable_count,
    'admissionIssue', schedule.admission_issue
  )
  from public.factory_benchmark_experiments experiment
  cross join lateral (
    select count(*) as admitted_count,
      count(*) filter (where trial.status = 'queued') as queued_count,
      count(*) filter (where trial.status = 'running') as running_count,
      count(*) filter (where trial.status in ('success', 'error', 'canceled')) as terminal_count,
      coalesce(sum(reservation.actual_usd), 0) as spent_usd,
      coalesce(sum(reservation.reserve_usd) filter (where reservation.accounted_at is null
        or reservation.cost_provenance = 'unavailable'), 0) as reserved_usd,
      count(*) filter (where reservation.cost_provenance = 'unavailable') as unavailable_count
    from public.factory_benchmark_schedule_trials reservation
    join public.factory_benchmark_trials trial on trial.id = reservation.trial_id
    where (reservation.workspace_id, reservation.factory_id, reservation.experiment_id) =
      (schedule.workspace_id, schedule.factory_id, schedule.experiment_id)
  ) execution
  cross join lateral (
    select coalesce(sum(reservation.actual_usd), 0) as spent_usd,
      coalesce(sum(reservation.reserve_usd) filter (where reservation.accounted_at is null
        or reservation.cost_provenance = 'unavailable'), 0) as reserved_usd,
      count(*) filter (where reservation.cost_provenance = 'unavailable') as unavailable_count
    from public.factory_benchmark_schedule_evaluations reservation
    join public.factory_benchmark_schedule_trials scheduled on scheduled.trial_id = reservation.trial_id
    where (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
      (schedule.workspace_id, schedule.factory_id, schedule.experiment_id)
  ) evaluations
  where (experiment.workspace_id, experiment.factory_id, experiment.id) =
    (schedule.workspace_id, schedule.factory_id, schedule.experiment_id);
$$;

create function internal.factory_benchmark_schedule_available_usd(snapshot jsonb)
returns numeric language sql immutable strict set search_path = '' as $$
  select (snapshot->>'budgetLimitUsd')::numeric - (snapshot->>'reservedUsd')::numeric
    - (snapshot->>'executionSpentUsd')::numeric - (snapshot->>'evaluationSpentUsd')::numeric;
$$;

-- OP-620 can attach an already allocated attempt before an invocation starts.
-- Its queue and scoring workflow remain independent.
create function public.reserve_factory_benchmark_evaluation_attempt(p_trial_id uuid, p_attempt_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  schedule public.factory_benchmark_schedules;
  invocation public.factory_evaluation_attempts;
begin
  perform internal.assert_checkpoint_publication_service();
  select control.* into schedule
  from public.factory_benchmark_schedule_trials scheduled
  join public.factory_benchmark_schedules control on
    (control.workspace_id, control.factory_id, control.experiment_id) =
    (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id)
  where scheduled.trial_id = p_trial_id for update of control;
  if not found then return false; end if;

  select attempt.* into invocation from public.factory_evaluation_attempts attempt
  join public.factory_evaluation_jobs job on (job.workspace_id, job.factory_id, job.id) =
    (attempt.workspace_id, attempt.factory_id, attempt.job_id)
  join public.factory_benchmark_trials trial on (trial.workspace_id, trial.factory_id, trial.session_id, trial.run_id) =
    (job.workspace_id, job.factory_id, job.session_id, job.run_id)
  where attempt.id = p_attempt_id and trial.id = p_trial_id and trial.status = 'success';
  if not found then return false; end if;
  if exists (select 1 from public.factory_benchmark_schedule_evaluations known
    where (known.trial_id, known.attempt_id) = (p_trial_id, p_attempt_id)) then return true; end if;
  if schedule.state <> 'active' or invocation.settled_at is not null
    or invocation.lease_expires_at <= clock_timestamp()
    or exists (select 1 from public.factory_judge_invocations started
      where started.attempt_id = p_attempt_id and started.started_at is not null)
  then return false; end if;

  perform internal.refresh_factory_benchmark_schedule_costs(schedule);
  if schedule.evaluation_reserve_usd >
    internal.factory_benchmark_schedule_available_usd(internal.factory_benchmark_schedule_snapshot(schedule))
  then return false; end if;
  insert into public.factory_benchmark_schedule_evaluations(attempt_id, trial_id, reserve_usd)
  values (p_attempt_id, p_trial_id, schedule.evaluation_reserve_usd);
  return true;
end;
$$;

revoke all on function internal.refresh_factory_benchmark_schedule_costs(public.factory_benchmark_schedules),
  internal.factory_benchmark_schedule_snapshot(public.factory_benchmark_schedules),
  internal.factory_benchmark_schedule_available_usd(jsonb),
  public.reserve_factory_benchmark_evaluation_attempt(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.reserve_factory_benchmark_evaluation_attempt(uuid, uuid) to service_role;
