create function internal.factory_benchmark_evaluation_claimable(p_trial_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((
    select schedule.state = 'active' and internal.factory_benchmark_evaluation_budget_block(schedule, plan.budget_limit_usd)
      is distinct from 'evaluation_budget_wait'
      and not exists (
        -- The workspace's evaluation lane serializes claims. Allow a new
        -- claim once the prior one has a visible reservation or has settled.
        select 1 from public.factory_benchmark_schedule_trials sibling
        join public.factory_scorer_sample_receipts sample on sample.benchmark_trial_id = sibling.trial_id
        join public.factory_evaluation_jobs job on (job.workspace_id, job.factory_id, job.sample_receipt_id) =
          (sample.workspace_id, sample.factory_id, sample.id)
        join public.factory_evaluation_attempts attempt on (attempt.job_id, attempt.attempt_number) = (job.id, job.attempt_count)
        where (sibling.workspace_id, sibling.factory_id, sibling.experiment_id) =
          (trial.workspace_id, trial.factory_id, trial.experiment_id)
          and job.status = 'claimed' and attempt.settled_at is null and attempt.lease_expires_at > statement_timestamp()
          and not exists (select 1 from public.factory_benchmark_schedule_evaluations reservation
            where reservation.attempt_id = attempt.id)
      )
    from public.factory_benchmark_schedule_trials trial
    join public.factory_benchmark_schedules schedule on (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
      (trial.workspace_id, trial.factory_id, trial.experiment_id)
    join public.factory_benchmark_evaluation_plans plan on (plan.workspace_id, plan.factory_id, plan.experiment_id) =
      (trial.workspace_id, trial.factory_id, trial.experiment_id)
    where trial.trial_id = p_trial_id
  ), false);
$$;

create function internal.cancel_factory_benchmark_evaluation_jobs(p_limit integer)
returns void language plpgsql set search_path = '' as $$
declare
  job public.factory_evaluation_jobs;
  attempt public.factory_evaluation_attempts;
begin
  for job in
    select queued.* from public.factory_evaluation_jobs queued
    join public.factory_scorer_sample_receipts sample on (sample.workspace_id, sample.factory_id, sample.id) =
      (queued.workspace_id, queued.factory_id, queued.sample_receipt_id)
    join public.factory_benchmark_schedule_trials trial on trial.trial_id = sample.benchmark_trial_id
    join public.factory_benchmark_schedules schedule on (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
      (trial.workspace_id, trial.factory_id, trial.experiment_id)
    where schedule.state = 'canceled' and queued.status in ('queued', 'claimed')
    order by queued.created_at, queued.id
    limit p_limit for update of queued skip locked
  loop
    if job.status = 'claimed' then
      select * into strict attempt from public.factory_evaluation_attempts claimed
      where (claimed.job_id, claimed.attempt_number) = (job.id, job.attempt_count) and claimed.settled_at is null
      for update;
      perform internal.block_factory_benchmark_evaluation_attempt(job, attempt, 'schedule_canceled');
    else
      update public.factory_evaluation_jobs
      set status = 'canceled', available_at = null, finished_at = clock_timestamp() where id = job.id;
    end if;
  end loop;
end;
$$;

alter function public.reconcile_factory_benchmark_evaluations(integer) set schema internal;
revoke all on function internal.reconcile_factory_benchmark_evaluations(integer) from public, anon, authenticated, service_role;

create function public.reconcile_factory_benchmark_evaluations(p_limit integer default 25)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if not coalesce(p_limit between 1 and 100, false) then
    raise exception 'Invalid benchmark evaluation batch size.' using errcode = '22023';
  end if;
  perform internal.cancel_factory_benchmark_evaluation_jobs(p_limit);
  return internal.reconcile_factory_benchmark_evaluations(p_limit);
end;
$$;

revoke all on function public.reconcile_factory_benchmark_evaluations(integer),
  internal.factory_benchmark_evaluation_claimable(uuid), internal.cancel_factory_benchmark_evaluation_jobs(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_factory_benchmark_evaluations(integer) to service_role;

create or replace function internal.claim_factory_evaluation_job(p_require_profile boolean)
returns table (
  job_id uuid, workspace_id uuid, factory_id uuid, session_id uuid, run_id uuid, scorer_revision_id uuid,
  sample_receipt_id uuid, target_commit_sha text, attempt_id uuid, attempt_number integer,
  lease_id uuid, lease_expires_at timestamptz
) language plpgsql set search_path = '' as $$
declare
  candidate record;
  job public.factory_evaluation_jobs;
  attempt public.factory_evaluation_attempts;
  capacity integer;
  checked_at timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  for candidate in
    select ready.id, lane.workspace_id, ready.factory_id, ready.benchmark_trial_id
    from public.factory_evaluation_lanes lane
    join public.workspaces workspace on workspace.id = lane.workspace_id and workspace.deletion_requested_at is null
    cross join lateral (
      select queued.id, queued.factory_id, queued.available_at, sample.benchmark_trial_id
      from public.factory_evaluation_jobs queued
      join public.factory_scorer_sample_receipts sample on (sample.workspace_id, sample.factory_id, sample.id) =
        (queued.workspace_id, queued.factory_id, queued.sample_receipt_id)
      join public.factories factory on (factory.workspace_id, factory.id) = (queued.workspace_id, queued.factory_id)
        and factory.status = 'active'
      where queued.workspace_id = lane.workspace_id and queued.status = 'queued' and queued.available_at <= statement_timestamp()
        and not internal.is_factory_evaluation_scorer_paused(queued.workspace_id, queued.factory_id, queued.scorer_revision_id)
        and (sample.benchmark_trial_id is null or
          (p_require_profile and internal.factory_benchmark_evaluation_claimable(sample.benchmark_trial_id)))
      order by (sample.benchmark_trial_id is not null), queued.available_at, queued.id limit 1
    ) ready
    where not lane.paused
      and (not p_require_profile or exists (
        select 1 from internal.factory_judge_credential_heads head
        join public.factory_judge_profile_revisions profile
          on (profile.workspace_id, profile.id) = (head.workspace_id, head.profile_revision_id) and profile.enabled
        where head.workspace_id = lane.workspace_id
      ))
      and not exists (
      select 1 from public.factory_evaluation_attempts live
      where live.workspace_id = lane.workspace_id and live.settled_at is null and live.lease_expires_at > statement_timestamp()
      order by live.lease_expires_at desc offset (lane.max_concurrent - 1) limit 1
    )
    order by (ready.benchmark_trial_id is not null), ready.available_at, ready.id limit 25
  loop
    -- Serialize with lifecycle changes, then take the separate capacity mutex
    -- before the job. This path never locks the production session, job or run.
    perform 1 from public.workspaces workspace
      where workspace.id = candidate.workspace_id and workspace.deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.factories factory
      where (factory.workspace_id, factory.id) = (candidate.workspace_id, candidate.factory_id)
        and factory.status = 'active' for share skip locked;
    if not found then continue; end if;
    select lane.max_concurrent into capacity from public.factory_evaluation_lanes lane
      where lane.workspace_id = candidate.workspace_id and not lane.paused for no key update skip locked;
    if not found then continue; end if;

    if p_require_profile and not exists (
      select 1 from internal.factory_judge_credential_heads head
      join public.factory_judge_profile_revisions profile
        on (profile.workspace_id, profile.id) = (head.workspace_id, head.profile_revision_id) and profile.enabled
      where head.workspace_id = candidate.workspace_id
    ) then continue; end if;

    select * into job from public.factory_evaluation_jobs current_job
      where current_job.id = candidate.id and current_job.status = 'queued' and current_job.available_at <= clock_timestamp()
      for update skip locked;
    if not found then continue; end if;
    -- Pause takes the conflicting factory lock through assert_factory_manager.
    -- Recheck after locking in case it committed during head selection.
    if internal.is_factory_evaluation_scorer_paused(job.workspace_id, job.factory_id, job.scorer_revision_id)
      then continue; end if;
    if candidate.benchmark_trial_id is not null and
      not internal.factory_benchmark_evaluation_claimable(candidate.benchmark_trial_id) then continue; end if;
    checked_at := clock_timestamp();
    if exists (
      select 1 from public.factory_evaluation_attempts live
      where live.workspace_id = candidate.workspace_id and live.settled_at is null and live.lease_expires_at > checked_at
      order by live.lease_expires_at desc offset (capacity - 1) limit 1
    ) then continue; end if;

    update public.factory_evaluation_jobs current_job
      set status = 'claimed', attempt_count = job.attempt_count + 1, available_at = null
      where current_job.id = job.id returning * into job;
    insert into public.factory_evaluation_attempts(
      job_id, workspace_id, factory_id, attempt_number, claimed_at, lease_expires_at
    ) values (job.id, job.workspace_id, job.factory_id, job.attempt_count, checked_at, checked_at + interval '90 seconds')
    returning * into attempt;
    return query select job.id, job.workspace_id, job.factory_id, job.session_id, job.run_id,
      job.scorer_revision_id, job.sample_receipt_id, job.target_commit_sha, attempt.id, attempt.attempt_number,
      attempt.lease_id, attempt.lease_expires_at;
    return;
  end loop;
end;
$$;

create or replace function public.list_factory_evaluation_receipts(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_job_id uuid default null, p_limit integer default 25,
  p_before_finished_at timestamptz default null, p_before_attempt_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; usage jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if not internal.can_read_factory_evaluation_receipts(p_workspace_id, p_factory_id, p_actor_user_id) then
    raise exception 'Evaluation factory is unavailable.' using errcode = 'P0002';
  end if;
  if p_limit is null or p_limit not between 1 and 100
    or (p_before_finished_at is null) <> (p_before_attempt_id is null)
    or not isfinite(p_before_finished_at) then
    raise exception 'Invalid evaluation receipt page.' using errcode = '22023';
  end if;

  -- An exact job has at most six attempts. Include its full visible aggregate
  -- independently of the page cursor, preserving unknown totals per axis.
  if p_job_id is not null then
    select jsonb_build_object(
      'attempt_count', count(*),
      'input_tokens', case when bool_and(receipt.token_provenance <> 'unavailable') then sum(receipt.input_tokens) end,
      'output_tokens', case when bool_and(receipt.token_provenance <> 'unavailable') then sum(receipt.output_tokens) end,
      'token_unavailable_count', count(*) filter (where receipt.token_provenance = 'unavailable'),
      'token_estimated_count', count(*) filter (where receipt.token_provenance = 'estimated'),
      'cost_usd', case when bool_and(receipt.cost_provenance <> 'unavailable') then sum(receipt.cost_usd) end,
      'cost_unavailable_count', count(*) filter (where receipt.cost_provenance = 'unavailable'),
      'cost_estimated_count', count(*) filter (where receipt.cost_provenance = 'estimated')
    ) into usage
    from public.factory_evaluation_receipts receipt
    join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
      (receipt.workspace_id, receipt.session_id, receipt.run_id)
    join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) =
      (receipt.workspace_id, receipt.factory_id, run.session_id) and owner.execution_purpose = 'production'
    where (receipt.workspace_id, receipt.factory_id, receipt.job_id) = (p_workspace_id, p_factory_id, p_job_id);
  end if;

  with page as materialized (
    select receipt as item, receipt.finished_at, receipt.attempt_id
    from public.factory_evaluation_receipts receipt
    join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
      (receipt.workspace_id, receipt.session_id, receipt.run_id)
    join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) =
      (receipt.workspace_id, receipt.factory_id, run.session_id) and owner.execution_purpose = 'production'
    where (receipt.workspace_id, receipt.factory_id) = (p_workspace_id, p_factory_id)
      and (p_job_id is null or receipt.job_id = p_job_id)
      and (p_before_finished_at is null or (receipt.finished_at, receipt.attempt_id) < (p_before_finished_at, p_before_attempt_id))
    order by receipt.finished_at desc, receipt.attempt_id desc limit p_limit + 1
  ), visible as materialized (
    select * from page order by finished_at desc, attempt_id desc limit p_limit
  ), boundary as (
    select visible.finished_at, visible.attempt_id from visible
    where (select count(*) from page) > p_limit
    order by visible.finished_at, visible.attempt_id limit 1
  )
  select jsonb_build_object(
    'receipts', coalesce((select jsonb_agg(internal.project_factory_evaluation_receipt(item)
      order by finished_at desc, attempt_id desc) from visible), '[]'),
    'usage', usage,
    'next_finished_at', (select finished_at from boundary),
    'next_attempt_id', (select attempt_id from boundary)
  ) into result;
  return result;
end;
$$;

create or replace function internal.read_factory_evaluation_review_receipt(
  p_workspace_id uuid, p_factory_id uuid, p_attempt_id uuid
) returns public.factory_evaluation_receipts language sql stable set search_path = '' as $$
  select receipt
  from public.factory_evaluation_receipts receipt
  join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
    (receipt.workspace_id, receipt.session_id, receipt.run_id)
  join public.sessions session on (session.workspace_id, session.factory_id, session.id) =
    (receipt.workspace_id, receipt.factory_id, receipt.session_id)
  where (receipt.workspace_id, receipt.factory_id, receipt.attempt_id) =
    (p_workspace_id, p_factory_id, p_attempt_id) and session.execution_purpose = 'production'
$$;

alter function public.list_factory_run_score_results(uuid,uuid,uuid,uuid) set schema internal;
revoke all on function internal.list_factory_run_score_results(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;
create function public.list_factory_run_score_results(
  p_workspace_id uuid, p_factory_id uuid, p_run_id uuid, p_attempt_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.require_factory_score_read(p_workspace_id, p_factory_id);
  if exists (
    select 1 from public.agent_runs run
    join public.sessions owner on (owner.workspace_id, owner.factory_id, owner.id) =
      (run.workspace_id, p_factory_id, run.session_id)
    where (run.workspace_id, run.id, owner.execution_purpose) = (p_workspace_id, p_run_id, 'benchmark')
  ) then raise exception 'Evaluation run is unavailable.' using errcode = 'P0002'; end if;
  return internal.list_factory_run_score_results(p_workspace_id, p_factory_id, p_run_id, p_attempt_id);
end;
$$;
revoke all on function public.list_factory_run_score_results(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_factory_run_score_results(uuid,uuid,uuid,uuid) to authenticated;

alter function public.request_factory_scorer_reevaluation(uuid,uuid,uuid,uuid,uuid) set schema internal;
revoke all on function internal.request_factory_scorer_reevaluation(uuid,uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
create function public.request_factory_scorer_reevaluation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_prior_attempt_id uuid, p_target_revision_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if (internal.read_factory_evaluation_review_receipt(p_workspace_id, p_factory_id, p_prior_attempt_id)).attempt_id is null then
    raise exception 'Prior evaluation receipt is unavailable.' using errcode = 'P0002';
  end if;
  return internal.request_factory_scorer_reevaluation(
    p_workspace_id, p_factory_id, p_actor_user_id, p_prior_attempt_id, p_target_revision_id);
end;
$$;
revoke all on function public.request_factory_scorer_reevaluation(uuid,uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.request_factory_scorer_reevaluation(uuid,uuid,uuid,uuid,uuid) to service_role;

alter function public.cancel_factory_evaluation_job(uuid,uuid,uuid,uuid) set schema internal;
revoke all on function internal.cancel_factory_evaluation_job(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;
create function public.cancel_factory_evaluation_job(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_job_id uuid
) returns public.factory_evaluation_jobs language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if exists (select 1 from public.factory_evaluation_jobs job
    join public.factory_scorer_sample_receipts sample on (sample.workspace_id, sample.factory_id, sample.id) =
      (job.workspace_id, job.factory_id, job.sample_receipt_id)
    where (job.workspace_id, job.factory_id, job.id) = (p_workspace_id, p_factory_id, p_job_id)
      and sample.benchmark_trial_id is not null)
  then raise exception 'Evaluation job is unavailable in this factory.' using errcode = 'P0002'; end if;
  return internal.cancel_factory_evaluation_job(p_workspace_id, p_factory_id, p_actor_user_id, p_job_id);
end;
$$;
revoke all on function public.cancel_factory_evaluation_job(uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_factory_evaluation_job(uuid,uuid,uuid,uuid) to service_role;
