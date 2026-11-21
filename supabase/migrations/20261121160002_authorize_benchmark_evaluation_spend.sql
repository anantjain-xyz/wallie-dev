create table internal.factory_benchmark_evaluation_blocks (
  attempt_id uuid primary key references public.factory_evaluation_attempts(id) on delete cascade,
  reason text not null check (reason in (
    'schedule_paused', 'schedule_canceled', 'evaluation_budget_exhausted', 'evaluation_budget_wait'
  ))
);
revoke all on internal.factory_benchmark_evaluation_blocks from public, anon, authenticated, service_role;

create function internal.factory_benchmark_evaluation_spend(schedule public.factory_benchmark_schedules)
returns table (
  spent_usd numeric, reserved_usd numeric, unknown_hold_usd numeric, unavailable_count bigint
) language sql stable set search_path = '' as $$
  select coalesce(sum(reservation.actual_usd), 0),
    coalesce(sum(reservation.reserve_usd) filter (where reservation.accounted_at is null
      or reservation.cost_provenance = 'unavailable'), 0),
    coalesce(sum(reservation.reserve_usd) filter (where reservation.cost_provenance = 'unavailable'), 0),
    count(*) filter (where reservation.cost_provenance = 'unavailable')
  from public.factory_benchmark_schedule_evaluations reservation
  join public.factory_benchmark_schedule_trials trial on trial.trial_id = reservation.trial_id
  where (trial.workspace_id, trial.factory_id, trial.experiment_id) =
    (schedule.workspace_id, schedule.factory_id, schedule.experiment_id);
$$;

create function internal.factory_benchmark_evaluation_budget_block(
  schedule public.factory_benchmark_schedules, evaluation_ceiling numeric
) returns text language sql stable set search_path = '' as $$
  select case
    when schedule.evaluation_reserve_usd <= 0 or evaluation_ceiling <= 0
      or schedule.evaluation_reserve_usd > evaluation_ceiling - scoring.spent_usd - scoring.unknown_hold_usd
      or schedule.evaluation_reserve_usd > schedule.budget_limit_usd - scoring.spent_usd - scoring.unknown_hold_usd
        - execution.spent_usd - execution.unknown_hold_usd
      then 'evaluation_budget_exhausted'
    when schedule.evaluation_reserve_usd > evaluation_ceiling - scoring.spent_usd - scoring.reserved_usd
      or schedule.evaluation_reserve_usd > schedule.budget_limit_usd - scoring.spent_usd - scoring.reserved_usd
        - execution.spent_usd - execution.reserved_usd
      then 'evaluation_budget_wait'
  end
  from internal.factory_benchmark_evaluation_spend(schedule) scoring
  cross join lateral (
    select coalesce(sum(reservation.actual_usd), 0) as spent_usd,
      coalesce(sum(reservation.reserve_usd) filter (where reservation.accounted_at is null
        or reservation.cost_provenance = 'unavailable'), 0) as reserved_usd,
      coalesce(sum(reservation.reserve_usd) filter (where reservation.cost_provenance = 'unavailable'), 0) as unknown_hold_usd
    from public.factory_benchmark_schedule_trials reservation
    where (reservation.workspace_id, reservation.factory_id, reservation.experiment_id) =
      (schedule.workspace_id, schedule.factory_id, schedule.experiment_id)
  ) execution;
$$;

create function internal.block_factory_benchmark_evaluation_attempt(
  job public.factory_evaluation_jobs, attempt public.factory_evaluation_attempts, p_reason text
) returns jsonb language plpgsql set search_path = '' as $$
begin
  insert into internal.factory_benchmark_evaluation_blocks(attempt_id, reason) values (attempt.id, p_reason);
  perform internal.settle_locked_factory_evaluation_attempt(job, attempt, case p_reason
    when 'schedule_canceled' then 'canceled'
    when 'evaluation_budget_exhausted' then 'permanent_failure'
    else 'retryable_failure'
  end);
  return jsonb_build_object('status', 'benchmark_blocked', 'reason', p_reason);
end;
$$;

-- A plan-aware evaluation is reserved exclusively by the live judge permit.
-- Preserve the earlier reservation RPC for legacy unscored fixture bridges.
alter function public.reserve_factory_benchmark_evaluation_attempt(uuid,uuid) set schema internal;
revoke all on function internal.reserve_factory_benchmark_evaluation_attempt(uuid,uuid)
  from public, anon, authenticated, service_role;
