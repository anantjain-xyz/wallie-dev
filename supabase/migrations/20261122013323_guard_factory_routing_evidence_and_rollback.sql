create function internal.factory_routing_policy_targets(p_policy jsonb)
returns table(rule_id text, task_class_id text, target text, configuration jsonb, constraints jsonb)
language sql immutable set search_path = '' as $$
  with rules as (
    select entry.value from jsonb_array_elements(case when jsonb_typeof(p_policy->'rules') = 'array'
      then p_policy->'rules' else '[]'::jsonb end) entry(value)
  )
  select rule.value->>'id', rule.value->>'taskClassId', 'primary', rule.value->'configuration', rule.value->'constraints'
  from rules rule
  union all
  select rule.value->>'id', rule.value->>'taskClassId', 'rule_fallback',
    rule.value#>'{onUnavailable,configuration}', rule.value->'constraints'
  from rules rule where rule.value#>>'{onUnavailable,kind}' = 'fallback'
  union all
  select null, null, 'unmatched_fallback', p_policy#>'{onUnmatched,configuration}', p_policy#>'{onUnmatched,constraints}'
  where p_policy#>>'{onUnmatched,kind}' = 'fallback'
$$;
revoke all on function internal.factory_routing_policy_targets(jsonb) from public, anon, authenticated, service_role;

-- Compare current qualification to the exact frozen candidate. No current
-- provider, sandbox, rubric or similarly named revision can substitute for it.
create function internal.factory_routing_qualification_reasons(
  p_workspace_id uuid, p_factory_id uuid, p_configuration jsonb
) returns text[] language plpgsql stable set search_path = '' as $$
declare
  experiment public.factory_benchmark_experiments;
  candidate public.factory_benchmark_experiment_candidates;
  candidate_definition jsonb;
  suite public.factory_benchmark_suite_revisions;
  scorer_ids uuid[];
  profile record;
  reasons text[] := '{}';
