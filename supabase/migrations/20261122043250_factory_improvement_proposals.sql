-- Improvement proposals hold immutable author intent and inactive candidate
-- revisions. Benchmarks and publishing bind to the exact revision IDs below.
-- Definition references defer until commit so workspace teardown can cascade
-- through definition and proposal history in either order.
create table internal.factory_improvement_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  diagnosis_id uuid not null,
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table internal.factory_improvement_proposal_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  proposal_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  previous_revision_id uuid,
  base_activation_number bigint not null check (base_activation_number > 0),
  base_revision_id uuid not null,
  base_digest text not null check (base_digest ~ '^[a-f0-9]{64}$'),
  request_id uuid not null,
  author_member_id uuid not null,
  intent jsonb not null,
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  cited_member_ids uuid[] not null check (cardinality(cited_member_ids) between 1 and 12),
  candidate_revision_id uuid unique,
  candidate_digest text check (candidate_digest ~ '^[a-f0-9]{64}$'),
  diff jsonb,
  diagnostics jsonb not null check (jsonb_typeof(diagnostics) = 'array'),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, proposal_id, id),
  unique (workspace_id, factory_id, proposal_id, revision_number),
  unique (workspace_id, factory_id, request_id),
  foreign key (workspace_id, factory_id, proposal_id)
    references internal.factory_improvement_proposals(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, proposal_id, previous_revision_id)
    references internal.factory_improvement_proposal_revisions(workspace_id, factory_id, proposal_id, id),
  foreign key (workspace_id, factory_id, base_activation_number)
    references public.factory_definition_activations(workspace_id, factory_id, activation_number) deferrable initially deferred,
  foreign key (workspace_id, factory_id, base_revision_id)
    references public.factory_definition_revisions(workspace_id, factory_id, id) deferrable initially deferred,
  foreign key (workspace_id, factory_id, candidate_revision_id)
    references public.factory_definition_revisions(workspace_id, factory_id, id) deferrable initially deferred,
  check ((revision_number = 1) = (previous_revision_id is null)),
  check ((candidate_revision_id is not null and candidate_digest is not null and diff is not null and diagnostics = '[]')
    or (candidate_revision_id is null and candidate_digest is null and diff is null and diagnostics <> '[]'))
);
create index factory_improvement_proposal_predecessor_idx
  on internal.factory_improvement_proposal_revisions(workspace_id, factory_id, proposal_id, previous_revision_id)
  where previous_revision_id is not null;

create index factory_improvement_proposal_revision_base_idx
  on internal.factory_improvement_proposal_revisions(workspace_id, factory_id, base_activation_number);
create index factory_improvement_proposal_revision_definition_idx
  on internal.factory_improvement_proposal_revisions(workspace_id, factory_id, base_revision_id);

alter table internal.factory_improvement_proposals enable row level security;
alter table internal.factory_improvement_proposal_revisions enable row level security;
revoke all on internal.factory_improvement_proposals, internal.factory_improvement_proposal_revisions
  from public, anon, authenticated, service_role;

create function internal.preserve_factory_improvement_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factories factory
    where (factory.workspace_id, factory.id) = (old.workspace_id, old.factory_id)
  ) then return old; end if;
  raise exception 'Factory improvement history is immutable.' using errcode = '23514';
end;
$$;
create trigger preserve_factory_improvement_proposals before update or delete on internal.factory_improvement_proposals
  for each row execute function internal.preserve_factory_improvement_history();
create trigger preserve_factory_improvement_proposal_revisions
  before update or delete on internal.factory_improvement_proposal_revisions
  for each row execute function internal.preserve_factory_improvement_history();