create function public.reserve_factory_benchmark_evaluation_attempt(p_trial_id uuid, p_attempt_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if exists (select 1 from public.factory_benchmark_schedule_trials trial
    join public.factory_benchmark_evaluation_plans plan on (plan.workspace_id, plan.factory_id, plan.experiment_id) =
      (trial.workspace_id, trial.factory_id, trial.experiment_id)
    where trial.trial_id = p_trial_id) then return false; end if;
  return internal.reserve_factory_benchmark_evaluation_attempt(p_trial_id, p_attempt_id);
end;
$$;
revoke all on function public.reserve_factory_benchmark_evaluation_attempt(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_factory_benchmark_evaluation_attempt(uuid,uuid) to service_role;

alter function internal.factory_judge_invocation_plan(uuid,uuid,uuid,uuid,uuid,boolean)
  rename to factory_production_judge_invocation_plan;
revoke all on function internal.factory_production_judge_invocation_plan(uuid,uuid,uuid,uuid,uuid,boolean)
  from public, anon, authenticated, service_role;

create function internal.factory_judge_invocation_plan(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid,
  p_include_content boolean
) returns jsonb language plpgsql set search_path = '' as $$
declare
  job public.factory_evaluation_jobs;
  sample public.factory_scorer_sample_receipts;
  attempt public.factory_evaluation_attempts;
  schedule public.factory_benchmark_schedules;
  output internal.factory_benchmark_evaluation_outputs;
  profile public.factory_judge_profile_revisions;
  definition jsonb;
  evidence jsonb;
begin
  select * into job from public.factory_evaluation_jobs exact
    where (exact.workspace_id, exact.factory_id, exact.id) = (p_workspace_id, p_factory_id, p_job_id);
  select * into sample from public.factory_scorer_sample_receipts exact
    where (exact.workspace_id, exact.factory_id, exact.id) = (p_workspace_id, p_factory_id, job.sample_receipt_id);
  if sample.benchmark_trial_id is null then
    return internal.factory_production_judge_invocation_plan(
      p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id, p_include_content);
  end if;

  -- The job and sample identities cannot change. Use the ordinary evaluator
  -- scope and lane locks, then the experiment mutex before the job/attempt.
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then return jsonb_build_object('status', 'stale_claim'); end if;
  perform 1 from public.factories factory
    where (factory.workspace_id, factory.id, factory.status) = (p_workspace_id, p_factory_id, 'active') for share;
  if not found then return jsonb_build_object('status', 'profile_unavailable'); end if;
  perform 1 from public.factory_evaluation_lanes lane where lane.workspace_id = p_workspace_id for share;
  if not found then return jsonb_build_object('status', 'stale_claim'); end if;

  select control.* into schedule from public.factory_benchmark_schedule_trials scheduled
  join public.factory_benchmark_schedules control on (control.workspace_id, control.factory_id, control.experiment_id) =
    (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id)
  where (scheduled.workspace_id, scheduled.factory_id, scheduled.trial_id, scheduled.run_id) =
    (p_workspace_id, p_factory_id, sample.benchmark_trial_id, job.run_id)
  for update of control;
  if not found then return jsonb_build_object('status', 'stale_claim'); end if;

  attempt := internal.lock_factory_evaluation_claim(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id);
  if attempt.id is null then return jsonb_build_object('status', 'stale_claim'); end if;
  if exists (select 1 from public.factory_judge_invocations invocation where invocation.attempt_id = attempt.id) then
    return jsonb_build_object('status', 'already_started');
  end if;
  if schedule.state <> 'active' then
    return internal.block_factory_benchmark_evaluation_attempt(job, attempt,
      case schedule.state when 'paused' then 'schedule_paused' else 'schedule_canceled' end);
  end if;

  select * into output from internal.factory_benchmark_evaluation_outputs exact
  where (exact.workspace_id, exact.factory_id, exact.experiment_id, exact.trial_id, exact.session_id, exact.run_id,
    exact.attempt_count, exact.output_commit_sha, exact.result_digest) =
    (p_workspace_id, p_factory_id, schedule.experiment_id, sample.benchmark_trial_id, job.session_id, job.run_id,
      sample.attempt_count, job.target_commit_sha, sample.benchmark_result_digest)
    and (sample.session_id, sample.run_id, sample.scorer_revision_id, sample.target_commit_sha) =
      (job.session_id, job.run_id, job.scorer_revision_id, job.target_commit_sha);
  if not found or not internal.factory_benchmark_evaluation_source_available(output) then
    return jsonb_build_object('status', 'evidence_unavailable');
  end if;

  select scorer.definition into definition from public.factory_benchmark_evaluation_dimensions selected
  join public.factory_scorer_revisions scorer on (scorer.workspace_id, scorer.factory_id, scorer.id) =
    (selected.workspace_id, selected.factory_id, selected.scorer_revision_id)
  where (selected.workspace_id, selected.factory_id, selected.experiment_id, selected.scorer_revision_id) =
    (p_workspace_id, p_factory_id, output.experiment_id, job.scorer_revision_id);
  if not found then return jsonb_build_object('status', 'evidence_unavailable'); end if;

  evidence := internal.factory_benchmark_evaluation_evidence(output, definition, false);
  if jsonb_array_length(evidence) <> jsonb_array_length(definition->'requiredEvidence')
    or evidence is distinct from sample.evidence then
    return jsonb_build_object('status', 'missing_evidence', 'missing_evidence', definition->'requiredEvidence');
  end if;

  select approved.* into profile from internal.factory_judge_credential_heads head
  join public.factory_judge_profile_revisions approved on (approved.workspace_id, approved.id) =
    (head.workspace_id, head.profile_revision_id)
  where head.workspace_id = p_workspace_id and approved.enabled;
  if not found then return jsonb_build_object('status', 'profile_unavailable'); end if;

  if attempt.lease_expires_at <= clock_timestamp() then return jsonb_build_object('status', 'stale_claim'); end if;
  return jsonb_build_object('status', 'ready', 'profile', to_jsonb(profile), 'definition', definition,
    'sample_receipt_id', sample.id, 'scorer_revision_id', job.scorer_revision_id, 'target_commit_sha', job.target_commit_sha,
    'run_id', job.run_id, 'session_id', job.session_id,
    'benchmark_source', jsonb_build_object('trial_id', output.trial_id, 'result_digest', output.result_digest),
    'evidence', case when p_include_content then internal.factory_benchmark_evaluation_evidence(output, definition, true)
      else evidence end);
end;
$$;

create or replace function public.begin_factory_judge_invocation(
  p_workspace_id uuid, p_factory_id uuid, p_job_id uuid, p_attempt_id uuid, p_lease_id uuid,
  p_profile_revision_id uuid, p_evidence_digest text, p_worker_runtime text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  plan jsonb;
  cipher text;
  benchmark_trial_id uuid;
  schedule public.factory_benchmark_schedules;
  job public.factory_evaluation_jobs;
  attempt public.factory_evaluation_attempts;
  evaluation_ceiling numeric;
  budget_block text;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_profile_revision_id is null or p_evidence_digest is null or p_evidence_digest !~ '^[a-f0-9]{64}$'
    or p_worker_runtime is null or p_worker_runtime not in ('node', 'workerd') then
    raise exception 'Invalid judge invocation identity.' using errcode = '22023';
  end if;
  plan := internal.factory_judge_invocation_plan(p_workspace_id, p_factory_id, p_job_id, p_attempt_id, p_lease_id, false);
  if plan->>'status' <> 'ready' then return plan; end if;
  if plan#>>'{profile,id}' is distinct from p_profile_revision_id::text then
    return jsonb_build_object('status', 'profile_unavailable');
  end if;

  benchmark_trial_id := (plan#>>'{benchmark_source,trial_id}')::uuid;
  if benchmark_trial_id is not null then
    -- The plan already owns the schedule, job, and attempt locks. Refresh
    -- receipts before comparing both ceilings, then reserve this attempt only.
    select control.* into strict schedule from public.factory_benchmark_schedule_trials scheduled
    join public.factory_benchmark_schedules control on (control.workspace_id, control.factory_id, control.experiment_id) =
      (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id)
    where scheduled.trial_id = benchmark_trial_id;
    select frozen.budget_limit_usd into strict evaluation_ceiling from public.factory_benchmark_evaluation_plans frozen
    where (frozen.workspace_id, frozen.factory_id, frozen.experiment_id) =
      (schedule.workspace_id, schedule.factory_id, schedule.experiment_id);
    select * into strict attempt from public.factory_evaluation_attempts exact where exact.id = p_attempt_id;
    select * into strict job from public.factory_evaluation_jobs exact where exact.id = p_job_id;
    perform internal.refresh_factory_benchmark_schedule_costs(schedule);
    if attempt.lease_expires_at <= clock_timestamp() then return jsonb_build_object('status', 'stale_claim'); end if;
    budget_block := internal.factory_benchmark_evaluation_budget_block(schedule, evaluation_ceiling);
    if budget_block is not null then
      return internal.block_factory_benchmark_evaluation_attempt(job, attempt, budget_block);
    end if;
    insert into public.factory_benchmark_schedule_evaluations(attempt_id, trial_id, reserve_usd)
    values (p_attempt_id, benchmark_trial_id, schedule.evaluation_reserve_usd);
  end if;

  select head.encrypted_api_key into strict cipher from internal.factory_judge_credential_heads head
    where (head.workspace_id, head.profile_revision_id) = (p_workspace_id, p_profile_revision_id);
  insert into public.factory_judge_invocations(
    attempt_id, workspace_id, factory_id, job_id, profile_revision_id, worker_runtime, evidence_digest, status, started_at
  ) values (
    p_attempt_id, p_workspace_id, p_factory_id, p_job_id, p_profile_revision_id, p_worker_runtime,
    p_evidence_digest, 'started', clock_timestamp()
  ) on conflict (attempt_id) do nothing;
  if not found then
    if benchmark_trial_id is not null then raise exception 'The benchmark judge authorization changed.' using errcode = 'PT409'; end if;
    return jsonb_build_object('status', 'already_started');
  end if;
  return jsonb_build_object('status', 'authorized', 'encrypted_api_key', cipher);
end;
$$;

revoke all on function internal.factory_benchmark_evaluation_spend(public.factory_benchmark_schedules),
  internal.factory_benchmark_evaluation_budget_block(public.factory_benchmark_schedules,numeric),
  internal.block_factory_benchmark_evaluation_attempt(public.factory_evaluation_jobs,public.factory_evaluation_attempts,text),
  internal.factory_judge_invocation_plan(uuid,uuid,uuid,uuid,uuid,boolean)
  from public, anon, authenticated, service_role;
