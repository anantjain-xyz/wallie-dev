-- These profiles add the managed, native-worker runner. Existing Node matrix
-- configurations and their retry identities remain independent.
alter function internal.factory_benchmark_axis_profiles(uuid,uuid,uuid,uuid[])
  rename to factory_benchmark_node_axis_profiles;

create function internal.factory_benchmark_axis_profiles(
  p_workspace_id uuid, p_factory_id uuid, p_suite_revision_id uuid, p_definition_ids uuid[] default null
) returns table (
  id uuid, definition_id uuid, definition_digest text, model_key text, harness text,
  harness_model text, worker_runtime text, sandbox_provider text, sandbox_connection_revision uuid, toolchain text,
  toolchain_digest text, unavailable_reason text
) language sql stable set search_path = '' as $$
  with node_profiles as (
    select * from internal.factory_benchmark_node_axis_profiles(p_workspace_id,p_factory_id,p_suite_revision_id,p_definition_ids)
  )
  select node.* from node_profiles node
  union all
  select node.id,node.definition_id,node.definition_digest,node.model_key,node.harness,node.harness_model,'workerd'::text,
    node.sandbox_provider,node.sandbox_connection_revision,node.toolchain,
    encode(sha256(convert_to(jsonb_build_array('openai-responses-v1',node.toolchain_digest,
      connection.id,connection.profile->>'image',connection.profile->node.harness)::text,'UTF8')),'hex'),
    coalesce(node.unavailable_reason,case when split_part(node.toolchain,' ',2) is distinct from
      connection.profile->node.harness->>'cliVersion'
      then 'The checked CLI version differs from the managed replay image.' end)
  from node_profiles node
  join internal.factory_benchmark_inference_connections connection
    on (connection.workspace_id,connection.factory_id,connection.sandbox_connection_revision) =
      (p_workspace_id,p_factory_id,node.sandbox_connection_revision)
    and connection.revoked_at is null
$$;
revoke all on function internal.factory_benchmark_axis_profiles(uuid,uuid,uuid,uuid[])
  from public, anon, authenticated, service_role;

-- SQL-function dependencies follow object identity after a rename. Rebind the
-- catalog to the functions which expose both supported runtime choices.
create or replace function public.list_factory_benchmark_axis_profiles(
  p_workspace_id uuid, p_factory_id uuid, p_suite_revision_id uuid
) returns table (
  id uuid, definition_id uuid, definition_digest text, model_key text, harness text,
  harness_model text, worker_runtime text, sandbox_provider text, sandbox_connection_revision uuid, toolchain text,
  toolchain_digest text, unavailable_reason text
) language sql stable security definer set search_path = '' as $$
  select profile.* from internal.factory_benchmark_axis_profiles(p_workspace_id,p_factory_id,p_suite_revision_id) profile
  where internal.can_manage_factory(p_workspace_id,p_factory_id)
$$;

create or replace function internal.freeze_factory_benchmark_experiment_axes(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  experiment public.factory_benchmark_experiments;
  requested jsonb;
  resolved jsonb;
  unavailable_reason text;
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

  select jsonb_agg(to_jsonb(profile) || jsonb_build_object('position', choice.position)
      || case when profile.worker_runtime = 'workerd' then jsonb_build_object('live_connection_id', (
        select connection.id from internal.factory_benchmark_inference_connections connection
        where (connection.workspace_id,connection.factory_id,connection.sandbox_connection_revision) =
          (p_workspace_id,p_factory_id,profile.sandbox_connection_revision) and connection.revoked_at is null
      )) else '{}'::jsonb end)
      filter (where profile.unavailable_reason is null),
    min(profile.unavailable_reason)
  into resolved, unavailable_reason from internal.factory_benchmark_axis_profiles(p_workspace_id, p_factory_id, p_suite_revision_id, definition_ids) profile
  join jsonb_array_elements(requested) with ordinality as choice(value, position)
    on (profile.definition_id, profile.id, profile.worker_runtime) =
      ((choice.value->>0)::uuid, (choice.value->>1)::uuid, choice.value->>2);
  if coalesce(jsonb_array_length(resolved), 0) <> num_candidates then
    raise exception '%', coalesce(unavailable_reason, 'A candidate lacks a current compatible capability check.') using errcode = 'PT422';
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
    sandbox_connection_revision, toolchain, toolchain_digest, comparison_position, live_inference_connection_revision
  )
  select p_workspace_id, p_factory_id, p_experiment_id,
    encode(sha256(convert_to(jsonb_build_array('wallie-benchmark-candidate-axes/v1', candidate.config - 'position')::text, 'UTF8')), 'hex'),
    (candidate.config->>'definition_id')::uuid, candidate.config->>'definition_digest', candidate.config->>'harness',
    candidate.config->>'harness_model', candidate.config->>'sandbox_provider', candidate.config->>'worker_runtime',
    (candidate.config->>'id')::uuid, candidate.config->>'model_key',
    (candidate.config->>'sandbox_connection_revision')::uuid, candidate.config->>'toolchain',
    candidate.config->>'toolchain_digest', (candidate.config->>'position')::integer, (candidate.config->>'live_connection_id')::uuid
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
