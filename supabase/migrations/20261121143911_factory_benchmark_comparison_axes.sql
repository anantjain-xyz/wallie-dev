-- Legacy matrices continue to use one candidate per definition revision.
do $$
declare legacy_constraint name;
begin
  select conname into strict legacy_constraint from pg_constraint
  where conrelid = 'public.factory_benchmark_experiment_candidates'::regclass
    and contype = 'u' and pg_get_constraintdef(oid) =
      'UNIQUE (workspace_id, factory_id, experiment_id, definition_revision_id)';
  execute format('alter table public.factory_benchmark_experiment_candidates drop constraint %I', legacy_constraint);
end;
$$;

alter table public.factory_benchmark_experiment_candidates
  add column qualification_id uuid,
  add column canonical_model_key text,
  add column sandbox_connection_revision uuid,
  add column toolchain text,
  add column toolchain_digest text,
  add column comparison_position integer,
  add constraint factory_benchmark_candidates_qualified_axes_check check (
    num_nonnulls(qualification_id, canonical_model_key, sandbox_connection_revision, toolchain, toolchain_digest, comparison_position) = 0 or
    (num_nonnulls(qualification_id, canonical_model_key, sandbox_connection_revision, toolchain, toolchain_digest, comparison_position) = 6
      and length(canonical_model_key) between 1 and 200 and length(toolchain) between 1 and 100
      and toolchain_digest ~ '^[a-f0-9]{64}$' and comparison_position between 1 and 100)
  );

create unique index factory_benchmark_experiment_legacy_definition_idx
  on public.factory_benchmark_experiment_candidates(workspace_id, factory_id, experiment_id, definition_revision_id)
  where qualification_id is null;

create unique index factory_benchmark_experiment_comparison_position_idx
  on public.factory_benchmark_experiment_candidates(workspace_id, factory_id, experiment_id, comparison_position)
  where comparison_position is not null;

