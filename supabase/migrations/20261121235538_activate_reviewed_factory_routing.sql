create table public.factory_routing_activations (
  workspace_id uuid not null,
  factory_id uuid not null,
  activation_number bigint not null,
  revision_id uuid not null,
  previous_activation_number bigint,
  previous_revision_id uuid,
  draft_id uuid not null,
  draft_digest text not null check (draft_digest ~ '^[0-9a-f]{64}$'),
  benchmark_evidence_draft_id uuid not null,
  reviewed_by_member_id uuid not null,
  reviewed_targets jsonb not null check (jsonb_typeof(reviewed_targets) = 'array'),
  reviewed_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, activation_number),
  foreign key (workspace_id, factory_id, activation_number)
    references public.factory_definition_activations(workspace_id, factory_id, activation_number) on delete cascade,
  foreign key (workspace_id, factory_id, draft_id)
    references public.factory_definition_drafts(workspace_id, factory_id, id) deferrable initially deferred,
  foreign key (workspace_id, factory_id, benchmark_evidence_draft_id)
    references public.factory_routing_draft_evidence(workspace_id, factory_id, draft_id) deferrable initially deferred,
  check ((previous_activation_number is null) = (previous_revision_id is null)),
  check (previous_activation_number is not distinct from nullif(activation_number - 1, 0))
);
alter table public.factory_routing_activations enable row level security;
revoke all on public.factory_routing_activations from public, anon, authenticated, service_role;
grant select on public.factory_routing_activations to authenticated, service_role;
create policy factory_routing_activations_read on public.factory_routing_activations
  for select to authenticated using (internal.can_manage_factory(workspace_id, factory_id));
create trigger preserve_factory_routing_activations before update or delete on public.factory_routing_activations
  for each row execute function internal.preserve_factory_definition_history();

alter table public.session_factory_admission_inputs
  drop constraint session_admission_routing_decision_format,
  add column routing_execution jsonb,
  add constraint session_admission_routing_decision_format check (
    (routing_decision is null and routing_execution is null) or (
      jsonb_typeof(routing_decision) is not distinct from 'object'
      and routing_decision->'version' is not distinct from '1'::jsonb
      and (
        (routing_decision->>'mode' is not distinct from 'shadow' and routing_execution is null)
        or (routing_decision->>'mode' is not distinct from 'active'
          and routing_decision->>'disposition' is not distinct from 'selected'
          and jsonb_typeof(routing_execution) is not distinct from 'object'
          and routing_execution->'configuration' is not distinct from routing_decision->'configuration'
          and routing_execution->>'benchmarkCandidateKey' is not distinct from routing_decision->>'benchmarkCandidateKey')
      )
    )
  );

create table public.session_factory_routing_overrides (
  session_id uuid primary key references public.session_factory_admission_inputs(session_id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  activation_number bigint not null,
  rule_id uuid not null,
  target text not null check (target in ('primary', 'rule_fallback')),
  actor_member_id uuid not null,
  reason text not null check (length(reason) between 1 and 500 and reason = btrim(reason, E' \t\r\n')),
  routing_execution jsonb not null check (jsonb_typeof(routing_execution) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (session_id, workspace_id, factory_id) references public.sessions(id, workspace_id, factory_id) on delete cascade,
  foreign key (workspace_id, factory_id, activation_number)
    references public.factory_routing_activations(workspace_id, factory_id, activation_number) deferrable initially deferred
);
alter table public.session_factory_routing_overrides enable row level security;
revoke all on public.session_factory_routing_overrides from public, anon, authenticated, service_role;
grant select on public.session_factory_routing_overrides to service_role;

create function internal.preserve_factory_routing_override()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.workspaces where id = old.workspace_id)
  ) then return old; end if;
  raise exception 'Factory routing overrides are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_routing_override() from public, anon, authenticated, service_role;
create trigger preserve_factory_routing_override before update or delete on public.session_factory_routing_overrides
  for each row execute function internal.preserve_factory_routing_override();

create function internal.effective_factory_routing_execution(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid
) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(override.routing_execution, admission.routing_execution)
  from public.session_factory_admission_inputs admission
  left join public.session_factory_routing_overrides override
    on (override.workspace_id, override.factory_id, override.session_id, override.activation_number) =
       (admission.workspace_id, admission.factory_id, admission.session_id, admission.activation_number)
  where (admission.workspace_id, admission.factory_id, admission.session_id) =
    (p_workspace_id, p_factory_id, p_session_id)
