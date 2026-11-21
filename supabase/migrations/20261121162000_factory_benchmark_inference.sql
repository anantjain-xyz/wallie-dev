create table internal.factory_benchmark_inference_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  sandbox_connection_revision uuid not null,
  encrypted_api_key text not null,
  profile jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
create unique index factory_benchmark_active_inference_connection_idx
  on internal.factory_benchmark_inference_connections(workspace_id, factory_id)
  where revoked_at is null;
revoke all on internal.factory_benchmark_inference_connections from public, anon, authenticated, service_role;

alter table public.factory_benchmark_experiment_candidates
  add column live_inference_connection_revision uuid,
  add foreign key (workspace_id, factory_id, live_inference_connection_revision)
    references internal.factory_benchmark_inference_connections(workspace_id, factory_id, id) on delete cascade;

alter table public.factory_benchmark_schedules
  drop constraint factory_benchmark_schedules_runner_revision_check,
  add column inference_connection_revision uuid,
  add foreign key (workspace_id, factory_id, inference_connection_revision)
    references internal.factory_benchmark_inference_connections(workspace_id, factory_id, id) on delete cascade,
  add constraint factory_benchmark_schedule_runner_check check (
    (runner_revision = 'recorded-fixture-v1' and inference_connection_revision is null) or
    (runner_revision = 'openai-responses-v1' and inference_connection_revision is not null and task_fixtures = '{}'::jsonb)
  );

alter table public.factory_benchmark_trials
  drop constraint factory_benchmark_trials_runner_revision_check,
  alter column fixture_key drop not null,
  alter column fixture_revision_id drop not null,
  add column inference_connection_revision uuid,
  add column effective_execution_digest text check (effective_execution_digest ~ '^[a-f0-9]{64}$'),
  add foreign key (workspace_id, factory_id, inference_connection_revision)
    references internal.factory_benchmark_inference_connections(workspace_id, factory_id, id) on delete cascade,
  add constraint factory_benchmark_trial_runner_check check (
    (runner_revision = 'recorded-fixture-v1' and fixture_key is not null and fixture_revision_id is not null
      and inference_connection_revision is null and effective_execution_digest is null) or
    (runner_revision = 'openai-responses-v1' and fixture_key is null and fixture_revision_id is null
      and inference_connection_revision is not null and effective_execution_digest is not null)
  );