create function internal.factory_benchmark_axis_profiles(
  p_workspace_id uuid, p_factory_id uuid, p_suite_revision_id uuid, p_definition_ids uuid[] default null
) returns table (
  id uuid, definition_id uuid, definition_digest text, model_key text, harness text,
  harness_model text, worker_runtime text, sandbox_provider text, sandbox_connection_revision uuid, toolchain text,
  toolchain_digest text, unavailable_reason text
) language sql stable set search_path = '' as $$
  with suite_repositories as (
    select distinct inputs.repository_id
    from public.factory_benchmark_suite_members member
    join public.factory_benchmark_task_revisions task on (task.workspace_id, task.factory_id, task.task_id, task.id) =
      (member.workspace_id, member.factory_id, member.task_id, member.task_revision_id)
    join public.factory_benchmark_task_inputs inputs on (inputs.workspace_id, inputs.factory_id, inputs.task_id) =
      (member.workspace_id, member.factory_id, member.task_id)
    where (member.workspace_id, member.factory_id, member.suite_revision_id) =
      (p_workspace_id, p_factory_id, p_suite_revision_id)
      and task.replay_eligibility = 'eligible' and inputs.repository_id is not null
  ), revisions as (
    select revision.id, revision.canonical_digest, revision.definition_json::jsonb as definition
    from public.factory_definition_revisions revision
    where (revision.workspace_id, revision.factory_id) = (p_workspace_id, p_factory_id)
      and (p_definition_ids is null or revision.id = any(p_definition_ids))
  ), latest as (
    select distinct on (revision.id, probe.agent_provider, probe.agent_model)
      probe.id, revision.id as definition_id, revision.canonical_digest,
      revision.definition, repository.id as repository_id, probe.agent_provider, probe.agent_model, probe.capabilities, probe.status,
      probe.sandbox_connection_revision
    from revisions revision
    join public.github_repositories repository
      on (repository.workspace_id, repository.factory_id, repository.id::text) =
        (p_workspace_id, p_factory_id, revision.definition->>'repositoryId')
      and not repository.is_archived
    join public.sandbox_capability_checks probe
      on (probe.workspace_id, probe.github_repository_id, probe.sandbox_provider) =
        (p_workspace_id, repository.id, 'vercel')
      and (probe.factory_definition_digest is null or probe.factory_definition_digest = revision.canonical_digest)
    join public.workspace_vercel_sandbox_connections connection
      on (connection.workspace_id, connection.connection_revision, connection.status) =
        (p_workspace_id, probe.sandbox_connection_revision, 'connected')
    where revision.definition->>'sandboxProvider' = 'vercel'
      and probe.agent_provider in ('codex', 'opencode')
      and ((probe.agent_provider = 'codex' and probe.agent_model ~ '^gpt-[a-z0-9.-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$')
        or (probe.agent_provider = 'opencode' and probe.agent_model ~ '^openai/gpt-[a-z0-9.-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
    order by revision.id, probe.agent_provider, probe.agent_model,
      (probe.factory_definition_digest is not null) desc, probe.checked_at desc, probe.id desc
  ), toolchains as (
    select latest.*, substring(btrim(split_part(capabilities#>>'{agentCli,detail}', E'\n', -1)) from
      '^(?:codex(?:-cli)?[[:space:]]+|opencode[[:space:]]+)?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?)$') as cli_version
    from latest
  )
  select latest.id, latest.definition_id, canonical_digest,
    case when agent_provider = 'codex' then 'openai/' || agent_model else agent_model end,
    agent_provider, agent_model, 'node'::text, 'vercel'::text, latest.sandbox_connection_revision,
    concat_ws(' ', case when agent_provider = 'codex' then 'Codex' else 'OpenCode' end, cli_version),
    encode(sha256(convert_to(capabilities::text, 'UTF8')), 'hex'),
    case
      when status <> 'success' or exists (
        select 1 from unnest(array['agentCli','git','node','packageManager','playwrightPackage','chromium','screenshotSmoke']
          || case when agent_provider = 'codex' then array['codexExternalSandbox'] else '{}'::text[] end) required(key)
        where capabilities->required.key->'ok' is distinct from 'true'::jsonb
      ) then 'Run a successful capability check for this model, harness, and connection.'
      when cli_version is null
        then 'The capability check did not record the CLI version.'
      when exists (select 1 from suite_repositories where suite_repositories.repository_id <> latest.repository_id)
        then 'An eligible task was captured from a different repository than this factory revision.'
      when jsonb_array_length(coalesce(definition#>'{mcpManifest,servers}', '[]'::jsonb)) > 0
        then 'This definition declares remote tools. This comparison profile supports local tools.'
      when exists (
        select 1 from jsonb_array_elements(coalesce(definition->'stages', '[]'::jsonb)) stage
        where not exists (
          select 1 from public.pipeline_stages active
          where active.workspace_id = p_workspace_id and active.pipeline_id::text = definition->>'pipelineId'
            and active.id::text = stage->>'id' and active.archived_at is null
        )
      ) then 'A stage in this definition is unavailable.'
    end
  from toolchains latest
$$;
revoke all on function internal.factory_benchmark_axis_profiles(uuid, uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;

create function public.list_factory_benchmark_axis_profiles(p_workspace_id uuid, p_factory_id uuid, p_suite_revision_id uuid)
returns table (
  id uuid, definition_id uuid, definition_digest text, model_key text, harness text,
  harness_model text, worker_runtime text, sandbox_provider text, sandbox_connection_revision uuid, toolchain text,
  toolchain_digest text, unavailable_reason text
) language sql stable security definer set search_path = '' as $$
  select profile.* from internal.factory_benchmark_axis_profiles(p_workspace_id, p_factory_id, p_suite_revision_id) profile
  where internal.can_manage_factory(p_workspace_id, p_factory_id)
$$;
revoke all on function public.list_factory_benchmark_axis_profiles(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_factory_benchmark_axis_profiles(uuid, uuid, uuid) to authenticated;

create function public.freeze_factory_benchmark_experiment_axes(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  experiment public.factory_benchmark_experiments;
  requested jsonb;
  resolved jsonb;
  definition_ids uuid[];
  canonical_request text;
  selected_policy public.factory_benchmark_replay_policy_revisions;
  num_candidates integer;
  num_tasks integer;
  num_eligible integer;
  num_trials bigint;
  num_inserted integer;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.validate_benchmark_experiment_parameters(p_experiment_id, p_suite_revision_id,
    p_policy_revision_id, p_repetitions, p_seed, p_timeout_ms);
  if jsonb_typeof(p_candidates) is distinct from 'array' then
    raise exception 'Provide comparison candidate axes.' using errcode = '22023';
  end if;
  num_candidates := jsonb_array_length(p_candidates);
  if num_candidates not between 2 and 100 or exists (
    select 1 from jsonb_array_elements(p_candidates) choice(value)
    where case when jsonb_typeof(choice.value) is distinct from 'object' then true else
      choice.value - array['definitionRevisionId','qualificationId','workerRuntime'] <> '{}'::jsonb
      or not coalesce(pg_input_is_valid(choice.value->>'definitionRevisionId', 'uuid'), false)
      or not coalesce(pg_input_is_valid(choice.value->>'qualificationId', 'uuid'), false)
      or not coalesce(choice.value->>'workerRuntime' in ('node','workerd'), false) end
  ) then
    raise exception 'Provide exact definition and qualification IDs and a known worker runtime.' using errcode = '22023';
  end if;
  with choices as (
    select (value->>'definitionRevisionId')::uuid as definition_id,
      (value->>'qualificationId')::uuid as qualification_id, value->>'workerRuntime' as worker,
      position
    from jsonb_array_elements(p_candidates) with ordinality as choice(value, position)
  )
  select jsonb_agg(jsonb_build_array(definition_id, qualification_id, worker) order by position),
    array_agg(distinct definition_id)
  into requested, definition_ids from choices;
  if (select count(distinct value) from jsonb_array_elements(requested)) <> num_candidates then
    raise exception 'Select distinct comparison candidates.' using errcode = '22023';
  end if;

  canonical_request := encode(sha256(convert_to(jsonb_build_array(
    'wallie-benchmark-experiment-axes/v1', p_suite_revision_id, p_policy_revision_id, p_repetitions,
    p_seed, p_timeout_ms, requested)::text, 'UTF8')), 'hex');
  select frozen.* into experiment from public.factory_benchmark_experiments frozen
  where (frozen.workspace_id, frozen.factory_id, frozen.id) = (p_workspace_id, p_factory_id, p_experiment_id);
  if found then
    if (experiment.created_by, experiment.request_digest) is distinct from (p_actor_user_id, canonical_request) then
      raise exception 'The experiment identity already refers to different inputs.' using errcode = 'PT409';
    end if;
    return internal.benchmark_experiment_receipt(experiment);
  end if;
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select policy.* into selected_policy from public.factory_benchmark_replay_policy_revisions policy
  where (policy.workspace_id, policy.factory_id, policy.id) = (p_workspace_id, p_factory_id, p_policy_revision_id)
    and not exists (select 1 from internal.factory_benchmark_replay_revocations revoked
      where revoked.policy_revision_id = policy.id);
  if not found then raise exception 'The replay policy revision is unavailable in this factory.' using errcode = 'PT422'; end if;

  select jsonb_agg(to_jsonb(profile) || jsonb_build_object('position', choice.position))
  into resolved from internal.factory_benchmark_axis_profiles(p_workspace_id, p_factory_id, p_suite_revision_id, definition_ids) profile
  join jsonb_array_elements(requested) with ordinality as choice(value, position)
    on (profile.definition_id, profile.id, profile.worker_runtime) =
      ((choice.value->>0)::uuid, (choice.value->>1)::uuid, choice.value->>2)
  where profile.unavailable_reason is null;
  if coalesce(jsonb_array_length(resolved), 0) <> num_candidates then
    raise exception 'A candidate lacks a current compatible capability check.' using errcode = 'PT422';
  end if;

  select count(*), count(*) filter (where task.replay_eligibility = 'eligible')
  into num_tasks, num_eligible from public.factory_benchmark_suite_members member
  join public.factory_benchmark_task_revisions task on (task.workspace_id, task.factory_id, task.task_id, task.id) =
    (member.workspace_id, member.factory_id, member.task_id, member.task_revision_id)
  where (member.workspace_id, member.factory_id, member.suite_revision_id) =
    (p_workspace_id, p_factory_id, p_suite_revision_id);
  num_trials := num_tasks::bigint * num_candidates * p_repetitions;
  if num_trials not between 1 and 10000 then
    raise exception 'The frozen experiment requires between 1 and 10000 planned trials.' using errcode = 'PT422';
  end if;

  insert into public.factory_benchmark_experiments (
    id, workspace_id, factory_id, suite_revision_id, policy_revision_id, policy_digest, repetitions, seed, timeout_ms,
    task_count, candidate_count, expected_trial_count, materialized_trial_count, eligible_trial_count,
    ineligible_trial_count, request_digest, created_by
  ) values (
    p_experiment_id, p_workspace_id, p_factory_id, p_suite_revision_id, p_policy_revision_id, selected_policy.policy_digest,
    p_repetitions, p_seed, p_timeout_ms, num_tasks, num_candidates, num_trials, num_trials,
    num_eligible * num_candidates * p_repetitions, num_trials - num_eligible * num_candidates * p_repetitions,
    canonical_request, p_actor_user_id
  ) returning * into experiment;

  insert into public.factory_benchmark_experiment_candidates (
    workspace_id, factory_id, experiment_id, candidate_key, definition_revision_id, definition_digest,
    harness, model, sandbox_provider, worker_runtime, qualification_id, canonical_model_key,
    sandbox_connection_revision, toolchain, toolchain_digest, comparison_position
  )
  select p_workspace_id, p_factory_id, p_experiment_id,
    encode(sha256(convert_to(jsonb_build_array('wallie-benchmark-candidate-axes/v1', candidate.config - 'position')::text, 'UTF8')), 'hex'),
    (candidate.config->>'definition_id')::uuid, candidate.config->>'definition_digest', candidate.config->>'harness',
    candidate.config->>'harness_model', candidate.config->>'sandbox_provider', candidate.config->>'worker_runtime',
    (candidate.config->>'id')::uuid, candidate.config->>'model_key',
    (candidate.config->>'sandbox_connection_revision')::uuid, candidate.config->>'toolchain',
    candidate.config->>'toolchain_digest', (candidate.config->>'position')::integer
  from jsonb_array_elements(resolved) candidate(config);

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
  get diagnostics num_inserted = row_count;
  if num_inserted <> experiment.expected_trial_count then
    raise exception 'The expected matrix did not materialize exactly.' using errcode = '23514';
  end if;
  return internal.benchmark_experiment_receipt(experiment);
end;
$$;
revoke all on function public.freeze_factory_benchmark_experiment_axes(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.freeze_factory_benchmark_experiment_axes(uuid, uuid, uuid, uuid, uuid, uuid, jsonb, integer, integer, integer)
  to service_role;

-- The legacy retry path must reject the identity of a qualified comparison.
create or replace function public.find_factory_benchmark_experiment_retry(
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
    bool_and(candidate.qualification_id is null and candidate.worker_runtime = p_worker_runtime) into frozen_ids, same_runtime
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
