-- Keep the proof of each reviewed activation on the row used by admission.
-- An adoption can also be the source of a later restoration of its revision.
alter table internal.factory_improvement_adoptions
  add constraint factory_improvement_adoptions_routing_source_key
  unique (workspace_id,factory_id,id,adopted_revision_id,adopted_digest);

alter table public.factory_routing_activations
  alter column draft_id drop not null,
  alter column benchmark_evidence_draft_id drop not null,
  add column source_improvement_adoption_id uuid,
  add constraint factory_routing_activation_provenance_check check (
    (source_improvement_adoption_id is null and draft_id is not null and benchmark_evidence_draft_id is not null)
    or (source_improvement_adoption_id is not null and draft_id is null and benchmark_evidence_draft_id is null)
  ),
  add constraint factory_routing_activation_improvement_source_fk
    foreign key (workspace_id,factory_id,source_improvement_adoption_id,revision_id,draft_digest)
    references internal.factory_improvement_adoptions(workspace_id,factory_id,id,adopted_revision_id,adopted_digest)
    deferrable initially deferred;
create index factory_routing_activations_improvement_source_idx
  on public.factory_routing_activations(workspace_id,factory_id,source_improvement_adoption_id)
  where source_improvement_adoption_id is not null;

create function internal.record_factory_improvement_routing(
  adoption internal.factory_improvement_adoptions, p_actor_user_id uuid,
  p_baseline jsonb, p_candidate jsonb, p_edits jsonb
) returns void language plpgsql set search_path = '' as $$
declare
  prior_review public.factory_routing_activations;
  prospective public.session_factory_admission_inputs;
  execution_grant public.factory_execution_grants;
  target record;
  checked record;
  baseline_targets jsonb;
  adopted_targets jsonb := '[]'::jsonb;
  suite_revision_id uuid;
  scorer_revision_id uuid;
  qualification_definition jsonb;
  rule_index text;