create table internal.factory_benchmark_live_sandbox_bindings (
  trial_id uuid primary key references public.factory_benchmark_trials(id) on delete cascade,
  team_id text not null,
  project_id text not null,
  nonce_sha256 text not null unique check (nonce_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  signed_sandbox_id text,
  replay_prompt_sha256 text,
  input_bundle_sha256 text,
  restoration_receipt_sha256 text,
  ready_at timestamptz,
  closed_at timestamptz,
  unique (team_id, project_id, signed_sandbox_id),
  check (num_nonnulls(ready_at,replay_prompt_sha256,input_bundle_sha256,restoration_receipt_sha256) in (0,4)),
  check (ready_at is null or signed_sandbox_id is not null)
);

create table internal.factory_benchmark_inference_requests (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null references public.factory_benchmark_trials(id) on delete cascade,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  expected_model text not null,
  observed_model text,
  status text not null default 'started' check (status in ('started','completed','failed','unavailable')),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check ((input_tokens is null) = (output_tokens is null)),
  check ((status = 'started') = (finished_at is null)),
  check (status <> 'completed' or (observed_model is not null and observed_model = expected_model))
);
create index factory_benchmark_inference_requests_trial_idx on internal.factory_benchmark_inference_requests(trial_id);

create table internal.factory_benchmark_inference_receipts (
  id uuid primary key default gen_random_uuid(),
  trial_id uuid not null unique references public.factory_benchmark_trials(id) on delete cascade,
  observed_model text not null,
  request_count integer not null check (request_count > 0),
  unavailable_usage_count integer not null check (unavailable_usage_count between 0 and request_count),
  input_tokens bigint not null check (input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  created_at timestamptz not null default clock_timestamp()
);
revoke all on internal.factory_benchmark_live_sandbox_bindings, internal.factory_benchmark_inference_requests,
  internal.factory_benchmark_inference_receipts from public, anon, authenticated, service_role;

alter table public.factory_benchmark_trial_results
  alter column fixture_operation_id drop not null,
  alter column fixture_revision_id drop not null,
  alter column fixture_response_sha256 drop not null,
  add column inference_receipt_id uuid references internal.factory_benchmark_inference_receipts(id),
  add column replay_prompt_sha256 text check (replay_prompt_sha256 ~ '^[a-f0-9]{64}$'),
  add column renderer_revision text,
  add constraint factory_benchmark_result_source_check check (
    (num_nonnulls(fixture_operation_id, fixture_revision_id, fixture_response_sha256) = 3
      and num_nonnulls(inference_receipt_id, replay_prompt_sha256, renderer_revision) = 0) or
    (num_nonnulls(fixture_operation_id, fixture_revision_id, fixture_response_sha256) = 0
      and num_nonnulls(inference_receipt_id, replay_prompt_sha256, renderer_revision) = 3)
  );

create function public.configure_factory_benchmark_inference_connection(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_encrypted_api_key text, p_profile jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_connection uuid;
  saved internal.factory_benchmark_inference_connections;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if not coalesce(length(p_encrypted_api_key) between 1 and 8192, false)
    or jsonb_typeof(p_profile) is distinct from 'object'
    or octet_length(p_profile::text) > 8192
    or not coalesce(p_profile->>'image' ~ '^vcr[.]vercel[.]com/[a-zA-Z0-9/_.-]+@sha256:[a-f0-9]{64}$', false)
    or exists (
      select 1 from unnest(array['codex','opencode']) harness(name)
      where not coalesce(p_profile->harness.name->>'cliVersion' ~ '^[0-9]+[.][0-9]+[.][0-9]+([-+][a-zA-Z0-9.-]+)?$', false)
        or not coalesce(p_profile->harness.name->>'cliDigest' ~ '^[a-f0-9]{64}$', false)
    ) then raise exception 'The benchmark inference connection is invalid.' using errcode = '22023'; end if;
  select connection.connection_revision into current_connection
  from public.workspace_vercel_sandbox_connections connection
  where connection.workspace_id = p_workspace_id and connection.status = 'connected' for share;
  if not found then raise exception 'A connected Vercel Sandbox project is required.' using errcode = 'PT422'; end if;
  update internal.factory_benchmark_inference_connections connection set revoked_at = clock_timestamp()
  where (connection.workspace_id, connection.factory_id) = (p_workspace_id, p_factory_id)
    and connection.revoked_at is null;
  insert into internal.factory_benchmark_inference_connections (
    workspace_id, factory_id, sandbox_connection_revision, encrypted_api_key, profile, created_by
  ) values (p_workspace_id, p_factory_id, current_connection, p_encrypted_api_key, p_profile, p_actor_user_id)
  returning * into saved;
  return jsonb_build_object('id', saved.id, 'sandboxConnectionRevision', saved.sandbox_connection_revision,
    'profile', saved.profile, 'createdAt', saved.created_at);
end;
$$;

create function public.read_factory_benchmark_inference_connection(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  return (select jsonb_build_object('id', connection.id,
    'sandboxConnectionRevision', connection.sandbox_connection_revision, 'profile', connection.profile,
    'createdAt', connection.created_at)
    from internal.factory_benchmark_inference_connections connection
    where (connection.workspace_id, connection.factory_id) = (p_workspace_id, p_factory_id)
      and connection.revoked_at is null);
end;
$$;

create function public.revoke_factory_benchmark_inference_connection(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_connection_revision uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  update internal.factory_benchmark_inference_connections connection set revoked_at = clock_timestamp()
  where (connection.workspace_id, connection.factory_id, connection.id) =
    (p_workspace_id, p_factory_id, p_connection_revision) and connection.revoked_at is null;
  return found;
end;
$$;

create function internal.lock_live_factory_benchmark_trial(
  p_trial_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns public.factory_benchmark_trials language plpgsql set search_path = '' as $$
declare trial public.factory_benchmark_trials;
begin
  trial := internal.lock_factory_benchmark_trial(p_trial_id, p_job_id);
  if trial.id is null or (trial.runner_revision,trial.run_id,trial.attempt_count,trial.status)
    is distinct from ('openai-responses-v1',p_run_id,p_attempt_count,'running')
    or trial.deadline_at <= clock_timestamp()
    or not exists (select 1 from public.agent_jobs job where job.id = p_job_id
      and job.attempt_count = p_attempt_count and job.status in ('started','running'))
    or not exists (select 1 from public.agent_runs run where run.id = p_run_id
      and run.attempt_count = p_attempt_count and run.status = 'running')
  then return null; end if;
  return trial;
end;
$$;
revoke all on function internal.lock_live_factory_benchmark_trial(uuid,uuid,uuid,integer)
  from public, anon, authenticated, service_role;

create function public.arm_factory_benchmark_live_sandbox_binding(
  p_trial_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer, p_nonce_sha256 text, p_expires_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
declare trial public.factory_benchmark_trials;
begin
  perform internal.assert_checkpoint_publication_service();
  trial := internal.lock_live_factory_benchmark_trial(p_trial_id,p_job_id,p_run_id,p_attempt_count);
  if trial.id is null or not coalesce(p_nonce_sha256 ~ '^[a-f0-9]{64}$', false)
    or not coalesce(p_expires_at > clock_timestamp(), false) then return false; end if;
  insert into internal.factory_benchmark_live_sandbox_bindings(trial_id,team_id,project_id,nonce_sha256,expires_at)
  select trial.id, sandbox.team_id, sandbox.project_id, p_nonce_sha256,
    least(p_expires_at, trial.deadline_at, clock_timestamp() + interval '30 seconds')
  from public.workspace_vercel_sandbox_connections sandbox
  join internal.factory_benchmark_inference_connections connection
    on (connection.workspace_id, connection.sandbox_connection_revision) =
      (sandbox.workspace_id, sandbox.connection_revision)
  where (sandbox.workspace_id, sandbox.connection_revision, sandbox.status, connection.factory_id, connection.id) =
    (trial.workspace_id, trial.sandbox_connection_revision, 'connected', trial.factory_id, trial.inference_connection_revision)
    and connection.revoked_at is null
  on conflict do nothing;
  return found;
end;
$$;

create function public.consume_factory_benchmark_live_sandbox_binding(
  p_nonce_sha256 text, p_team_id text, p_project_id text, p_signed_sandbox_id text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare trial public.factory_benchmark_trials;
begin
  perform internal.assert_checkpoint_publication_service();
  if not coalesce(length(p_signed_sandbox_id) between 1 and 200, false) then return false; end if;
  select run.* into trial from internal.factory_benchmark_live_sandbox_bindings binding
  join public.factory_benchmark_trials run on run.id = binding.trial_id
  where (binding.nonce_sha256,binding.team_id,binding.project_id) = (p_nonce_sha256,p_team_id,p_project_id);
  if not found then return false; end if;
  trial := internal.lock_live_factory_benchmark_trial(trial.id,trial.job_id,trial.run_id,trial.attempt_count);
  if trial.id is null then return false; end if;
  update internal.factory_benchmark_live_sandbox_bindings binding
  set signed_sandbox_id = p_signed_sandbox_id
  where (binding.trial_id,binding.nonce_sha256,binding.team_id,binding.project_id) =
    (trial.id,p_nonce_sha256,p_team_id,p_project_id)
    and binding.signed_sandbox_id is null and binding.expires_at > clock_timestamp()
    and exists (select 1 from internal.factory_benchmark_inference_connections connection
      where connection.id = trial.inference_connection_revision and connection.revoked_at is null);
  return found;
exception when unique_violation then return false;
end;
$$;

create function public.read_factory_benchmark_live_sandbox_binding(
  p_trial_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare trial public.factory_benchmark_trials;
begin
  perform internal.assert_checkpoint_publication_service();
  trial := internal.lock_live_factory_benchmark_trial(p_trial_id,p_job_id,p_run_id,p_attempt_count);
  if trial.id is null then return null; end if;
  return (select jsonb_build_object('signedSandboxId', binding.signed_sandbox_id)
    from internal.factory_benchmark_live_sandbox_bindings binding where binding.trial_id = trial.id
      and binding.signed_sandbox_id is not null and binding.closed_at is null);
end;
$$;

create function public.enable_factory_benchmark_live_inference(
  p_trial_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer, p_signed_sandbox_id text,
  p_replay_prompt_sha256 text, p_input_bundle_sha256 text, p_restoration_receipt_sha256 text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare trial public.factory_benchmark_trials;
begin
  perform internal.assert_checkpoint_publication_service();
  trial := internal.lock_live_factory_benchmark_trial(p_trial_id,p_job_id,p_run_id,p_attempt_count);
  if trial.id is null or exists (select 1 from unnest(array[p_replay_prompt_sha256,p_input_bundle_sha256,
    p_restoration_receipt_sha256]) digest(value) where not coalesce(value ~ '^[a-f0-9]{64}$', false))
  then return false; end if;
  if not exists (
    select 1 from public.factory_benchmark_replay_executions execution
    where (execution.workspace_id, execution.factory_id, execution.id, execution.task_revision_id,
      execution.policy_revision_id, execution.policy_digest, execution.created_by, execution.restoration_receipt_sha256) =
      (trial.workspace_id, trial.factory_id, trial.id, trial.task_revision_id,
       trial.policy_revision_id, trial.policy_digest, trial.actor_user_id, p_restoration_receipt_sha256)
  ) then return false; end if;
  update internal.factory_benchmark_live_sandbox_bindings binding
  set ready_at = clock_timestamp(), replay_prompt_sha256 = p_replay_prompt_sha256,
    input_bundle_sha256 = p_input_bundle_sha256, restoration_receipt_sha256 = p_restoration_receipt_sha256
  where (binding.trial_id, binding.signed_sandbox_id) = (trial.id,p_signed_sandbox_id)
    and binding.ready_at is null and binding.closed_at is null;
  return found;
end;
$$;

create function public.begin_factory_benchmark_inference_request(
  p_team_id text, p_project_id text, p_signed_sandbox_id text, p_request_digest text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  connection internal.factory_benchmark_inference_connections;
  expected_model text;
  request_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  if not coalesce(p_request_digest ~ '^[a-f0-9]{64}$', false) then return null; end if;
  select run.* into trial from internal.factory_benchmark_live_sandbox_bindings binding
  join public.factory_benchmark_trials run on run.id = binding.trial_id
  where (binding.team_id,binding.project_id,binding.signed_sandbox_id) = (p_team_id,p_project_id,p_signed_sandbox_id);
  if not found then return null; end if;
  trial := internal.lock_live_factory_benchmark_trial(trial.id,trial.job_id,trial.run_id,trial.attempt_count);
  if trial.id is null then return null; end if;
  perform 1 from internal.factory_benchmark_live_sandbox_bindings binding
  where binding.trial_id = trial.id and binding.ready_at is not null and binding.closed_at is null
  for update;
  if not found or exists (select 1 from internal.factory_benchmark_replay_revocations revocation
    where revocation.policy_revision_id = trial.policy_revision_id) then return null; end if;
  select key.* into connection from internal.factory_benchmark_inference_connections key
  join public.workspace_vercel_sandbox_connections sandbox
  on (sandbox.workspace_id,sandbox.connection_revision,sandbox.status) =
    (key.workspace_id,key.sandbox_connection_revision,'connected')
  where (key.workspace_id,key.factory_id,key.id,key.sandbox_connection_revision) =
    (trial.workspace_id,trial.factory_id,trial.inference_connection_revision,trial.sandbox_connection_revision)
    and (sandbox.team_id,sandbox.project_id) = (p_team_id,p_project_id) and key.revoked_at is null
  for share of key;
  if not found then return null; end if;
  select split_part(candidate.canonical_model_key,'/',2) into expected_model
  from public.factory_benchmark_experiment_trials cell
  join public.factory_benchmark_experiment_candidates candidate
    using (workspace_id,factory_id,experiment_id,candidate_key)
  where cell.trial_id = trial.id and candidate.live_inference_connection_revision = connection.id;
  if not found or expected_model = '' or (select count(*) from internal.factory_benchmark_inference_requests request
      where request.trial_id = trial.id) >= 40 then return null; end if;
  insert into internal.factory_benchmark_inference_requests(trial_id,request_digest,expected_model)
  values (trial.id,p_request_digest,expected_model) returning id into request_id;
  return jsonb_build_object('requestId',request_id,'deadlineAt',trial.deadline_at,
    'model',expected_model,'encryptedApiKey',connection.encrypted_api_key);
end;
$$;

create function public.is_factory_benchmark_inference_request_open(p_request_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return exists (
    select 1 from internal.factory_benchmark_inference_requests request
    join internal.factory_benchmark_live_sandbox_bindings binding on binding.trial_id = request.trial_id
    join public.factory_benchmark_trials trial on trial.id = request.trial_id
    join public.agent_jobs job on job.id = trial.job_id and job.attempt_count = trial.attempt_count
    join public.agent_runs run on run.id = trial.run_id and run.attempt_count = trial.attempt_count
    join internal.factory_benchmark_inference_connections connection on connection.id = trial.inference_connection_revision
    join public.workspace_vercel_sandbox_connections sandbox
      on (sandbox.workspace_id,sandbox.connection_revision,sandbox.status) =
        (connection.workspace_id,connection.sandbox_connection_revision,'connected')
    where request.id = p_request_id and request.status = 'started'
      and binding.ready_at is not null and binding.closed_at is null
      and trial.status = 'running' and trial.deadline_at > clock_timestamp()
      and connection.revoked_at is null and job.status in ('started','running') and run.status = 'running'
      and not exists (select 1 from internal.factory_benchmark_replay_revocations revocation
        where revocation.policy_revision_id = trial.policy_revision_id)
  );
end;
$$;

create function public.finish_factory_benchmark_inference_request(
  p_request_id uuid, p_status text, p_observed_model text default null,
  p_input_tokens integer default null, p_output_tokens integer default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  delivery_allowed boolean := false;
  resolved_status text := p_status;
begin
  perform internal.assert_checkpoint_publication_service();
  if not coalesce(p_status in ('completed','failed','unavailable'),false)
    or (p_input_tokens is null) <> (p_output_tokens is null)
    or coalesce(least(p_input_tokens,p_output_tokens) < 0,false)
    or coalesce(length(p_observed_model) > 200,false) then return false; end if;
  if p_status = 'completed' then
    select current.* into trial from internal.factory_benchmark_inference_requests request
    join public.factory_benchmark_trials current on current.id = request.trial_id
    where request.id = p_request_id and request.expected_model = p_observed_model;
    if not found then return false; end if;
    trial := internal.lock_live_factory_benchmark_trial(trial.id,trial.job_id,trial.run_id,trial.attempt_count);
    if trial.id is not null then
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
  where request.id = p_request_id and request.status = 'started'
    and (p_status <> 'completed' or p_observed_model = request.expected_model);
  if found then return p_status <> 'completed' or delivery_allowed; end if;
  return (p_status <> 'completed' or delivery_allowed) and exists (select 1 from internal.factory_benchmark_inference_requests request
    where request.id = p_request_id and
      (request.status,request.observed_model,request.input_tokens,request.output_tokens) is not distinct from
      (resolved_status,p_observed_model,p_input_tokens,p_output_tokens));
end;
$$;

create function public.close_factory_benchmark_live_inference(
  p_trial_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  receipt internal.factory_benchmark_inference_receipts;
begin
  perform internal.assert_checkpoint_publication_service();
  trial := internal.lock_live_factory_benchmark_trial(p_trial_id,p_job_id,p_run_id,p_attempt_count);
  if trial.id is null then return null; end if;
  update internal.factory_benchmark_live_sandbox_bindings binding set closed_at = clock_timestamp()
    where binding.trial_id = trial.id and binding.ready_at is not null and binding.closed_at is null;
  if found then
    update internal.factory_benchmark_inference_requests request
      set status = 'unavailable', finished_at = clock_timestamp()
      where request.trial_id = trial.id and request.status = 'started';
    insert into internal.factory_benchmark_inference_receipts
      (trial_id,observed_model,request_count,unavailable_usage_count,input_tokens,output_tokens)
    select trial.id,
      min(request.observed_model) filter (where request.status = 'completed'),
      count(*), count(*) filter (where request.input_tokens is null),
      coalesce(sum(request.input_tokens),0), coalesce(sum(request.output_tokens),0)
    from internal.factory_benchmark_inference_requests request
    where request.trial_id = trial.id
    having count(*) filter (where request.status = 'completed') > 0
      and count(distinct request.observed_model) filter (where request.status = 'completed') = 1
    returning * into receipt;
  else
    select * into receipt from internal.factory_benchmark_inference_receipts aggregate
    where aggregate.trial_id = trial.id;
  end if;
  if receipt.id is null then return null; end if;
  return jsonb_build_object('inferenceReceiptId',receipt.id,'observedModel',receipt.observed_model);
end;
$$;

revoke all on function
  public.configure_factory_benchmark_inference_connection(uuid,uuid,uuid,text,jsonb),
  public.read_factory_benchmark_inference_connection(uuid,uuid,uuid),
  public.revoke_factory_benchmark_inference_connection(uuid,uuid,uuid,uuid),
  public.arm_factory_benchmark_live_sandbox_binding(uuid,uuid,uuid,integer,text,timestamptz),
  public.consume_factory_benchmark_live_sandbox_binding(text,text,text,text),
  public.read_factory_benchmark_live_sandbox_binding(uuid,uuid,uuid,integer),
  public.enable_factory_benchmark_live_inference(uuid,uuid,uuid,integer,text,text,text,text),
  public.begin_factory_benchmark_inference_request(text,text,text,text),
  public.is_factory_benchmark_inference_request_open(uuid),
  public.finish_factory_benchmark_inference_request(uuid,text,text,integer,integer),
  public.close_factory_benchmark_live_inference(uuid,uuid,uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.configure_factory_benchmark_inference_connection(uuid,uuid,uuid,text,jsonb),
  public.read_factory_benchmark_inference_connection(uuid,uuid,uuid),
  public.revoke_factory_benchmark_inference_connection(uuid,uuid,uuid,uuid),
  public.arm_factory_benchmark_live_sandbox_binding(uuid,uuid,uuid,integer,text,timestamptz),
  public.consume_factory_benchmark_live_sandbox_binding(text,text,text,text),
  public.read_factory_benchmark_live_sandbox_binding(uuid,uuid,uuid,integer),
  public.enable_factory_benchmark_live_inference(uuid,uuid,uuid,integer,text,text,text,text),
  public.begin_factory_benchmark_inference_request(text,text,text,text),
  public.is_factory_benchmark_inference_request_open(uuid),
  public.finish_factory_benchmark_inference_request(uuid,text,text,integer,integer),
  public.close_factory_benchmark_live_inference(uuid,uuid,uuid,integer)
  to service_role;
