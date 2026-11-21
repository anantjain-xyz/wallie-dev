alter table public.sessions add column execution_purpose text not null default 'production'
  check (execution_purpose in ('production', 'benchmark'));
alter table public.sessions drop constraint sessions_number_positive_check;
alter table public.sessions add constraint sessions_number_matches_execution_purpose check (
  (execution_purpose = 'production' and number > 0) or (execution_purpose = 'benchmark' and number < 0)
);
create sequence internal.factory_benchmark_session_number as integer increment by -1 minvalue -2147483648
  maxvalue -1 start with -1 no cycle;
revoke all on sequence internal.factory_benchmark_session_number from public, anon, authenticated, service_role;

create function internal.guard_session_execution_purpose()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.execution_purpose is distinct from old.execution_purpose then
    raise exception 'Session execution purpose is immutable.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new.execution_purpose = 'benchmark'
    and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'Benchmark sessions require trial admission.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_session_execution_purpose() from public, anon, authenticated, service_role;
create trigger guard_session_execution_purpose before insert or update of execution_purpose on public.sessions
  for each row execute function internal.guard_session_execution_purpose();

create or replace function internal.enroll_fresh_git_continuity_session()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.execution_purpose = 'production' then
    insert into public.session_git_continuity_enrollments(session_id, workspace_id) values(new.id, new.workspace_id);
  end if;
  return new;
end;
$$;

create table public.factory_benchmark_trials (
  id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  actor_user_id uuid not null,
  task_id uuid not null,
  task_revision_id uuid not null,
  policy_revision_id uuid not null,
  policy_digest text not null check (policy_digest ~ '^[a-f0-9]{64}$'),
  fixture_key text not null check (fixture_key ~ '^[a-f0-9]{64}$'),
  fixture_revision_id uuid not null,
  sandbox_connection_revision uuid not null,
  runner_revision text not null default 'recorded-fixture-v1' check (runner_revision = 'recorded-fixture-v1'),
  session_id uuid not null unique,
  job_id uuid not null unique references public.agent_jobs(id) on delete cascade,
  run_id uuid not null unique references public.agent_runs(id) on delete cascade,
  replay_execution_id uuid generated always as (id) stored not null,
  attempt_count integer check (attempt_count = 1),
  deadline_at timestamptz,
  status text not null default 'queued' check (status in ('queued','running','success','error','canceled')),
  failure_code text check (failure_code in (
    'sandbox_unavailable','replay_unavailable','fixture_unavailable','candidate_failed',
    'validation_failed','checkpoint_unavailable','attempt_lost'
  )),
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check ((status = 'error') = (failure_code is not null)),
  check ((status in ('success','error','canceled')) = (finished_at is not null)),
  check (status not in ('running','success') or (attempt_count is not null and deadline_at is not null)),
  unique (workspace_id, factory_id, id),
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  foreign key (workspace_id, factory_id, task_id, task_revision_id)
    references public.factory_benchmark_task_revisions(workspace_id, factory_id, task_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, policy_revision_id)
    references public.factory_benchmark_replay_policy_revisions(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, fixture_revision_id)
    references public.factory_benchmark_replay_fixture_revisions(workspace_id, factory_id, id) on delete cascade
);
create index factory_benchmark_trials_task_idx on public.factory_benchmark_trials(workspace_id, factory_id, task_id, task_revision_id);
create index factory_benchmark_trials_policy_idx on public.factory_benchmark_trials(workspace_id, factory_id, policy_revision_id);
create index factory_benchmark_trials_fixture_idx on public.factory_benchmark_trials(workspace_id, factory_id, fixture_revision_id);

create table public.factory_benchmark_trial_results (
  trial_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  run_id uuid not null,
  replay_execution_id uuid not null,
  fixture_operation_id uuid not null,
  fixture_revision_id uuid not null,
  fixture_response_sha256 text not null,
  restoration_receipt_sha256 text not null,
  input_bundle_sha256 text not null,
  input_commit_sha text not null,
  input_tree_sha text not null,
  output_commit_sha text not null,
  output_tree_sha text not null,
  artifact_markdown text not null,
  artifact_sha256 text not null,
  checkpoint_bundle_sha256 text not null,
  checkpoint_storage_path text not null unique,
  validation jsonb not null,
  runtime text not null check (runtime in ('node','workerd')),
  result_digest text not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, factory_id, trial_id)
    references public.factory_benchmark_trials(workspace_id, factory_id, id) on delete cascade,
  foreign key (replay_execution_id, fixture_operation_id)
    references public.factory_benchmark_replay_operations(execution_id, operation_id) on delete cascade
);
create index factory_benchmark_trial_results_operation_idx
  on public.factory_benchmark_trial_results(replay_execution_id, fixture_operation_id);
