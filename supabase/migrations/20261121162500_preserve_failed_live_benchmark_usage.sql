-- The shared failure routine finalizes the run before evaluating its budget.
-- Attach complete live usage during that update, even when recovery owns it.
create function internal.capture_failed_factory_benchmark_usage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  receipt internal.factory_benchmark_inference_receipts;
begin
  select usage.* into receipt
  from public.factory_benchmark_trials trial
  join internal.factory_benchmark_inference_receipts usage on usage.trial_id = trial.id
  where (trial.workspace_id,trial.session_id,trial.job_id,trial.run_id,trial.attempt_count) =
    (new.workspace_id,new.session_id,new.agent_job_id,new.id,new.attempt_count)
    and trial.runner_revision = 'openai-responses-v1' and trial.status in ('running','error')
    and usage.unavailable_usage_count = 0;
  if found then
    new.input_tokens := receipt.input_tokens;
    new.output_tokens := receipt.output_tokens;
    new.token_provenance := 'measured';
    new.usage_recorded_at := clock_timestamp();
    new.usage_unavailable_reason := case when new.cost_provenance = 'unavailable' then 'provider_did_not_report' end;
  end if;
  return new;
end;
$$;
revoke all on function internal.capture_failed_factory_benchmark_usage() from public, anon, authenticated, service_role;
create trigger capture_failed_factory_benchmark_usage
  before update of status on public.agent_runs
  for each row when (new.status = 'error' and old.status not in ('success','error','canceled')
    and new.started_at is not null and new.token_provenance = 'unavailable')
  execute function internal.capture_failed_factory_benchmark_usage();

-- Relay completion already locks the trial and run in lifecycle order. Fill
-- the terminal telemetry once when the exact retained receipt becomes complete.
create function internal.capture_late_failed_factory_benchmark_usage()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.agent_runs run
  set input_tokens = new.input_tokens, output_tokens = new.output_tokens,
    token_provenance = 'measured', usage_recorded_at = clock_timestamp(),
    usage_unavailable_reason = case when run.cost_provenance = 'unavailable' then 'provider_did_not_report' end
  from public.factory_benchmark_trials trial
  where trial.id = new.trial_id and trial.runner_revision = 'openai-responses-v1' and trial.status = 'error'
    and (run.workspace_id,run.session_id,run.agent_job_id,run.id,run.attempt_count) =
      (trial.workspace_id,trial.session_id,trial.job_id,trial.run_id,trial.attempt_count)
    and run.status = 'error' and run.started_at is not null and run.token_provenance = 'unavailable';
  return new;
end;
$$;
revoke all on function internal.capture_late_failed_factory_benchmark_usage() from public, anon, authenticated, service_role;
create trigger capture_late_failed_factory_benchmark_usage
  after update of unavailable_usage_count on internal.factory_benchmark_inference_receipts
  for each row when (old.unavailable_usage_count > 0 and new.unavailable_usage_count = 0)
  execute function internal.capture_late_failed_factory_benchmark_usage();
