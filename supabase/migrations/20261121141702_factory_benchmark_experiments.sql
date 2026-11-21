create table public.factory_benchmark_experiments (
  id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  suite_revision_id uuid not null,
  policy_revision_id uuid not null,
  policy_digest text not null check (policy_digest ~ '^[a-f0-9]{64}$'),
  repetitions integer not null check (repetitions between 1 and 100),
  seed integer not null check (seed >= 0),
  timeout_ms integer not null check (timeout_ms between 1000 and 1800000),
  task_count integer not null check (task_count between 1 and 10000),
  candidate_count integer not null check (candidate_count between 1 and 10000),
  expected_trial_count integer not null check (expected_trial_count between 1 and 10000),
  materialized_trial_count integer not null,
  eligible_trial_count integer not null check (eligible_trial_count >= 0),
  ineligible_trial_count integer not null check (ineligible_trial_count >= 0),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, id),
  check (expected_trial_count = task_count::bigint * candidate_count * repetitions),
  check (materialized_trial_count = expected_trial_count),
  check (eligible_trial_count + ineligible_trial_count = materialized_trial_count),
  foreign key (workspace_id, factory_id, suite_revision_id)
    references public.factory_benchmark_suite_revisions(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, policy_revision_id)
    references public.factory_benchmark_replay_policy_revisions(workspace_id, factory_id, id) on delete cascade
);
create index factory_benchmark_experiments_suite_idx
  on public.factory_benchmark_experiments(workspace_id, factory_id, suite_revision_id);
create index factory_benchmark_experiments_policy_idx
  on public.factory_benchmark_experiments(workspace_id, factory_id, policy_revision_id);

create table public.factory_benchmark_experiment_candidates (
  workspace_id uuid not null,
  factory_id uuid not null,
  experiment_id uuid not null,
  candidate_key text not null check (candidate_key ~ '^[a-f0-9]{64}$'),
  definition_revision_id uuid not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  harness text not null check (harness in ('codex', 'claude-code', 'cursor', 'opencode')),
  model text not null check (length(btrim(model)) between 1 and 200),
  sandbox_provider text not null check (sandbox_provider in ('vercel', 'e2b', 'daytona')),
  worker_runtime text not null check (worker_runtime in ('node', 'workerd')),
  primary key (workspace_id, factory_id, experiment_id, candidate_key),
  unique (workspace_id, factory_id, experiment_id, definition_revision_id),
  foreign key (workspace_id, factory_id, experiment_id)
    references public.factory_benchmark_experiments(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, definition_revision_id)
    references public.factory_definition_revisions(workspace_id, factory_id, id) on delete cascade
);
create index factory_benchmark_experiment_candidates_definition_idx
  on public.factory_benchmark_experiment_candidates(workspace_id, factory_id, definition_revision_id);

create table public.factory_benchmark_experiment_trials (
  trial_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  experiment_id uuid not null,
  task_id uuid not null,
  task_revision_id uuid not null,
  candidate_key text not null,
  repetition integer not null check (repetition between 1 and 100),
  seed integer not null check (seed >= 0),
  timeout_ms integer not null check (timeout_ms between 1000 and 1800000),
  replay_eligibility text not null check (replay_eligibility in ('unverified', 'eligible', 'ineligible')),
  eligibility_reason text,
  check (replay_eligibility <> 'ineligible' or eligibility_reason is not null),
  check (replay_eligibility <> 'eligible' or eligibility_reason is null),
  unique (workspace_id, factory_id, experiment_id, task_id, candidate_key, repetition),
  foreign key (workspace_id, factory_id, experiment_id, candidate_key)
    references public.factory_benchmark_experiment_candidates(workspace_id, factory_id, experiment_id, candidate_key) on delete cascade,
  foreign key (workspace_id, factory_id, task_id, task_revision_id)
    references public.factory_benchmark_task_revisions(workspace_id, factory_id, task_id, id) on delete cascade
);
create index factory_benchmark_experiment_trials_candidate_idx
  on public.factory_benchmark_experiment_trials(workspace_id, factory_id, experiment_id, candidate_key);