create trigger preserve_factory_benchmark_trial_results before update or delete on public.factory_benchmark_trial_results
  for each row execute function internal.preserve_factory_benchmark_history();

alter table public.factory_benchmark_trials enable row level security;
alter table public.factory_benchmark_trial_results enable row level security;
revoke all on public.factory_benchmark_trials, public.factory_benchmark_trial_results
  from public, anon, authenticated, service_role;
grant select on public.factory_benchmark_trials, public.factory_benchmark_trial_results to service_role;
comment on table public.factory_benchmark_trial_results is
  'Private replay results and adopted checkpoint objects scoped to the exact internal job attempt.';

-- The reservation is the only cleanup owner until finish transfers the object.
create unique index workspace_resource_operations_benchmark_checkpoint_path_idx
  on public.workspace_resource_operations(workspace_id, resource_id)
  where kind = 'upload' and storage_bucket = 'session-source-checkpoints'
    and split_part(resource_id, '/', 2) = 'benchmark';

create function internal.guard_factory_benchmark_checkpoint_reservation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.factory_benchmark_trials trial
    where trial.workspace_id = new.workspace_id and trial.status = 'running' and trial.deadline_at > clock_timestamp()
      and new.resource_id ~ ('^' || trial.workspace_id::text || '/benchmark/' || trial.id::text || '/' ||
        trial.run_id::text || '/[a-f0-9]{64}[.]bundle$')
  ) then
    raise exception 'Checkpoint upload requires an active exact benchmark trial.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_factory_benchmark_checkpoint_reservation()
  from public, anon, authenticated, service_role;
create trigger guard_factory_benchmark_checkpoint_reservation
  after insert or update of workspace_id, kind, storage_bucket, resource_id on public.workspace_resource_operations
  for each row when (new.kind = 'upload' and new.storage_bucket = 'session-source-checkpoints'
    and split_part(new.resource_id, '/', 2) = 'benchmark')
  execute function internal.guard_factory_benchmark_checkpoint_reservation();

create function internal.guard_factory_benchmark_checkpoint_storage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare owner_id uuid;
begin
  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.factory_benchmark_trial_results result
      join public.workspaces workspace on workspace.id = result.workspace_id
      where result.checkpoint_storage_path = old.name and workspace.deletion_requested_at is null
    ) then
      raise exception 'A retained benchmark checkpoint is owned by its trial result.' using errcode = '23514';
    end if;
    return old;
  end if;

  owner_id := split_part(new.name, '/', 1)::uuid;
  perform internal.assert_workspace_accepts_work(owner_id);
  -- Share transfer and cleanup's reservation lock. Delayed Storage writes
  -- cannot recreate or replace a transferred or already reclaimed object.
  perform 1 from public.workspace_resource_operations upload
  where (upload.workspace_id, upload.kind, upload.storage_bucket, upload.resource_id) =
    (owner_id, 'upload', new.bucket_id, new.name)
    and upload.settled_at is null and upload.recovery_after > clock_timestamp()
  for update;
  if not found then
    raise exception 'Benchmark checkpoint upload reservation is not active.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_factory_benchmark_checkpoint_storage() from public, anon, authenticated, service_role;
create trigger guard_factory_benchmark_checkpoint_storage before insert or update on storage.objects
  for each row when (new.bucket_id = 'session-source-checkpoints' and split_part(new.name, '/', 2) = 'benchmark')
  execute function internal.guard_factory_benchmark_checkpoint_storage();
create trigger preserve_factory_benchmark_checkpoint_storage before delete on storage.objects
  for each row when (old.bucket_id = 'session-source-checkpoints' and split_part(old.name, '/', 2) = 'benchmark')
  execute function internal.guard_factory_benchmark_checkpoint_storage();

