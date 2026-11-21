create or replace function public.finish_factory_benchmark_inference_request(
  p_request_id uuid, p_status text, p_observed_model text default null,
  p_input_tokens integer default null, p_output_tokens integer default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  delivery_allowed boolean := false;
  resolved_status text := p_status;
  aggregate internal.factory_benchmark_inference_receipts;
begin
  perform internal.assert_checkpoint_publication_service();
  if not coalesce(p_status in ('completed','failed','unavailable'),false)
    or (p_input_tokens is null) <> (p_output_tokens is null)
    or coalesce(least(p_input_tokens,p_output_tokens) < 0,false)
    or coalesce(length(p_observed_model) > 200,false) then return false; end if;
  select current.* into trial from internal.factory_benchmark_inference_requests request
  join public.factory_benchmark_trials current on current.id = request.trial_id
  where request.id = p_request_id and (p_observed_model is null or request.expected_model = p_observed_model)
    and (p_status <> 'completed' or p_observed_model is not null);
  if not found then return false; end if;

  -- Match the trial close and adoption lock order before touching requests,
  -- so a late usage update cannot race aggregate creation or adoption.
  trial := internal.lock_factory_benchmark_trial(trial.id,trial.job_id);
  if trial.id is null or trial.runner_revision <> 'openai-responses-v1' then return false; end if;
  if p_status = 'completed' then
    if (internal.lock_live_factory_benchmark_trial(trial.id,trial.job_id,trial.run_id,trial.attempt_count)).id is not null then
      perform 1 from internal.factory_benchmark_inference_connections connection
      join internal.factory_benchmark_live_sandbox_bindings binding on binding.trial_id = trial.id
      join public.workspace_vercel_sandbox_connections sandbox
        on (sandbox.workspace_id,sandbox.connection_revision,sandbox.status) =
          (connection.workspace_id,connection.sandbox_connection_revision,'connected')
      where connection.id = trial.inference_connection_revision and connection.revoked_at is null
        and binding.ready_at is not null and binding.closed_at is null
        and not exists (select 1 from internal.factory_benchmark_replay_revocations revocation
          where revocation.policy_revision_id = trial.policy_revision_id)
      for share of connection;
      delivery_allowed := found;
    end if;
    -- A canceled call can still have measured usage. Keep its receipt without
    -- authorizing delivery of a completed provider response to the sandbox.
    if not delivery_allowed then resolved_status := 'unavailable'; end if;
  end if;
  update internal.factory_benchmark_inference_requests request
  set status = resolved_status, observed_model = p_observed_model, input_tokens = p_input_tokens,
    output_tokens = p_output_tokens, finished_at = clock_timestamp()
  where request.id = p_request_id and request.trial_id = trial.id and request.status = 'started';
  if found then return p_status <> 'completed' or delivery_allowed; end if;
  -- Closing a request forbids delivery. An exact late observation may fill
  -- the missing token pair once while leaving status and finish time intact.
  if p_input_tokens is not null then
    update internal.factory_benchmark_inference_requests request
    set observed_model = coalesce(request.observed_model,p_observed_model), input_tokens = p_input_tokens,
      output_tokens = p_output_tokens
    where request.id = p_request_id and request.trial_id = trial.id and request.status = 'unavailable'
      and request.input_tokens is null and request.output_tokens is null
      and (request.observed_model is null or p_observed_model is null or request.observed_model = p_observed_model);
    if found then
      update internal.factory_benchmark_inference_receipts receipt
      set unavailable_usage_count = receipt.unavailable_usage_count - 1,
        input_tokens = receipt.input_tokens + p_input_tokens,
        output_tokens = receipt.output_tokens + p_output_tokens
      where receipt.trial_id = trial.id and receipt.unavailable_usage_count > 0
      returning * into aggregate;
      if aggregate.id is not null and aggregate.unavailable_usage_count = 0 then
        update public.agent_runs run
        set input_tokens = aggregate.input_tokens, output_tokens = aggregate.output_tokens,
          token_provenance = 'measured', usage_unavailable_reason = null
        where (run.workspace_id,run.session_id,run.id,run.attempt_count,run.status,run.token_provenance) =
          (trial.workspace_id,trial.session_id,trial.run_id,trial.attempt_count,'success','unavailable')
          and exists (select 1 from public.factory_benchmark_trial_results result
            where (result.trial_id,result.run_id,result.inference_receipt_id) = (trial.id,run.id,aggregate.id));
      end if;
      return p_status <> 'completed';
    end if;
  end if;
  return (p_status <> 'completed' or delivery_allowed) and exists (select 1 from internal.factory_benchmark_inference_requests request
    where request.id = p_request_id and request.trial_id = trial.id and (
      (request.status,request.observed_model,request.input_tokens,request.output_tokens) is not distinct from
        (resolved_status,p_observed_model,p_input_tokens,p_output_tokens)
      or (p_status <> 'completed' and request.status = 'unavailable' and p_input_tokens is not null
        and (request.input_tokens,request.output_tokens) = (p_input_tokens,p_output_tokens)
        and (p_observed_model is null or request.observed_model = p_observed_model))
    ));
end;
$$;

alter table public.factory_benchmark_trials
  drop constraint factory_benchmark_trials_failure_code_check,
  add constraint factory_benchmark_trials_failure_code_check check (
    failure_code in (
      'sandbox_unavailable','replay_unavailable','fixture_unavailable','candidate_failed',
      'validation_failed','checkpoint_unavailable','attempt_lost'
    ) or (runner_revision = 'openai-responses-v1' and failure_code in (
      'cli_pin_mismatch','sandbox_binding_unavailable','replay_prompt_unavailable',
      'inference_relay_unavailable','provider_receipt_unavailable'
    ))
  );

create or replace function public.fail_factory_benchmark_trial(
  p_trial_id uuid, p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_failure_code text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  qualified_failures constant text[] := array['cli_pin_mismatch','sandbox_binding_unavailable','replay_prompt_unavailable',
    'inference_relay_unavailable','provider_receipt_unavailable'];
begin
  perform internal.assert_checkpoint_publication_service();
  if p_failure_code is null or (p_failure_code not in (
    'sandbox_unavailable','replay_unavailable','fixture_unavailable','candidate_failed',
    'validation_failed','checkpoint_unavailable','attempt_lost'
  ) and p_failure_code <> all(qualified_failures)) then
    raise exception 'Unknown trial failure code.' using errcode = '22023';
  end if;
  trial := internal.lock_factory_benchmark_trial(p_trial_id, p_job_id);
  if trial.id is null or (trial.attempt_count, trial.run_id) is distinct from (p_attempt_count, p_run_id) then
    return false;
  end if;
  if p_failure_code = any(qualified_failures) and trial.runner_revision <> 'openai-responses-v1' then
    raise exception 'Unknown trial failure code.' using errcode = '22023';
  end if;
  if trial.status = 'error' then return trial.failure_code = p_failure_code; end if;
  if trial.status <> 'running' or public.fail_session_job_attempt(
    p_job_id, p_attempt_count, 'Benchmark trial failed.', false, 0, p_run_id
  ) <> 'error' then return false; end if;
  update public.factory_benchmark_trials set failure_code = p_failure_code
  where id = p_trial_id and status = 'error';
  return found;
end;
$$;
