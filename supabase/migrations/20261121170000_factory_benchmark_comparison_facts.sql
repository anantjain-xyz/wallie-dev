create index factory_benchmark_experiments_comparison_order_idx
  on public.factory_benchmark_experiments(workspace_id, factory_id, created_at desc, id desc);

-- The service supplies the signed-in actor. Archived factories retain their
-- manager read scope, while deleting workspaces and revoked grants do not.
create function internal.factory_benchmark_comparison_manager(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns uuid language sql stable set search_path = '' as $$
  select member.id from public.workspaces workspace
  join public.factories factory on (factory.workspace_id, factory.id) = (workspace.id, p_factory_id)
  join public.workspace_members member on (member.workspace_id, member.user_id) = (workspace.id, p_actor_user_id)
  where workspace.id = p_workspace_id and workspace.deletion_requested_at is null
    and member.kind = 'human' and member.is_active and (
      member.role in ('owner', 'admin') or exists (
        select 1 from public.factory_members grant_row
        where (grant_row.workspace_id, grant_row.factory_id, grant_row.member_id) =
          (workspace.id, factory.id, member.id) and grant_row.role = 'manager' and grant_row.revoked_at is null
      )
    );
$$;

-- Start from every immutable matrix identity. A claim alone is not a
-- started execution and a missing execution is never dropped from the grid.
create function internal.factory_benchmark_comparison_trial_facts(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_as_of timestamptz
) returns table (
  trial_id uuid, task_id uuid, task_revision_id uuid, task_revision_number integer, task_name text,
  candidate_key text, candidate_position integer, repetition integer, seed integer, timeout_ms integer,
  eligibility text, eligibility_reason text, disposition text, reason text, admitted boolean, started boolean,
  run_id uuid, started_at timestamptz, finished_at timestamptz, deadline_at timestamptz, wall_runtime_ms bigint,
  deadline_elapsed boolean, runner_revision text, actual_runtime text, model_provider text, model_name text,
  result_digest text, evaluation_commit_sha text, execution_provenance text, execution_actual_usd numeric,
  execution_reserved_usd numeric
) language sql stable set search_path = '' as $$
  with admitted as (
    select count(*) as count
    from public.factory_benchmark_schedule_trials reservation
    where (reservation.workspace_id, reservation.factory_id, reservation.experiment_id) =
      (p_workspace_id, p_factory_id, p_experiment_id)
  ), facts as (
    select frozen.trial_id, frozen.task_id, frozen.task_revision_id,
      task.revision_number, task.name, frozen.candidate_key, candidate.comparison_position, frozen.repetition, frozen.seed, frozen.timeout_ms,
      frozen.replay_eligibility, frozen.eligibility_reason,
      case
        when frozen.replay_eligibility <> 'eligible' then 'excluded'
        when trial.status = 'success' and result.trial_id is not null and run.status = 'success' then 'succeeded'
        when trial.status = 'success' or (reservation.trial_id is not null and (trial.id is null or run.id is null)) then 'unavailable'
        when trial.status = 'error' and trial.failure_code = 'deadline_elapsed' then 'timed_out'
        when trial.status = 'error' then 'failed'
        when trial.status = 'canceled' or (trial.id is null and schedule.state = 'canceled') then 'canceled'
        when trial.id is null and admitted.count >= schedule.max_admitted_trials then 'unavailable'
        when trial.status = 'running' then 'running'
        else 'pending'
      end as disposition,
      case
        when frozen.replay_eligibility <> 'eligible' then coalesce(frozen.eligibility_reason, frozen.replay_eligibility)
        when trial.status = 'success' then case when result.trial_id is null or run.status is distinct from 'success' then 'result_unavailable' end
        when reservation.trial_id is not null and (trial.id is null or run.id is null) then 'execution_unavailable'
        when trial.status = 'error' then trial.failure_code
        when trial.status = 'canceled' then 'trial_canceled'
        when trial.id is null and schedule.state = 'canceled' then 'schedule_canceled'
        when trial.id is null and admitted.count >= schedule.max_admitted_trials then 'expansion_limit_reached'
        when trial.status = 'running' then null
        when factory.status = 'archived' then 'factory_archived'
        when schedule.state = 'paused' then 'schedule_paused'
        when schedule.experiment_id is null then 'schedule_unconfigured'
        when trial.id is null then coalesce(schedule.admission_issue, 'trial_not_admitted')
        else 'trial_queued'
      end as reason,
      reservation.trial_id is not null as admitted, run.started_at is not null as started, reservation.run_id, run.started_at,
      trial.finished_at, trial.deadline_at,
      case when run.finished_at >= run.started_at then floor(extract(epoch from (run.finished_at - run.started_at)) * 1000)::bigint end
        as wall_runtime_ms,
      coalesce(trial.failure_code = 'deadline_elapsed', false)
        or coalesce(trial.deadline_at <= coalesce(trial.finished_at, p_as_of), false) as deadline_elapsed,
      case when run.started_at is not null then trial.runner_revision end as runner_revision,
      case when run.started_at is not null then result.runtime end as actual_runtime,
      case when run.started_at is not null then run.model_provider end as model_provider,
      case when run.started_at is not null then run.model_name end as model_name,
      case when run.status = 'success' then result.result_digest end as result_digest,
      case when run.status = 'success' then result.output_commit_sha end as evaluation_commit_sha,
      case
        when reservation.trial_id is null then null
        when reservation.accounted_at is not null then reservation.cost_provenance
        when trial.status in ('success', 'error', 'canceled') and run.status in ('success', 'error', 'canceled') then case
          when run.started_at is null then 'never_started'
          when run.usage_finalized_at is not null and run.cost_provenance in ('measured', 'estimated')
            and run.total_cost_usd >= 0 and run.total_cost_usd < 'Infinity'::numeric then run.cost_provenance
          else 'unavailable'
        end
        else 'pending'
      end as execution_provenance,
      case when reservation.accounted_at is not null then reservation.actual_usd else run.total_cost_usd end as observed_usd,
      reservation.reserve_usd
    from public.factory_benchmark_experiment_trials frozen
    join public.factories factory on (factory.workspace_id, factory.id) = (frozen.workspace_id, frozen.factory_id)
    join public.factory_benchmark_task_revisions task on (task.workspace_id, task.factory_id, task.task_id, task.id) =
      (frozen.workspace_id, frozen.factory_id, frozen.task_id, frozen.task_revision_id)
    join public.factory_benchmark_experiment_candidates candidate
      on (candidate.workspace_id, candidate.factory_id, candidate.experiment_id, candidate.candidate_key) =
        (frozen.workspace_id, frozen.factory_id, frozen.experiment_id, frozen.candidate_key)
    left join public.factory_benchmark_schedules schedule on (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
      (frozen.workspace_id, frozen.factory_id, frozen.experiment_id)
    left join public.factory_benchmark_schedule_trials reservation
      on (reservation.workspace_id, reservation.factory_id, reservation.experiment_id, reservation.trial_id) =
        (frozen.workspace_id, frozen.factory_id, frozen.experiment_id, frozen.trial_id)
    left join public.factory_benchmark_trials trial
      on (trial.workspace_id, trial.factory_id, trial.id, trial.run_id, trial.task_revision_id) =
        (reservation.workspace_id, reservation.factory_id, reservation.trial_id, reservation.run_id, frozen.task_revision_id)
    left join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
      (trial.workspace_id, trial.session_id, trial.run_id)
    left join public.factory_benchmark_trial_results result
      on (result.workspace_id, result.factory_id, result.trial_id, result.run_id) =
        (trial.workspace_id, trial.factory_id, trial.id, trial.run_id) and trial.status = 'success'
    cross join admitted
    where (frozen.workspace_id, frozen.factory_id, frozen.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id)
  )
  select trial_id, task_id, task_revision_id, revision_number, name, candidate_key, comparison_position,
    repetition, seed, timeout_ms, replay_eligibility, eligibility_reason, disposition, reason, admitted, started, run_id,
    started_at, finished_at, deadline_at, wall_runtime_ms, deadline_elapsed, runner_revision, actual_runtime, model_provider,
    model_name, result_digest, evaluation_commit_sha, execution_provenance,
    case when execution_provenance in ('measured', 'estimated') then observed_usd end,
    case when execution_provenance in ('pending', 'unavailable') then reserve_usd else 0 end
  from facts;
$$;

-- Scope the existing M07 evaluator job through its exact neutral result and
-- selected rubric. This projection deliberately contains no evidence payload.
create function internal.factory_benchmark_comparison_evaluation_jobs(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid
) returns table (
  trial_id uuid, candidate_key text, run_id uuid, scorer_revision_id uuid, job_id uuid, job_status text,
  sample_receipt_id uuid, target_commit_sha text
) language sql stable set search_path = '' as $$
  select output.trial_id, output.candidate_key, output.run_id, job.scorer_revision_id, job.id, job.status,
    sample.id, output.output_commit_sha
  from internal.factory_benchmark_evaluation_outputs output
  join public.factory_scorer_sample_receipts sample
    on (sample.workspace_id, sample.factory_id, sample.benchmark_trial_id, sample.benchmark_result_digest,
      sample.run_id, sample.session_id, sample.target_commit_sha) =
      (output.workspace_id, output.factory_id, output.trial_id, output.result_digest, output.run_id,
        output.session_id, output.output_commit_sha)
  join public.factory_benchmark_evaluation_dimensions dimension on
    (dimension.workspace_id, dimension.factory_id, dimension.experiment_id, dimension.scorer_revision_id) =
    (output.workspace_id, output.factory_id, output.experiment_id, sample.scorer_revision_id)
  join public.factory_evaluation_jobs job on (job.workspace_id, job.factory_id, job.run_id, job.session_id,
    job.scorer_revision_id, job.sample_receipt_id, job.target_commit_sha) =
    (output.workspace_id, output.factory_id, output.run_id, output.session_id, dimension.scorer_revision_id,
      sample.id, output.output_commit_sha) and job.source_attempt_id is null
  where (output.workspace_id, output.factory_id, output.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id);
$$;

create function internal.factory_benchmark_comparison_evaluation_costs(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid
) returns table (trial_id uuid, candidate_key text, provenance text, actual_usd numeric, reserved_usd numeric)
language sql stable set search_path = '' as $$
  with facts as (
    select job.trial_id, job.candidate_key,
      case
        when reservation.accounted_at is not null then reservation.cost_provenance
        when receipt.attempt_id is not null then case
          when receipt.started_at is null then 'never_started'
          else receipt.cost_provenance
        end
        when attempt.settled_at is not null then case
          when invocation.started_at is null then 'never_started' else 'unavailable'
        end
        else 'pending'
      end as provenance,
      coalesce(reservation.actual_usd, receipt.cost_usd) as observed_usd,
      reservation.reserve_usd
    from internal.factory_benchmark_comparison_evaluation_jobs(p_workspace_id, p_factory_id, p_experiment_id) job
    join public.factory_evaluation_attempts attempt on (attempt.workspace_id, attempt.factory_id, attempt.job_id) =
      (p_workspace_id, p_factory_id, job.job_id)
    left join public.factory_evaluation_receipts receipt on (receipt.workspace_id, receipt.factory_id, receipt.job_id,
      receipt.attempt_id, receipt.sample_receipt_id, receipt.run_id, receipt.scorer_revision_id, receipt.target_commit_sha) =
      (p_workspace_id, p_factory_id, job.job_id, attempt.id, job.sample_receipt_id, job.run_id, job.scorer_revision_id, job.target_commit_sha)
    left join public.factory_judge_invocations invocation on (invocation.workspace_id, invocation.factory_id,
      invocation.job_id, invocation.attempt_id) = (p_workspace_id, p_factory_id, job.job_id, attempt.id)
    left join public.factory_benchmark_schedule_evaluations reservation on (reservation.trial_id, reservation.attempt_id) =
      (job.trial_id, attempt.id)
  )
  select facts.trial_id, facts.candidate_key, facts.provenance,
    case when facts.provenance in ('measured', 'estimated') then facts.observed_usd end,
    case when facts.provenance in ('pending', 'unavailable') then coalesce(facts.reserve_usd, 0) else 0 end
  from facts;
$$;

create function internal.factory_benchmark_comparison_cost_bucket(
  p_measured numeric default 0, p_estimated numeric default 0, p_reserved numeric default 0, p_unknown_hold numeric default 0,
  p_measured_count bigint default 0, p_estimated_count bigint default 0, p_unknown_count bigint default 0,
  p_pending_count bigint default 0, p_never_started_count bigint default 0
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'measuredUsd', trim_scale(p_measured)::text, 'estimatedUsd', trim_scale(p_estimated)::text,
    'knownUsd', trim_scale(p_measured + p_estimated)::text, 'reservedUsd', trim_scale(p_reserved)::text,
    'unavailableHoldUsd', trim_scale(p_unknown_hold)::text, 'measuredAttemptCount', p_measured_count,
    'estimatedAttemptCount', p_estimated_count, 'unavailableAttemptCount', p_unknown_count,
    'pendingAttemptCount', p_pending_count, 'neverStartedAttemptCount', p_never_started_count
  );
$$;
create function internal.factory_benchmark_comparison_spend(
  p_execution jsonb default null, p_evaluation jsonb default null, p_combined jsonb default null,
  p_unknown_trial_count bigint default 0
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('execution', coalesce(p_execution, internal.factory_benchmark_comparison_cost_bucket()),
    'evaluation', coalesce(p_evaluation, internal.factory_benchmark_comparison_cost_bucket()),
    'combined', coalesce(p_combined, internal.factory_benchmark_comparison_cost_bucket()),
    'costUnavailableTrialCount', coalesce(p_unknown_trial_count, 0));
$$;

revoke all on function
  internal.factory_benchmark_comparison_manager(uuid,uuid,uuid),
  internal.factory_benchmark_comparison_trial_facts(uuid,uuid,uuid,timestamptz),
  internal.factory_benchmark_comparison_evaluation_jobs(uuid,uuid,uuid),
  internal.factory_benchmark_comparison_evaluation_costs(uuid,uuid,uuid),
  internal.factory_benchmark_comparison_cost_bucket(numeric,numeric,numeric,numeric,bigint,bigint,bigint,bigint,bigint),
  internal.factory_benchmark_comparison_spend(jsonb,jsonb,jsonb,bigint)
from public, anon, authenticated, service_role;