begin
  if exists (
    select 1 from public.factory_routing_canaries canary
    where (canary.workspace_id,canary.factory_id,canary.activation_number) =
      (adoption.workspace_id,adoption.factory_id,adoption.baseline_activation_number)
  ) then
    raise exception 'Resolve the active routing canary before adopting an improvement.' using errcode = 'PT409';
  end if;
  select * into prior_review from public.factory_routing_activations reviewed
  where (reviewed.workspace_id,reviewed.factory_id,reviewed.activation_number,reviewed.revision_id,reviewed.draft_digest) =
    (adoption.workspace_id,adoption.factory_id,adoption.baseline_activation_number,adoption.baseline_revision_id,adoption.baseline_digest);
  -- A saved routing policy without reviewed activation still runs in shadow.
  if not found then return; end if;

  select coalesce(jsonb_agg(jsonb_build_object('ruleId', option.rule_id, 'target', option.target,
    'configuration', option.configuration)), '[]'::jsonb) into baseline_targets
  from internal.factory_routing_policy_targets(p_baseline->'modelRouting') option;
  if jsonb_array_length(baseline_targets) = 0
    or jsonb_array_length(baseline_targets) <> jsonb_array_length(prior_review.reviewed_targets)
    or not (baseline_targets @> prior_review.reviewed_targets and prior_review.reviewed_targets @> baseline_targets) then
    raise exception 'The active configuration differs from its reviewed routing targets.' using errcode = 'PT409';
  end if;

  prospective.workspace_id := adoption.workspace_id;
  prospective.factory_id := adoption.factory_id;
  prospective.github_repository_id := (p_candidate->>'repositoryId')::uuid;
  prospective.execution_policy_revision_id := (p_candidate->>'executionPolicyRevisionId')::uuid;
  if p_candidate ? 'executionGrant' then
    execution_grant := internal.resolve_definition_execution_grant(adoption.workspace_id,adoption.factory_id,p_candidate,
      prospective.github_repository_id,prospective.execution_policy_revision_id);
    prospective.execution_grant_id := execution_grant.id;
    prospective.execution_grant_version := execution_grant.version;
    prospective.credential_owner_service_principal_id := execution_grant.service_principal_id;
  else
    prospective.credential_owner_member_id := adoption.actor_member_id;
  end if;

  for target in
    select proposed.*, previous.configuration as previous_configuration,
      previous.task_class_id as previous_task_class_id, previous.constraints as previous_constraints
    from internal.factory_routing_policy_targets(p_candidate->'modelRouting') proposed
    left join internal.factory_routing_policy_targets(p_baseline->'modelRouting') previous
      on proposed.rule_id is not distinct from previous.rule_id and proposed.target = previous.target
    order by proposed.rule_id, proposed.target
  loop
    if target.previous_configuration is null
      or (target.task_class_id,target.constraints) is distinct from (target.previous_task_class_id,target.previous_constraints) then
      raise exception 'Adoption must preserve the reviewed routing policy scope.' using errcode = 'PT422';
    end if;
    perform internal.assert_current_reviewed_routing_evidence(adoption.workspace_id,adoption.factory_id,target.configuration);
    select * into checked from internal.check_factory_model_routing_target(prospective,null::public.sessions,
      target.configuration,target.constraints);
    if checked.reason is not null or checked.benchmark_candidate_key is null then
      raise exception 'The reviewed routing target is unavailable (%)',coalesce(checked.reason,'configuration_unavailable')
        using errcode = 'PT422';
    end if;
    perform internal.make_factory_routing_execution(prospective,p_candidate,target.configuration,checked.benchmark_candidate_key);
    if target.configuration is distinct from target.previous_configuration then
      if target.target <> 'primary' or not exists (
        select 1 from jsonb_array_elements(p_edits) edit(value)
        where (edit.value->>'kind',edit.value->>'ruleId',edit.value->'from',edit.value->'to') =
          ('routing_target',target.rule_id,target.previous_configuration,target.configuration)
      ) then
        raise exception 'A changed routing target requires the exact reviewed improvement edit.' using errcode = 'PT422';
      end if;
      select experiment.suite_revision_id,dimension.scorer_revision_id into strict suite_revision_id,scorer_revision_id
      from public.factory_benchmark_experiments experiment
      join public.factory_benchmark_evaluation_dimensions dimension
        on (dimension.workspace_id,dimension.factory_id,dimension.experiment_id) =
          (experiment.workspace_id,experiment.factory_id,experiment.id)
      where (experiment.workspace_id,experiment.factory_id,experiment.id) =
        (adoption.workspace_id,adoption.factory_id,(target.configuration->>'experimentId')::uuid)
        and (target.configuration->>'scorerRevisionId' is null
          or dimension.scorer_revision_id::text = target.configuration->>'scorerRevisionId');
      qualification_definition := p_candidate;
      if target.configuration->>'scorerRevisionId' is null then
        -- A target with an omitted scorer resolves to the single dimension
        -- checked above. The M09 qualifier expects that ID in its input.
        select (rule.position - 1)::text into strict rule_index
        from jsonb_array_elements(p_candidate#>'{modelRouting,rules}') with ordinality rule(value,position)
        where rule.value->>'id' = target.rule_id;
        qualification_definition := jsonb_set(p_candidate,
          array['modelRouting','rules',rule_index,'configuration','scorerRevisionId'],to_jsonb(scorer_revision_id));
      end if;
      perform internal.qualify_factory_routing_draft(adoption.workspace_id,adoption.factory_id,p_actor_user_id,
        (target.configuration->>'experimentId')::uuid,checked.benchmark_candidate_key,suite_revision_id,
        scorer_revision_id,qualification_definition,target.rule_id::uuid);
    end if;
    adopted_targets := adopted_targets || jsonb_build_array(jsonb_build_object(
      'ruleId',target.rule_id,'target',target.target,'configuration',target.configuration));
  end loop;
  if jsonb_array_length(adopted_targets) <> jsonb_array_length(baseline_targets) then
    raise exception 'Adoption must retain every reviewed routing choice.' using errcode = 'PT422';
  end if;

  insert into public.factory_routing_activations(workspace_id,factory_id,activation_number,revision_id,
    previous_activation_number,previous_revision_id,draft_digest,source_improvement_adoption_id,
    reviewed_by_member_id,reviewed_targets)
  values(adoption.workspace_id,adoption.factory_id,adoption.activation_number,adoption.adopted_revision_id,
    adoption.baseline_activation_number,adoption.baseline_revision_id,adoption.adopted_digest,adoption.id,
    adoption.actor_member_id,adopted_targets);
end;
$$;
revoke all on function internal.record_factory_improvement_routing(
  internal.factory_improvement_adoptions,uuid,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;

-- Report current target qualification for either provenance using the same read contract.
create or replace function internal.get_factory_routing_qualification_status(
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
  has_improvement_evidence boolean := false;
  reasons text[] := '{}';
  targets jsonb;
  baseline jsonb;
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
    where (review.workspace_id,review.factory_id,review.activation_number,review.revision_id,review.draft_digest) =
      (p_workspace_id,p_factory_id,activation.activation_number,revision.id,revision.canonical_digest);
    evidence_id := reviewed.benchmark_evidence_draft_id;
    has_improvement_evidence := reviewed.source_improvement_adoption_id is not null;
    if evidence_id is null and not has_improvement_evidence then
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
  if evidence_id is null and not has_improvement_evidence then reasons := array['missing_proposal']; end if;
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

  -- A reviewed control can carry different qualified evidence from the
  -- candidate. A shadow control has no reviewed routing to qualify.
  select internal.get_factory_routing_qualification_status(p_workspace_id,p_factory_id,
    canary.baseline_activation_number,null) into baseline
  from public.factory_routing_canaries canary
  join public.factory_routing_activations control
    on (control.workspace_id,control.factory_id,control.activation_number,control.revision_id) =
       (canary.workspace_id,canary.factory_id,canary.baseline_activation_number,canary.baseline_revision_id)
  join public.factory_definition_revisions control_revision
    on (control_revision.workspace_id,control_revision.factory_id,control_revision.id,control_revision.canonical_digest) =
       (control.workspace_id,control.factory_id,control.revision_id,control.draft_digest)
  where (canary.workspace_id,canary.factory_id,canary.activation_number,canary.candidate_revision_id) =
    (p_workspace_id,p_factory_id,activation.activation_number,revision.id);
  return jsonb_build_object('activationNumber',activation.activation_number,'draftId',draft.id,'revisionId',revision.id,
    'definitionDigest',definition_digest,'status',case when cardinality(reasons)=0 and baseline->>'status' is distinct from 'stale'
      then 'current' else 'stale' end,'reasons',reasons,'targets',targets)
    || case when baseline is null then '{}'::jsonb else jsonb_build_object('baseline',jsonb_build_object(
      'activationNumber',baseline->'activationNumber','revisionId',baseline->'revisionId',
      'status',baseline->'status','reasons',baseline->'reasons')) end;
end;
$$;
