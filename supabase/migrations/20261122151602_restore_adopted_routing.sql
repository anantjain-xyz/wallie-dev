-- Restore either reviewed routing provenance through the existing activation and rollback receipt.
create or replace function public.rollback_factory_routing_activation(
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
    -- An adoption source already binds this reviewed revision and digest.
    -- Both provenance paths still revalidate every retained target below.
    if prior_review.source_improvement_adoption_id is null then
      select * into evidence from public.factory_routing_draft_evidence receipt
      where (receipt.workspace_id,receipt.factory_id,receipt.draft_id) =
        (p_workspace_id,p_factory_id,prior_review.benchmark_evidence_draft_id);
      if not found then raise exception 'The prior reviewed activation lacks its exact benchmark evidence.' using errcode = 'PT422'; end if;
      perform internal.qualify_factory_routing_draft(p_workspace_id,p_factory_id,p_actor_user_id,
        evidence.experiment_id,evidence.candidate_key,(evidence.evidence#>>'{suite,revisionId}')::uuid,
        (evidence.evidence->>'scorerRevisionId')::uuid,workflow,(evidence.evidence->>'ruleId')::uuid);
    end if;
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
      source_improvement_adoption_id,reviewed_by_member_id,reviewed_targets)
    values (p_workspace_id,p_factory_id,restored.activation_number,restored.revision_id,
      head.activation_number,head.revision_id,prior_review.draft_id,prior_review.draft_digest,
      prior_review.benchmark_evidence_draft_id,prior_review.source_improvement_adoption_id,reviewer,restored_targets);
  end if;
  insert into public.factory_routing_rollbacks(workspace_id,factory_id,activation_number,previous_activation_number,
    target_activation_number,target_revision_id,restored_mode,actor_member_id)
  values (p_workspace_id,p_factory_id,restored.activation_number,head.activation_number,baseline.activation_number,
    baseline.revision_id,case when restoring_reviewed then 'reviewed' else 'shadow' end,reviewer);
  return restored;
end;
$$;