create index factory_benchmark_experiment_trials_task_idx
  on public.factory_benchmark_experiment_trials(workspace_id, factory_id, task_id, task_revision_id);

alter table public.factory_benchmark_experiments enable row level security;
alter table public.factory_benchmark_experiment_candidates enable row level security;
alter table public.factory_benchmark_experiment_trials enable row level security;
revoke all on public.factory_benchmark_experiments, public.factory_benchmark_experiment_candidates,
  public.factory_benchmark_experiment_trials from public, anon, authenticated, service_role;
grant select on public.factory_benchmark_experiments, public.factory_benchmark_experiment_candidates,
  public.factory_benchmark_experiment_trials to authenticated, service_role;
create policy factory_benchmark_experiments_read on public.factory_benchmark_experiments
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_benchmark_experiment_candidates_read on public.factory_benchmark_experiment_candidates
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_benchmark_experiment_trials_read on public.factory_benchmark_experiment_trials
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));

create trigger preserve_factory_benchmark_experiments before update or delete on public.factory_benchmark_experiments
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_factory_benchmark_experiment_candidates
  before update or delete on public.factory_benchmark_experiment_candidates
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_factory_benchmark_experiment_trials before update or delete on public.factory_benchmark_experiment_trials
  for each row execute function internal.preserve_factory_benchmark_history();

comment on table public.factory_benchmark_experiment_trials is
  'Frozen matrix cells. trial_id can identify a future execution. These rows create no agent jobs or sessions.';

create function internal.benchmark_experiment_receipt(experiment public.factory_benchmark_experiments)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'experimentId', experiment.id, 'suiteRevisionId', experiment.suite_revision_id,
    'policyRevisionId', experiment.policy_revision_id, 'taskCount', experiment.task_count,
    'candidateCount', experiment.candidate_count, 'repetitions', experiment.repetitions,
    'expectedTrialCount', experiment.expected_trial_count, 'materializedTrialCount', experiment.materialized_trial_count,
    'eligibleTrialCount', experiment.eligible_trial_count, 'ineligibleTrialCount', experiment.ineligible_trial_count
  )
$$;

create function internal.benchmark_experiment_trial_id(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_task_revision_id uuid, p_candidate_key text, p_repetition integer
) returns uuid language sql immutable strict set search_path = '' as $$
  -- UUIDv8 from the first 128 bits of a domain-separated SHA-256 hash.
  select overlay(overlay(left(encode(sha256(convert_to(jsonb_build_array(
    'wallie-benchmark-experiment-trial/v1', p_workspace_id, p_factory_id, p_experiment_id, p_task_revision_id,
    p_candidate_key, p_repetition
  )::text, 'UTF8')), 'hex'), 32) placing '8' from 13 for 1) placing '8' from 17 for 1)::uuid
$$;

create function internal.validate_benchmark_experiment_parameters(
  p_experiment_id uuid, p_suite_revision_id uuid, p_policy_revision_id uuid,
  p_repetitions integer, p_seed integer, p_timeout_ms integer
) returns void language plpgsql immutable set search_path = '' as $$
begin
  if num_nulls(p_experiment_id, p_suite_revision_id, p_policy_revision_id, p_repetitions, p_seed, p_timeout_ms) <> 0
    or p_repetitions not between 1 and 100 or p_seed < 0 or p_timeout_ms not between 1000 and 1800000 then
    raise exception 'Provide exact suite and policy revisions, a nonnegative seed, and bounded repetitions and timeout.'
      using errcode = '22023';
  end if;
end;
$$;

revoke all on function internal.benchmark_experiment_receipt(public.factory_benchmark_experiments),
  internal.benchmark_experiment_trial_id(uuid,uuid,uuid,uuid,text,integer),
  internal.validate_benchmark_experiment_parameters(uuid,uuid,uuid,integer,integer,integer)
  from public, anon, authenticated, service_role;