create function internal.current_factory_improvement_base(p_workspace_id uuid, p_factory_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('activationNumber', active.activation_number,
    'revisionId', definition.id, 'digest', definition.canonical_digest)
  from public.factory_definition_activations active
  join public.factory_definition_revisions definition
    on (definition.workspace_id, definition.factory_id, definition.id) =
       (active.workspace_id, active.factory_id, active.revision_id)
  where (active.workspace_id, active.factory_id) = (p_workspace_id, p_factory_id)
  order by active.activation_number desc limit 1;
$$;

create function internal.project_factory_improvement_revision(revision internal.factory_improvement_proposal_revisions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('proposalId', proposal.id, 'revisionId', revision.id,
    'revisionNumber', revision.revision_number, 'previousRevisionId', revision.previous_revision_id,
    'requestId', revision.request_id, 'diagnosisId', proposal.diagnosis_id,
    'base', revision.intent->'base', 'baseCurrent', coalesce(revision.intent->'base' =
      internal.current_factory_improvement_base(proposal.workspace_id, proposal.factory_id), false),
    'rationale', revision.intent->'rationale', 'expectedBenefit', revision.intent->'expectedBenefit',
    'regressionRisks', revision.intent->'regressionRisks', 'edits', revision.intent->'edits',
    'status', case when candidate.id is null then 'invalid' else 'compiled' end,
    'candidate', case when candidate.id is not null then jsonb_build_object('revisionId', candidate.id,
      'digest', candidate.canonical_digest, 'definitionJson', candidate.definition_json) end,
    'diff', revision.diff, 'diagnostics', revision.diagnostics,
    'createdAt', revision.created_at, 'authorMemberId', revision.author_member_id)
  from internal.factory_improvement_proposals proposal
  left join public.factory_definition_revisions candidate
    on (candidate.workspace_id, candidate.factory_id, candidate.id) =
       (revision.workspace_id, revision.factory_id, revision.candidate_revision_id)
  where (proposal.workspace_id, proposal.factory_id, proposal.id) =
    (revision.workspace_id, revision.factory_id, revision.proposal_id);
$$;

create function internal.factory_improvement_cited_members(diagnosis internal.factory_diagnoses)
returns uuid[] language sql stable set search_path = '' as $$
  select array(select distinct cited.id::uuid from jsonb_array_elements(diagnosis.result->'claims') claim(value)
    cross join lateral jsonb_array_elements_text(claim.value->'member_ids') cited(id)
    where cited.id::uuid = any(diagnosis.member_ids) order by cited.id::uuid);
$$;

create function internal.factory_improvement_edit_grant(diagnosis internal.factory_diagnoses, p_members uuid[])
returns jsonb language sql stable set search_path = '' as $$
  with cited as materialized (
    select coalesce(manifest.stage_id, run.stage_id)::text as stage_id, cohort.agent_id::text as agent_id,
      manifest.definition_skill_ids as skill_ids, member.scorer_revision_id::text as scorer_id,
      case when manifest.routing_decision_session_id is not null
        and admission.routing_decision->>'source' = 'primary'
        and admission.routing_decision->'configuration' = routed.receipt->'configuration'
        and routed.receipt#>>'{configuration,definitionRevisionId}' = member.execution_revision_id::text
        then admission.routing_decision->>'ruleId' end as rule_id
    from internal.factory_failure_cohorts cohort
    cross join lateral internal.visible_factory_failure_cohort_members(cohort) member
    join public.agent_runs run on (run.workspace_id, run.session_id, run.id) =
      (member.workspace_id, member.session_id, member.run_id)
    left join public.session_attempt_manifests manifest on
      (manifest.workspace_id, manifest.run_id, manifest.session_id, manifest.attempt_count) =
      (member.workspace_id, member.run_id, member.session_id, member.run_attempt_count)
    left join public.session_factory_admission_inputs admission on
      (admission.workspace_id, admission.factory_id, admission.session_id) =
      (member.workspace_id, member.factory_id, manifest.routing_decision_session_id)
    left join lateral (
      select internal.effective_factory_routing_execution(member.workspace_id, member.factory_id, member.session_id) as receipt
    ) routed on manifest.routing_decision_session_id is not null
    where (cohort.workspace_id, cohort.factory_id, cohort.id) = (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.cohort_id)
      and member.id = any(p_members)
  )
  select jsonb_build_object(
    'stageIds', array(select distinct stage_id from cited where stage_id is not null order by stage_id),
    'agentIds', array(select distinct agent_id from cited order by agent_id),
    'skillRevisionIds', array(select distinct id from cited cross join lateral unnest(skill_ids) skill(id) order by id),
    'scorerRevisionIds', array(select distinct scorer_id from cited where scorer_id is not null order by scorer_id),
    'routingRuleIds', array(select distinct rule_id from cited where rule_id is not null order by rule_id));
$$;

-- Expiry and session erasure already take this workspace fence. Direct
-- service-role validation marker inserts must participate before they hide evidence.
create function internal.lock_validation_withholding_workspace()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform workspace.id from public.session_validation_assets asset
  join public.workspaces workspace on workspace.id = asset.workspace_id
  where asset.id = new.asset_id for no key update of workspace;
  if not found then
    raise exception 'Validation evidence asset is unavailable.' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger lock_validation_withholding_workspace before insert on public.session_validation_asset_withholdings
  for each row execute function internal.lock_validation_withholding_workspace();

-- Scorer code-diff availability also depends on mutable GitHub metadata when
-- the checkpoint changed. Lock installation before repository, like definition
-- activation, and retry instead of waiting while holding the workspace fence.
create function internal.lock_factory_improvement_source_repositories(diagnosis internal.factory_diagnoses)
returns void language plpgsql set search_path = '' as $$
declare
  repository_ids uuid[];
  installation_ids uuid[];
  locked_count integer;
begin
  select array_agg(distinct checkpoint.repository_id) into repository_ids
  from internal.factory_failure_cohort_members member
  join public.factory_evaluation_receipts receipt on
    (receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.run_id, receipt.attempt_id,
     receipt.job_id, receipt.scorer_revision_id, receipt.target_commit_sha) =
    (member.workspace_id, member.factory_id, member.session_id, member.run_id, member.evaluation_attempt_id,
     member.evaluation_job_id, member.scorer_revision_id, member.target_commit_sha)
  join public.session_git_checkpoints checkpoint on
    (checkpoint.workspace_id, checkpoint.session_id, checkpoint.run_id, checkpoint.output_sha) =
    (member.workspace_id, member.session_id, member.run_id, member.target_commit_sha)
  where (member.workspace_id, member.factory_id, member.cohort_id) =
    (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.cohort_id)
    and member.id = any(diagnosis.member_ids) and member.source_kind = 'scorer'
    and checkpoint.input_sha <> checkpoint.output_sha
    and receipt.result->'evidence' @> jsonb_build_array(jsonb_build_object('kind','code_diff','id',checkpoint.run_id));
  if repository_ids is null then return; end if;

  select coalesce(array_agg(distinct repository.github_installation_id), '{}') into installation_ids
  from public.github_repositories repository
  where (repository.workspace_id, repository.factory_id) = (diagnosis.workspace_id, diagnosis.factory_id)
    and repository.id = any(repository_ids);
  begin
    perform installation.id from public.github_installations installation
    where installation.workspace_id = diagnosis.workspace_id and installation.id = any(installation_ids)
    order by installation.id for share nowait;
    get diagnostics locked_count = row_count;
    if locked_count <> cardinality(installation_ids) then
      raise exception 'GitHub source metadata changed. Retry saving the proposal.' using errcode = 'PT409';
    end if;
    perform repository.id from public.github_repositories repository
    where (repository.workspace_id, repository.factory_id) = (diagnosis.workspace_id, diagnosis.factory_id)
      and repository.id = any(repository_ids)
    order by repository.id for share nowait;
    get diagnostics locked_count = row_count;
    if locked_count <> cardinality(repository_ids) then
      raise exception 'GitHub source metadata changed. Retry saving the proposal.' using errcode = 'PT409';
    end if;
  exception when lock_not_available then
    raise exception 'GitHub source metadata is changing. Retry saving the proposal.' using errcode = 'PT409';
  end;
  if exists (select 1 from public.github_repositories repository
    where (repository.workspace_id, repository.factory_id) = (diagnosis.workspace_id, diagnosis.factory_id)
      and repository.id = any(repository_ids) and not (repository.github_installation_id = any(installation_ids))) then
    raise exception 'GitHub source metadata changed. Retry saving the proposal.' using errcode = 'PT409';
  end if;
end;
$$;

-- Upload recovery can remove a command object without a retention marker.
-- Hold the exact metadata rows through settlement, just as for GitHub metadata.
create function internal.lock_factory_improvement_source_objects(diagnosis internal.factory_diagnoses)
returns void language plpgsql set search_path = '' as $$
begin
  perform object.id from storage.objects object
  join (
    with members as materialized (
      select member.* from internal.factory_failure_cohort_members member
      where (member.workspace_id, member.factory_id, member.cohort_id) =
        (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.cohort_id)
        and member.id = any(diagnosis.member_ids)
    ), scored_assets as materialized (
      select member.workspace_id, member.session_id, member.run_id,
        (reference.value->>'id')::uuid as asset_id, reference.value->>'kind' as kind
      from members member
      join public.factory_evaluation_receipts receipt on
        (receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.run_id, receipt.attempt_id,
         receipt.job_id, receipt.scorer_revision_id, receipt.target_commit_sha) =
        (member.workspace_id, member.factory_id, member.session_id, member.run_id, member.evaluation_attempt_id,
         member.evaluation_job_id, member.scorer_revision_id, member.target_commit_sha)
      cross join lateral jsonb_array_elements(receipt.result->'evidence') reference(value)
      where member.source_kind = 'scorer'
        and reference.value->>'kind' in ('validation_report', 'browser_screenshot', 'browser_recording')
    )
    select asset.storage_path from members member
    join public.session_validation_evidence receipt on
      (receipt.workspace_id, receipt.session_id, receipt.run_id, receipt.attempt_count, receipt.commit_sha,
       receipt.validation_tree_sha) =
      (member.workspace_id, member.session_id, member.validation_run_id, member.run_attempt_count,
       member.target_commit_sha, member.target_tree_sha)
    cross join lateral jsonb_array_elements(receipt.records) command(value)
    join public.session_validation_assets asset on (asset.workspace_id, asset.session_id, asset.run_id) =
      (member.workspace_id, member.session_id, member.run_id)
    left join public.session_validation_plans plan on plan.run_id = member.run_id
    where member.source_kind = 'validation' and command.value->>'key' = member.validation_record_key
      and (
        asset.evidence_key = member.validation_record_key || '/log'
        or command.value->'reportKeys' ? asset.evidence_key
        or exists (select 1 from jsonb_array_elements(plan.plan->'commands') planned(value)
          cross join lateral jsonb_array_elements(planned.value->'reports') report(value)
          where planned.value->>'key' = member.validation_record_key and report.value->'required' = 'true'
            and asset.evidence_key = member.validation_record_key || '/' || (report.value->>'key'))
      )
    union
    select asset.storage_path from scored_assets ref join public.session_validation_assets asset on
      (asset.workspace_id, asset.session_id, asset.run_id, asset.id) =
      (ref.workspace_id, ref.session_id, ref.run_id, ref.asset_id)
    where ref.kind = 'validation_report' and asset.kind = 'report'
    union
    select asset.storage_path from scored_assets ref join public.session_browser_verification_assets asset on
      (asset.workspace_id, asset.session_id, asset.run_id, asset.id) =
      (ref.workspace_id, ref.session_id, ref.run_id, ref.asset_id)
    where ref.kind in ('browser_screenshot','browser_recording')
  ) source on object.name = source.storage_path
  where object.bucket_id = 'session-validation-evidence'
  order by object.id for share of object nowait;
exception when lock_not_available then
  raise exception 'Evidence storage is changing. Retry saving the proposal.' using errcode = 'PT409';
end;
$$;

create function internal.assert_factory_improvement_routing_targets(
  p_workspace_id uuid, p_factory_id uuid, p_candidate jsonb, p_edits jsonb
) returns void language plpgsql set search_path = '' as $$
declare
  scope_keys text[] := array['repositoryId','pipelineId','sandboxProvider','executionGrant','credentialBindingId',
    'executionPolicyRevisionId','deliveryPolicyRevisionId','writableRepositoryIds','readContextRepositoryIds',
    'contextDocuments','toolIds','skillIds','mcpManifest'];
  target record;
  selected public.factory_benchmark_experiment_candidates;
  target_definition jsonb;
begin
  for target in
    select routing.* from internal.factory_routing_policy_targets(p_candidate->'modelRouting') routing
    where exists (select 1 from jsonb_array_elements(p_edits) edit
      where edit->>'kind' = 'skill_revision' or
        (edit->>'kind' = 'routing_target' and edit->>'ruleId' = routing.rule_id and routing.target = 'primary'))
  loop
    perform internal.assert_current_reviewed_routing_evidence(p_workspace_id, p_factory_id, target.configuration);
    select * into selected from public.factory_benchmark_experiment_candidates candidate
    where (candidate.workspace_id, candidate.factory_id, candidate.experiment_id::text, candidate.definition_revision_id::text,
      candidate.qualification_id::text, candidate.canonical_model_key, candidate.harness, candidate.worker_runtime) =
      (p_workspace_id, p_factory_id, target.configuration->>'experimentId', target.configuration->>'definitionRevisionId',
       target.configuration->>'qualificationId', target.configuration->>'modelKey', target.configuration->>'harness',
       target.configuration->>'workerRuntime')
    order by candidate.candidate_key limit 1;
    if not found then
      raise exception 'Replacement routing target requires an exact qualified candidate.' using errcode = 'PT422';
    end if;
    select revision.definition_json::jsonb into target_definition from public.factory_definition_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
      (p_workspace_id, p_factory_id, selected.definition_revision_id, selected.definition_digest);
    if target_definition is null
      or exists (select 1 from unnest(scope_keys) key where p_candidate->key is distinct from target_definition->key)
      or (p_candidate ? 'executionGrant' and target.configuration->>'agentId' is distinct from
        p_candidate#>>'{implementationAgent,agentId}')
      or (jsonb_array_length(p_candidate#>'{mcpManifest,servers}') > 0 and target.configuration->>'harness' is distinct from
        p_candidate#>>'{agent,provider}')
      or internal.factory_model_routing_evidence_reason(p_workspace_id, p_factory_id, selected.experiment_id,
        selected.candidate_key, target.configuration->>'scorerRevisionId', target.constraints) is not null then
      raise exception 'Routing target must preserve execution scope and meet current evidence constraints.' using errcode = 'PT422';
    end if;
  end loop;
end;
$$;

-- Reconciling typed edits against the original structure also protects every
-- untouched field and catches an adapter sending unrelated compiled changes.
create function internal.apply_factory_improvement_edits(
  p_workspace_id uuid, p_factory_id uuid, p_base jsonb, p_grant jsonb, p_edits jsonb, p_candidate jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  edit jsonb;
  edit_kind text;
  target_id text;
  from_id text;
  to_id text;
  target_key text;
  targets text[] := '{}';
  allowed_fields text[];
  current_value jsonb;
  field_name text;
  scope_name text;
  snapshot jsonb;
  ref_position bigint;
  ref_index integer;
  expected jsonb := p_base;
begin
  for edit in select value from jsonb_array_elements(p_edits) loop
    edit_kind := edit->>'kind';
    case edit_kind
      when 'stage_prompt' then
        target_id := edit->>'stageId';
        allowed_fields := array['kind','stageId','expectedPromptSha256','promptTemplateMd'];
      when 'agent_prompt' then
        target_id := edit->>'agentId';
        allowed_fields := array['kind','agentId','fromRevisionId','toRevisionId'];
      when 'skill_revision' then
        target_id := edit->>'skillId';
        allowed_fields := array['kind','skillId','fromRevisionId','toRevisionId'];
      when 'scorer_revision' then
        target_id := edit->>'scorerId';
        allowed_fields := array['kind','scorerId','fromRevisionId','toRevisionId'];
      when 'workflow_order' then
        target_id := 'workflow';
        allowed_fields := array['kind','fromStageIds','toStageIds'];
      when 'routing_target' then
        target_id := edit->>'ruleId';
        allowed_fields := array['kind','ruleId','from','to'];
      else raise exception 'Unsupported factory improvement edit.' using errcode = 'PT422';
    end case;
    target_key := edit_kind || '/' || target_id;
    if jsonb_typeof(edit) is distinct from 'object' or not edit ?& allowed_fields
      or edit - allowed_fields <> '{}' or target_key is null or target_key = any(targets)
      or (edit_kind <> 'workflow_order' and (target_id !~ '^[0-9a-f-]{36}$'
        or not coalesce(pg_input_is_valid(target_id, 'uuid'), false))) then
      raise exception 'Invalid or duplicate factory improvement edit.' using errcode = 'PT422';
    end if;
    targets := array_append(targets, target_key);
    from_id := edit->>'fromRevisionId';
    to_id := edit->>'toRevisionId';
    if edit_kind in ('agent_prompt','skill_revision','scorer_revision') and (
      not coalesce(pg_input_is_valid(from_id, 'uuid'), false) or not coalesce(pg_input_is_valid(to_id, 'uuid'), false)
      or from_id !~ '^[0-9a-f-]{36}$' or to_id !~ '^[0-9a-f-]{36}$' or from_id = to_id
    ) then raise exception 'A distinct existing revision is required.' using errcode = 'PT422'; end if;

    case edit_kind
      when 'stage_prompt' then
        select stage.value, stage.position into current_value, ref_position
        from jsonb_array_elements(expected->'stages') with ordinality stage(value,position)
        where stage.value->>'id' = target_id;
        if current_value is null or not (p_grant->'stageIds' ? target_id)
          or edit->>'expectedPromptSha256' is distinct from
            encode(sha256(convert_to(current_value->>'promptTemplateMd', 'UTF8')), 'hex')
          or jsonb_typeof(edit->'promptTemplateMd') is distinct from 'string'
          or char_length(edit->>'promptTemplateMd') > 20000
          or current_value->'promptTemplateMd' = edit->'promptTemplateMd' then
          raise exception 'Stage prompt edit is outside the cited scope or pinned prompt.' using errcode = 'PT422';
        end if;
        expected := jsonb_set(expected, array['stages',(ref_position - 1)::text,'promptTemplateMd'], edit->'promptTemplateMd');

      when 'agent_prompt' then
        if not (p_grant->'agentIds' ? target_id)
          or expected#>>'{implementationAgent,agentId}' is distinct from target_id
          or expected#>>'{implementationAgent,promptRevisionId}' is distinct from from_id then
          raise exception 'Agent prompt edit is outside the cited scope or pinned prompt.' using errcode = 'PT422';
        end if;
        if p_candidate is not null then
          select jsonb_build_object('agentId', revision.agent_id, 'promptRevisionId', revision.id,
            'promptMd', revision.prompt_md, 'promptSha256', revision.prompt_sha256) into snapshot
          from public.factory_agent_prompt_revisions revision
          where (revision.workspace_id, revision.factory_id, revision.agent_id, revision.id) =
            (p_workspace_id, p_factory_id, target_id::uuid, to_id::uuid);
          if snapshot is null then raise exception 'Replacement agent prompt is unavailable.' using errcode = 'PT422'; end if;
          expected := jsonb_set(expected, '{implementationAgent}', snapshot);
        end if;

      when 'skill_revision', 'scorer_revision' then
        field_name := case edit_kind when 'skill_revision' then 'skillIds' else 'scorerRevisionIds' end;
        scope_name := case edit_kind when 'skill_revision' then 'skillRevisionIds' else 'scorerRevisionIds' end;
        if not (p_grant->scope_name ? from_id) or not coalesce(expected->field_name ? from_id, false)
          or expected->field_name ? to_id then
          raise exception 'Revision edit is outside the cited scope or pinned revision.' using errcode = 'PT422';
        end if;
        if p_candidate is not null and edit_kind = 'skill_revision' then
          if (select count(*) from (
            select revision.id from public.factory_skill_revisions revision
            where (revision.workspace_id, revision.factory_id, revision.skill_id) =
              (p_workspace_id, p_factory_id, target_id::uuid) and revision.id in (from_id::uuid, to_id::uuid)
              and (revision.id = from_id::uuid or revision.revoked_at is null)
            order by revision.id for share
          ) locked) <> 2 then
            raise exception 'Replacement skill revision is unavailable.' using errcode = 'PT422';
          end if;
        elsif p_candidate is not null and (select count(*) from public.factory_scorer_revisions revision
            where (revision.workspace_id, revision.factory_id, revision.scorer_id) =
              (p_workspace_id, p_factory_id, target_id::uuid) and revision.id in (from_id::uuid, to_id::uuid)) <> 2 then
          raise exception 'Replacement scorer revision is unavailable.' using errcode = 'PT422';
        end if;
        select jsonb_agg(ids.id order by ids.id) into snapshot from (
          select case when value = from_id then to_id else value end id
          from jsonb_array_elements_text(expected->field_name)
        ) ids;
        expected := jsonb_set(expected, array[field_name], snapshot);

      when 'workflow_order' then
        select jsonb_agg(stage.value->'id' order by stage.position) into current_value
        from jsonb_array_elements(p_base->'stages') with ordinality stage(value,position);
        if jsonb_typeof(edit->'toStageIds') is distinct from 'array' or current_value is null
          or edit->'fromStageIds' is distinct from current_value or edit->'toStageIds' = current_value then
          raise exception 'Stage ordering must start from the pinned workflow.' using errcode = 'PT422';
        end if;
        if jsonb_array_length(edit->'toStageIds') > 200
          or jsonb_array_length(edit->'toStageIds') <> jsonb_array_length(current_value)
          or not (current_value @> (edit->'toStageIds') and (edit->'toStageIds') @> current_value)
          or exists (
            select 1 from jsonb_array_elements_text(edit->'toStageIds') with ordinality stage(id,position)
            where current_value->>((stage.position - 1)::integer) <> stage.id and not (p_grant->'stageIds' ? stage.id)
          ) then raise exception 'Workflow changes may reorder only cited stages.' using errcode = 'PT422'; end if;
        select jsonb_agg(stage.value order by ordered.position) into snapshot
        from jsonb_array_elements_text(edit->'toStageIds') with ordinality ordered(id,position)
        join jsonb_array_elements(expected->'stages') stage(value) on stage.value->>'id' = ordered.id;
        expected := jsonb_set(expected, '{stages}', snapshot);

      when 'routing_target' then
        select rule.value, rule.position into current_value, ref_position
        from jsonb_array_elements(expected#>'{modelRouting,rules}') with ordinality rule(value,position)
        where rule.value->>'id' = target_id;
        if current_value is null or not (p_grant->'routingRuleIds' ? target_id)
          or current_value->'configuration' is distinct from edit->'from' or edit->'from' = edit->'to'
          or jsonb_typeof(edit->'to') is distinct from 'object'
          or not (edit->'to' ?& array['agentId','definitionRevisionId','experimentId','qualificationId',
            'modelKey','harness','workerRuntime'])
          or edit->'to' - array['agentId','definitionRevisionId','experimentId','qualificationId',
            'scorerRevisionId','modelKey','harness','workerRuntime'] <> '{}'
          or edit#>>'{to,agentId}' is distinct from current_value#>>'{configuration,agentId}'
          or exists (select 1 from jsonb_each(edit->'to') entry
            where jsonb_typeof(entry.value) is distinct from 'string') then
          raise exception 'Routing edit is outside the cited scope or pinned configuration.' using errcode = 'PT422';
        end if;
        expected := jsonb_set(expected, array['modelRouting','rules',(ref_position - 1)::text,'configuration'], edit->'to');
    end case;
  end loop;

  if p_candidate is not null then
    -- The compiler resolves template references. The write fence independently
    -- checks that references can change only on the edited stage and that every
    -- reference resolves to a distinct earlier stage in the exact workflow.
    for current_value, ref_index in
      select stage.value, (stage.position - 1)::integer
      from jsonb_array_elements(expected->'stages') with ordinality stage(value,position)
    loop
      snapshot := case when ('stage_prompt/' || (current_value->>'id')) = any(targets)
        then p_candidate->'stages'->ref_index->'previousStageIds' else current_value->'previousStageIds' end;
      if jsonb_typeof(snapshot) is distinct from 'array' then
        raise exception 'Compiled stage predecessors must be an array.' using errcode = 'PT422';
      end if;
      if jsonb_array_length(snapshot) <> (
        select count(distinct stage.value->>'id')
        from jsonb_array_elements(expected->'stages') with ordinality stage(value, position)
        where stage.position <= ref_index and snapshot ? (stage.value->>'id')
      ) then raise exception 'Compiled stage prompt has an unavailable predecessor.' using errcode = 'PT422';
      end if;
      expected := jsonb_set(expected, array['stages',ref_index::text,'previousStageIds'], snapshot);
    end loop;
  end if;
  return expected;
end;
$$;

create function internal.factory_improvement_intent(
  p_diagnosis_id uuid, p_activation_number bigint, p_base_revision_id uuid, p_base_digest text,
  p_rationale text, p_expected_benefit text, p_regression_risks text, p_edits jsonb,
  p_proposal_id uuid, p_expected_revision_id uuid
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('diagnosisId', p_diagnosis_id, 'base', jsonb_build_object(
    'activationNumber', p_activation_number, 'revisionId', p_base_revision_id, 'digest', p_base_digest),
    'rationale', p_rationale, 'expectedBenefit', p_expected_benefit, 'regressionRisks', p_regression_risks,
    'edits', p_edits, 'proposalId', p_proposal_id, 'previousRevisionId', p_expected_revision_id);
$$;

create function public.prepare_factory_improvement_proposal(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_diagnosis_id uuid,
  p_activation_number bigint, p_base_revision_id uuid, p_base_digest text, p_request_id uuid,
  p_rationale text, p_expected_benefit text, p_regression_risks text, p_edits jsonb,
  p_proposal_id uuid default null, p_expected_revision_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  intent jsonb;
  previous internal.factory_improvement_proposal_revisions;
  proposal internal.factory_improvement_proposals;
  diagnosis internal.factory_diagnoses;
  definition public.factory_definition_revisions;
  cited_members uuid[];
  edit_grant jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  -- Matches factory membership mutations and activation's workspace/factory
  -- fence. Both prepare and save check the exact active head after the lock.
  actor := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_request_id is null or p_diagnosis_id is null or p_activation_number is null or p_activation_number < 1
    or p_base_revision_id is null or p_base_digest is null or p_base_digest !~ '^[a-f0-9]{64}$'
    or (p_proposal_id is null) <> (p_expected_revision_id is null)
    or p_rationale is null or btrim(p_rationale) = '' or char_length(p_rationale) > 2400
    or p_expected_benefit is null or btrim(p_expected_benefit) = '' or char_length(p_expected_benefit) > 2400
    or p_regression_risks is null or char_length(p_regression_risks) > 2400
    or jsonb_typeof(p_edits) is distinct from 'array' then
    raise exception 'Invalid factory improvement request.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_edits) not between 1 and 12 or pg_column_size(p_edits) > 524288 then
    raise exception 'Factory improvement edits exceed the request limits.' using errcode = '22023';
  end if;
  intent := internal.factory_improvement_intent(p_diagnosis_id, p_activation_number, p_base_revision_id, p_base_digest,
    p_rationale, p_expected_benefit, p_regression_risks, p_edits, p_proposal_id, p_expected_revision_id);
  select revision.* into previous from internal.factory_improvement_proposal_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.request_id) = (p_workspace_id, p_factory_id, p_request_id);
  if found then
    if previous.author_member_id is distinct from actor or previous.intent is distinct from intent then
      raise exception 'The improvement request ID is already in use.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('replay', internal.project_factory_improvement_revision(previous));
  end if;

  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if internal.current_factory_improvement_base(p_workspace_id, p_factory_id) is distinct from intent->'base' then
    raise exception 'The active factory definition changed. Reload before saving the proposal.' using errcode = 'PT409';
  end if;
  if p_proposal_id is not null then
    select * into proposal from internal.factory_improvement_proposals record
    where (record.workspace_id, record.factory_id, record.id) = (p_workspace_id, p_factory_id, p_proposal_id);
    if not found then raise exception 'Improvement proposal is unavailable.' using errcode = 'P0002'; end if;
    if proposal.diagnosis_id is distinct from p_diagnosis_id or (select revision.id from internal.factory_improvement_proposal_revisions revision
        where (revision.workspace_id, revision.factory_id, revision.proposal_id) = (p_workspace_id, p_factory_id, p_proposal_id)
        order by revision.revision_number desc limit 1) is distinct from p_expected_revision_id then
      raise exception 'The proposal changed. Reload its exact revision and base.' using errcode = 'PT409';
    end if;
  end if;

  select * into diagnosis from internal.factory_diagnoses job
  where (job.workspace_id, job.factory_id, job.id) = (p_workspace_id, p_factory_id, p_diagnosis_id);
  if not found then raise exception 'Factory diagnosis is unavailable.' using errcode = 'P0002'; end if;
  if diagnosis.status <> 'completed' or (p_proposal_id is null
    and (diagnosis.definition_revision_id, diagnosis.definition_digest) is distinct from (p_base_revision_id, p_base_digest)) then
    raise exception 'A completed diagnosis against the exact active definition is required.' using errcode = 'PT422';
  end if;
  cited_members := internal.factory_improvement_cited_members(diagnosis);
  if cardinality(cited_members) = 0 or not internal.factory_diagnosis_sources_current(diagnosis) then
    raise exception 'Current cited diagnosis evidence is required.' using errcode = 'PT422';
  end if;
  select * into strict definition from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, p_base_revision_id);
  edit_grant := internal.factory_improvement_edit_grant(diagnosis, cited_members);
  perform internal.apply_factory_improvement_edits(p_workspace_id, p_factory_id,
    definition.definition_json::jsonb, edit_grant, p_edits, null);
  return jsonb_build_object('base', (intent->'base') || jsonb_build_object('definitionJson', definition.definition_json),
    'grant', edit_grant);
end;
$$;

create function public.save_factory_improvement_proposal(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_diagnosis_id uuid,
  p_activation_number bigint, p_base_revision_id uuid, p_base_digest text, p_request_id uuid,
  p_rationale text, p_expected_benefit text, p_regression_risks text, p_edits jsonb, p_diagnostics jsonb,
  p_proposal_id uuid default null, p_expected_revision_id uuid default null,
  p_definition_json text default null, p_candidate_digest text default null, p_diff jsonb default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prepared jsonb;
  diagnosis internal.factory_diagnoses;
  actor uuid;
  base_definition jsonb;
  expected_definition jsonb;
  diagnostics jsonb := p_diagnostics;
  candidate_id uuid;
  proposal_id uuid := p_proposal_id;
  proposal_revision_number integer := 1;
  receipt internal.factory_improvement_proposal_revisions;
begin
  -- The check holds the membership/factory fences through receipt insertion.
  prepared := public.prepare_factory_improvement_proposal(p_workspace_id, p_factory_id, p_actor_user_id,
    p_diagnosis_id, p_activation_number, p_base_revision_id, p_base_digest, p_request_id, p_rationale,
    p_expected_benefit, p_regression_risks, p_edits, p_proposal_id, p_expected_revision_id);
  if prepared ? 'replay' then
    return jsonb_build_object('proposal', prepared->'replay', 'replay', true);
  end if;

  if jsonb_typeof(p_diagnostics) is distinct from 'array' or pg_column_size(p_diagnostics) > 65536 then
    raise exception 'Invalid compilation diagnostics.' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_diagnostics) diagnostic(item)
    where jsonb_typeof(item) is distinct from 'object'
      or jsonb_typeof(item->'code') is distinct from 'string'
      or jsonb_typeof(item->'message') is distinct from 'string'
      or jsonb_typeof(item->'path') is distinct from 'array'
      or jsonb_path_exists(item, '$.path[*] ? (@.type() != "string" && @.type() != "number")')) then
    raise exception 'Invalid compilation diagnostic entry.' using errcode = '22023';
  end if;
  if p_definition_json is null then
    if p_candidate_digest is not null or p_diff is not null or p_diagnostics = '[]' then
      raise exception 'A failed compilation requires diagnostics without a candidate.' using errcode = '22023';
    end if;
  else
    if octet_length(p_definition_json) > 2097152 or not (p_definition_json is json object with unique keys)
      or p_candidate_digest is distinct from encode(sha256(convert_to(p_definition_json, 'UTF8')), 'hex')
      or jsonb_typeof(p_diff) is distinct from 'object'
      or jsonb_typeof(p_diff->'fields') is distinct from 'array'
      or jsonb_typeof(p_diff->'stages') is distinct from 'array'
      or pg_column_size(p_diff) > 1048576 or p_diagnostics <> '[]' then
      raise exception 'Invalid compiled improvement candidate.' using errcode = '22023';
    end if;
    base_definition := (prepared#>>'{base,definitionJson}')::jsonb;
    expected_definition := internal.apply_factory_improvement_edits(p_workspace_id, p_factory_id,
      base_definition, prepared->'grant', p_edits, p_definition_json::jsonb);
    if p_definition_json::jsonb is distinct from expected_definition then
      raise exception 'The compiled candidate changes fields outside the exact authorized edits.' using errcode = 'PT422';
    end if;
    begin
      perform internal.assert_factory_improvement_routing_targets(p_workspace_id, p_factory_id, expected_definition, p_edits);
    exception when sqlstate 'PT409' or sqlstate 'PT422' then
      diagnostics := jsonb_build_array(jsonb_build_object(
        'path', jsonb_build_array('modelRouting'), 'code', 'unsupported_capability',
        'message', case sqlstate when 'PT409' then
          'The reviewed routing evidence changed. Run a new comparison for this routing target.'
        else 'Use a qualified routing target that preserves execution scope and meets the rule constraints.' end));
    end;
  end if;

  select * into strict diagnosis from internal.factory_diagnoses job
  where (job.workspace_id, job.factory_id, job.id) = (p_workspace_id, p_factory_id, p_diagnosis_id);
  perform internal.lock_factory_improvement_source_repositories(diagnosis);
  perform internal.lock_factory_improvement_source_objects(diagnosis);
  -- The workspace SHARE lock taken before membership and factory locks remains
  -- held for saving. Check the exact sources again under their availability fences.
  if not internal.factory_diagnosis_sources_current(diagnosis) then
    raise exception 'Current cited diagnosis evidence is required.' using errcode = 'PT422';
  end if;

  if p_definition_json is not null and diagnostics = '[]' then
    insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version,
      definition_json, canonical_digest, created_by)
    values (p_workspace_id, p_factory_id, coalesce((expected_definition->>'schemaVersion')::integer, 1),
      p_definition_json, p_candidate_digest, p_actor_user_id) returning id into candidate_id;
  end if;

  if proposal_id is null then
    insert into internal.factory_improvement_proposals(workspace_id, factory_id, diagnosis_id)
    values (p_workspace_id, p_factory_id, p_diagnosis_id)
    returning id into proposal_id;
  else
    select revision.revision_number + 1 into strict proposal_revision_number
    from internal.factory_improvement_proposal_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.proposal_id, revision.id) =
      (p_workspace_id, p_factory_id, p_proposal_id, p_expected_revision_id);
  end if;
  select member.id into strict actor from public.workspace_members member
  where (member.workspace_id, member.user_id, member.kind) = (p_workspace_id, p_actor_user_id, 'human');
  insert into internal.factory_improvement_proposal_revisions(workspace_id, factory_id, proposal_id,
    revision_number, previous_revision_id, base_activation_number, base_revision_id, base_digest,
    request_id, author_member_id, intent, evidence_digest, cited_member_ids,
    candidate_revision_id, candidate_digest, diff, diagnostics)
  values (p_workspace_id, p_factory_id, proposal_id, proposal_revision_number, p_expected_revision_id,
    p_activation_number, p_base_revision_id, p_base_digest, p_request_id,
    actor, internal.factory_improvement_intent(p_diagnosis_id, p_activation_number, p_base_revision_id, p_base_digest,
      p_rationale, p_expected_benefit, p_regression_risks, p_edits, p_proposal_id, p_expected_revision_id),
    diagnosis.evidence_digest, internal.factory_improvement_cited_members(diagnosis),
    candidate_id, case when candidate_id is not null then p_candidate_digest end,
    case when candidate_id is not null then p_diff end, diagnostics)
  returning * into receipt;
  return jsonb_build_object('proposal', internal.project_factory_improvement_revision(receipt), 'replay', false);
end;
$$;

create function internal.get_factory_improvement_proposal_revision(
  p_workspace_id uuid, p_factory_id uuid, p_proposal_id uuid, p_revision_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not internal.can_access_factory(p_workspace_id, p_factory_id) then
    raise exception 'Factory improvement proposal is unavailable.' using errcode = 'P0002';
  end if;
  return (select internal.project_factory_improvement_revision(revision)
    from internal.factory_improvement_proposal_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.proposal_id) = (p_workspace_id, p_factory_id, p_proposal_id)
      and (p_revision_id is null or revision.id = p_revision_id)
    order by revision.revision_number desc limit 1);
end;
$$;

create function public.get_factory_improvement_proposal_revision(
  p_workspace_id uuid, p_factory_id uuid, p_proposal_id uuid, p_revision_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_factory_improvement_proposal_revision(p_workspace_id, p_factory_id, p_proposal_id, p_revision_id);
$$;

revoke all on function
  internal.preserve_factory_improvement_history(),
  internal.current_factory_improvement_base(uuid, uuid),
  internal.project_factory_improvement_revision(internal.factory_improvement_proposal_revisions),
  internal.factory_improvement_cited_members(internal.factory_diagnoses),
  internal.factory_improvement_edit_grant(internal.factory_diagnoses, uuid[]),
  internal.lock_validation_withholding_workspace(),
  internal.lock_factory_improvement_source_repositories(internal.factory_diagnoses),
  internal.lock_factory_improvement_source_objects(internal.factory_diagnoses),
  internal.apply_factory_improvement_edits(uuid, uuid, jsonb, jsonb, jsonb, jsonb),
  internal.assert_factory_improvement_routing_targets(uuid, uuid, jsonb, jsonb),
  internal.factory_improvement_intent(uuid, bigint, uuid, text, text, text, text, jsonb, uuid, uuid),
  internal.get_factory_improvement_proposal_revision(uuid, uuid, uuid, uuid),
  public.get_factory_improvement_proposal_revision(uuid, uuid, uuid, uuid),
  public.prepare_factory_improvement_proposal(uuid, uuid, uuid, uuid, bigint, uuid, text, uuid, text, text, text, jsonb, uuid, uuid),
  public.save_factory_improvement_proposal(uuid, uuid, uuid, uuid, bigint, uuid, text, uuid, text, text, text, jsonb, jsonb, uuid, uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  internal.get_factory_improvement_proposal_revision(uuid, uuid, uuid, uuid),
  public.get_factory_improvement_proposal_revision(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function
  public.prepare_factory_improvement_proposal(uuid, uuid, uuid, uuid, bigint, uuid, text, uuid, text, text, text, jsonb, uuid, uuid),
  public.save_factory_improvement_proposal(uuid, uuid, uuid, uuid, bigint, uuid, text, uuid, text, text, text, jsonb, jsonb, uuid, uuid, text, text, jsonb)
  to service_role;
