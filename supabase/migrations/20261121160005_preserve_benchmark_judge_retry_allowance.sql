-- Each lease keeps its immutable ordinal, including pre-provider deferrals.
-- Only the two temporary benchmark blocks are exempt from the retry allowance.
alter table public.factory_evaluation_jobs
  add column benchmark_deferral_count integer not null default 0,
  drop constraint factory_evaluation_jobs_check,
  drop constraint factory_evaluation_jobs_check2,
  add constraint factory_evaluation_jobs_attempt_allowance_check check (
    benchmark_deferral_count between 0 and attempt_count
    and attempt_count - benchmark_deferral_count <= attempt_limit
    and (status <> 'queued' or attempt_count - benchmark_deferral_count < attempt_limit)
  );
alter table public.factory_evaluation_attempts
  drop constraint factory_evaluation_attempts_attempt_number_check,
  add constraint factory_evaluation_attempts_attempt_number_check check (attempt_number > 0);
alter table public.factory_evaluation_receipts
  drop constraint factory_evaluation_receipts_attempt_number_check,
  add constraint factory_evaluation_receipts_attempt_number_check check (attempt_number > 0);

create function internal.is_unstarted_factory_benchmark_evaluation_deferral(p_attempt_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from internal.factory_benchmark_evaluation_blocks blocked
    where blocked.attempt_id = p_attempt_id and blocked.reason in ('schedule_paused', 'evaluation_budget_wait'))
    and not exists (select 1 from public.factory_judge_invocations invocation where invocation.attempt_id = p_attempt_id)
    and not exists (select 1 from public.factory_benchmark_schedule_evaluations reservation where reservation.attempt_id = p_attempt_id);
$$;
revoke all on function internal.is_unstarted_factory_benchmark_evaluation_deferral(uuid)
  from public, anon, authenticated, service_role;

create or replace function internal.settle_locked_factory_evaluation_attempt(
  p_job public.factory_evaluation_jobs, p_attempt public.factory_evaluation_attempts, p_outcome text
) returns public.factory_evaluation_jobs language plpgsql set search_path = '' as $$
declare
  next_status text;
  finished timestamptz := clock_timestamp();
  result public.factory_evaluation_jobs;
  is_deferral boolean;
  deferral_count integer;
  used_attempts integer;
begin
  is_deferral := p_outcome = 'retryable_failure' and internal.is_unstarted_factory_benchmark_evaluation_deferral(p_attempt.id);
  deferral_count := p_job.benchmark_deferral_count + is_deferral::integer;
  used_attempts := p_job.attempt_count - deferral_count;
  next_status := case
    when p_outcome = 'succeeded' then 'succeeded'
    when p_outcome = 'canceled' then 'canceled'
    when p_outcome = 'permanent_failure' or used_attempts >= p_job.attempt_limit then 'failed'
    else 'queued'
  end;
  update public.factory_evaluation_attempts attempt set settled_at = finished, outcome = p_outcome
    where (attempt.id, attempt.job_id, attempt.attempt_number, attempt.lease_id) =
      (p_attempt.id, p_job.id, p_job.attempt_count, p_attempt.lease_id) and attempt.settled_at is null;
  if not found then raise exception 'Evaluation attempt is no longer current.' using errcode = '23514'; end if;
  update public.factory_evaluation_jobs job set status = next_status, benchmark_deferral_count = deferral_count,
    available_at = case when next_status = 'queued'
      then finished + make_interval(secs => least(60, 5 * (1 << greatest(0, used_attempts - 1)))) end,
    finished_at = case when next_status <> 'queued' then finished end
    where (job.id, job.status, job.attempt_count) = (p_job.id, 'claimed', p_job.attempt_count)
    returning * into strict result;
  return result;
end;
$$;

create or replace function internal.guard_factory_evaluation_job()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.factory_scorer_sample_receipts sample where sample.id = old.sample_receipt_id)
      or not exists (select 1 from public.factory_evaluation_lanes lane where lane.workspace_id = old.workspace_id) then
      return old;
    end if;
  elsif old.status in ('queued', 'claimed') and
    (new.id, new.workspace_id, new.factory_id, new.session_id, new.run_id, new.scorer_revision_id,
      new.sample_receipt_id, new.target_commit_sha, new.created_at, new.attempt_limit, new.canceled_recorded_xact_id,
      new.source_attempt_id, new.requested_by)
    is not distinct from
    (old.id, old.workspace_id, old.factory_id, old.session_id, old.run_id, old.scorer_revision_id,
      old.sample_receipt_id, old.target_commit_sha, old.created_at, old.attempt_limit, old.canceled_recorded_xact_id,
      old.source_attempt_id, old.requested_by) then
    if new.benchmark_deferral_count <> old.benchmark_deferral_count and not (
      old.status = 'claimed' and new.status = 'queued'
      and new.attempt_count = old.attempt_count and new.benchmark_deferral_count = old.benchmark_deferral_count + 1
      and exists (select 1 from public.factory_evaluation_attempts settled
        where (settled.job_id, settled.attempt_number, settled.outcome) = (old.id, old.attempt_count, 'retryable_failure')
          and internal.is_unstarted_factory_benchmark_evaluation_deferral(settled.id))
    ) then
      raise exception 'An exact unstarted benchmark deferral is required.' using errcode = '23514';
    end if;
    if new.status = 'canceled' then new.canceled_recorded_xact_id := pg_current_xact_id(); end if;
    return new;
  end if;
  raise exception 'Evaluation job identity and terminal history are immutable.' using errcode = '23514';
end;
$$;
