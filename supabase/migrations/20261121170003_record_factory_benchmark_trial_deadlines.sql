alter table public.factory_benchmark_trials
  drop constraint factory_benchmark_trials_failure_code_check,
  add constraint factory_benchmark_trials_failure_code_check check (
    failure_code in (
      'sandbox_unavailable','replay_unavailable','fixture_unavailable','candidate_failed',
      'validation_failed','checkpoint_unavailable','attempt_lost','deadline_elapsed'
    ) or (runner_revision = 'openai-responses-v1' and failure_code in (
      'cli_pin_mismatch','sandbox_binding_unavailable','replay_prompt_unavailable',
      'inference_relay_unavailable','provider_receipt_unavailable'
    ))
  );

-- Recognize only the canonical messages emitted by deployed workers during
-- their own deadline handling. Elapsed time and generic stalls prove no cause.
create function internal.is_legacy_factory_benchmark_deadline(p_error text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_error in (
    'Benchmark trial deadline elapsed before start.',
    'Worker attempt deadline expired before dispatch.',
    'Worker attempt deadline expired before execution.',
    'Benchmark attempt deadline expired.',
    'The live benchmark deadline expired.'
  ) or p_error ~ '^Worker attempt exceeded its [1-9][0-9]{0,9}ms deadline[.]$', false);
$$;
revoke all on function internal.is_legacy_factory_benchmark_deadline(text) from public, anon, authenticated, service_role;

create or replace function internal.record_factory_benchmark_job_terminal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'queued' and old.status in ('started','running') and exists (
    select 1 from public.factory_benchmark_trials trial where trial.job_id = new.id
  ) then
    new.status := 'error';
    new.scheduled_at := null;
    new.finished_at := clock_timestamp();
  end if;
  if new.status in ('error','canceled') and new.status is distinct from old.status then
    update public.factory_benchmark_trials trial set
      status = new.status::text,
      failure_code = case when new.status = 'error' then case
        when internal.is_legacy_factory_benchmark_deadline(new.last_error) then 'deadline_elapsed'
        else 'attempt_lost' end end,
      finished_at = coalesce(new.finished_at, clock_timestamp())
    where (trial.workspace_id,trial.session_id,trial.job_id) = (new.workspace_id,new.session_id,new.id)
      and trial.status in ('queued','running');
  end if;
  return new;
end;
$$;

update public.factory_benchmark_trials trial
set failure_code = 'deadline_elapsed'
from public.agent_jobs job
where (trial.workspace_id,trial.session_id,trial.job_id) = (job.workspace_id,job.session_id,job.id)
  and (trial.attempt_count is null or trial.attempt_count = job.attempt_count)
  and trial.status = 'error' and job.status = 'error' and trial.failure_code = 'attempt_lost'
  and internal.is_legacy_factory_benchmark_deadline(job.last_error);

-- Starting may discover the elapsed deadline before the supervisor can recover
-- the claim. Preserve that cause separately from an unavailable execution budget.
create or replace function internal.start_factory_benchmark_trial(
  p_job_id uuid, p_attempt_count integer, p_deadline_at timestamptz default null
)
returns public.factory_benchmark_trials language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  owner public.sessions;
  budget record;
  started_run_id uuid;
  run_started_at timestamptz;
  effective_deadline timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_attempt_count is distinct from 1 then return null; end if;
  select * into trial from public.factory_benchmark_trials t where t.job_id = p_job_id;
  if not found then return null; end if;
  perform internal.assert_workspace_accepts_work(trial.workspace_id);
  trial := internal.lock_factory_benchmark_trial(trial.id, p_job_id);
  if trial.id is null or not exists (
    select 1 from public.agent_jobs job where job.id = trial.job_id
      and job.attempt_count = p_attempt_count and job.status in ('started','running')
  ) then return null; end if;
  if trial.status <> 'queued' then return null; end if;
  select * into strict owner from public.sessions where id = trial.session_id;
  effective_deadline := least(
    p_deadline_at, clock_timestamp() + interval '180 seconds',
    (select dispatch.deadline_at from public.worker_dispatches dispatch
      where (dispatch.job_id, dispatch.attempt_count) = (p_job_id, p_attempt_count))
  );
  select * into budget from public.get_session_execution_budget(owner.id);
  if not found or budget.exhaustion_code is not null
    or (owner.execution_policy_revision_id is not null and budget.remaining_execution_ms is null)
    or coalesce(budget.remaining_execution_ms <= 0, false) then
    perform public.fail_session_job_attempt(p_job_id, p_attempt_count,
      'Benchmark trial execution budget unavailable.', false, 0);
    return null;
  end if;
  if effective_deadline <= clock_timestamp() then
    perform public.fail_session_job_attempt(p_job_id, p_attempt_count,
      'Benchmark trial deadline elapsed before start.', false, 0);
    return null;
  end if;

  started_run_id := internal.start_session_job_attempt_before_release(
    p_job_id, p_attempt_count, owner.current_stage_id, 0, 'benchmark', trial.runner_revision, 'project'
  );
  if started_run_id is distinct from trial.run_id then
    raise exception 'The isolated claim did not match the admitted run.' using errcode = 'PT409';
  end if;
  -- The shared budget charges time from the run's stored start, including
  -- sandbox setup. The pre-run balance includes any prior elapsed usage.
  select started_at into strict run_started_at from public.agent_runs where id = started_run_id;
  effective_deadline := least(effective_deadline,
    run_started_at + budget.remaining_execution_ms * interval '1 millisecond');
  if effective_deadline <= clock_timestamp() then
    perform public.fail_session_job_attempt(p_job_id, p_attempt_count,
      'Benchmark trial deadline elapsed before start.', false, 0, started_run_id);
    return null;
  end if;
  update public.factory_benchmark_trials t
  set status = 'running', attempt_count = p_attempt_count, deadline_at = effective_deadline
  where t.id = trial.id returning * into trial;
  return trial;
end;
$$;

-- Both worker runtimes use this entry point for their independently observed
-- deadline. The exact stalled guard preserves existing publication ownership.
create function public.fail_deadline_session_job_attempt(
  p_job_id uuid, p_attempt_count integer, p_error text, p_run_id uuid default null
) returns text language plpgsql security definer set search_path = '' as $$
declare outcome text;
begin
  perform internal.assert_checkpoint_publication_service();
  outcome := internal.fail_stalled_session_job_attempt(p_job_id,p_attempt_count,p_error,false,0,p_run_id);
  if outcome = 'error' then
    update public.factory_benchmark_trials trial set failure_code = 'deadline_elapsed'
    where trial.job_id = p_job_id and trial.status = 'error' and trial.failure_code = 'attempt_lost'
      and ((p_run_id is null and trial.attempt_count is null)
        or (trial.run_id,trial.attempt_count) = (p_run_id,p_attempt_count));
  end if;
  return outcome;
end;
$$;
revoke all on function public.fail_deadline_session_job_attempt(uuid,integer,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.fail_deadline_session_job_attempt(uuid,integer,text,uuid) to service_role;