create function internal.assert_factory_benchmark_trial_pin(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_task_revision_id uuid,
  p_policy_revision_id uuid, p_policy_digest text, p_fixture_key text, p_sandbox_connection_revision uuid
) returns uuid language plpgsql set search_path = '' as $$
declare fixture_id uuid;
begin
  perform public.assert_factory_benchmark_replay_access(p_workspace_id, p_factory_id, p_actor_user_id, p_task_revision_id);
  select fixture.id into fixture_id from public.factory_benchmark_replay_policy_revisions policy
  join internal.factory_benchmark_replay_policy_fixtures approved
    on (approved.workspace_id, approved.factory_id, approved.policy_revision_id) =
      (policy.workspace_id, policy.factory_id, policy.id)
  join public.factory_benchmark_replay_fixture_revisions fixture
    on (fixture.workspace_id, fixture.factory_id, fixture.id) =
      (approved.workspace_id, approved.factory_id, approved.fixture_revision_id)
  where (policy.workspace_id, policy.factory_id, policy.id, policy.policy_digest) =
      (p_workspace_id, p_factory_id, p_policy_revision_id, p_policy_digest)
    and policy.profile in ('recorded_fixtures','isolated_test')
    and (fixture.operation, fixture.fixture_key) = ('tool_read', p_fixture_key)
    and not exists (select 1 from internal.factory_benchmark_replay_revocations revoked
      where revoked.policy_revision_id = policy.id or revoked.fixture_revision_id = fixture.id);
  if not found then
    raise exception 'An approved replay fixture is required.' using errcode = 'PT422';
  end if;

  perform 1 from public.workspace_vercel_sandbox_connections connection
  where (connection.workspace_id, connection.connection_revision, connection.status) =
    (p_workspace_id, p_sandbox_connection_revision, 'connected') for share;
  if not found then
    raise exception 'The isolated sandbox connection is unavailable.' using errcode = 'PT422';
  end if;
  return fixture_id;
