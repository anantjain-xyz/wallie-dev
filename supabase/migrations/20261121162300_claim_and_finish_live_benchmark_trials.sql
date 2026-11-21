create or replace function public.start_factory_benchmark_trial(
  p_job_id uuid, p_attempt_count integer, p_deadline_at timestamptz default null
) returns public.factory_benchmark_trials language plpgsql security definer set search_path = '' as $$
declare timeout_ms integer;
begin
  perform internal.assert_checkpoint_publication_service();
  if exists (select 1 from public.factory_benchmark_trials trial where trial.job_id = p_job_id
    and trial.runner_revision <> 'recorded-fixture-v1') then return null; end if;
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

create function public.claim_next_agent_job(
  accept_benchmark_trials boolean,
  default_concurrency_limit int,
  p_worker_runtime text
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
  if p_worker_runtime not in ('node','workerd') or p_worker_runtime is null then
    raise exception 'A supported worker runtime is required.' using errcode = '22023';
  end if;
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
              (owner.workspace_id, owner.id, ready.id, 'queued')
              and (trial.runner_revision = 'recorded-fixture-v1' or
                (trial.runner_revision = 'openai-responses-v1' and p_worker_runtime = 'workerd'))))
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
        and schedule.state = 'active'
        and exists (
          select 1 from public.factory_benchmark_schedule_trials scheduled
          join public.factory_benchmark_trials outstanding
            on (outstanding.id, outstanding.run_id) = (scheduled.trial_id, scheduled.run_id)
          where (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
            (schedule.workspace_id, schedule.factory_id, schedule.experiment_id)
            and outstanding.status in ('queued', 'running')
        );
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

create or replace function public.claim_next_agent_job(
  accept_benchmark_trials boolean, default_concurrency_limit int default 2
) returns setof public.agent_jobs
language sql security definer set search_path = '' as $$
  select * from public.claim_next_agent_job(accept_benchmark_trials,default_concurrency_limit,'node')
$$;

revoke all on function public.claim_next_agent_job(boolean,int,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_next_agent_job(boolean,int,text) to service_role;

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
    p_default_workspace_limit, 'workerd'
  );
  if claimed.id is null then return; end if;
  return query insert into public.worker_dispatches(job_id, attempt_count, workspace_id, workflow_id, deadline_at)
  values (claimed.id, claimed.attempt_count, claimed.workspace_id,
    'job-' || claimed.id::text || '-' || claimed.attempt_count::text,
    now() + p_timeout_ms * interval '1 millisecond') returning *;
end;
$$;

create function public.start_factory_benchmark_live_trial(
  p_job_id uuid,p_attempt_count integer,p_deadline_at timestamptz,p_worker_runtime text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  candidate public.factory_benchmark_experiment_candidates;
  connection internal.factory_benchmark_inference_connections;
  timeout_ms integer;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_worker_runtime is distinct from 'workerd' or p_attempt_count is distinct from 1 or not exists (
    select 1 from public.worker_dispatches dispatch
    where (dispatch.job_id,dispatch.attempt_count) = (p_job_id,p_attempt_count)
      and dispatch.execution_started_at is not null and dispatch.deadline_at > clock_timestamp()
  ) then return null; end if;
  select queued.* into trial from public.factory_benchmark_trials queued
  where (queued.job_id,queued.runner_revision,queued.status) = (p_job_id,'openai-responses-v1','queued');
  if not found then return null; end if;
  select frozen.* into candidate
  from public.factory_benchmark_experiment_trials cell
  join public.factory_benchmark_experiment_candidates frozen using (workspace_id,factory_id,experiment_id,candidate_key)
  where cell.trial_id = trial.id and frozen.worker_runtime = p_worker_runtime
    and (frozen.live_inference_connection_revision,frozen.candidate_key) =
      (trial.inference_connection_revision,trial.effective_execution_digest);
  if not found then return null; end if;
  select key.* into connection from internal.factory_benchmark_inference_connections key
  join public.workspace_vercel_sandbox_connections sandbox
    on (sandbox.workspace_id,sandbox.connection_revision,sandbox.status) =
      (key.workspace_id,key.sandbox_connection_revision,'connected')
  where key.id = trial.inference_connection_revision and key.revoked_at is null;
  if not found then return null; end if;
  select cell.timeout_ms into timeout_ms from public.factory_benchmark_experiment_trials cell where cell.trial_id = trial.id;
  trial := internal.start_factory_benchmark_trial(p_job_id,p_attempt_count,
    least(p_deadline_at,clock_timestamp() + timeout_ms * interval '1 millisecond'));
  if trial.id is null then return null; end if;
  return jsonb_build_object(
    'runnerRevision',trial.runner_revision,
    'identity',jsonb_build_object('trialId',trial.id,'jobId',trial.job_id,'runId',trial.run_id,
      'workspaceId',trial.workspace_id,'factoryId',trial.factory_id,'sessionId',trial.session_id,
      'actorUserId',trial.actor_user_id,'attemptCount',trial.attempt_count),
    'deadlineAt',trial.deadline_at,'taskRevisionId',trial.task_revision_id,'policyRevisionId',trial.policy_revision_id,
    'policyDigest',trial.policy_digest,'workerRuntime',candidate.worker_runtime,
    'sandboxConnectionRevision',trial.sandbox_connection_revision,'inferenceConnectionRevision',connection.id,
    'candidate',jsonb_build_object('definitionRevisionId',candidate.definition_revision_id,
      'definitionDigest',candidate.definition_digest,'effectiveExecutionDigest',trial.effective_execution_digest,
      'qualificationId',candidate.qualification_id,'harness',candidate.harness,'nativeModel',candidate.model,
      'upstreamModel',split_part(candidate.canonical_model_key,'/',2),
      'toolchain',jsonb_build_object('image',connection.profile->>'image',
        'cliVersion',connection.profile->candidate.harness->>'cliVersion',
        'cliDigest',connection.profile->candidate.harness->>'cliDigest'))
  );
end;
$$;
revoke all on function public.start_factory_benchmark_live_trial(uuid,integer,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.start_factory_benchmark_live_trial(uuid,integer,timestamptz,text) to service_role;

create function public.finish_factory_benchmark_live_trial(
  p_trial_id uuid,p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_result jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  inference internal.factory_benchmark_inference_receipts;
  binding internal.factory_benchmark_live_sandbox_bindings;
  upload public.workspace_resource_operations;
  checkpoint_path text;
  supplied_result_digest text;
  evidence jsonb;
  input_commit text := p_result#>>'{input,commitSha}';
  input_tree text := p_result#>>'{input,treeSha}';
  output_commit text := p_result#>>'{output,commitSha}';
  output_tree text := p_result#>>'{output,treeSha}';
  artifact text := p_result#>>'{output,artifactMarkdown}';
  bundle_sha text := p_result#>>'{output,checkpoint,sha256}';
begin
  perform internal.assert_checkpoint_publication_service();
  if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text) > 1600000
    or jsonb_typeof(p_result->'input') is distinct from 'object'
    or jsonb_typeof(p_result->'output') is distinct from 'object'
    or jsonb_typeof(p_result#>'{output,checkpoint}') is distinct from 'object'
  then raise exception 'The live trial output must be a bounded result object.' using errcode = '22023'; end if;
  if p_result - array['input','output','inferenceReceiptId'] <> '{}'::jsonb
    or (p_result->'input') - array['restorationReceiptSha256','inputBundleSha256','commitSha',
        'treeSha','replayPromptSha256','rendererRevision'] <> '{}'::jsonb
    or (p_result->'output') - array['artifactMarkdown','commitSha','treeSha','validation','checkpoint'] <> '{}'::jsonb
    or (p_result#>'{output,checkpoint}') - array['kind','sha256','storagePath','uploadOperationId'] <> '{}'::jsonb
    or jsonb_typeof(p_result#>'{output,artifactMarkdown}') is distinct from 'string'
    or not coalesce(octet_length(artifact) between 1 and 262144,false) or nullif(btrim(artifact),'') is null
    or not coalesce(pg_input_is_valid(p_result->>'inferenceReceiptId','uuid'),false)
    or not coalesce(pg_input_is_valid(p_result#>>'{output,checkpoint,uploadOperationId}','uuid'),false)
    or p_result#>>'{output,checkpoint,kind}' is distinct from 'bundle'
    or p_result#>'{input,rendererRevision}' is distinct from '1'::jsonb
    or not coalesce(bundle_sha ~ '^[a-f0-9]{64}$',false)
    or exists (select 1 from unnest(array[input_commit,input_tree,output_commit,output_tree]) sha(value)
      where not coalesce(value ~ '^[a-f0-9]{40}$',false))
    or output_commit = input_commit or output_tree = input_tree
  then raise exception 'The live trial output is invalid.' using errcode = '22023'; end if;
  evidence := p_result#>'{output,validation}';
  if evidence is distinct from jsonb_build_object(
    'version',1,'key','qualified-replay-source','status','passed','commitSha',output_commit,'treeSha',output_tree)
  then raise exception 'Validation does not match the produced commit and tree.' using errcode = '23514'; end if;
  supplied_result_digest := encode(sha256(convert_to(p_result::text,'UTF8')),'hex');
  select * into trial from public.factory_benchmark_trials current
  where (current.id,current.job_id,current.run_id,current.attempt_count,current.runner_revision) =
    (p_trial_id,p_job_id,p_run_id,p_attempt_count,'openai-responses-v1');
  if not found or trial.status not in ('running','success') then return false; end if;
  if trial.status = 'success' then
    return exists (select 1 from public.factory_benchmark_trial_results saved
      where (saved.trial_id,saved.result_digest) = (trial.id,supplied_result_digest));
  end if;
  perform public.assert_factory_benchmark_replay_access(
    trial.workspace_id,trial.factory_id,trial.actor_user_id,trial.task_revision_id);
  trial := internal.lock_factory_benchmark_trial(p_trial_id,p_job_id);
  if trial.status = 'success' then
    return exists (select 1 from public.factory_benchmark_trial_results saved
      where (saved.trial_id,saved.result_digest) = (trial.id,supplied_result_digest));
  end if;
  trial := internal.lock_live_factory_benchmark_trial(p_trial_id,p_job_id,p_run_id,p_attempt_count);
  if trial.id is null then return false; end if;
  if not exists (select 1 from public.factory_benchmark_task_inputs input
    where (input.workspace_id,input.factory_id,input.task_id,input.checkout_sha) =
      (trial.workspace_id,trial.factory_id,trial.task_id,input_commit))
    or exists (select 1 from internal.factory_benchmark_replay_revocations revoked
      where revoked.policy_revision_id = trial.policy_revision_id)
  then raise exception 'The exact replay input or policy is unavailable.' using errcode = '23514'; end if;
  select * into binding from internal.factory_benchmark_live_sandbox_bindings current
  where current.trial_id = trial.id and current.ready_at is not null and current.closed_at is not null
    and (current.restoration_receipt_sha256,current.input_bundle_sha256,current.replay_prompt_sha256) =
      (p_result#>>'{input,restorationReceiptSha256}',p_result#>>'{input,inputBundleSha256}',p_result#>>'{input,replayPromptSha256}');
  if not found then raise exception 'The live trial input does not match the opened replay.' using errcode = '23514'; end if;
  select * into inference from internal.factory_benchmark_inference_receipts receipt
  where (receipt.id,receipt.trial_id) = ((p_result->>'inferenceReceiptId')::uuid,trial.id);
  if not found then raise exception 'The provider evidence is unavailable.' using errcode = '23514'; end if;

  checkpoint_path := trial.workspace_id::text || '/benchmark/' || trial.id::text || '/' || trial.run_id::text ||
    '/' || bundle_sha || '.bundle';
  if p_result#>>'{output,checkpoint,storagePath}' is distinct from checkpoint_path then
    raise exception 'The checkpoint path does not match the trial attempt.' using errcode = '23514';
  end if;
  select * into upload from public.workspace_resource_operations pending
  where (pending.id,pending.workspace_id,pending.kind,pending.storage_bucket,pending.resource_id) =
    ((p_result#>>'{output,checkpoint,uploadOperationId}')::uuid,trial.workspace_id,
     'upload','session-source-checkpoints',checkpoint_path) for update;
  if not found or upload.settled_at is not null or upload.recovery_after <= clock_timestamp() then
    raise exception 'The private checkpoint upload is unavailable.' using errcode = '23514';
  end if;
  perform 1 from storage.objects object
  where (object.bucket_id,object.name) = ('session-source-checkpoints',checkpoint_path)
    and object.metadata->>'mimetype' = 'application/octet-stream'
    and (object.metadata->>'size')::bigint > 0 for key share;
  if not found then raise exception 'The private checkpoint was not retained.' using errcode = '23514'; end if;
  if clock_timestamp() >= trial.deadline_at then return false; end if;

  insert into public.factory_benchmark_trial_results (
    trial_id,workspace_id,factory_id,run_id,replay_execution_id,inference_receipt_id,
    restoration_receipt_sha256,input_bundle_sha256,replay_prompt_sha256,renderer_revision,
    input_commit_sha,input_tree_sha,output_commit_sha,output_tree_sha,
    artifact_markdown,artifact_sha256,checkpoint_bundle_sha256,checkpoint_storage_path,validation,runtime,result_digest
  ) values (
    trial.id,trial.workspace_id,trial.factory_id,trial.run_id,trial.id,inference.id,
    binding.restoration_receipt_sha256,binding.input_bundle_sha256,binding.replay_prompt_sha256,'1',
    input_commit,input_tree,output_commit,output_tree,
    artifact,encode(sha256(convert_to(artifact,'UTF8')),'hex'),bundle_sha,checkpoint_path,evidence,'workerd',supplied_result_digest
  );
  update public.agent_runs set status = 'success',finished_at = clock_timestamp(),last_activity_at = clock_timestamp(),
    input_tokens = case when inference.unavailable_usage_count = 0 then inference.input_tokens end,
    output_tokens = case when inference.unavailable_usage_count = 0 then inference.output_tokens end,
    token_provenance = case when inference.unavailable_usage_count = 0 then 'measured' else 'unavailable' end,
    usage_recorded_at = clock_timestamp(),
    usage_unavailable_reason = case when inference.unavailable_usage_count <> 0
      then 'partial_provider_usage' else 'provider_did_not_report' end
  where id = p_run_id;
  if not public.complete_session_job_attempt(p_job_id,p_attempt_count,p_run_id) then
    raise exception 'The trial claim is no longer current.' using errcode = 'PT409';
  end if;
  update public.sessions set phase_status = 'approved' where id = trial.session_id;
  update public.factory_benchmark_trials set status = 'success',finished_at = clock_timestamp() where id = trial.id;
  perform public.settle_workspace_resource_operation(upload.id,true);
  return true;
end;
$$;
revoke all on function public.finish_factory_benchmark_live_trial(uuid,uuid,integer,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.finish_factory_benchmark_live_trial(uuid,uuid,integer,uuid,jsonb) to service_role;