begin
  if not (coalesce(pg_input_is_valid(p_configuration->>'experimentId','uuid'),false)
    and coalesce(pg_input_is_valid(p_configuration->>'definitionRevisionId','uuid'),false)
    and coalesce(pg_input_is_valid(p_configuration->>'qualificationId','uuid'),false)) then
    return array['candidate_unavailable'];
  end if;
  select * into experiment from public.factory_benchmark_experiments frozen
  where (frozen.workspace_id,frozen.factory_id,frozen.id) =
    (p_workspace_id,p_factory_id,(p_configuration->>'experimentId')::uuid);
  if not found then return array['candidate_unavailable']; end if;
  select * into candidate from public.factory_benchmark_experiment_candidates stored
  where (stored.workspace_id,stored.factory_id,stored.experiment_id,stored.definition_revision_id) =
    (p_workspace_id,p_factory_id,experiment.id,(p_configuration->>'definitionRevisionId')::uuid)
  order by (stored.qualification_id = (p_configuration->>'qualificationId')::uuid
    and stored.canonical_model_key = p_configuration->>'modelKey'
    and stored.harness = p_configuration->>'harness'
    and stored.worker_runtime = p_configuration->>'workerRuntime') desc nulls last,
    (stored.qualification_id = (p_configuration->>'qualificationId')::uuid) desc,
    ((case when stored.canonical_model_key = p_configuration->>'modelKey' then 1 else 0 end)
      + (case when stored.harness = p_configuration->>'harness' then 1 else 0 end)
      + (case when stored.worker_runtime = p_configuration->>'workerRuntime' then 1 else 0 end)) desc,
    stored.candidate_key
  limit 1;
  if not found then return array['definition_changed']; end if;
  select revision.definition_json::jsonb into candidate_definition from public.factory_definition_revisions revision
  where (revision.workspace_id,revision.factory_id,revision.id,revision.canonical_digest) =
    (p_workspace_id,p_factory_id,candidate.definition_revision_id,candidate.definition_digest);
  if candidate_definition is null
    or candidate_definition#>>'{implementationAgent,agentId}' is distinct from p_configuration->>'agentId' then
    reasons := array_append(reasons,'definition_changed');
  end if;
  if candidate.canonical_model_key is distinct from p_configuration->>'modelKey' then
    reasons := array_append(reasons,'model_changed');
  end if;
  if candidate.harness is distinct from p_configuration->>'harness' then
    reasons := array_append(reasons,'harness_changed');
  end if;
  if candidate.worker_runtime is distinct from p_configuration->>'workerRuntime' then
    reasons := array_append(reasons,'runtime_changed');
  end if;
  if candidate.qualification_id::text is distinct from p_configuration->>'qualificationId' then
    reasons := array_append(reasons,'qualification_changed');
  end if;
  select * into suite from public.factory_benchmark_suite_revisions pinned
  where (pinned.workspace_id,pinned.factory_id,pinned.id) = (p_workspace_id,p_factory_id,experiment.suite_revision_id);
  if not found or exists (
    select 1 from public.factory_benchmark_suite_revisions newer
    where (newer.workspace_id,newer.factory_id,newer.suite_id) = (p_workspace_id,p_factory_id,suite.suite_id)
      and newer.revision_number > suite.revision_number
  ) then
    reasons := array_append(reasons,'suite_revision_changed');
  end if;
  select array_agg(dimension.scorer_revision_id) into scorer_ids
  from public.factory_benchmark_evaluation_dimensions dimension
  where (dimension.workspace_id,dimension.factory_id,dimension.experiment_id) = (p_workspace_id,p_factory_id,experiment.id)
    and (p_configuration->>'scorerRevisionId' is null or dimension.scorer_revision_id::text = p_configuration->>'scorerRevisionId');
  if cardinality(scorer_ids) is distinct from 1 then
    reasons := array_append(reasons,'scorer_unavailable');
  elsif exists (
    select 1 from public.factory_scorer_revisions pinned
    join public.factory_scorer_revisions newer using(workspace_id,factory_id,scorer_id)
    where (pinned.workspace_id,pinned.factory_id,pinned.id) = (p_workspace_id,p_factory_id,scorer_ids[1])
      and newer.revision_number > pinned.revision_number
  ) then
    reasons := array_append(reasons,'scorer_revision_changed');
  end if;
  if exists (
    select 1 from internal.factory_benchmark_replay_revocations revoked
    where revoked.policy_revision_id = experiment.policy_revision_id
    union all
    select 1 from internal.factory_benchmark_replay_policy_fixtures fixture
    join internal.factory_benchmark_replay_revocations revoked using(fixture_revision_id)
    where fixture.policy_revision_id = experiment.policy_revision_id
  ) then
    reasons := array_append(reasons,'replay_policy_revoked');
  end if;

  if internal.factory_connected_sandbox_revision(p_workspace_id,candidate.sandbox_provider) is distinct from
    candidate.sandbox_connection_revision then
    reasons := array_append(reasons,'sandbox_connection_changed');
  else
    select available.* into profile
    from internal.factory_benchmark_axis_profiles(p_workspace_id,p_factory_id,suite.id,array[candidate.definition_revision_id]) available
    where (available.definition_id,available.definition_digest,available.model_key,available.harness,
      available.harness_model,available.worker_runtime,available.sandbox_provider) =
      (candidate.definition_revision_id,candidate.definition_digest,candidate.canonical_model_key,candidate.harness,
        candidate.model,candidate.worker_runtime,candidate.sandbox_provider)
    order by (available.id = candidate.qualification_id and available.toolchain_digest = candidate.toolchain_digest
      and available.sandbox_connection_revision = candidate.sandbox_connection_revision and available.unavailable_reason is null) desc,
      available.id
    limit 1;
    if not found or profile.unavailable_reason is not null or exists (
      select 1 from public.workspace_sandbox_connection_mutations mutation
      where (mutation.workspace_id,mutation.provider) = (p_workspace_id,candidate.sandbox_provider)
        and mutation.expires_at > statement_timestamp()
    ) then
      reasons := array_append(reasons,'capability_unavailable');
    elsif profile.sandbox_connection_revision is distinct from candidate.sandbox_connection_revision then
      reasons := array_append(reasons,'sandbox_connection_changed');
    elsif profile.toolchain_digest is distinct from candidate.toolchain_digest then
      reasons := array_append(reasons,'toolchain_changed');
    elsif profile.id is distinct from candidate.qualification_id and not ('qualification_changed' = any(reasons)) then
      reasons := array_append(reasons,'qualification_changed');
    end if;
  end if;
  return reasons;
