create table public.factory_routing_draft_evidence (
  workspace_id uuid not null,
  factory_id uuid not null,
  draft_id uuid not null,
  request_id uuid not null,
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid not null,
  experiment_id uuid not null,
  candidate_key text not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  primary key (workspace_id, factory_id, draft_id),
  unique (workspace_id, factory_id, request_id),
  foreign key (workspace_id, factory_id, draft_id)
    references public.factory_definition_drafts(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, experiment_id, candidate_key)
    references public.factory_benchmark_experiment_candidates(workspace_id, factory_id, experiment_id, candidate_key)
    on delete cascade
);
alter table public.factory_routing_draft_evidence enable row level security;
revoke all on public.factory_routing_draft_evidence from public, anon, authenticated, service_role;
grant select on public.factory_routing_draft_evidence to authenticated, service_role;
create policy factory_routing_draft_evidence_read on public.factory_routing_draft_evidence
  for select to authenticated using (internal.can_manage_factory(workspace_id, factory_id));
create trigger preserve_factory_routing_draft_evidence before update or delete
  on public.factory_routing_draft_evidence for each row execute function internal.preserve_factory_definition_history();

create function internal.qualify_factory_routing_draft(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_candidate_key text, p_suite_revision_id uuid, p_scorer_revision_id uuid,
  p_definition jsonb, p_rule_id uuid
) returns jsonb language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  experiment public.factory_benchmark_experiments;
  suite public.factory_benchmark_suite_revisions;
  candidate public.factory_benchmark_experiment_candidates;
  scorer public.factory_scorer_revisions;
  candidate_definition jsonb;
  rule jsonb;
  task_class_name text;
  limits jsonb;
  frontier jsonb;
  observed jsonb;
  resolved integer;
  observed_cost numeric;
  latency_ms bigint;