end;
$$;
revoke all on function internal.assert_factory_benchmark_trial_pin(uuid, uuid, uuid, uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;

create function public.admit_factory_benchmark_trial(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_trial_id uuid, p_task_revision_id uuid,
  p_policy_revision_id uuid, p_policy_digest text, p_fixture_key text, p_sandbox_connection_revision uuid
) returns public.factory_benchmark_trials
language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  actor_member_id uuid;
  task_revision public.factory_benchmark_task_revisions;
  input public.factory_benchmark_task_inputs;
  source public.sessions;
  source_run public.agent_runs;
  anchor public.pipeline_stages;
  manifest_stage_id uuid;
  fixture_id uuid;
  internal_session_id uuid := gen_random_uuid();
  internal_job_id uuid := gen_random_uuid();
  internal_run_id uuid := gen_random_uuid();
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_trial_id is null or coalesce(p_policy_digest !~ '^[a-f0-9]{64}$', true)
    or coalesce(p_fixture_key !~ '^[a-f0-9]{64}$', true) then
    raise exception 'Provide a trial identity and exact replay policy and fixture pins.' using errcode = '22023';
  end if;
  -- Serialize a client-generated ID even if two different factories race to claim it.
  perform pg_advisory_xact_lock(hashtextextended(p_trial_id::text, 616));
  select * into trial from public.factory_benchmark_trials existing where existing.id = p_trial_id;
  if found then
    if (trial.workspace_id, trial.factory_id, trial.actor_user_id, trial.task_revision_id, trial.policy_revision_id,
        trial.policy_digest, trial.fixture_key, trial.sandbox_connection_revision)
      is distinct from (p_workspace_id, p_factory_id, p_actor_user_id, p_task_revision_id, p_policy_revision_id,
        p_policy_digest, p_fixture_key, p_sandbox_connection_revision) then
      raise exception 'The trial identity already refers to different immutable inputs.' using errcode = 'PT409';
    end if;
    return trial;
  end if;

  fixture_id := internal.assert_factory_benchmark_trial_pin(p_workspace_id, p_factory_id, p_actor_user_id,
    p_task_revision_id, p_policy_revision_id, p_policy_digest, p_fixture_key, p_sandbox_connection_revision);
  select * into strict task_revision from public.factory_benchmark_task_revisions where id = p_task_revision_id;
  select * into strict input from public.factory_benchmark_task_inputs where task_id = task_revision.task_id;
  select * into strict source from public.sessions where id = input.source_session_id;
  select * into strict source_run from public.agent_runs where id = input.source_run_id;
  if input.checkout_sha is null then
    raise exception 'The trial requires an exact source checkout.' using errcode = 'PT422';
  end if;
  select manifest.stage_id into manifest_stage_id from public.session_attempt_manifests manifest
  where (manifest.workspace_id, manifest.session_id, manifest.run_id, manifest.job_id, manifest.attempt_count) =
    (input.workspace_id, input.source_session_id, input.source_run_id, input.source_job_id, input.source_attempt_count);
  if manifest_stage_id is not null and source_run.stage_id is not null
    and manifest_stage_id <> source_run.stage_id then
    raise exception 'The original trial stage does not match its attempt provenance.' using errcode = 'PT422';
  end if;
  select stage.* into anchor from public.pipeline_stages stage
  where (stage.workspace_id, stage.pipeline_id) = (source.workspace_id, source.pipeline_id)
    and stage.id = coalesce(manifest_stage_id, source_run.stage_id);
  if not found then
    raise exception 'The original trial stage is unavailable.' using errcode = 'PT422';
  end if;

  insert into public.sessions (
    id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id,
    phase_status, execution_purpose, factory_definition_provenance, factory_definition_revision_id,
    execution_policy_revision_id
  ) values (
    internal_session_id, p_workspace_id, p_factory_id, nextval('internal.factory_benchmark_session_number'),
    'Benchmark trial', actor_member_id, source.pipeline_id, anchor.id, 'in_progress', 'benchmark',
    'pinned', input.definition_revision_id, source.execution_policy_revision_id
  );
  insert into public.agent_jobs (
    id, workspace_id, session_id, requested_by_member_id, stage_id, stage_slug, stage_name, trigger_type
  ) values (
    internal_job_id, p_workspace_id, internal_session_id, actor_member_id, anchor.id, anchor.slug, anchor.name, 'manual_run'
  );
  insert into public.agent_runs (
    id, workspace_id, session_id, agent_job_id, triggered_by_member_id, stage_id, stage_slug, stage_name,
    run_type, model_provider, model_name
  ) values (
    internal_run_id, p_workspace_id, internal_session_id, internal_job_id, actor_member_id, anchor.id, anchor.slug, anchor.name,
    'project', 'benchmark', 'recorded-fixture-v1'
  );
  insert into public.factory_benchmark_trials (
    id, workspace_id, factory_id, actor_user_id, task_id, task_revision_id, policy_revision_id, policy_digest,
    fixture_key, fixture_revision_id, sandbox_connection_revision, session_id, job_id, run_id
  ) values (
    p_trial_id, p_workspace_id, p_factory_id, p_actor_user_id, task_revision.task_id, p_task_revision_id,
    p_policy_revision_id, p_policy_digest, p_fixture_key, fixture_id, p_sandbox_connection_revision,
    internal_session_id, internal_job_id, internal_run_id
  ) returning * into trial;
  return trial;
end;
$$;

-- Existing lifecycle transactions lock session, job and run in this order.
create function internal.lock_factory_benchmark_trial(p_trial_id uuid, p_job_id uuid)
returns public.factory_benchmark_trials language plpgsql set search_path = '' as $$
declare trial public.factory_benchmark_trials;
begin
  select * into trial from public.factory_benchmark_trials t where (t.id, t.job_id) = (p_trial_id, p_job_id);
  if not found then return null; end if;
  perform 1 from public.sessions s where (s.workspace_id, s.factory_id, s.id, s.execution_purpose) =
    (trial.workspace_id, trial.factory_id, trial.session_id, 'benchmark') for no key update;
  if not found then return null; end if;
  perform 1 from public.agent_jobs j where (j.workspace_id, j.session_id, j.id) =
    (trial.workspace_id, trial.session_id, trial.job_id) for update;
  if not found then return null; end if;
  perform 1 from public.agent_runs r where (r.workspace_id, r.session_id, r.agent_job_id, r.id) =
    (trial.workspace_id, trial.session_id, trial.job_id, trial.run_id) for update;
  if not found then return null; end if;
  select * into trial from public.factory_benchmark_trials t where t.id = p_trial_id for update;
  return trial;
end;
$$;
revoke all on function internal.lock_factory_benchmark_trial(uuid, uuid) from public, anon, authenticated, service_role;

create function public.start_factory_benchmark_trial(
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
    or coalesce(budget.remaining_execution_ms <= 0, false)
    or effective_deadline <= clock_timestamp() then
    perform public.fail_session_job_attempt(p_job_id, p_attempt_count,
      'Benchmark trial deadline or execution budget unavailable.', false, 0);
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

-- The common stall reconciler drives the job fence. Its terminal update also
-- retires the trial, including a claim lost before start bound the run.
create function internal.record_factory_benchmark_job_terminal()
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
      failure_code = case when new.status = 'error' then 'attempt_lost' end,
      finished_at = coalesce(new.finished_at, clock_timestamp())
    where trial.job_id = new.id and trial.status in ('queued','running');
  end if;
  return new;
end;
$$;
revoke all on function internal.record_factory_benchmark_job_terminal() from public, anon, authenticated, service_role;
create trigger record_factory_benchmark_job_terminal before update of status on public.agent_jobs
  for each row execute function internal.record_factory_benchmark_job_terminal();

create or replace view public.pinned_job_recovery_settings with (security_invoker = true) as
select job.id as job_id, case when owner.execution_purpose = 'benchmark' then 180000
    else (definition #>> '{agent,stallTimeoutMs}')::integer end as stall_timeout_ms,
  case when owner.execution_purpose = 'benchmark' then 0
    else (definition #>> '{agent,maxRetries}')::integer end as max_retries
from public.agent_jobs job
join public.sessions owner on (owner.workspace_id, owner.id) = (job.workspace_id, job.session_id)
cross join lateral (select internal.pinned_session_execution_definition(owner) as definition) recipe
where owner.execute_pinned_definition or owner.execution_purpose = 'benchmark';

create function public.fail_factory_benchmark_trial(
  p_trial_id uuid, p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_failure_code text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare trial public.factory_benchmark_trials;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_failure_code is null or p_failure_code not in (
    'sandbox_unavailable','replay_unavailable','fixture_unavailable','candidate_failed',
    'validation_failed','checkpoint_unavailable','attempt_lost'
  ) then raise exception 'Unknown trial failure code.' using errcode = '22023'; end if;
  trial := internal.lock_factory_benchmark_trial(p_trial_id, p_job_id);
  if trial.id is null or (trial.attempt_count, trial.run_id) is distinct from (p_attempt_count, p_run_id) then
    return false;
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

create function public.cancel_factory_benchmark_trial(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_trial_id uuid, p_expected_run_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  canceled record;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into trial from public.factory_benchmark_trials t
  where (t.workspace_id, t.factory_id, t.id, t.run_id) = (p_workspace_id, p_factory_id, p_trial_id, p_expected_run_id);
  if not found then return false; end if;
  trial := internal.lock_factory_benchmark_trial(trial.id, trial.job_id);
  if trial.status = 'canceled' then return true; end if;
  if trial.id is null or trial.status not in ('queued','running') then return false; end if;
  select * into strict canceled from public.cancel_session_job_attempts(
    trial.session_id, trial.workspace_id, 'Benchmark trial canceled.', trial.run_id, true
  );
  return trial.run_id = any(canceled.run_ids) and trial.job_id = any(canceled.job_ids);
end;
$$;

create function public.finish_factory_benchmark_trial(
  p_trial_id uuid, p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_result jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  trial public.factory_benchmark_trials;
  execution public.factory_benchmark_replay_executions;
  operation public.factory_benchmark_replay_operations;
  upload public.workspace_resource_operations;
  checkpoint_path text;
  evidence jsonb;
  receipt_digest text;
  digest_key text;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into trial from public.factory_benchmark_trials t
  where (t.id, t.job_id, t.run_id, t.attempt_count) = (p_trial_id, p_job_id, p_run_id, p_attempt_count);
  if not found or trial.status not in ('running','success') then return false; end if;

  if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text) > 270336 then
    raise exception 'Trial output must be a bounded result object.' using errcode = '22023';
  end if;
  if p_result - array['restorationReceiptSha256','inputBundleSha256','inputCommitSha','inputTreeSha',
    'outputCommitSha','outputTreeSha','fixtureOperationId','artifactMarkdown','checkpointBundleSha256',
    'checkpointStoragePath','checkpointUploadOperationId','validation','runtime'] <> '{}'::jsonb
    or coalesce(p_result->>'runtime' not in ('node','workerd'), true)
    or jsonb_typeof(p_result->'artifactMarkdown') is distinct from 'string'
    or octet_length(p_result->>'artifactMarkdown') not between 1 and 131072
    or nullif(btrim(p_result->>'artifactMarkdown'), '') is null then
    raise exception 'Trial output is malformed.' using errcode = '22023';
  end if;
  foreach digest_key in array array['restorationReceiptSha256','inputBundleSha256','checkpointBundleSha256'] loop
    if coalesce(p_result->>digest_key !~ '^[a-f0-9]{64}$', true) then
      raise exception 'Trial output must carry its exact SHA-256 receipts.' using errcode = '22023';
    end if;
  end loop;
  foreach digest_key in array array['inputCommitSha','inputTreeSha','outputCommitSha','outputTreeSha'] loop
    if coalesce(p_result->>digest_key !~ '^[a-f0-9]{40}$', true) then
      raise exception 'Trial output must carry exact Git commit and tree identities.' using errcode = '22023';
    end if;
  end loop;
  evidence := p_result->'validation';
  if coalesce(evidence->>'outputSha256' !~ '^[a-f0-9]{64}$', true)
    or evidence is distinct from jsonb_build_object(
      'version', 1, 'key', 'recorded-fixture-output', 'status', 'passed', 'commitSha', p_result->>'outputCommitSha',
      'treeSha', p_result->>'outputTreeSha', 'outputSha256', evidence->>'outputSha256'
    )
    or p_result->>'outputCommitSha' = p_result->>'inputCommitSha'
    or p_result->>'outputTreeSha' = p_result->>'inputTreeSha' then
    raise exception 'Validation must bind the exact produced commit and tree.' using errcode = '23514';
  end if;
  receipt_digest := encode(sha256(convert_to(p_result::text, 'UTF8')), 'hex');
  if trial.status = 'success' then
    return exists (select 1 from public.factory_benchmark_trial_results result
      where result.trial_id = trial.id and result.result_digest = receipt_digest);
  end if;
  if internal.assert_factory_benchmark_trial_pin(trial.workspace_id, trial.factory_id, trial.actor_user_id,
    trial.task_revision_id, trial.policy_revision_id, trial.policy_digest, trial.fixture_key,
    trial.sandbox_connection_revision) is distinct from trial.fixture_revision_id then
    raise exception 'The approved trial fixture is unavailable.' using errcode = '42501';
  end if;

  trial := internal.lock_factory_benchmark_trial(p_trial_id, p_job_id);
  if trial.status = 'success' then
    return exists (select 1 from public.factory_benchmark_trial_results result
      where result.trial_id = trial.id and result.result_digest = receipt_digest);
  end if;
  if trial.id is null or trial.status <> 'running' or clock_timestamp() >= trial.deadline_at or not exists (
    select 1 from public.agent_jobs job
    join public.agent_runs run on (run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
      (job.workspace_id, job.session_id, job.id, job.attempt_count)
    join public.sessions owner on (owner.workspace_id, owner.id) = (job.workspace_id, job.session_id)
    where (job.id, job.attempt_count, run.id) = (p_job_id, p_attempt_count, p_run_id)
      and owner.phase_status = 'in_progress' and owner.archived_at is null
      and run.status = 'running' and job.status in ('started','running')
  ) then return false; end if;

  select * into execution from public.factory_benchmark_replay_executions opened
  where (opened.workspace_id, opened.factory_id, opened.id, opened.task_revision_id, opened.policy_revision_id,
    opened.policy_digest, opened.created_by, opened.restoration_receipt_sha256) =
    (trial.workspace_id, trial.factory_id, trial.replay_execution_id, trial.task_revision_id, trial.policy_revision_id,
      trial.policy_digest, trial.actor_user_id, p_result->>'restorationReceiptSha256');
  if not found or not exists (select 1 from public.factory_benchmark_task_inputs input
    where (input.workspace_id, input.factory_id, input.task_id, input.checkout_sha) =
      (trial.workspace_id, trial.factory_id, trial.task_id, p_result->>'inputCommitSha')
  ) then raise exception 'The result does not match its exact restored inputs.' using errcode = '23514'; end if;

  select * into operation from public.factory_benchmark_replay_operations recorded
  where (recorded.workspace_id, recorded.factory_id, recorded.execution_id, recorded.operation_id,
    recorded.operation, recorded.fixture_key, recorded.decision, recorded.fixture_revision_id) =
    (trial.workspace_id, trial.factory_id, execution.id, (p_result->>'fixtureOperationId')::uuid,
      'tool_read', trial.fixture_key, 'stubbed', trial.fixture_revision_id);
  if not found then
    raise exception 'The result requires its exact approved fixture receipt.' using errcode = '23514';
  end if;

  checkpoint_path := trial.workspace_id::text || '/benchmark/' || trial.id::text || '/' || trial.run_id::text ||
    '/' || (p_result->>'checkpointBundleSha256') || '.bundle';
  if p_result->>'checkpointStoragePath' is distinct from checkpoint_path then
    raise exception 'The checkpoint path does not match the trial attempt.' using errcode = '23514';
  end if;
  select * into upload from public.workspace_resource_operations pending
  where (pending.id, pending.workspace_id, pending.kind, pending.storage_bucket, pending.resource_id) =
    ((p_result->>'checkpointUploadOperationId')::uuid, trial.workspace_id, 'upload', 'session-source-checkpoints', checkpoint_path)
  for update;
  if not found or upload.settled_at is not null or upload.recovery_after <= clock_timestamp() then
    raise exception 'The private checkpoint upload is unavailable.' using errcode = '23514';
  end if;
  perform 1 from storage.objects object
  where (object.bucket_id, object.name) = ('session-source-checkpoints', checkpoint_path)
    and object.metadata->>'mimetype' = 'application/octet-stream'
    and (object.metadata->>'size')::bigint > 0 for key share;
  if not found then
    raise exception 'The private checkpoint has not been retained.' using errcode = '23514';
  end if;
  if clock_timestamp() >= trial.deadline_at then return false; end if;

  insert into public.factory_benchmark_trial_results (
    trial_id, workspace_id, factory_id, run_id, replay_execution_id, fixture_operation_id, fixture_revision_id,
    fixture_response_sha256, restoration_receipt_sha256, input_bundle_sha256, input_commit_sha, input_tree_sha,
    output_commit_sha, output_tree_sha, artifact_markdown, artifact_sha256, checkpoint_bundle_sha256,
    checkpoint_storage_path, validation, runtime, result_digest
  ) values (
    trial.id, trial.workspace_id, trial.factory_id, trial.run_id, execution.id, operation.operation_id, operation.fixture_revision_id,
    operation.fixture_response_sha256, execution.restoration_receipt_sha256, p_result->>'inputBundleSha256',
    p_result->>'inputCommitSha', p_result->>'inputTreeSha', p_result->>'outputCommitSha', p_result->>'outputTreeSha',
    p_result->>'artifactMarkdown', encode(sha256(convert_to(p_result->>'artifactMarkdown', 'UTF8')), 'hex'),
    p_result->>'checkpointBundleSha256', checkpoint_path, evidence, p_result->>'runtime', receipt_digest
  );
  update public.agent_runs set status = 'success', finished_at = clock_timestamp(), last_activity_at = clock_timestamp()
  where id = p_run_id;
  if not public.complete_session_job_attempt(p_job_id, p_attempt_count, p_run_id) then
    raise exception 'The trial claim is no longer current.' using errcode = 'PT409';
  end if;
  update public.sessions set phase_status = 'approved' where id = trial.session_id;
  update public.factory_benchmark_trials set status = 'success', finished_at = clock_timestamp() where id = trial.id;
  perform public.settle_workspace_resource_operation(upload.id, true);
  return true;
end;
$$;

revoke all on function
  public.admit_factory_benchmark_trial(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid),
  public.start_factory_benchmark_trial(uuid,integer,timestamptz),
  public.fail_factory_benchmark_trial(uuid,uuid,integer,uuid,text),
  public.cancel_factory_benchmark_trial(uuid,uuid,uuid,uuid,uuid),
  public.finish_factory_benchmark_trial(uuid,uuid,integer,uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  public.admit_factory_benchmark_trial(uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid),
  public.start_factory_benchmark_trial(uuid,integer,timestamptz),
  public.fail_factory_benchmark_trial(uuid,uuid,integer,uuid,text),
  public.cancel_factory_benchmark_trial(uuid,uuid,uuid,uuid,uuid),
  public.finish_factory_benchmark_trial(uuid,uuid,integer,uuid,jsonb)
  to service_role;

-- Only workers that understand benchmark purpose may claim internal trials.
create function public.claim_next_agent_job(
  accept_benchmark_trials boolean,
  default_concurrency_limit int default 2
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.agent_jobs%rowtype;
  configured_limit int;
  effective_limit int;
  running_count int;
  selected_provider text;
  release_state internal.git_continuity_release_control%rowtype;
  pipeline_job boolean;
  session_owner public.sessions;
  definition jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict release_state from internal.git_continuity_release_control where singleton for share;
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();

  for candidate in
    select * from public.agent_jobs
    where status = 'queued' and (scheduled_at is null or scheduled_at <= now())
      and exists (
        select 1 from public.sessions owner where (owner.workspace_id, owner.id) =
          (agent_jobs.workspace_id, agent_jobs.session_id)
          and (
            (owner.execution_purpose = 'production' and (owner.pipeline_id is null or (release_state.enabled
              and exists (select 1 from public.session_git_continuity_enrollments e
                where (e.workspace_id, e.session_id) = (owner.workspace_id, owner.id)))))
            or (accept_benchmark_trials is true and owner.execution_purpose = 'benchmark'
              and agent_jobs.attempt_count = 0 and exists (select 1 from public.factory_benchmark_trials trial
                where (trial.workspace_id, trial.session_id, trial.job_id, trial.status) =
                  (owner.workspace_id, owner.id, agent_jobs.id, 'queued')))
          )
      )
    order by created_at asc
  loop
    perform 1 from public.workspaces where id=candidate.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    select * into candidate from public.agent_jobs where id=candidate.id and status='queued'
      and (scheduled_at is null or scheduled_at<=now()) for update skip locked;
    if not found then continue; end if;
    select * into session_owner from public.sessions
      where (workspace_id, id) = (candidate.workspace_id, candidate.session_id);
    if not found then continue; end if;
    pipeline_job := session_owner.execution_purpose = 'production' and session_owner.pipeline_id is not null;
    perform pg_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0));

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
    where workspace_id = candidate.workspace_id and status = 'running';
    if running_count >= effective_limit then continue; end if;

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
revoke all on function public.claim_next_agent_job(boolean,integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_next_agent_job(boolean,integer) to service_role;

create or replace function public.claim_next_agent_job(default_concurrency_limit integer default 2)
returns setof public.agent_jobs language sql security invoker set search_path = '' as $$
  select * from public.claim_next_agent_job(false, default_concurrency_limit);
$$;

create function public.claim_next_worker_dispatch(
  accept_benchmark_trials boolean,
  p_max_concurrent integer default 10,
  p_default_workspace_limit integer default 2,
  p_timeout_ms integer default 1800000
) returns setof public.worker_dispatches
language plpgsql security definer set search_path = '' as $$
declare claimed public.agent_jobs%rowtype;
begin
  if p_max_concurrent is null or p_default_workspace_limit is null or p_timeout_ms is null
    or p_max_concurrent < 1 or p_default_workspace_limit < 1
    or p_timeout_ms < 1 or p_timeout_ms > 1800000 then
    raise exception 'Invalid worker dispatch limits';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallie/cloudflare/dispatch', 0));
  if (select count(*) from public.agent_jobs where status in ('started', 'running')) >= p_max_concurrent then
    return;
  end if;
  select * into claimed from public.claim_next_agent_job(accept_benchmark_trials, p_default_workspace_limit);
  if claimed.id is null then return; end if;
  return query insert into public.worker_dispatches(job_id, attempt_count, workspace_id, workflow_id, deadline_at)
  values (claimed.id, claimed.attempt_count, claimed.workspace_id,
    'job-' || claimed.id::text || '-' || claimed.attempt_count::text,
    now() + p_timeout_ms * interval '1 millisecond') returning *;
end;
$$;
revoke all on function public.claim_next_worker_dispatch(boolean,integer,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_next_worker_dispatch(boolean,integer,integer,integer) to service_role;

create or replace function public.claim_next_worker_dispatch(
  p_max_concurrent integer default 10, p_default_workspace_limit integer default 2, p_timeout_ms integer default 1800000
) returns setof public.worker_dispatches language sql security invoker set search_path = '' as $$
  select * from public.claim_next_worker_dispatch(false,p_max_concurrent,p_default_workspace_limit,p_timeout_ms);
$$;

-- An unstarted benchmark claim is retired by stall recovery, not deferred to a production release.
create or replace function internal.defer_session_job_for_continuity_release(p_job_id uuid,p_attempt_count integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare session public.sessions; job public.agent_jobs; control internal.git_continuity_release_control; owner_workspace uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  -- SHARE before lifecycle locks matches claim/start admission and the setter.
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  select workspace_id into owner_workspace from public.agent_jobs where id=p_job_id;
  if not found then return false; end if;
  perform 1 from public.workspaces where id=owner_workspace and deletion_requested_at is null for share;
  if not found then return false; end if;
  select owner.* into session from public.sessions owner join public.agent_jobs j on j.session_id=owner.id
    where j.id=p_job_id for no key update of owner;
  if not found or session.execution_purpose <> 'production' or session.pipeline_id is null
    or session.workspace_id is distinct from owner_workspace then return false; end if;
  select * into job from public.agent_jobs where id=p_job_id for update;
  if not found or p_attempt_count is null or p_attempt_count<=0 or job.attempt_count<>p_attempt_count or job.status not in('started','running')
    or job.workspace_id<>session.workspace_id then return false; end if;
  if control.enabled and job.git_continuity_release_revision=control.revision
    and exists(select 1 from public.session_git_continuity_enrollments e where e.session_id=session.id and e.workspace_id=session.workspace_id) then return false; end if;
  perform 1 from public.agent_runs where agent_job_id=job.id order by id for update;
  if exists(select 1 from public.agent_runs where agent_job_id=job.id
    and ((attempt_count=p_attempt_count and status in('queued','started','running','success'))
      or (attempt_count is null and status in('started','running')))) then return false; end if;
  -- The successful deferral and its one-per-claim credit are one transaction.
  -- A lost reply or duplicate request cannot mint a second credit.
  insert into internal.session_job_release_deferrals(job_id,attempt_count,workspace_id,session_id,release_revision)
  values(job.id,p_attempt_count,job.workspace_id,job.session_id,job.git_continuity_release_revision)
  on conflict(job_id,attempt_count) do nothing;
  update public.agent_jobs set status='queued',started_at=null,finished_at=null,scheduled_at=null,
    last_error=null,git_continuity_release_revision=null where id=job.id;
  delete from public.worker_dispatches where job_id=job.id and attempt_count=p_attempt_count;
  return true;
end;
$$;
