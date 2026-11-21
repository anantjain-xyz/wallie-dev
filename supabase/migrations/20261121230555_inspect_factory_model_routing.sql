-- Only callers that load an exact stored definition can pass its policy here.
create function internal.resolve_factory_model_routing_policy(
  policy jsonb, admission public.session_factory_admission_inputs, session_row public.sessions, task_class_slug text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  matching_classes jsonb;
  matching_rules jsonb;
  task_class_id text;
  rule jsonb;
  configuration jsonb;
  constraints jsonb;
  prefix jsonb;
  decision record;
  source text;
  reason text;
  initial_reason text;
begin
  if policy is null then return null; end if;

  if policy->'version' is distinct from '1'::jsonb
    or jsonb_typeof(policy->'taskClasses') is distinct from 'array'
    or jsonb_typeof(policy->'rules') is distinct from 'array' then
    reason := 'invalid_policy';
  else
    select jsonb_agg(entry) into matching_classes
    from jsonb_array_elements(policy->'taskClasses') as classes(entry)
    where entry->>'slug' = task_class_slug;
    if jsonb_array_length(matching_classes) > 1 then
      reason := 'ambiguous_class';
    else
      task_class_id := matching_classes->0->>'id';
      select jsonb_agg(entry) into matching_rules
      from jsonb_array_elements(policy->'rules') as rules(entry)
      where entry->>'taskClassId' = task_class_id;
      if jsonb_array_length(matching_rules) > 1 then
        reason := 'ambiguous_rule';
      else
        rule := matching_rules->0;
      end if;
    end if;
  end if;
  prefix := jsonb_build_object('version', 1, 'taskClassSlug', task_class_slug,
    'taskClassId', task_class_id, 'ruleId', rule->>'id');

  if reason is null and rule is null then
    reason := case when task_class_id is null then 'unmatched_class' else 'no_rule' end;
    if policy#>>'{onUnmatched,kind}' = 'fallback' then
      configuration := policy#>'{onUnmatched,configuration}';
      constraints := policy#>'{onUnmatched,constraints}';
      source := 'unmatched_fallback';
      initial_reason := reason;
    end if;
  elsif reason is null then
    configuration := rule->'configuration';
    constraints := rule->'constraints';
    source := 'primary';
  end if;

  if configuration is not null then
    select * into decision from internal.check_factory_model_routing_target(admission, session_row, configuration, constraints);
    reason := decision.reason;
    if reason is not null and source = 'primary' and rule#>>'{onUnavailable,kind}' = 'fallback' then
      initial_reason := reason;
      configuration := rule#>'{onUnavailable,configuration}';
      source := 'rule_fallback';
      select * into decision from internal.check_factory_model_routing_target(admission, session_row, configuration, constraints);
      reason := decision.reason;
    end if;
    if reason is null then
      return prefix || jsonb_build_object('disposition', 'selected', 'source', source, 'reason', 'qualified',
        'configuration', configuration, 'benchmarkCandidateKey', decision.benchmark_candidate_key,
        'initialReason', initial_reason);
    end if;
  end if;
  return prefix || jsonb_build_object('disposition', 'escalated', 'source', null, 'reason', coalesce(reason, 'invalid_policy'),
    'configuration', null, 'benchmarkCandidateKey', null, 'initialReason', initial_reason);
end;
$$;
revoke all on function internal.resolve_factory_model_routing_policy(
  jsonb, public.session_factory_admission_inputs, public.sessions, text
) from public, anon, authenticated, service_role;

create or replace function internal.resolve_factory_model_routing(
  admission public.session_factory_admission_inputs, session_row public.sessions, task_class_slug text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  policy jsonb;
  resolved jsonb;
begin
  select revision.definition_json::jsonb->'modelRouting' into policy
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
    (admission.workspace_id, admission.factory_id, admission.definition_revision_id, admission.definition_digest);
  resolved := internal.resolve_factory_model_routing_policy(policy, admission, session_row, task_class_slug);
  return resolved || jsonb_build_object('mode', 'shadow', 'policyRevisionId', admission.definition_revision_id,
    'policyDigest', admission.definition_digest);
end;
$$;

create function public.preview_factory_model_routing(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_expected_activation_number bigint, p_draft_id uuid, p_task_class_slug text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid;
  draft public.factory_definition_drafts;
  definition jsonb;
  preview public.session_factory_admission_inputs;
  execution_grant public.factory_execution_grants;
  resolved jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_draft_id is null or (p_task_class_slug is not null and
    (length(p_task_class_slug) > 64 or p_task_class_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$')) then
    raise exception 'Select a saved definition and valid routing task class.' using errcode = '22023';
  end if;
  perform internal.lock_factory_definition_head(
    p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  if internal.latest_factory_draft_id(p_workspace_id, p_factory_id, p_expected_activation_number) is distinct from p_draft_id then
    raise exception 'The factory draft changed. Reload before previewing.' using errcode = 'PT409';
  end if;
  begin
    select member.id into actor_id from public.workspace_members member
    where (member.workspace_id, member.user_id) = (p_workspace_id, p_actor_user_id)
      and member.kind = 'human' and member.is_active and member.role in ('owner', 'admin') for share nowait;
    if not found then raise exception 'Active workspace manager required.' using errcode = '42501'; end if;
  exception when lock_not_available then
    raise exception 'Factory manager access is changing. Retry shortly.' using errcode = 'PT409';
  end;
  select * into strict draft from public.factory_definition_drafts saved
  where (saved.workspace_id, saved.factory_id, saved.id) = (p_workspace_id, p_factory_id, p_draft_id);
  definition := draft.definition_json::jsonb;
  if definition ? 'modelRouting' then
    preview.workspace_id := draft.workspace_id;
    preview.factory_id := draft.factory_id;
    preview.github_repository_id := (definition->>'repositoryId')::uuid;
    preview.execution_policy_revision_id := (definition->>'executionPolicyRevisionId')::uuid;
    if definition ? 'executionGrant' then
      -- Keep the declared grant on the preview even when it cannot resolve. The
      -- same target check will report unavailable authority without using personal credentials.
      preview.execution_grant_id := (definition#>>'{executionGrant,id}')::uuid;
      preview.execution_grant_version := (definition#>>'{executionGrant,version}')::bigint;
      begin
        execution_grant := internal.resolve_definition_execution_grant(draft.workspace_id, draft.factory_id,
          definition, preview.github_repository_id, preview.execution_policy_revision_id);
        perform internal.assert_factory_grant_invoker(draft.workspace_id, draft.factory_id, actor_id);
        perform internal.lock_definition_credential_binding(draft.workspace_id, draft.factory_id, definition,
          execution_grant.id, execution_grant.service_principal_id);
        preview.credential_owner_service_principal_id := execution_grant.service_principal_id;
      exception when sqlstate '42501' or sqlstate 'PT409' or sqlstate 'PT422' then
        preview.credential_owner_service_principal_id := null;
      end;
    else
      preview.credential_owner_member_id := actor_id;
    end if;
    resolved := internal.resolve_factory_model_routing_policy(
      definition->'modelRouting', preview, null::public.sessions, p_task_class_slug);
  end if;
  return jsonb_build_object('draftId', draft.id, 'draftDigest', draft.canonical_digest, 'decision', resolved);
end;
$$;
revoke all on function public.preview_factory_model_routing(uuid, uuid, uuid, bigint, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.preview_factory_model_routing(uuid, uuid, uuid, bigint, uuid, text) to service_role;

alter table public.factory_definition_drafts add column routing_evidence_source_draft_id uuid,
  add constraint factory_definition_drafts_routing_evidence_source_fk
  foreign key (workspace_id, factory_id, routing_evidence_source_draft_id)
  references public.factory_routing_draft_evidence(workspace_id, factory_id, draft_id)
  deferrable initially deferred;
create index factory_definition_drafts_routing_evidence_source_idx
  on public.factory_definition_drafts(workspace_id, factory_id, routing_evidence_source_draft_id)
  where routing_evidence_source_draft_id is not null;
comment on column public.factory_definition_drafts.routing_evidence_source_draft_id is
  'Original benchmark proposal carried by an equivalent routing rule in the preceding draft or published base.';

create function internal.inherit_factory_routing_draft_evidence()
returns trigger language plpgsql set search_path = '' as $$
declare
  previous_draft_id uuid;
  previous_draft public.factory_definition_drafts;
  proposal public.factory_routing_draft_evidence;
  previous_definition jsonb;
  definition jsonb := new.definition_json::jsonb;
  rule_matches jsonb;
begin
  new.routing_evidence_source_draft_id := null;
  if jsonb_typeof(definition#>'{modelRouting,rules}') is distinct from 'array'
    or jsonb_typeof(definition#>'{modelRouting,taskClasses}') is distinct from 'array' then
    return new;
  end if;
  previous_draft_id := internal.latest_factory_draft_id(new.workspace_id, new.factory_id,
    coalesce(new.base_activation_number, 0));
  if previous_draft_id is null and new.base_activation_number is not null then
    select revision.source_draft_id, revision.definition_json::jsonb into previous_draft_id, previous_definition
    from public.factory_definition_activations activation
    join public.factory_definition_revisions revision
      on (revision.workspace_id, revision.factory_id, revision.id) =
         (activation.workspace_id, activation.factory_id, activation.revision_id)
    where (activation.workspace_id, activation.factory_id, activation.activation_number) =
      (new.workspace_id, new.factory_id, new.base_activation_number);
  end if;
  select * into previous_draft from public.factory_definition_drafts previous
  where (previous.workspace_id, previous.factory_id, previous.id) = (new.workspace_id, new.factory_id, previous_draft_id);
  if not found then return new; end if;
  select * into proposal from public.factory_routing_draft_evidence evidence
  where (evidence.workspace_id, evidence.factory_id) = (previous_draft.workspace_id, previous_draft.factory_id)
    and evidence.draft_id in (previous_draft.id, previous_draft.routing_evidence_source_draft_id)
  order by (evidence.draft_id = previous_draft.id) desc limit 1;
  if not found then return new; end if;

  previous_definition := coalesce(previous_definition, previous_draft.definition_json::jsonb);
  if (previous_definition->'repositoryId', previous_definition->'pipelineId') is distinct from
    (definition->'repositoryId', definition->'pipelineId') then
    return new;
  end if;
  -- Evidence qualifies the primary configuration and constraints. A display
  -- name or the response to an unavailable primary can change independently.
  select jsonb_agg(exact.match) into rule_matches
  from (values (previous_definition), (definition)) policy(body)
  cross join lateral (
    select (jsonb_agg(jsonb_build_object('rule', rule.value - 'onUnavailable', 'classSlug', task_class.value->>'slug')))->0 as match
    from jsonb_array_elements(case when jsonb_typeof(policy.body#>'{modelRouting,rules}') = 'array'
      then policy.body#>'{modelRouting,rules}' else '[]'::jsonb end) rule(value)
    join jsonb_array_elements(case when jsonb_typeof(policy.body#>'{modelRouting,taskClasses}') = 'array'
      then policy.body#>'{modelRouting,taskClasses}' else '[]'::jsonb end) task_class(value)
      on task_class.value->>'id' = rule.value->>'taskClassId'
    where rule.value->>'id' = proposal.evidence->>'ruleId'
      and rule.value#>>'{configuration,experimentId}' = proposal.experiment_id::text
      and rule.value->'constraints' = proposal.evidence->'constraints'
      and task_class.value->>'slug' is not null
    having count(*) = 1
  ) exact;
  if jsonb_array_length(rule_matches) = 2 and rule_matches->0 = rule_matches->1 then
    new.routing_evidence_source_draft_id := proposal.draft_id;
  end if;
  return new;
end;
$$;
revoke all on function internal.inherit_factory_routing_draft_evidence() from public, anon, authenticated, service_role;
create trigger inherit_factory_routing_draft_evidence before insert on public.factory_definition_drafts
  for each row execute function internal.inherit_factory_routing_draft_evidence();

create function internal.get_run_routing_decision(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  with recorded as (
    select admission.workspace_id, admission.factory_id, admission.routing_decision as decision,
      revision.source_draft_id, draft.routing_evidence_source_draft_id,
      revision.definition_json::jsonb->'modelRouting' as policy,
      internal.can_manage_factory(admission.workspace_id, admission.factory_id) as can_manage_factory
    from public.session_attempt_manifests manifest
    join public.agent_runs run
      on (run.workspace_id, run.session_id, run.id, run.agent_job_id, run.attempt_count, run.stage_id) =
         (manifest.workspace_id, manifest.session_id, manifest.run_id, manifest.job_id, manifest.attempt_count, manifest.stage_id)
    join public.sessions owner on (owner.workspace_id, owner.id) = (run.workspace_id, run.session_id)
    join public.session_factory_admission_inputs admission
      on (admission.workspace_id, admission.factory_id, admission.session_id, admission.definition_revision_id, admission.definition_digest) =
         (manifest.workspace_id, owner.factory_id, manifest.routing_decision_session_id, manifest.definition_revision_id, manifest.definition_digest)
    join public.factory_definition_revisions revision
      on (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
         (admission.workspace_id, admission.factory_id, admission.definition_revision_id, admission.definition_digest)
    left join public.factory_definition_drafts draft
      on (draft.workspace_id, draft.factory_id, draft.id) =
         (revision.workspace_id, revision.factory_id, revision.source_draft_id)
    where manifest.workspace_id = target_workspace_id and manifest.run_id = target_run_id
      and manifest.attempt_count = target_attempt_count and admission.routing_decision is not null
      and auth.uid() is not null and internal.can_access_session(owner.id)
  )
  select jsonb_build_object('factoryId', history.factory_id, 'canManageFactory', history.can_manage_factory,
    'decision', history.decision, 'taskClassName', (
      select task_class.value->>'name'
      from jsonb_array_elements(case when jsonb_typeof(history.policy->'taskClasses') = 'array'
        then history.policy->'taskClasses' else '[]'::jsonb end) task_class(value)
      where task_class.value->>'id' = history.decision->>'taskClassId'
      limit 1
    ), 'benchmarkEvidence', case when history.can_manage_factory and history.decision->>'source' = 'primary' then (
      select receipt.evidence from public.factory_routing_draft_evidence receipt
      where (receipt.workspace_id, receipt.factory_id, receipt.draft_id) =
        (history.workspace_id, history.factory_id, coalesce((
          select direct.draft_id from public.factory_routing_draft_evidence direct
          where (direct.workspace_id, direct.factory_id, direct.draft_id) =
            (history.workspace_id, history.factory_id, history.source_draft_id)
        ), history.routing_evidence_source_draft_id))
        and receipt.experiment_id::text = history.decision#>>'{configuration,experimentId}'
        and receipt.candidate_key = history.decision->>'benchmarkCandidateKey'
        and receipt.evidence->>'ruleId' = history.decision->>'ruleId'
        and receipt.evidence->>'scorerRevisionId' = history.decision#>>'{configuration,scorerRevisionId}'
        and exists (
          select 1 from jsonb_array_elements(history.policy->'rules') rule(value)
          where rule.value->>'id' = history.decision->>'ruleId'
            and rule.value->'constraints' = receipt.evidence->'constraints'
            and rule.value->'configuration' = history.decision->'configuration'
        )
    ) end)
  from recorded history
$$;
revoke all on function internal.get_run_routing_decision(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function internal.get_run_routing_decision(uuid, uuid, integer) to authenticated;

create function public.get_run_routing_decision(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_run_routing_decision(target_workspace_id, target_run_id, target_attempt_count)
$$;
revoke all on function public.get_run_routing_decision(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_run_routing_decision(uuid, uuid, integer) to authenticated;