begin
  select * into experiment from public.factory_benchmark_experiments row
    where (row.workspace_id, row.factory_id, row.id) = (p_workspace_id, p_factory_id, p_experiment_id);
  select * into candidate from public.factory_benchmark_experiment_candidates row
    where (row.workspace_id, row.factory_id, row.experiment_id, row.candidate_key) =
      (p_workspace_id, p_factory_id, p_experiment_id, p_candidate_key);
  if candidate.candidate_key is null or candidate.qualification_id is null then
    raise exception 'This candidate has no exact benchmark qualification.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from public.workspace_sandbox_connection_mutations mutation
    where (mutation.workspace_id, mutation.provider) = (p_workspace_id, candidate.sandbox_provider)
      and mutation.expires_at > clock_timestamp()
  ) then
    raise exception 'The sandbox connection is being updated. Retry after the change finishes.' using errcode = 'PT409';
  end if;

  select * into suite from public.factory_benchmark_suite_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id) =
      (p_workspace_id, p_factory_id, experiment.suite_revision_id);
  select revision.* into scorer from public.factory_benchmark_evaluation_dimensions dimension
    join public.factory_scorer_revisions revision on (revision.workspace_id, revision.factory_id, revision.id) =
      (dimension.workspace_id, dimension.factory_id, dimension.scorer_revision_id)
    where (dimension.workspace_id, dimension.factory_id, dimension.experiment_id, dimension.scorer_revision_id) =
      (p_workspace_id, p_factory_id, p_experiment_id, p_scorer_revision_id);
  if suite.id is distinct from p_suite_revision_id or exists (
    select 1 from public.factory_benchmark_suite_revisions newer
    where (newer.workspace_id, newer.factory_id, newer.suite_id) = (p_workspace_id, p_factory_id, suite.suite_id)
      and newer.revision_number > suite.revision_number
  ) then
    raise exception 'The suite revision changed. Run a new comparison before applying it.' using errcode = 'PT409';
  end if;
  if scorer.id is null or exists (
    select 1 from public.factory_scorer_revisions newer
    where (newer.workspace_id, newer.factory_id, newer.scorer_id) = (p_workspace_id, p_factory_id, scorer.scorer_id)
      and newer.revision_number > scorer.revision_number
  ) then
    raise exception 'The selected scorer is unavailable or has a newer revision. Run a new comparison.' using errcode = 'PT409';
  end if;
  if exists (
    select 1 from internal.factory_benchmark_replay_revocations revocation
    where revocation.policy_revision_id = experiment.policy_revision_id
    union all
    select 1 from internal.factory_benchmark_replay_policy_fixtures fixture
    join internal.factory_benchmark_replay_revocations revocation using (fixture_revision_id)
    where fixture.policy_revision_id = experiment.policy_revision_id
  ) or not exists (
    select 1 from internal.factory_benchmark_axis_profiles(
      p_workspace_id, p_factory_id, suite.id, array[candidate.definition_revision_id]
    ) profile
    where (profile.id, profile.definition_id, profile.definition_digest, profile.model_key,
      profile.harness, profile.worker_runtime, profile.sandbox_connection_revision, profile.toolchain_digest) =
      (candidate.qualification_id, candidate.definition_revision_id, candidate.definition_digest,
      candidate.canonical_model_key, candidate.harness, candidate.worker_runtime,
      candidate.sandbox_connection_revision, candidate.toolchain_digest)
      and profile.unavailable_reason is null
  ) then
    raise exception 'The replay policy or execution qualification changed. Run a new comparison.' using errcode = 'PT409';
  end if;

  select definition.definition_json::jsonb into candidate_definition
    from public.factory_definition_revisions definition
    where (definition.workspace_id, definition.factory_id, definition.id, definition.canonical_digest) =
      (p_workspace_id, p_factory_id, candidate.definition_revision_id, candidate.definition_digest);
  select entry.value into rule from jsonb_array_elements(p_definition#>'{modelRouting,rules}') entry
    where entry.value->>'id' = p_rule_id::text;
  select entry.value->>'name' into task_class_name
    from jsonb_array_elements(p_definition#>'{modelRouting,taskClasses}') entry
    where entry.value->>'id' = rule->>'taskClassId';
  if candidate_definition is null or
    task_class_name is null or
    (candidate_definition->>'repositoryId', candidate_definition->>'pipelineId') is distinct from
    (p_definition->>'repositoryId', p_definition->>'pipelineId') or
    rule->'configuration' is distinct from jsonb_build_object(
      'agentId', candidate_definition#>>'{implementationAgent,agentId}',
      'definitionRevisionId', candidate.definition_revision_id, 'experimentId', p_experiment_id,
      'qualificationId', candidate.qualification_id, 'scorerRevisionId', scorer.id, 'modelKey', candidate.canonical_model_key,
      'harness', candidate.harness, 'workerRuntime', candidate.worker_runtime
    ) then
    raise exception 'The benchmark configuration does not match this routing draft.' using errcode = 'PT422';
  end if;

  limits := rule->'constraints';
  if limits->>'minConfidenceBps' is not null then
    raise exception 'The comparison does not have a measured confidence value for this limit.' using errcode = 'PT422';
  end if;
  frontier := public.read_factory_benchmark_frontier(p_workspace_id, p_factory_id,
    p_experiment_id, p_actor_user_id, scorer.id, null, 100,
    (limits->>'qualityFloorBps')::integer, (limits->>'minResolvedTrials')::integer);
  select item.value into observed from jsonb_array_elements(frontier->'items') item
    where item.value->>'candidateKey' = candidate.candidate_key;
  if frontier#>>'{recommendation,reason}' = 'comparison_in_progress' then
    raise exception 'The comparison is still in progress.' using errcode = 'PT422';
  end if;
  if observed#>'{exclusions}' ? 'below_quality_floor' then
    raise exception 'The measured pass rate is below the selected quality floor.' using errcode = 'PT422';
  end if;
  if observed#>'{exclusions}' ? 'insufficient_samples' then
    raise exception 'The candidate has fewer resolved trials than the selected minimum.' using errcode = 'PT422';
  end if;
  observed_cost := (observed#>>'{cost,meanCostUsd}')::numeric;
  if observed#>'{exclusions}' ?| array['unavailable_cost', 'estimated_cost'] then
    raise exception 'The candidate needs measured cost for all comparable trials.' using errcode = 'PT422';
  end if;
  if observed#>>'{status}' is null or observed#>>'{status}' = 'excluded' or observed_cost is null then
    raise exception 'The candidate does not have complete comparable quality and cost evidence.' using errcode = 'PT422';
  end if;
  resolved := (observed#>>'{counts,resolved}')::integer;
  if (observed#>>'{cost,measuredUsd}')::numeric > resolved * (limits->>'maxMeanCostUsd')::numeric then
    raise exception 'The measured mean cost exceeds the selected ceiling.' using errcode = 'PT422';
  end if;
  select ceil(percentile_cont(0.95) within group (order by trial.wall_runtime_ms))::bigint into latency_ms
    from internal.factory_benchmark_comparison_trial_facts(
      p_workspace_id, p_factory_id, p_experiment_id, statement_timestamp()
    ) trial
    where trial.candidate_key = candidate.candidate_key and trial.eligibility = 'eligible'
    having count(*) = resolved and count(trial.wall_runtime_ms) = resolved;
  if limits->>'maxLatencyMs' is not null and latency_ms is null then
    raise exception 'Wall latency is unavailable for one or more comparable trials.' using errcode = 'PT422';
  end if;
  if latency_ms > (limits->>'maxLatencyMs')::integer then
    raise exception 'The measured p95 wall latency exceeds the selected ceiling.' using errcode = 'PT422';
  end if;

  return jsonb_build_object(
    'version', 1, 'experimentId', experiment.id, 'candidateKey', candidate.candidate_key,
    'suite', jsonb_build_object('id', suite.suite_id, 'revisionId', suite.id, 'purpose', suite.purpose, 'name', suite.name),
    'scorerRevisionId', scorer.id, 'scorerName', frontier#>>'{scorer,name}',
    'taskClassName', task_class_name, 'constraints', limits,
    'definitionDigest', candidate.definition_digest, 'replayPolicyRevisionId', experiment.policy_revision_id,
    'replayPolicyDigest', experiment.policy_digest, 'ruleId', p_rule_id, 'capturedAt', statement_timestamp(),
    'qualityPassRateBps', observed#>'{quality,passRateBps}', 'resolvedTrials', resolved,
    'measuredMeanCostUsd', observed#>>'{cost,meanCostUsd}', 'p95WallLatencyMs', latency_ms,
    'isRecommended', observed->'isRecommended'
  );
end;
$$;
revoke all on function internal.qualify_factory_routing_draft(uuid, uuid, uuid, uuid, text, uuid, uuid, jsonb, uuid)
  from public, anon, authenticated, service_role;

create function public.save_factory_routing_draft(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_definition_json text, p_canonical_digest text, p_settings_metadata jsonb,
  p_experiment_id uuid, p_candidate_key text, p_suite_revision_id uuid, p_scorer_revision_id uuid,
  p_rule_id uuid, p_request_id uuid, p_request_digest text, p_expected_draft_id uuid default null
) returns public.factory_definition_drafts
language plpgsql security definer set search_path = '' as $$
declare
  prior public.factory_routing_draft_evidence;
  draft public.factory_definition_drafts;
  receipt jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  perform internal.lock_factory_definition_head(
    p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number
  );
  select * into prior from public.factory_routing_draft_evidence stored
    where (stored.workspace_id, stored.factory_id, stored.request_id) = (p_workspace_id, p_factory_id, p_request_id);
  if found then
    if (prior.created_by, prior.request_digest) is distinct from (p_actor_user_id, p_request_digest) then
      raise exception 'This routing request ID was already used.' using errcode = 'PT409';
    end if;
    select * into strict draft from public.factory_definition_drafts stored
      where (stored.workspace_id, stored.factory_id, stored.id) = (prior.workspace_id, prior.factory_id, prior.draft_id);
    return draft;
  end if;

  -- The guarded save still performs its normal draft CAS, stage and component validation.
  -- A failed qualification rolls back the draft insert in this same transaction.
  draft := public.save_settings_factory_definition_draft(
    p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number,
    p_definition_json, p_canonical_digest, p_settings_metadata, p_expected_draft_id
  );
  begin
    perform 1 from public.github_repositories repository
    join public.github_installations installation on (installation.workspace_id, installation.id) =
      (repository.workspace_id, repository.github_installation_id)
    where (repository.workspace_id, repository.factory_id, repository.id) =
      (p_workspace_id, p_factory_id, (draft.definition_json::jsonb->>'repositoryId')::uuid)
      and not repository.is_archived and not installation.suspended
    for share of repository, installation nowait;
    if not found then
      raise exception 'The factory writer repository or installation is unavailable.' using errcode = 'PT409';
    end if;
  exception when lock_not_available then
    raise exception 'The factory writer repository or installation is being updated.' using errcode = 'PT409';
  end;
  receipt := internal.qualify_factory_routing_draft(
    p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id, p_candidate_key,
    p_suite_revision_id, p_scorer_revision_id, draft.definition_json::jsonb, p_rule_id
  );
  insert into public.factory_routing_draft_evidence(
    workspace_id, factory_id, draft_id, request_id, request_digest, created_by, experiment_id, candidate_key, evidence
  ) values (
    p_workspace_id, p_factory_id, draft.id, p_request_id, p_request_digest, p_actor_user_id,
    p_experiment_id, p_candidate_key, receipt
  );
  return draft;
end;
$$;
revoke all on function public.save_factory_routing_draft(
  uuid, uuid, uuid, bigint, text, text, jsonb, uuid, text, uuid, uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.save_factory_routing_draft(
  uuid, uuid, uuid, bigint, text, text, jsonb, uuid, text, uuid, uuid, uuid, uuid, text, uuid
) to service_role;