create function public.find_factory_benchmark_experiment_retry(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_definition_revision_ids uuid[],
  p_repetitions integer, p_seed integer, p_timeout_ms integer, p_worker_runtime text default 'node'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  experiment public.factory_benchmark_experiments;
  requested_ids uuid[];
  frozen_ids uuid[];
  same_runtime boolean;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.validate_benchmark_experiment_parameters(p_experiment_id, p_suite_revision_id,
    p_policy_revision_id, p_repetitions, p_seed, p_timeout_ms);
  if p_definition_revision_ids is null or cardinality(p_definition_revision_ids) not between 1 and 10000
    or array_ndims(p_definition_revision_ids) <> 1 or array_position(p_definition_revision_ids, null) is not null
    or p_worker_runtime is null or p_worker_runtime not in ('node', 'workerd') then
    raise exception 'Provide exact candidate revision IDs and a known worker runtime.' using errcode = '22023';
  end if;
  select array_agg(distinct requested.id order by requested.id) into requested_ids
  from unnest(p_definition_revision_ids) requested(id);
  if cardinality(requested_ids) <> cardinality(p_definition_revision_ids) then
    raise exception 'Candidate revisions must be distinct.' using errcode = '22023';
  end if;

  select * into experiment from public.factory_benchmark_experiments frozen
  where (frozen.workspace_id, frozen.factory_id, frozen.id) = (p_workspace_id, p_factory_id, p_experiment_id);
  if not found then return null; end if;
  select array_agg(candidate.definition_revision_id order by candidate.definition_revision_id),
    bool_and(candidate.worker_runtime = p_worker_runtime) into frozen_ids, same_runtime
  from public.factory_benchmark_experiment_candidates candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.experiment_id) =
    (p_workspace_id, p_factory_id, p_experiment_id);

  if (experiment.created_by, experiment.suite_revision_id, experiment.policy_revision_id, experiment.repetitions,
      experiment.seed, experiment.timeout_ms, frozen_ids, same_runtime)
    is distinct from (p_actor_user_id, p_suite_revision_id, p_policy_revision_id, p_repetitions,
      p_seed, p_timeout_ms, requested_ids, true) then
    raise exception 'The experiment identity already refers to different inputs.' using errcode = 'PT409';
  end if;
  return internal.benchmark_experiment_receipt(experiment);
end;
$$;