$$;
revoke all on function internal.effective_factory_routing_execution(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function internal.effective_factory_routing_execution(uuid, uuid, uuid) to service_role;

create function public.get_session_factory_routing_execution(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return internal.effective_factory_routing_execution(p_workspace_id, p_factory_id, p_session_id);
end;
$$;
revoke all on function public.get_session_factory_routing_execution(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_session_factory_routing_execution(uuid, uuid, uuid) to service_role;

create function internal.make_factory_routing_execution(
  admission public.session_factory_admission_inputs, workflow jsonb, configuration jsonb, candidate_key text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  candidate record;
  target jsonb;
  snapshot jsonb;
  scope_key text;
  personal_user_id uuid;
begin
  select frozen.model, frozen.harness, frozen.sandbox_provider, frozen.sandbox_connection_revision, frozen.definition_digest,
    revision.definition_json::jsonb as body into candidate
  from public.factory_benchmark_experiment_candidates frozen
  join public.factory_definition_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
       (frozen.workspace_id, frozen.factory_id, frozen.definition_revision_id, frozen.definition_digest)
  where (frozen.workspace_id, frozen.factory_id, frozen.candidate_key, frozen.experiment_id::text,
    frozen.definition_revision_id::text, frozen.qualification_id::text, frozen.canonical_model_key,
    frozen.harness, frozen.worker_runtime) = (admission.workspace_id, admission.factory_id, make_factory_routing_execution.candidate_key,
    configuration->>'experimentId', configuration->>'definitionRevisionId', configuration->>'qualificationId',
    configuration->>'modelKey', configuration->>'harness', configuration->>'workerRuntime');
  if not found then raise exception 'The exact benchmark configuration is unavailable.' using errcode = 'PT422'; end if;
  target := candidate.body;
  -- The benchmark selects execution. It cannot replace the admitted workflow,
  -- expand any repository or tool scope, or select a different credential binding.
  foreach scope_key in array array['repositoryId','pipelineId','sandboxProvider','executionGrant',
    'credentialBindingId','executionPolicyRevisionId','deliveryPolicyRevisionId'] loop
    if target->scope_key is distinct from workflow->scope_key then
      raise exception 'The benchmark configuration is outside the admitted factory scope.' using errcode = 'PT422';
    end if;
  end loop;
  foreach scope_key in array array['writableRepositoryIds','readContextRepositoryIds','toolIds','skillIds'] loop
    if coalesce(target->scope_key, '[]'::jsonb) is distinct from coalesce(workflow->scope_key, '[]'::jsonb) then
      raise exception 'The benchmark configuration is outside the admitted factory scope.' using errcode = 'PT422';
    end if;
  end loop;
  if target->>'repositoryId' is distinct from admission.github_repository_id::text
    or candidate.sandbox_provider is distinct from workflow->>'sandboxProvider'
    or candidate.sandbox_connection_revision is null
    or target->'mcpManifest' is distinct from workflow->'mcpManifest'
    or (coalesce(jsonb_array_length(workflow#>'{mcpManifest,servers}'),0) > 0
      and (configuration->>'agentId', configuration->>'harness') is distinct from
        (workflow#>>'{implementationAgent,agentId}', workflow#>>'{agent,provider}'))
    or (admission.execution_grant_id is not null
      and configuration->>'agentId' is distinct from workflow#>>'{implementationAgent,agentId}') then
    raise exception 'The benchmark configuration is outside the admitted factory scope.' using errcode = 'PT422';
  end if;
  snapshot := target->'implementationAgent';
  perform internal.assert_factory_agent_snapshot(admission.workspace_id, admission.factory_id, snapshot);
  if admission.execution_grant_id is null then
    select member.user_id into personal_user_id from public.workspace_members member
    where (member.workspace_id, member.id) = (admission.workspace_id, admission.credential_owner_member_id)
      and member.kind = 'human' and member.is_active for share;
    if personal_user_id is null then raise exception 'The routing credential owner is unavailable.' using errcode = '42501'; end if;
    perform internal.assert_current_factory_agent_credential(personal_user_id, configuration->>'harness', candidate.model);
  else
    perform internal.lock_definition_credential_binding(admission.workspace_id, admission.factory_id, target,
      admission.execution_grant_id, admission.credential_owner_service_principal_id);
  end if;
  return jsonb_build_object('version', 1, 'configuration', configuration, 'benchmarkCandidateKey', candidate_key,
    'definitionDigest', candidate.definition_digest, 'modelName', candidate.model,
    'effort', case when candidate.harness = 'codex' then target#>>'{agent,effort}' end,
    'sandboxProvider', candidate.sandbox_provider,
    'sandboxConnectionRevision', candidate.sandbox_connection_revision, 'credentialBindingId', target->>'credentialBindingId',
    'implementationAgent', jsonb_build_object('agentId', snapshot->>'agentId',
      'promptRevisionId', snapshot->>'promptRevisionId', 'promptSha256', snapshot->>'promptSha256'));
end;
$$;
revoke all on function internal.make_factory_routing_execution(public.session_factory_admission_inputs,jsonb,jsonb,text)
  from public, anon, authenticated, service_role;

create function internal.assert_current_reviewed_routing_evidence(
  p_workspace_id uuid, p_factory_id uuid, p_configuration jsonb
) returns void language plpgsql stable set search_path = '' as $$
declare
  experiment public.factory_benchmark_experiments;
begin
  select * into strict experiment from public.factory_benchmark_experiments frozen
  where (frozen.workspace_id, frozen.factory_id, frozen.id) =
    (p_workspace_id, p_factory_id, (p_configuration->>'experimentId')::uuid);
  if exists (
    select 1 from public.factory_benchmark_suite_revisions pinned
    join public.factory_benchmark_suite_revisions newer using(workspace_id,factory_id,suite_id)
    where (pinned.workspace_id,pinned.factory_id,pinned.id) = (p_workspace_id,p_factory_id,experiment.suite_revision_id)
      and newer.revision_number > pinned.revision_number
  ) or exists (
    select 1 from public.factory_benchmark_evaluation_dimensions dimension
    join public.factory_scorer_revisions pinned
      on (pinned.workspace_id,pinned.factory_id,pinned.id) =
         (dimension.workspace_id,dimension.factory_id,dimension.scorer_revision_id)
    join public.factory_scorer_revisions newer on (newer.workspace_id,newer.factory_id,newer.scorer_id) =
      (pinned.workspace_id,pinned.factory_id,pinned.scorer_id)
    where (dimension.workspace_id,dimension.factory_id,dimension.experiment_id) = (p_workspace_id,p_factory_id,experiment.id)
      and (p_configuration->>'scorerRevisionId' is null or pinned.id::text = p_configuration->>'scorerRevisionId')
      and newer.revision_number > pinned.revision_number
  ) or exists (
    select 1 from internal.factory_benchmark_replay_revocations revoked
    where revoked.policy_revision_id = experiment.policy_revision_id
    union all
    select 1 from internal.factory_benchmark_replay_policy_fixtures fixture
    join internal.factory_benchmark_replay_revocations revoked using(fixture_revision_id)
    where fixture.policy_revision_id = experiment.policy_revision_id
  ) then
    raise exception 'Reviewed routing evidence has changed. Run a new comparison before activating.' using errcode = 'PT409';
  end if;
end;
$$;
revoke all on function internal.assert_current_reviewed_routing_evidence(uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

create function public.activate_reviewed_factory_routing(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_draft_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  head public.factory_definition_activations;
  draft public.factory_definition_drafts;
  evidence public.factory_routing_draft_evidence;
  activation public.factory_definition_activations;
  prospective public.session_factory_admission_inputs;
  execution_grant public.factory_execution_grants;
  reviewer uuid;
  definition jsonb;
  policy jsonb;
  target record;
  checked record;
  reviewed_targets jsonb := '[]'::jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text, 0));
  head := internal.lock_factory_definition_head(p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  if p_draft_id is null or internal.latest_factory_draft_id(p_workspace_id, p_factory_id, p_expected_activation_number)
    is distinct from p_draft_id then
    raise exception 'The factory draft changed. Reload before activating reviewed routing.' using errcode = 'PT409';
  end if;
  select * into strict draft from public.factory_definition_drafts saved
  where (saved.workspace_id, saved.factory_id, saved.id) = (p_workspace_id, p_factory_id, p_draft_id);
  select * into evidence from public.factory_routing_draft_evidence receipt
  where (receipt.workspace_id, receipt.factory_id) = (p_workspace_id, p_factory_id)
    and receipt.draft_id in (draft.id, draft.routing_evidence_source_draft_id)
  order by (receipt.draft_id = draft.id) desc limit 1;
  if not found then raise exception 'Review a routing draft with qualified benchmark evidence first.' using errcode = 'PT422'; end if;
  definition := draft.definition_json::jsonb;
  policy := definition->'modelRouting';
  if policy->'version' is distinct from '1'::jsonb
    or jsonb_typeof(policy->'taskClasses') is distinct from 'array'
    or jsonb_typeof(policy->'rules') is distinct from 'array' then
    raise exception 'The reviewed draft does not contain a valid routing policy.' using errcode = 'PT422';
  end if;
  perform internal.qualify_factory_routing_draft(p_workspace_id, p_factory_id, p_actor_user_id,
    evidence.experiment_id, evidence.candidate_key, (evidence.evidence#>>'{suite,revisionId}')::uuid,
    (evidence.evidence->>'scorerRevisionId')::uuid, definition, (evidence.evidence->>'ruleId')::uuid);

  -- The canonical publisher owns materialization, current authorization,
  -- smoke proof, expected-head comparison, and activation history.
  activation := public.publish_factory_definition_draft(p_workspace_id, p_factory_id, p_actor_user_id,
    p_expected_activation_number, p_draft_id, p_enabled_sandbox_providers, p_required_probes);
  select member.id into strict reviewer from public.workspace_members member
  where (member.workspace_id, member.user_id) = (p_workspace_id, p_actor_user_id)
    and member.kind = 'human' and member.is_active and member.role in ('owner', 'admin') for share;
  prospective.workspace_id := p_workspace_id;
  prospective.factory_id := p_factory_id;
  prospective.github_repository_id := (definition->>'repositoryId')::uuid;
  prospective.execution_policy_revision_id := (definition->>'executionPolicyRevisionId')::uuid;
  if definition ? 'executionGrant' then
    execution_grant := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, definition,
      prospective.github_repository_id, prospective.execution_policy_revision_id);
    prospective.execution_grant_id := execution_grant.id;
    prospective.execution_grant_version := execution_grant.version;
    prospective.credential_owner_service_principal_id := execution_grant.service_principal_id;
  else
    prospective.credential_owner_member_id := reviewer;
  end if;
  for target in
    select rule.value->>'id' as rule_id, 'primary' as source, rule.value->'configuration' as configuration,
      rule.value->'constraints' as constraints
    from jsonb_array_elements(policy->'rules') rule(value)
    union all
    select rule.value->>'id', 'rule_fallback', rule.value#>'{onUnavailable,configuration}', rule.value->'constraints'
    from jsonb_array_elements(policy->'rules') rule(value) where rule.value#>>'{onUnavailable,kind}' = 'fallback'
    union all
    select null, 'unmatched_fallback', policy#>'{onUnmatched,configuration}', policy#>'{onUnmatched,constraints}'
    where policy#>>'{onUnmatched,kind}' = 'fallback'
  loop
    select * into checked from internal.check_factory_model_routing_target(prospective, null::public.sessions,
      target.configuration, target.constraints);
    if checked.reason is not null or checked.benchmark_candidate_key is null then
      raise exception 'A reviewed routing target is unavailable (%)', coalesce(checked.reason, 'configuration_unavailable')
        using errcode = 'PT422';
    end if;
    perform internal.assert_current_reviewed_routing_evidence(p_workspace_id, p_factory_id, target.configuration);
    perform internal.make_factory_routing_execution(prospective, definition, target.configuration, checked.benchmark_candidate_key);
    reviewed_targets := reviewed_targets || jsonb_build_array(jsonb_build_object(
      'ruleId', target.rule_id, 'target', target.source, 'configuration', target.configuration));
  end loop;

  insert into public.factory_routing_activations(workspace_id, factory_id, activation_number, revision_id,
    previous_activation_number, previous_revision_id, draft_id, draft_digest, benchmark_evidence_draft_id,
    reviewed_by_member_id, reviewed_targets)
  values (p_workspace_id, p_factory_id, activation.activation_number, activation.revision_id,
    head.activation_number, head.revision_id, draft.id, draft.canonical_digest, evidence.draft_id, reviewer, reviewed_targets);
  return jsonb_build_object('activationId', activation.id, 'activationNumber', activation.activation_number,
    'revisionId', activation.revision_id, 'previousActivationNumber', head.activation_number,
    'previousRevisionId', head.revision_id, 'draftId', draft.id, 'draftDigest', draft.canonical_digest,
    'createdAt', activation.created_at);
end;
$$;
revoke all on function public.activate_reviewed_factory_routing(uuid,uuid,uuid,bigint,uuid,text[],text[])
  from public, anon, authenticated, service_role;
grant execute on function public.activate_reviewed_factory_routing(uuid,uuid,uuid,bigint,uuid,text[],text[]) to service_role;

create function public.create_session_command_with_routing_override(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  expected_factory_definition_digest text, session_title text, session_prompt_md text,
  agent_model_provider text, agent_model_name text, session_attachment_ids uuid[], p_routing_override jsonb,
  session_linear_issue_id text default null, session_linear_issue_url text default null,
  session_github_repository_id uuid default null, selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null, source_session_id uuid default null, target_factory_id uuid default null,
  draft_specification boolean default false
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  actual_factory_id uuid;
  prior public.session_factory_routing_overrides;
  accepted record;
  owner public.sessions;
  admission public.session_factory_admission_inputs;
  reviewed public.factory_routing_activations;
  expected_activation bigint;
  selected_rule_id uuid;
  selected_target text := p_routing_override->>'target';
  override_reason text := btrim(p_routing_override->>'reason', E' \t\r\n');
  workflow jsonb;
  rule jsonb;
  configuration jsonb;
  checked record;
  execution jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if jsonb_typeof(p_routing_override) is distinct from 'object'
    or jsonb_typeof(p_routing_override->'expectedActivationNumber') is distinct from 'number'
    or not coalesce(pg_input_is_valid(p_routing_override->>'expectedActivationNumber', 'bigint'), false)
    or not coalesce(pg_input_is_valid(p_routing_override->>'ruleId', 'uuid'), false)
    or not coalesce(selected_target in ('primary', 'rule_fallback'), false)
    or jsonb_typeof(p_routing_override->'reason') is distinct from 'string'
    or not coalesce(length(override_reason) between 1 and 500, false)
    or (select count(*) from jsonb_object_keys(p_routing_override)) <> 4 then
    raise exception 'Select a reviewed task route and provide an override reason.' using errcode = '22023';
  end if;
  expected_activation := (p_routing_override->>'expectedActivationNumber')::bigint;
  selected_rule_id := (p_routing_override->>'ruleId')::uuid;
  if expected_activation <= 0 then
    raise exception 'A reviewed activation is required for a routing override.' using errcode = '22023';
  end if;
  if source_session_id is not null or draft_specification is distinct from false then
    raise exception 'A routing override requires a new task without a draft specification.' using errcode = '22023';
  end if;

  perform internal.assert_workspace_accepts_work(target_workspace_id);
  select factory.id into actual_factory_id from public.factories factory
  where factory.workspace_id = target_workspace_id
    and case when target_factory_id is null then factory.is_default else factory.id = target_factory_id end;
  if not found then raise exception 'The active factory changed.' using errcode = 'P0003'; end if;
  perform internal.assert_session_mutation_human_access(target_workspace_id, actual_factory_id, creator_member_id);
  perform internal.lock_session_mutation_key(target_workspace_id, actual_factory_id, 'create', target_request_id);
  select * into accepted from public.find_session_creation_command(target_workspace_id, creator_member_id,
    target_request_id, target_request_hash, actual_factory_id, source_session_id, draft_specification);
  if found then
    select * into prior from public.session_factory_routing_overrides stored
    where (stored.workspace_id, stored.factory_id, stored.session_id) =
      (target_workspace_id, actual_factory_id, accepted.session_id);
    if not found or (prior.activation_number, prior.rule_id, prior.target, prior.actor_member_id, prior.reason) is distinct from
      (expected_activation, selected_rule_id, selected_target, creator_member_id, override_reason) then
      raise exception 'This creation request was already used for different routing input.' using errcode = 'P0005';
    end if;
    return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
    return;
  end if;
  perform 1 from public.workspace_members member
  where (member.workspace_id, member.id) = (target_workspace_id, creator_member_id)
    and member.kind = 'human' and member.is_active and member.role in ('owner', 'admin') for share;
  if not found then raise exception 'An active workspace manager must authorize a routing override.' using errcode = '42501'; end if;
  if exists (select 1 from internal.session_mutation_receipts receipt
    where (receipt.workspace_id, receipt.factory_id, receipt.operation, receipt.request_id) =
      (target_workspace_id, actual_factory_id, 'create', target_request_id)) then
    raise exception 'This creation request was already used for different routing input.' using errcode = 'P0005';
  end if;
  select review.* into reviewed from public.factory_routing_activations review
  where (review.workspace_id, review.factory_id, review.activation_number, review.draft_digest) =
    (target_workspace_id, actual_factory_id, expected_activation, expected_factory_definition_digest)
    and review.activation_number = (select max(activation.activation_number) from public.factory_definition_activations activation
      where (activation.workspace_id, activation.factory_id) = (target_workspace_id, actual_factory_id));
  if not found then raise exception 'The reviewed routing activation changed. Reload before retrying.' using errcode = 'PT409'; end if;

  select * into strict accepted from public.create_session_command_once(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash, expected_factory_definition_digest,
    session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
    session_linear_issue_id, session_linear_issue_url, session_github_repository_id, selected_pipeline_id,
    selected_stage_ids, source_session_id, actual_factory_id, draft_specification
  );
  select * into strict owner from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) = (target_workspace_id, actual_factory_id, accepted.session_id);
  select * into admission from public.session_factory_admission_inputs receipt
  where (receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.activation_number, receipt.definition_revision_id) =
    (owner.workspace_id, owner.factory_id, owner.id, expected_activation, reviewed.revision_id)
    and receipt.invoking_actor_member_id = creator_member_id
    and receipt.invoking_actor_service_principal_id is null;
  if not found or admission.routing_decision->>'mode' is distinct from 'active'
    or admission.routing_decision->>'ruleId' is distinct from selected_rule_id::text then
    raise exception 'The reviewed routing rule does not apply to the admitted task class.' using errcode = 'PT422';
  end if;
  workflow := internal.pinned_session_execution_definition(owner);
  select entry.value into rule from jsonb_array_elements(workflow#>'{modelRouting,rules}') entry(value)
  where entry.value->>'id' = selected_rule_id::text;
  configuration := case selected_target when 'primary' then rule->'configuration' else rule#>'{onUnavailable,configuration}' end;
  if configuration is null or not reviewed.reviewed_targets @> jsonb_build_array(jsonb_build_object(
    'ruleId', selected_rule_id, 'target', selected_target, 'configuration', configuration)) then
    raise exception 'The routing override is outside the reviewed choices for this task.' using errcode = 'PT422';
  end if;
  select * into checked from internal.check_factory_model_routing_target(admission, owner, configuration, rule->'constraints');
  if checked.reason is not null or checked.benchmark_candidate_key is null then
    raise exception 'The reviewed override target is unavailable (%)', coalesce(checked.reason,'configuration_unavailable')
      using errcode = 'PT422';
  end if;
  execution := internal.make_factory_routing_execution(admission, workflow, configuration, checked.benchmark_candidate_key);
  insert into public.session_factory_routing_overrides(session_id, workspace_id, factory_id, activation_number,
    rule_id, target, actor_member_id, reason, routing_execution)
  values (owner.id, owner.workspace_id, owner.factory_id, expected_activation,
    selected_rule_id, selected_target, creator_member_id, override_reason, execution);
  -- The shared creation transaction has yet to release this job to a worker.
  update public.agent_runs run
  set model_provider = configuration->>'harness', model_name = execution->>'modelName'
  where (run.workspace_id, run.session_id, run.id, run.agent_job_id, run.status) =
    (owner.workspace_id, owner.id, accepted.run_id, accepted.job_id, 'queued')
    and run.attempt_count is null;
  if not found then raise exception 'A routing override requires an unstarted task.' using errcode = 'PT409'; end if;
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
end;
$$;
revoke all on function public.create_session_command_with_routing_override(
  uuid,uuid,uuid,text,text,text,text,text,text,uuid[],jsonb,text,text,uuid,uuid,uuid[],uuid,uuid,boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_session_command_with_routing_override(
  uuid,uuid,uuid,text,text,text,text,text,text,uuid[],jsonb,text,text,uuid,uuid,uuid[],uuid,uuid,boolean
) to service_role;

create function internal.get_run_routing_override(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('actorMemberId', override.actor_member_id, 'reason', override.reason,
    'target', override.target, 'configuration', override.routing_execution->'configuration',
    'benchmarkCandidateKey', override.routing_execution->>'benchmarkCandidateKey', 'createdAt', override.created_at)
  from public.session_attempt_manifests manifest
  join public.agent_runs run
    on (run.workspace_id, run.session_id, run.id, run.agent_job_id, run.attempt_count, run.stage_id) =
       (manifest.workspace_id, manifest.session_id, manifest.run_id, manifest.job_id, manifest.attempt_count, manifest.stage_id)
  join public.sessions owner on (owner.workspace_id, owner.id) = (run.workspace_id, run.session_id)
  join public.session_factory_routing_overrides override
    on (override.workspace_id, override.factory_id, override.session_id) =
       (owner.workspace_id, owner.factory_id, manifest.routing_decision_session_id)
  where (manifest.workspace_id, manifest.run_id, manifest.attempt_count) =
    (target_workspace_id, target_run_id, target_attempt_count)
    and auth.uid() is not null and internal.can_access_session(owner.id)
$$;
revoke all on function internal.get_run_routing_override(uuid,uuid,integer) from public, anon, authenticated, service_role;
grant execute on function internal.get_run_routing_override(uuid,uuid,integer) to authenticated;

create or replace function public.get_run_routing_decision(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_run_routing_decision(target_workspace_id, target_run_id, target_attempt_count)
    || jsonb_build_object('override', internal.get_run_routing_override(target_workspace_id, target_run_id, target_attempt_count))
$$;

create or replace function internal.pin_session_model_routing_admission()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  owner public.sessions;
  definition jsonb;
  task_class_slug text;
  reviewed public.factory_routing_activations;
begin
  new.routing_decision := null;
  new.routing_execution := null;
  select session.* into owner from public.sessions session
  where (session.id, session.workspace_id, session.factory_id, session.factory_definition_revision_id) =
    (new.session_id, new.workspace_id, new.factory_id, new.definition_revision_id)
    and session.execution_purpose = 'production' and session.execute_pinned_definition;
  if not found then return new; end if;
  definition := internal.pinned_session_execution_definition(owner);
  if not (definition ? 'modelRouting') then return new; end if;
  select stage.value->>'slug' into task_class_slug
  from jsonb_array_elements(definition->'stages') stage(value)
  where stage.value->>'id' = new.selected_stage_ids[1]::text;
  new.routing_decision := internal.resolve_factory_model_routing(new, owner, task_class_slug);
  select * into reviewed from public.factory_routing_activations activation
  where (activation.workspace_id, activation.factory_id, activation.activation_number, activation.revision_id, activation.draft_digest) =
    (new.workspace_id, new.factory_id, new.activation_number, new.definition_revision_id, new.definition_digest);
  if not found then return new; end if;
  if new.routing_decision->>'disposition' is distinct from 'selected'
    or not reviewed.reviewed_targets @> jsonb_build_array(jsonb_build_object(
      'ruleId', new.routing_decision->'ruleId', 'target', new.routing_decision->'source',
      'configuration', new.routing_decision->'configuration')) then
    raise exception 'The reviewed routing policy escalated this task (%)', coalesce(new.routing_decision->>'reason', 'invalid_policy')
      using errcode = 'PT422';
  end if;
  new.routing_execution := internal.make_factory_routing_execution(new, definition,
    new.routing_decision->'configuration', new.routing_decision->>'benchmarkCandidateKey');
  new.routing_decision := jsonb_set(new.routing_decision, '{mode}', '"active"');
  return new;
end;
$$;

create or replace function internal.create_attributed_session(
  target_workspace_id uuid,
  creator_member_id uuid,
  session_title text,
  session_prompt_md text,
  agent_model_provider text,
  agent_model_name text,
  session_linear_issue_id text default null,
  session_linear_issue_url text default null,
  session_github_repository_id uuid default null,
  selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null,
  p_actor internal.session_mutation_actor default null,
  p_expected_agent_id uuid default null,
  p_expected_definition_digest text default null
)
returns table (
  session_id uuid,
  session_number integer,
  workspace_slug text,
  job_id uuid,
  run_id uuid
)
language plpgsql
set search_path = ''
as $$
declare
  allocated_number integer;
  created_job_id uuid;
  created_run_id uuid;
  created_session_id uuid;
  first_stage_slug text;
  first_stage_name text;
  pinned_pipeline_id uuid;
  resolved_stage_ids uuid[];
  admitted_factory_id uuid;
  admitted_activation_number bigint;
  admitted_revision_id uuid;
  admitted_definition_digest text;
  admitted_definition jsonb;
  repository_id uuid;
  model_provider text;
  model_name text;
  creator_user_id uuid;
  admitted_execution_policy_revision_id uuid;
  admitted_delivery_policy_revision_id uuid;
  effective_execution_policy_revision_id uuid;
  approved public.factory_execution_grants;
  machine boolean := p_actor.service_principal_id is not null;
begin
  if nullif(btrim(session_title), '') is null then
    raise exception 'Session title must not be blank' using errcode = '23514';
  end if;

  if nullif(btrim(session_prompt_md), '') is null then
    raise exception 'Session prompt must not be blank' using errcode = '23514';
  end if;

  -- Take the workspace admission fence before the pipeline lock. Publication
  -- takes the same workspace row for no-key-update, so a racing create uses
  -- exactly one complete activation and never waits in pipeline/workspace order.
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  if p_actor.factory_id is not null then
    if p_actor.workspace_id is distinct from target_workspace_id then
      raise exception 'Session creation authority is unavailable.' using errcode = '42501';
    end if;
    perform internal.assert_factory_accepts_work(target_workspace_id, p_actor.factory_id);
  end if;
  if machine then
    if creator_member_id is not null then
      raise exception 'Session creation authority is unavailable.' using errcode = '42501';
    end if;
    -- The temporary permit belongs to this command transaction only.
    perform internal.assert_session_mutation_actor(p_actor, 'create');
  end if;
  select a.factory_id, a.activation_number, a.revision_id, r.canonical_digest, r.definition_json::jsonb
  into admitted_factory_id, admitted_activation_number, admitted_revision_id, admitted_definition_digest, admitted_definition
  from public.factories f
  join public.factory_definition_activations a on (a.workspace_id, a.factory_id) = (f.workspace_id, f.id)
  join public.factory_definition_revisions r on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
  where f.workspace_id = target_workspace_id
    and case when p_actor.factory_id is null then f.is_default else f.id = p_actor.factory_id end
  order by a.activation_number desc
  limit 1;

  if p_expected_definition_digest is not null and admitted_definition_digest is distinct from p_expected_definition_digest then
    raise exception 'The active factory definition changed.' using errcode = 'P0003';
  end if;
  if machine or p_expected_agent_id is not null then
    if admitted_revision_id is null or p_expected_agent_id is null
      or admitted_definition#>>'{implementationAgent,agentId}' is distinct from p_expected_agent_id::text
      or not (admitted_definition ? 'executionGrant' and admitted_definition ? 'credentialBindingId')
      or (admitted_definition->>'repositoryId')::uuid is distinct from session_github_repository_id
      or p_actor.writer_repository_id is distinct from session_github_repository_id then
      raise exception 'The requested writer and named agent must match an active service-backed factory definition.' using errcode = 'PT422';
    end if;
    approved := internal.resolve_definition_execution_grant(target_workspace_id, admitted_factory_id,
      admitted_definition, session_github_repository_id, (admitted_definition->>'executionPolicyRevisionId')::uuid);
    if (approved.id, approved.version) is distinct from (p_actor.grant_id, p_actor.grant_version)
      or (machine and approved.service_principal_id is distinct from p_actor.service_principal_id) then
      raise exception 'The requested factory execution grant is unavailable.' using errcode = '42501';
    end if;
    perform internal.lock_definition_credential_binding(target_workspace_id, admitted_factory_id, admitted_definition,
      approved.id, approved.service_principal_id);
  end if;

  if admitted_revision_id is null then
    if nullif(btrim(agent_model_provider), '') is null
       or nullif(btrim(agent_model_name), '') is null then
      raise exception 'Agent provider and model must not be blank' using errcode = '23514';
    end if;

    if session_github_repository_id is not null
       and not exists (
         select 1
         from public.github_repositories repository
         where repository.id = session_github_repository_id
           and repository.workspace_id = target_workspace_id
           and repository.is_archived = false
       ) then
      raise exception 'Repository is not available for workspace %', target_workspace_id
        using errcode = '42501';
    end if;

    -- Legacy admission still selects from the live Settings pipeline.
    if selected_pipeline_id is null then
      select pipeline.id
      into pinned_pipeline_id
      from public.pipelines pipeline
      where pipeline.workspace_id = target_workspace_id
        and pipeline.is_default = true
      for update;
    else
      select pipeline.id
      into pinned_pipeline_id
      from public.pipelines pipeline
      where pipeline.id = selected_pipeline_id
        and pipeline.workspace_id = target_workspace_id
      for update;
    end if;

    if pinned_pipeline_id is null then
      raise exception 'Workspace has no selected or default pipeline configured'
        using errcode = 'P0002';
    end if;

    if selected_stage_ids is null then
      select array_agg(stage.id order by stage.position)
      into resolved_stage_ids
      from public.pipeline_stages stage
      where stage.pipeline_id = pinned_pipeline_id
        and stage.workspace_id = target_workspace_id
        and stage.archived_at is null;
    else
      if cardinality(selected_stage_ids) = 0 then
        raise exception 'Select at least one pipeline stage'
          using errcode = '22023';
      end if;

      if array_position(selected_stage_ids, null) is not null
         or cardinality(selected_stage_ids) <> (
           select count(distinct stage_id)
           from unnest(selected_stage_ids) as selected(stage_id)
         ) then
        raise exception 'Selected pipeline stages must be unique and non-null'
          using errcode = '22023';
      end if;

      select array_agg(stage.id order by stage.position)
      into resolved_stage_ids
      from public.pipeline_stages stage
      where stage.pipeline_id = pinned_pipeline_id
        and stage.workspace_id = target_workspace_id
        and stage.archived_at is null
        and stage.id = any(selected_stage_ids);

      if coalesce(cardinality(resolved_stage_ids), 0) <> cardinality(selected_stage_ids) then
        raise exception 'Selected pipeline stages changed or do not belong to this pipeline'
          using errcode = 'P0003';
      end if;
    end if;

    if coalesce(cardinality(resolved_stage_ids), 0) = 0 then
      raise exception 'Selected pipeline has no stages configured'
        using errcode = 'P0002';
    end if;
    select stage.slug, stage.name into first_stage_slug, first_stage_name
    from public.pipeline_stages stage where stage.id = resolved_stage_ids[1];
    repository_id := session_github_repository_id;
    model_provider := btrim(agent_model_provider);
    model_name := btrim(agent_model_name);
  else
    select pipeline.id into pinned_pipeline_id
    from public.pipelines pipeline
    where pipeline.id = (admitted_definition ->> 'pipelineId')::uuid
      and pipeline.workspace_id = target_workspace_id for share;
    if not found then
      raise exception 'The factory definition pipeline is unavailable.' using errcode = 'P0002';
    end if;
    resolved_stage_ids := internal.read_factory_definition_stage_ids(
      target_workspace_id, pinned_pipeline_id, admitted_definition
    );
    first_stage_slug := admitted_definition #>> '{stages,0,slug}';
    first_stage_name := admitted_definition #>> '{stages,0,name}';
    repository_id := coalesce(session_github_repository_id, (admitted_definition ->> 'repositoryId')::uuid);
    model_provider := admitted_definition #>> '{agent,provider}';
    model_name := admitted_definition #>> '{agent,model}';
    admitted_execution_policy_revision_id := (admitted_definition ->> 'executionPolicyRevisionId')::uuid;
    admitted_delivery_policy_revision_id := (admitted_definition ->> 'deliveryPolicyRevisionId')::uuid;

    -- A create request can confirm the options it displayed. Validate that
    -- ordered selection against the revision that won the admission fence.
    if not internal.factory_allows_writable_repository(admitted_definition, repository_id)
      or (selected_pipeline_id is not null and selected_pipeline_id is distinct from pinned_pipeline_id)
      or (selected_stage_ids is not null and selected_stage_ids is distinct from resolved_stage_ids) then
      raise exception 'The active factory no longer matches the requested session options.' using errcode = 'P0003';
    end if;

    -- GitHub disconnect can hold these rows while waiting on session locks.
    -- Admission retries the request rather than reversing that lock order.
    begin
      perform installation.id from public.github_installations installation
      where installation.workspace_id = target_workspace_id and not installation.suspended
      for share nowait;
      perform 1 from public.github_repositories repository
      join public.github_installations installation
        on (installation.id, installation.workspace_id) = (repository.github_installation_id, repository.workspace_id)
      where repository.id = repository_id and repository.workspace_id = target_workspace_id
        and repository.factory_id = admitted_factory_id and not repository.is_archived and not installation.suspended
      for share of repository nowait;
      if not found then
        raise exception 'The factory definition repository is unavailable.' using errcode = 'P0002';
      end if;
    exception when lock_not_available then
      raise exception 'Repository access is changing. Retry session creation.' using errcode = 'P0002';
    end;
  end if;

  -- Membership removal takes the pipeline lock before changing the member.
  if not machine then
    select member.user_id into creator_user_id from public.workspace_members member
    where member.id = creator_member_id and member.workspace_id = target_workspace_id
      and member.kind = 'human' and member.is_active for share;
    if not found or (p_actor.member_id is not null and p_actor.member_id is distinct from creator_member_id) then
      raise exception 'Creator is not an active human member of workspace %', target_workspace_id
        using errcode = '42501';
    end if;

    -- Reviewed routing authorizes its selected personal credential in the
    -- admission trigger. Shadow and unreviewed admissions retain the base check.
    if admitted_revision_id is not null and not (admitted_definition ? 'executionGrant') and not exists (
      select 1 from public.factory_routing_activations review
      where (review.workspace_id, review.factory_id, review.activation_number, review.revision_id, review.draft_digest) =
        (target_workspace_id, admitted_factory_id, admitted_activation_number, admitted_revision_id, admitted_definition_digest)
    ) then
      perform internal.assert_current_factory_agent_credential(creator_user_id, model_provider, model_name);
    end if;
  end if;

  insert into internal.workspace_issue_counters as counters (
    workspace_id,
    last_issue_number
  )
  values (target_workspace_id, 1)
  on conflict (workspace_id)
  do update
    set last_issue_number = counters.last_issue_number + 1,
        updated_at = now()
  returning last_issue_number into allocated_number;

  insert into public.sessions (
    workspace_id,
    factory_id,
    number,
    title,
    prompt_md,
    creator_member_id,
    creator_service_principal_id,
    linear_issue_id,
    linear_issue_url,
    pipeline_id,
    current_stage_id,
    phase_status,
    github_repository_id,
    factory_definition_provenance,
    factory_definition_revision_id,
    execute_pinned_definition,
    pinned_delivery_policy_revision_id,
    execution_policy_revision_id
  )
  values (
    target_workspace_id,
    admitted_factory_id,
    allocated_number,
    btrim(session_title),
    btrim(session_prompt_md),
    creator_member_id,
    p_actor.service_principal_id,
    session_linear_issue_id,
    session_linear_issue_url,
    pinned_pipeline_id,
    resolved_stage_ids[1],
    'in_progress',
    repository_id,
    case when admitted_revision_id is null then 'legacy' else 'pinned' end,
    admitted_revision_id,
    admitted_revision_id is not null,
    admitted_delivery_policy_revision_id,
    admitted_execution_policy_revision_id
  )
  returning id, sessions.execution_policy_revision_id into created_session_id, effective_execution_policy_revision_id;

  if admitted_revision_id is not null then
    insert into public.session_factory_admission_inputs (
      session_id, workspace_id, factory_id, activation_number, definition_revision_id,
      definition_digest, pipeline_id, github_repository_id, selected_stage_ids,
      execution_policy_revision_id, model_provider, model_name, title_sha256, prompt_sha256, original_title, original_prompt_md
    ) values (
      created_session_id, target_workspace_id, admitted_factory_id, admitted_activation_number,
      admitted_revision_id, admitted_definition_digest, pinned_pipeline_id, repository_id,
      resolved_stage_ids, effective_execution_policy_revision_id, model_provider, model_name,
      encode(sha256(convert_to(btrim(session_title), 'UTF8')), 'hex'),
      encode(sha256(convert_to(btrim(session_prompt_md), 'UTF8')), 'hex'),
      btrim(session_title), btrim(session_prompt_md)
    );
  end if;

  insert into public.session_selected_stages (session_id, workspace_id, stage_id)
  select created_session_id, target_workspace_id, stage.id
  from public.pipeline_stages stage
  where stage.id = any(resolved_stage_ids);

  insert into public.agent_jobs (
    workspace_id,
    session_id,
    requested_by_member_id,
    stage_id,
    stage_slug,
    stage_name,
    trigger_type,
    status,
    dedupe_key
  )
  values (
    target_workspace_id,
    created_session_id,
    creator_member_id,
    resolved_stage_ids[1],
    first_stage_slug,
    first_stage_name,
    'assignment',
    'queued',
    'session:' || created_session_id::text || ':active'
  )
  returning id into created_job_id;

  insert into public.agent_runs (
    workspace_id,
    session_id,
    agent_job_id,
    triggered_by_member_id,
    stage_id,
    stage_slug,
    stage_name,
    run_type,
    model_provider,
    model_name,
    status
  )
  values (
    target_workspace_id,
    created_session_id,
    created_job_id,
    creator_member_id,
    resolved_stage_ids[1],
    first_stage_slug,
    first_stage_name,
    case when repository_id is null then 'project' else 'code' end,
    model_provider,
    model_name,
    'queued'
  )
  returning id into created_run_id;

  return query
  select
    created_session_id,
    allocated_number,
    workspace.slug,
    created_job_id,
    created_run_id
  from public.workspaces workspace
  where workspace.id = target_workspace_id;
end;
$$;