end;
$$;
revoke all on function internal.factory_routing_qualification_reasons(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.check_factory_model_routing_target(
  admission public.session_factory_admission_inputs, session_row public.sessions,
  configuration jsonb, constraints jsonb
) returns table (benchmark_candidate_key text, reason text)
language plpgsql set search_path = '' as $$
declare
  candidate record;
  current_grant public.factory_execution_grants;
  target_definition jsonb;
  target_agent_id uuid;
  credential_status text;
begin
  if not coalesce(pg_input_is_valid(configuration->>'experimentId', 'uuid'), false)
    or not coalesce(pg_input_is_valid(configuration->>'definitionRevisionId', 'uuid'), false)
    or not coalesce(pg_input_is_valid(configuration->>'qualificationId', 'uuid'), false)
    or not coalesce(pg_input_is_valid(configuration->>'agentId', 'uuid'), false) then
    return query select null::text, 'invalid_policy'::text;
    return;
  end if;

  select stored.*, experiment.suite_revision_id, revision.definition_json::jsonb as definition
  into candidate
  from public.factory_benchmark_experiment_candidates stored
  join public.factory_benchmark_experiments experiment
    on (experiment.workspace_id, experiment.factory_id, experiment.id) =
       (stored.workspace_id, stored.factory_id, stored.experiment_id)
  join public.factory_definition_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
       (stored.workspace_id, stored.factory_id, stored.definition_revision_id, stored.definition_digest)
  join public.factory_agents agent
    on (agent.workspace_id, agent.factory_id, agent.id) =
       (stored.workspace_id, stored.factory_id, (configuration->>'agentId')::uuid)
  where (stored.workspace_id, stored.factory_id, stored.experiment_id, stored.definition_revision_id,
         stored.qualification_id, stored.canonical_model_key, stored.harness, stored.worker_runtime) =
        (admission.workspace_id, admission.factory_id, (configuration->>'experimentId')::uuid,
         (configuration->>'definitionRevisionId')::uuid, (configuration->>'qualificationId')::uuid,
         configuration->>'modelKey', configuration->>'harness', configuration->>'workerRuntime')
    and revision.definition_json::jsonb#>>'{implementationAgent,agentId}' = agent.id::text;
  if not found then
    return query select null::text, 'configuration_unavailable'::text;
    return;
  end if;
  target_definition := candidate.definition;
  target_agent_id := (configuration->>'agentId')::uuid;
  if admission.github_repository_id is null
    or target_definition->>'repositoryId' is distinct from admission.github_repository_id::text then
    return query select null::text, 'repository_mismatch'::text;
    return;
  end if;

  -- Fresh routing uses only current qualifications. The established resolver
  -- still explains a missing or ambiguous scorer as unavailable evidence.
  if exists (
    select 1 from unnest(internal.factory_routing_qualification_reasons(
      admission.workspace_id, admission.factory_id, configuration)) drift(reason)
    where drift.reason <> 'scorer_unavailable'
  ) then
    return query select null::text, 'qualification_unavailable'::text;
    return;
  end if;

  if admission.execution_grant_id is null and not (target_definition ? 'executionGrant') then
    credential_status := public.check_session_agent_credential(
      admission.workspace_id, admission.credential_owner_member_id, candidate.harness, candidate.model);
  elsif admission.execution_grant_id is not null
    and target_definition#>>'{executionGrant,id}' = admission.execution_grant_id::text
    and target_definition#>>'{executionGrant,version}' = admission.execution_grant_version::text
    and target_definition->>'executionPolicyRevisionId' = admission.execution_policy_revision_id::text
    and pg_input_is_valid(target_definition->>'credentialBindingId', 'uuid')
    and (session_row.creator_service_principal_id is null or target_agent_id::text =
      internal.pinned_session_execution_definition(session_row)#>>'{implementationAgent,agentId}') then
    begin
      current_grant := internal.resolve_definition_execution_grant(admission.workspace_id, admission.factory_id,
        target_definition, admission.github_repository_id, admission.execution_policy_revision_id);
    exception when sqlstate '42501' or sqlstate 'PT409' or sqlstate 'PT422' then
      return query select null::text, 'authority_unavailable'::text;
      return;
    end;
    if current_grant.service_principal_id is distinct from admission.credential_owner_service_principal_id then
      return query select null::text, 'authority_unavailable'::text;
      return;
    end if;
    credential_status := public.check_factory_credential_binding(admission.workspace_id, admission.factory_id,
      (target_definition->>'credentialBindingId')::uuid, current_grant.id, current_grant.version,
      target_agent_id, candidate.harness, candidate.model);
  else
    return query select null::text, 'authority_unavailable'::text;
    return;
  end if;
  if credential_status is distinct from 'ready' then
    return query select null::text, 'credential_unavailable'::text;
    return;
  end if;

  return query select candidate.candidate_key, internal.factory_model_routing_evidence_reason(
    admission.workspace_id, admission.factory_id, candidate.experiment_id, candidate.candidate_key,
    configuration->>'scorerRevisionId', constraints);
exception when data_exception then
  return query select null::text, 'invalid_policy'::text;
end;
$$;

create or replace function internal.assert_current_reviewed_routing_evidence(
  p_workspace_id uuid, p_factory_id uuid, p_configuration jsonb
) returns void language plpgsql stable set search_path = '' as $$
declare reasons text[];
begin
  reasons := internal.factory_routing_qualification_reasons(p_workspace_id,p_factory_id,p_configuration);
  if cardinality(reasons) > 0 then
    raise exception 'Reviewed routing evidence has changed. Run a new comparison before activating.' using
      errcode = 'PT409', detail = array_to_string(reasons, ', ');
  end if;
end;
$$;

create function internal.get_factory_routing_qualification_status(
  p_workspace_id uuid, p_factory_id uuid, p_activation_number bigint, p_draft_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  activation public.factory_definition_activations;
  draft public.factory_definition_drafts;
  revision public.factory_definition_revisions;
  reviewed public.factory_routing_activations;
  policy jsonb;
  definition_digest text;
  evidence_id uuid;
  reasons text[] := '{}';
  targets jsonb;
begin
  if auth.uid() is null or not internal.can_manage_factory(p_workspace_id,p_factory_id) then
    raise exception 'Routing qualification status is unavailable.' using errcode = '42501';
  end if;
  if (p_activation_number is not null and p_draft_id is not null) or p_activation_number <= 0 then
    raise exception 'Select a stored draft or activation.' using errcode = '22023';
  end if;
  if p_draft_id is not null then
    select * into draft from public.factory_definition_drafts saved
    where (saved.workspace_id,saved.factory_id,saved.id) = (p_workspace_id,p_factory_id,p_draft_id);
    if not found then raise exception 'Factory definition draft is unavailable.' using errcode = 'P0002'; end if;
    policy := draft.definition_json::jsonb->'modelRouting';
    definition_digest := draft.canonical_digest;
    select receipt.draft_id into evidence_id from public.factory_routing_draft_evidence receipt
    where (receipt.workspace_id,receipt.factory_id) = (p_workspace_id,p_factory_id)
      and receipt.draft_id in (draft.id,draft.routing_evidence_source_draft_id)
    order by (receipt.draft_id = draft.id) desc limit 1;
  else
    select * into activation from public.factory_definition_activations published
    where (published.workspace_id,published.factory_id) = (p_workspace_id,p_factory_id)
      and (p_activation_number is null or published.activation_number = p_activation_number)
    order by published.activation_number desc limit 1;
    if not found then
      if p_activation_number is null then return null; end if;
      raise exception 'Factory activation is unavailable.' using errcode = 'P0002';
    end if;
    select * into strict revision from public.factory_definition_revisions published
    where (published.workspace_id,published.factory_id,published.id) = (p_workspace_id,p_factory_id,activation.revision_id);
    policy := revision.definition_json::jsonb->'modelRouting';
    definition_digest := revision.canonical_digest;
    select * into reviewed from public.factory_routing_activations review
    where (review.workspace_id,review.factory_id,review.activation_number,review.revision_id) =
      (p_workspace_id,p_factory_id,activation.activation_number,revision.id);
    evidence_id := reviewed.benchmark_evidence_draft_id;
    if evidence_id is null then
      select receipt.draft_id into evidence_id from public.factory_definition_drafts source
      join public.factory_routing_draft_evidence receipt
        on (receipt.workspace_id,receipt.factory_id) = (source.workspace_id,source.factory_id)
        and receipt.draft_id in (source.id,source.routing_evidence_source_draft_id)
      where (source.workspace_id,source.factory_id,source.id,source.canonical_digest) =
        (p_workspace_id,p_factory_id,revision.source_draft_id,revision.canonical_digest)
      order by (receipt.draft_id = source.id) desc limit 1;
    end if;
  end if;
  if policy is null then return null; end if;
  if evidence_id is null then reasons := array['missing_proposal']; end if;
  select coalesce(jsonb_agg(jsonb_build_object('ruleId', checked.rule_id, 'taskClassId', checked.task_class_id,
    'target', checked.target, 'configuration', checked.configuration, 'reasons', checked.reasons)
    order by checked.rule_id, checked.target),'[]'::jsonb)
  into targets from (
    select target.*,internal.factory_routing_qualification_reasons(p_workspace_id,p_factory_id,target.configuration) as reasons
    from internal.factory_routing_policy_targets(policy) target
  ) checked;
  select coalesce(array_agg(distinct value order by value),'{}'::text[]) into reasons
  from (
    select unnest(reasons) as value
    union
    select reason.value from jsonb_array_elements(targets) target(value)
    cross join jsonb_array_elements_text(target.value->'reasons') reason(value)
  ) all_reasons;
  return jsonb_build_object('activationNumber',activation.activation_number,'draftId',draft.id,'revisionId',revision.id,
    'definitionDigest',definition_digest,'status',case when cardinality(reasons)=0 then 'current' else 'stale' end,
    'reasons',reasons,'targets',targets);
end;
$$;
revoke all on function internal.get_factory_routing_qualification_status(uuid,uuid,bigint,uuid)
  from public, anon, authenticated, service_role;
grant execute on function internal.get_factory_routing_qualification_status(uuid,uuid,bigint,uuid) to authenticated;

create function public.get_factory_routing_qualification_status(
  p_workspace_id uuid,p_factory_id uuid,p_activation_number bigint default null,p_draft_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_factory_routing_qualification_status(p_workspace_id,p_factory_id,p_activation_number,p_draft_id)
$$;
revoke all on function public.get_factory_routing_qualification_status(uuid,uuid,bigint,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_routing_qualification_status(uuid,uuid,bigint,uuid) to authenticated;

create table public.factory_routing_rollbacks (
  workspace_id uuid not null,
  factory_id uuid not null,
  activation_number bigint not null,
  previous_activation_number bigint not null,
  target_activation_number bigint not null,
  target_revision_id uuid not null,
  restored_mode text not null check (restored_mode in ('shadow','reviewed')),
  actor_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id,factory_id,activation_number),
  foreign key (workspace_id,factory_id,activation_number)
    references public.factory_definition_activations(workspace_id,factory_id,activation_number) on delete cascade,
  foreign key (workspace_id,factory_id,target_activation_number)
    references public.factory_definition_activations(workspace_id,factory_id,activation_number) deferrable initially deferred,
  check (previous_activation_number = activation_number - 1 and target_activation_number < previous_activation_number)
);
alter table public.factory_routing_rollbacks enable row level security;
revoke all on public.factory_routing_rollbacks from public, anon, authenticated, service_role;
grant select on public.factory_routing_rollbacks to authenticated, service_role;
create policy factory_routing_rollbacks_manager_read on public.factory_routing_rollbacks
  for select to authenticated using (internal.can_manage_factory(workspace_id,factory_id));
create trigger preserve_factory_routing_rollbacks before update or delete on public.factory_routing_rollbacks
  for each row execute function internal.preserve_factory_definition_history();

-- Preserve the canonical append, authority and smoke implementation. The
-- public compatibility entry point cannot infer a reviewed activation by revision ID.
alter function public.rollback_factory_definition(uuid,uuid,uuid,bigint,uuid,text[],text[]) set schema internal;
alter function internal.rollback_factory_definition(uuid,uuid,uuid,bigint,uuid,text[],text[])
  rename to rollback_factory_definition_at_head;
revoke all on function internal.rollback_factory_definition_at_head(uuid,uuid,uuid,bigint,uuid,text[],text[])
  from public, anon, authenticated, service_role;

create function public.rollback_factory_definition(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_revision_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[]
) returns public.factory_definition_activations language plpgsql security definer set search_path = '' as $$
declare head public.factory_definition_activations;
begin
  head := internal.lock_factory_definition_head(p_workspace_id,p_factory_id,p_actor_user_id,p_expected_activation_number);
  if exists (select 1 from public.factory_routing_activations reviewed
    where (reviewed.workspace_id,reviewed.factory_id) = (p_workspace_id,p_factory_id)
      and (reviewed.activation_number = head.activation_number or reviewed.revision_id = p_revision_id)) then
    raise exception 'Select the exact prior activation to roll back reviewed routing.' using errcode = 'PT422';
  end if;
  return internal.rollback_factory_definition_at_head(p_workspace_id,p_factory_id,p_actor_user_id,
    p_expected_activation_number,p_revision_id,p_enabled_sandbox_providers,p_required_probes);
end;
$$;
revoke all on function public.rollback_factory_definition(uuid,uuid,uuid,bigint,uuid,text[],text[])
  from public, anon, authenticated, service_role;
grant execute on function public.rollback_factory_definition(uuid,uuid,uuid,bigint,uuid,text[],text[]) to service_role;

create function public.rollback_factory_routing_activation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_target_activation_number bigint, p_revision_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[]
) returns public.factory_definition_activations language plpgsql security definer set search_path = '' as $$
declare
  head public.factory_definition_activations;
  baseline public.factory_definition_activations;
  designation public.factory_routing_canaries;
  prior_review public.factory_routing_activations;
  evidence public.factory_routing_draft_evidence;
  restored public.factory_definition_activations;
  prospective public.session_factory_admission_inputs;
  execution_grant public.factory_execution_grants;
  reviewer uuid;
  workflow jsonb;
  head_workflow jsonb;
  target record;
  checked record;
  restored_targets jsonb := '[]'::jsonb;
  restoring_reviewed boolean;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_target_activation_number is null or p_target_activation_number <= 0 or p_revision_id is null then
    raise exception 'Select an exact prior factory activation.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text,0));
  head := internal.lock_factory_definition_head(p_workspace_id,p_factory_id,p_actor_user_id,p_expected_activation_number);
  if p_target_activation_number >= p_expected_activation_number then
    raise exception 'Select a factory activation earlier than the current head.' using errcode = 'PT409';
  end if;
  select * into baseline from public.factory_definition_activations activation
  where (activation.workspace_id,activation.factory_id,activation.activation_number,activation.revision_id) =
    (p_workspace_id,p_factory_id,p_target_activation_number,p_revision_id);
  if not found then raise exception 'The exact prior factory activation is unavailable.' using errcode = 'P0002'; end if;
  select * into designation from public.factory_routing_canaries canary
  where (canary.workspace_id,canary.factory_id,canary.activation_number) =
    (p_workspace_id,p_factory_id,baseline.activation_number);
  if found then
    raise exception 'The selected activation contains a canary. Select its earlier baseline activation %.',
      designation.baseline_activation_number using errcode = 'PT422';
  end if;

  select * into prior_review from public.factory_routing_activations reviewed
  where (reviewed.workspace_id,reviewed.factory_id,reviewed.activation_number,reviewed.revision_id) =
    (p_workspace_id,p_factory_id,baseline.activation_number,baseline.revision_id);
  restoring_reviewed := found;
  select revision.definition_json::jsonb into strict workflow from public.factory_definition_revisions revision
  where (revision.workspace_id,revision.factory_id,revision.id) = (p_workspace_id,p_factory_id,baseline.revision_id);
  if restoring_reviewed or exists (
    select 1 from public.factory_routing_activations reviewed
    where (reviewed.workspace_id,reviewed.factory_id,reviewed.activation_number) =
      (p_workspace_id,p_factory_id,head.activation_number)
  ) then
    select revision.definition_json::jsonb into strict head_workflow from public.factory_definition_revisions revision
    where (revision.workspace_id,revision.factory_id,revision.id) = (p_workspace_id,p_factory_id,head.revision_id);
    if workflow - 'modelRouting' is distinct from head_workflow - 'modelRouting' then
      raise exception 'The prior activation does not preserve the current workflow and base execution scope.' using errcode = 'PT422';
    end if;
  end if;
  select member.id into strict reviewer from public.workspace_members member
  where (member.workspace_id,member.user_id) = (p_workspace_id,p_actor_user_id)
    and member.kind = 'human' and member.is_active and member.role in ('owner','admin') for share;
  if restoring_reviewed then
    select * into evidence from public.factory_routing_draft_evidence receipt
    where (receipt.workspace_id,receipt.factory_id,receipt.draft_id) =
      (p_workspace_id,p_factory_id,prior_review.benchmark_evidence_draft_id);
    if not found then raise exception 'The prior reviewed activation lacks its exact benchmark evidence.' using errcode = 'PT422'; end if;
    perform internal.qualify_factory_routing_draft(p_workspace_id,p_factory_id,p_actor_user_id,
      evidence.experiment_id,evidence.candidate_key,(evidence.evidence#>>'{suite,revisionId}')::uuid,
      (evidence.evidence->>'scorerRevisionId')::uuid,workflow,(evidence.evidence->>'ruleId')::uuid);
    prospective.workspace_id := p_workspace_id;
    prospective.factory_id := p_factory_id;
    prospective.github_repository_id := (workflow->>'repositoryId')::uuid;
    prospective.execution_policy_revision_id := (workflow->>'executionPolicyRevisionId')::uuid;
    if workflow ? 'executionGrant' then
      execution_grant := internal.resolve_definition_execution_grant(p_workspace_id,p_factory_id,workflow,
        prospective.github_repository_id,prospective.execution_policy_revision_id);
      prospective.execution_grant_id := execution_grant.id;
      prospective.execution_grant_version := execution_grant.version;
      prospective.credential_owner_service_principal_id := execution_grant.service_principal_id;
    else
      prospective.credential_owner_member_id := reviewer;
    end if;
    for target in select option.* from internal.factory_routing_policy_targets(workflow->'modelRouting') option
    loop
      perform internal.assert_current_reviewed_routing_evidence(p_workspace_id,p_factory_id,target.configuration);
      select * into checked from internal.check_factory_model_routing_target(prospective,null::public.sessions,
        target.configuration,target.constraints);
      if checked.reason is not null or checked.benchmark_candidate_key is null then
        raise exception 'The prior reviewed routing target is unavailable (%)',coalesce(checked.reason,'configuration_unavailable')
          using errcode = 'PT422';
      end if;
      perform internal.make_factory_routing_execution(prospective,workflow,target.configuration,checked.benchmark_candidate_key);
      restored_targets := restored_targets || jsonb_build_array(jsonb_build_object(
        'ruleId',target.rule_id,'target',target.target,'configuration',target.configuration));
    end loop;
    if jsonb_array_length(restored_targets) = 0
      or jsonb_array_length(restored_targets) <> jsonb_array_length(prior_review.reviewed_targets)
      or not restored_targets @> prior_review.reviewed_targets or not prior_review.reviewed_targets @> restored_targets then
      raise exception 'The prior activation does not match its exact reviewed routing targets.' using errcode = 'PT422';
    end if;
  end if;

  restored := internal.rollback_factory_definition_at_head(p_workspace_id,p_factory_id,p_actor_user_id,
    p_expected_activation_number,p_revision_id,p_enabled_sandbox_providers,p_required_probes);
  if restoring_reviewed then
    insert into public.factory_routing_activations(workspace_id,factory_id,activation_number,revision_id,
      previous_activation_number,previous_revision_id,draft_id,draft_digest,benchmark_evidence_draft_id,
      reviewed_by_member_id,reviewed_targets)
    values (p_workspace_id,p_factory_id,restored.activation_number,restored.revision_id,
      head.activation_number,head.revision_id,prior_review.draft_id,prior_review.draft_digest,
      prior_review.benchmark_evidence_draft_id,reviewer,restored_targets);
  end if;
  insert into public.factory_routing_rollbacks(workspace_id,factory_id,activation_number,previous_activation_number,
    target_activation_number,target_revision_id,restored_mode,actor_member_id)
  values (p_workspace_id,p_factory_id,restored.activation_number,head.activation_number,baseline.activation_number,
    baseline.revision_id,case when restoring_reviewed then 'reviewed' else 'shadow' end,reviewer);
  return restored;
end;
$$;
revoke all on function public.rollback_factory_routing_activation(uuid,uuid,uuid,bigint,bigint,uuid,text[],text[])
  from public, anon, authenticated, service_role;
grant execute on function public.rollback_factory_routing_activation(uuid,uuid,uuid,bigint,bigint,uuid,text[],text[])
  to service_role;