create function public.freeze_factory_benchmark_experiment(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  experiment public.factory_benchmark_experiments;
  policy_digest text;
  candidates jsonb;
  candidate_count integer;
  distinct_definitions integer;
  task_count integer;
  eligible_tasks integer;
  expected_count bigint;
  materialized_count integer;
  request_digest text;
  candidate_fields text[] := array['definitionRevisionId','definitionDigest','harness','model','sandboxProvider','workerRuntime'];
begin
  perform internal.assert_checkpoint_publication_service();
  -- Serializes this factory's new freezes and replay policy revocations.
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.validate_benchmark_experiment_parameters(p_experiment_id, p_suite_revision_id,
    p_policy_revision_id, p_repetitions, p_seed, p_timeout_ms);
  if jsonb_typeof(p_candidates) is distinct from 'array' then
    raise exception 'Provide a candidate configuration array.' using errcode = '22023';
  end if;
  candidate_count := jsonb_array_length(p_candidates);
  if candidate_count not between 1 and 10000 or exists (
    select 1 from jsonb_array_elements(p_candidates) candidate(config)
    where case when jsonb_typeof(candidate.config) <> 'object' then true else
      candidate.config - candidate_fields <> '{}'::jsonb or not (candidate.config ?& candidate_fields)
      or exists (select 1 from jsonb_each(candidate.config) field(key, value) where jsonb_typeof(field.value) <> 'string')
      or candidate.config->>'definitionRevisionId' !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      or candidate.config->>'definitionDigest' !~ '^[a-f0-9]{64}$'
      or candidate.config->>'harness' not in ('codex', 'claude-code', 'cursor', 'opencode')
      or length(btrim(candidate.config->>'model')) not between 1 and 200
      or candidate.config->>'model' <> btrim(candidate.config->>'model')
      or candidate.config->>'sandboxProvider' not in ('vercel', 'e2b', 'daytona')
      or candidate.config->>'workerRuntime' not in ('node', 'workerd') end
  ) then raise exception 'Provide bounded, exact candidate configurations.' using errcode = '22023'; end if;

  select jsonb_agg(candidate.config || jsonb_build_object('definitionRevisionId', definition_id.id)
      order by definition_id.id), count(distinct definition_id.id)
  into candidates, distinct_definitions from jsonb_array_elements(p_candidates) candidate(config)
  cross join lateral (select (candidate.config->>'definitionRevisionId')::uuid as id) definition_id;
  if distinct_definitions <> candidate_count then
    raise exception 'Candidate revisions must be distinct.' using errcode = '22023';
  end if;
  request_digest := encode(sha256(convert_to(jsonb_build_array(
    'wallie-benchmark-experiment/v1', p_suite_revision_id, p_policy_revision_id, p_repetitions, p_seed, p_timeout_ms, candidates
  )::text, 'UTF8')), 'hex');
  select * into experiment from public.factory_benchmark_experiments frozen
  where (frozen.workspace_id, frozen.factory_id, frozen.id) = (p_workspace_id, p_factory_id, p_experiment_id);
  if found then
    if (experiment.created_by, experiment.request_digest) is distinct from (p_actor_user_id, request_digest) then
      raise exception 'The experiment identity already refers to different inputs.' using errcode = 'PT409';
    end if;
    return internal.benchmark_experiment_receipt(experiment);
  end if;

  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  perform 1 from public.factory_benchmark_suite_revisions suite
  where (suite.workspace_id, suite.factory_id, suite.id) = (p_workspace_id, p_factory_id, p_suite_revision_id);
  if not found then raise exception 'The suite revision is unavailable in this factory.' using errcode = 'PT422'; end if;
  select revision.policy_digest into policy_digest from public.factory_benchmark_replay_policy_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, p_policy_revision_id)
    and not exists (select 1 from internal.factory_benchmark_replay_revocations revoked
      where revoked.policy_revision_id = revision.id);
  if not found then raise exception 'The replay policy revision is unavailable in this factory.' using errcode = 'PT422'; end if;

  select count(*), count(*) filter (where task.replay_eligibility = 'eligible')
  into task_count, eligible_tasks from public.factory_benchmark_suite_members member
  join public.factory_benchmark_task_revisions task on (task.workspace_id, task.factory_id, task.task_id, task.id) =
    (member.workspace_id, member.factory_id, member.task_id, member.task_revision_id)
  where (member.workspace_id, member.factory_id, member.suite_revision_id) =
    (p_workspace_id, p_factory_id, p_suite_revision_id);
  expected_count := task_count::bigint * candidate_count * p_repetitions;
  if expected_count not between 1 and 10000 then
    raise exception 'The frozen experiment requires between 1 and 10000 planned trials.' using errcode = 'PT422';
  end if;

  if exists (
    select 1 from jsonb_array_elements(candidates) candidate(config)
    left join public.factory_definition_revisions revision
      on (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
        (p_workspace_id, p_factory_id, (candidate.config->>'definitionRevisionId')::uuid, candidate.config->>'definitionDigest')
    cross join lateral (select revision.definition_json::jsonb as compiled) definition
    left join public.pipelines pipeline on (pipeline.workspace_id, pipeline.factory_id, pipeline.id) =
      (p_workspace_id, p_factory_id, (definition.compiled->>'pipelineId')::uuid)
    left join public.github_repositories repository on (repository.workspace_id, repository.factory_id, repository.id) =
      (p_workspace_id, p_factory_id, (definition.compiled->>'repositoryId')::uuid)
    where revision.id is null or revision.schema_version not in (1, 2)
      or definition.compiled->>'schemaVersion' is distinct from revision.schema_version::text
      or definition.compiled->>'kind' is distinct from 'serial'
      or (definition.compiled#>>'{agent,provider}', definition.compiled#>>'{agent,model}', definition.compiled->>'sandboxProvider')
        is distinct from (candidate.config->>'harness', candidate.config->>'model', candidate.config->>'sandboxProvider')
      or pipeline.id is null or repository.id is null or repository.is_archived
      or jsonb_typeof(definition.compiled->'stages') is distinct from 'array'
      or definition.compiled->'stages' = '[]'::jsonb
      or exists (
        select 1 from jsonb_array_elements(case when jsonb_typeof(definition.compiled->'stages') = 'array'
          then definition.compiled->'stages' else '[]'::jsonb end) stored(stage)
        left join public.pipeline_stages current_stage
          on (current_stage.workspace_id, current_stage.pipeline_id, current_stage.id::text) =
            (p_workspace_id, pipeline.id, stored.stage->>'id')
        where current_stage.id is null or current_stage.archived_at is not null
      )
  ) then raise exception 'A candidate does not resolve to an exact compiled definition in this factory.' using errcode = 'PT422'; end if;

  insert into public.factory_benchmark_experiments (
    id, workspace_id, factory_id, suite_revision_id, policy_revision_id, policy_digest, repetitions, seed, timeout_ms,
    task_count, candidate_count, expected_trial_count, materialized_trial_count, eligible_trial_count,
    ineligible_trial_count, request_digest, created_by
  ) values (
    p_experiment_id, p_workspace_id, p_factory_id, p_suite_revision_id, p_policy_revision_id, policy_digest,
    p_repetitions, p_seed, p_timeout_ms, task_count, candidate_count, expected_count, expected_count,
    eligible_tasks * candidate_count * p_repetitions, expected_count - eligible_tasks * candidate_count * p_repetitions,
    request_digest, p_actor_user_id
  ) returning * into experiment;

  insert into public.factory_benchmark_experiment_candidates (
    workspace_id, factory_id, experiment_id, candidate_key, definition_revision_id, definition_digest,
    harness, model, sandbox_provider, worker_runtime
  )
  select p_workspace_id, p_factory_id, p_experiment_id,
    encode(sha256(convert_to(jsonb_build_array('wallie-benchmark-candidate/v1', candidate.config)::text, 'UTF8')), 'hex'),
    (candidate.config->>'definitionRevisionId')::uuid, candidate.config->>'definitionDigest', candidate.config->>'harness',
    candidate.config->>'model', candidate.config->>'sandboxProvider', candidate.config->>'workerRuntime'
  from jsonb_array_elements(candidates) candidate(config);

  with suite_members as (
    select member.task_id, member.task_revision_id, task.replay_eligibility, task.eligibility_reason,
      row_number() over (order by member.task_id) - 1 as task_index
    from public.factory_benchmark_suite_members member
    join public.factory_benchmark_task_revisions task on (task.workspace_id, task.factory_id, task.task_id, task.id) =
      (member.workspace_id, member.factory_id, member.task_id, member.task_revision_id)
    where (member.workspace_id, member.factory_id, member.suite_revision_id) =
      (p_workspace_id, p_factory_id, p_suite_revision_id)
  )
  insert into public.factory_benchmark_experiment_trials (
    trial_id, workspace_id, factory_id, experiment_id, task_id, task_revision_id, candidate_key, repetition,
    seed, timeout_ms, replay_eligibility, eligibility_reason
  )
  select internal.benchmark_experiment_trial_id(p_workspace_id, p_factory_id, p_experiment_id, member.task_revision_id,
      candidate.candidate_key, run.repetition),
    p_workspace_id, p_factory_id, p_experiment_id, member.task_id, member.task_revision_id, candidate.candidate_key, run.repetition,
    ((p_seed::bigint + member.task_index * p_repetitions + run.repetition - 1) % 2147483648)::integer,
    p_timeout_ms, member.replay_eligibility, member.eligibility_reason
  from suite_members member
  cross join generate_series(1, p_repetitions) run(repetition)
  cross join public.factory_benchmark_experiment_candidates candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id);
  get diagnostics materialized_count = row_count;
  if materialized_count <> experiment.expected_trial_count then
    raise exception 'The expected matrix did not materialize exactly.' using errcode = '23514';
  end if;
  return internal.benchmark_experiment_receipt(experiment);
end;
$$;

revoke all on function
  public.find_factory_benchmark_experiment_retry(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text),
  public.freeze_factory_benchmark_experiment(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.find_factory_benchmark_experiment_retry(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text),
  public.freeze_factory_benchmark_experiment(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer)
  to service_role;
