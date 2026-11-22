create table public.factory_routing_canaries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  activation_number bigint not null,
  baseline_activation_number bigint not null,
  candidate_revision_id uuid not null,
  baseline_revision_id uuid not null,
  task_class_id uuid not null,
  task_class_slug text not null,
  candidate_bps integer not null check (candidate_bps between 1 and 9999),
  minimum_support integer not null default 5 check (minimum_support >= 2),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, activation_number),
  unique (workspace_id, factory_id, id, activation_number),
  foreign key (workspace_id, factory_id, activation_number)
    references public.factory_routing_activations(workspace_id, factory_id, activation_number) on delete cascade,
  foreign key (workspace_id, factory_id, baseline_activation_number)
    references public.factory_definition_activations(workspace_id, factory_id, activation_number) deferrable initially deferred,
  check (baseline_activation_number = activation_number - 1)
);
alter table public.factory_routing_canaries enable row level security;
revoke all on public.factory_routing_canaries from public, anon, authenticated, service_role;
grant select on public.factory_routing_canaries to authenticated, service_role;
create policy factory_routing_canaries_manager_read on public.factory_routing_canaries
  for select to authenticated using (internal.can_manage_factory(workspace_id, factory_id));
create trigger preserve_factory_routing_canaries before update or delete on public.factory_routing_canaries
  for each row execute function internal.preserve_factory_definition_history();

alter table public.session_factory_admission_inputs
  add column routing_canary_id uuid,
  add column routing_canary_arm text,
  add column routing_canary_eligible boolean,
  add column routing_canary_bucket integer,
  add column routing_canary_baseline_execution jsonb,
  add constraint session_factory_admission_canary_scope_fk foreign key
    (workspace_id, factory_id, routing_canary_id, activation_number)
    references public.factory_routing_canaries(workspace_id, factory_id, id, activation_number)
    deferrable initially deferred,
  add constraint session_factory_admission_canary_assignment_check check ((
    (routing_canary_id is null and routing_canary_arm is null and routing_canary_eligible is null
      and routing_canary_bucket is null and routing_canary_baseline_execution is null)
    or (
      routing_canary_id is not null and routing_canary_eligible is not null and routing_canary_arm is not null and (
        (routing_canary_eligible and routing_canary_bucket is not null and routing_canary_bucket between 0 and 9999)
        or (not routing_canary_eligible and routing_canary_bucket is null and routing_canary_arm = 'baseline')
      ) and (
        (routing_canary_arm = 'candidate' and routing_execution is not null and routing_canary_baseline_execution is null)
        or (routing_canary_arm = 'baseline' and routing_execution is null
          and (routing_canary_baseline_execution is null or jsonb_typeof(routing_canary_baseline_execution) = 'object'))
      )
    )
  ) is true);
create index session_factory_admission_canary_idx
  on public.session_factory_admission_inputs(workspace_id, factory_id, routing_canary_id, created_at, session_id)
  where routing_canary_id is not null;

-- The override command reserves and consumes this private handoff in its
-- creation transaction. A failed command rolls it back with the admission.
create table internal.factory_routing_canary_override_requests (
  transaction_id xid8 primary key,
  request_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  canary_id uuid not null,
  activation_number bigint not null,
  revision_id uuid not null,
  actor_member_id uuid not null,
  rule_id uuid not null,
  task_class_id uuid not null,
  session_id uuid
);
revoke all on internal.factory_routing_canary_override_requests from public, anon, authenticated, service_role;

create function public.activate_factory_routing_canary(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_draft_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[],
  p_task_class_id uuid, p_candidate_bps integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  activation jsonb;
  candidate public.factory_routing_activations;
  designation public.factory_routing_canaries;
  baseline public.factory_definition_revisions;
  prospective public.session_factory_admission_inputs;
  execution_grant public.factory_execution_grants;
  baseline_definition jsonb;
  candidate_definition jsonb;
  selected_slug text;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_task_class_id is null or not coalesce(p_candidate_bps between 1 and 9999, false) then
    raise exception 'Select a task class and a candidate enrollment between 1 and 9999 basis points.' using errcode = '22023';
  end if;

  -- Publishing and designation share the same workspace and factory fences.
  -- Any rejected designation rolls back publication before it is visible to admissions.
  activation := public.activate_reviewed_factory_routing(p_workspace_id, p_factory_id, p_actor_user_id,
    p_expected_activation_number, p_draft_id, p_enabled_sandbox_providers, p_required_probes);
  select * into strict candidate from public.factory_routing_activations review
  where (review.workspace_id, review.factory_id, review.activation_number, review.revision_id) =
    (p_workspace_id, p_factory_id, (activation->>'activationNumber')::bigint, (activation->>'revisionId')::uuid);
  select * into baseline from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (p_workspace_id, p_factory_id, candidate.previous_revision_id);
  if not found or candidate.previous_activation_number is null then
    raise exception 'A canary requires an existing factory activation for its baseline.' using errcode = 'PT422';
  end if;
  if exists (select 1 from public.factory_routing_canaries prior
    where (prior.workspace_id, prior.factory_id, prior.activation_number) =
      (p_workspace_id, p_factory_id, candidate.previous_activation_number)) then
    raise exception 'The previous activation already contains a canary and cannot be used as a single baseline.' using errcode = 'PT422';
  end if;
  select definition_json::jsonb into strict candidate_definition from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, candidate.revision_id);
  baseline_definition := baseline.definition_json::jsonb;
  if baseline_definition - 'modelRouting' is distinct from candidate_definition - 'modelRouting' then
    raise exception 'A routing canary requires the same workflow and base execution profile as its baseline.' using errcode = 'PT422';
  end if;

  select entry.value->>'slug' into selected_slug
  from jsonb_array_elements(candidate_definition#>'{modelRouting,taskClasses}') entry(value)
  where entry.value->>'id' = p_task_class_id::text;
  if selected_slug is null or selected_slug is distinct from candidate_definition#>>'{stages,0,slug}' or not exists (
    select 1 from public.factory_routing_draft_evidence receipt
    cross join jsonb_array_elements(candidate_definition#>'{modelRouting,rules}') rule(value)
    where (receipt.workspace_id, receipt.factory_id, receipt.draft_id) =
      (p_workspace_id, p_factory_id, candidate.benchmark_evidence_draft_id)
      and receipt.evidence->>'ruleId' = rule.value->>'id'
      and rule.value->>'taskClassId' = p_task_class_id::text
  ) then
    raise exception 'Select the workflow’s first task class with exact reviewed benchmark evidence.' using errcode = 'PT422';
  end if;
  insert into public.factory_routing_canaries(workspace_id, factory_id, activation_number, baseline_activation_number,
    candidate_revision_id, baseline_revision_id, task_class_id, task_class_slug, candidate_bps)
  values (p_workspace_id, p_factory_id, candidate.activation_number, candidate.previous_activation_number,
    candidate.revision_id, baseline.id, p_task_class_id, selected_slug, p_candidate_bps) returning * into designation;
  prospective.workspace_id := p_workspace_id;
  prospective.factory_id := p_factory_id;
  prospective.github_repository_id := (candidate_definition->>'repositoryId')::uuid;
  prospective.execution_policy_revision_id := (candidate_definition->>'executionPolicyRevisionId')::uuid;
  if candidate_definition ? 'executionGrant' then
    execution_grant := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, candidate_definition,
      prospective.github_repository_id, prospective.execution_policy_revision_id);
    prospective.execution_grant_id := execution_grant.id;
    prospective.execution_grant_version := execution_grant.version;
    prospective.credential_owner_service_principal_id := execution_grant.service_principal_id;
  else
    prospective.credential_owner_member_id := candidate.reviewed_by_member_id;
  end if;
  perform internal.make_factory_routing_canary_baseline(designation, prospective,
    null::public.sessions, candidate_definition, selected_slug);
  return activation;
end;
$$;
revoke all on function public.activate_factory_routing_canary(uuid,uuid,uuid,bigint,uuid,text[],text[],uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.activate_factory_routing_canary(uuid,uuid,uuid,bigint,uuid,text[],text[],uuid,integer)
  to service_role;

create function internal.factory_routing_canary_bucket(
  p_canary public.factory_routing_canaries, p_session_id uuid
) returns integer language sql immutable strict set search_path = '' as $$
  select (('x' || left(encode(sha256(convert_to(
    'wallie/factory-routing-canary/v1/' || p_canary.workspace_id::text || '/' || p_canary.factory_id::text || '/' ||
    p_canary.id::text || '/' || p_canary.task_class_id::text || '/' || p_session_id::text, 'UTF8')), 'hex'), 8))::bit(32)::bigint
    % 10000)::integer
$$;
revoke all on function internal.factory_routing_canary_bucket(public.factory_routing_canaries,uuid)
  from public, anon, authenticated, service_role;

create or replace function internal.effective_factory_routing_execution(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid
) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(override.routing_execution, admission.routing_execution, admission.routing_canary_baseline_execution)
  from public.session_factory_admission_inputs admission
  left join public.session_factory_routing_overrides override
    on (override.workspace_id, override.factory_id, override.session_id, override.activation_number) =
       (admission.workspace_id, admission.factory_id, admission.session_id, admission.activation_number)
  where (admission.workspace_id, admission.factory_id, admission.session_id) =
    (p_workspace_id, p_factory_id, p_session_id)
$$;

create function internal.make_factory_routing_canary_baseline(
  canary public.factory_routing_canaries, admission public.session_factory_admission_inputs,
  owner public.sessions, workflow jsonb, task_class_slug text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  reviewed public.factory_routing_activations;
  definition jsonb;
  decision jsonb;
  personal_user_id uuid;
begin
  select * into reviewed from public.factory_routing_activations activation
  where (activation.workspace_id, activation.factory_id, activation.activation_number, activation.revision_id) =
    (canary.workspace_id, canary.factory_id, canary.baseline_activation_number, canary.baseline_revision_id);
  if found then
    select revision.definition_json::jsonb into strict definition from public.factory_definition_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
      (reviewed.workspace_id, reviewed.factory_id, reviewed.revision_id, reviewed.draft_digest);
    decision := internal.resolve_factory_model_routing_policy(definition->'modelRouting', admission, owner, task_class_slug);
    if decision->>'disposition' is distinct from 'selected'
      or not reviewed.reviewed_targets @> jsonb_build_array(jsonb_build_object(
        'ruleId', decision->'ruleId', 'target', decision->'source', 'configuration', decision->'configuration')) then
      raise exception 'The reviewed routing baseline escalated this task (%)', coalesce(decision->>'reason', 'invalid_policy')
        using errcode = 'PT422';
    end if;
    return internal.make_factory_routing_execution(admission, workflow, decision->'configuration', decision->>'benchmarkCandidateKey');
  end if;

  -- Reviewed heads otherwise rely on target authorization. The shadow control
  -- retains the exact base profile and must check its actual personal authority.
  if admission.execution_grant_id is null then
    select member.user_id into personal_user_id from public.workspace_members member
    where (member.workspace_id, member.id) = (admission.workspace_id, admission.credential_owner_member_id)
      and member.kind = 'human' and member.is_active for share;
    if personal_user_id is null then raise exception 'The baseline credential owner is unavailable.' using errcode = '42501'; end if;
    perform internal.assert_current_factory_agent_credential(personal_user_id, workflow#>>'{agent,provider}', workflow#>>'{agent,model}');
  end if;
  return null;
end;
$$;
revoke all on function internal.make_factory_routing_canary_baseline(
  public.factory_routing_canaries,public.session_factory_admission_inputs,public.sessions,jsonb,text
) from public, anon, authenticated, service_role;

create or replace function internal.pin_session_model_routing_admission()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  owner public.sessions;
  definition jsonb;
  task_class_slug text;
  reviewed public.factory_routing_activations;
  canary public.factory_routing_canaries;
  has_override_request boolean := false;
begin
  new.routing_decision := null;
  new.routing_execution := null;
  new.routing_canary_id := null;
  new.routing_canary_arm := null;
  new.routing_canary_eligible := null;
  new.routing_canary_bucket := null;
  new.routing_canary_baseline_execution := null;
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
  select * into canary from public.factory_routing_canaries designation
  where (designation.workspace_id, designation.factory_id, designation.activation_number, designation.candidate_revision_id) =
    (new.workspace_id, new.factory_id, new.activation_number, new.definition_revision_id);
  if found then
    new.routing_canary_id := canary.id;
    new.routing_canary_eligible := task_class_slug is not distinct from canary.task_class_slug
      and new.routing_decision->>'taskClassId' is not distinct from canary.task_class_id::text;
    if new.routing_canary_eligible then
      new.routing_canary_bucket := internal.factory_routing_canary_bucket(canary, new.session_id);
      update internal.factory_routing_canary_override_requests pending set session_id = new.session_id
      where (pending.transaction_id, pending.workspace_id, pending.factory_id, pending.canary_id,
        pending.activation_number, pending.revision_id, pending.actor_member_id, pending.rule_id::text, pending.task_class_id)
        = (pg_current_xact_id(), new.workspace_id, new.factory_id, canary.id, new.activation_number, new.definition_revision_id,
          new.invoking_actor_member_id, new.routing_decision->>'ruleId', canary.task_class_id)
        and pending.session_id is null and new.invoking_actor_service_principal_id is null;
      has_override_request := found;
    end if;
    new.routing_canary_arm := case when new.routing_canary_bucket < canary.candidate_bps then 'candidate' else 'baseline' end;
    if new.routing_canary_arm = 'baseline' then
      if not has_override_request then
        new.routing_canary_baseline_execution := internal.make_factory_routing_canary_baseline(
          canary, new, owner, definition, task_class_slug);
      end if;
      return new;
    end if;
  end if;
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

create or replace function public.create_session_command_with_routing_override(
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
  canary public.factory_routing_canaries;
  reserved_session_id uuid;
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

  -- Match the requested option against the original workflow even when the
  -- session will be assigned a different execution profile for the control.
  select revision.definition_json::jsonb into strict workflow
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
    (reviewed.workspace_id, reviewed.factory_id, reviewed.revision_id, reviewed.draft_digest);
  select entry.value into rule from jsonb_array_elements(workflow#>'{modelRouting,rules}') entry(value)
  where entry.value->>'id' = selected_rule_id::text;
  configuration := case selected_target when 'primary' then rule->'configuration' else rule#>'{onUnavailable,configuration}' end;
  if configuration is null or not reviewed.reviewed_targets @> jsonb_build_array(jsonb_build_object(
    'ruleId', selected_rule_id, 'target', selected_target, 'configuration', configuration)) then
    raise exception 'The routing override is outside the reviewed choices for this task.' using errcode = 'PT422';
  end if;

  select * into canary from public.factory_routing_canaries designation
  where (designation.workspace_id, designation.factory_id, designation.activation_number, designation.candidate_revision_id) =
    (reviewed.workspace_id, reviewed.factory_id, reviewed.activation_number, reviewed.revision_id);
  if found then
    if rule->>'taskClassId' is distinct from canary.task_class_id::text then
      raise exception 'The reviewed routing rule does not apply to the admitted task class.' using errcode = 'PT422';
    end if;
    insert into internal.factory_routing_canary_override_requests(transaction_id, request_id, workspace_id, factory_id,
      canary_id, activation_number, revision_id, actor_member_id, rule_id, task_class_id)
    values (pg_current_xact_id(), target_request_id, target_workspace_id, actual_factory_id,
      canary.id, expected_activation, reviewed.revision_id, creator_member_id, selected_rule_id, canary.task_class_id);
  end if;
  select * into strict accepted from public.create_session_command_once(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash, expected_factory_definition_digest,
    session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
    session_linear_issue_id, session_linear_issue_url, session_github_repository_id, selected_pipeline_id,
    selected_stage_ids, source_session_id, actual_factory_id, draft_specification
  );
  if canary.id is not null then
    delete from internal.factory_routing_canary_override_requests pending
    where (pending.transaction_id, pending.request_id) = (pg_current_xact_id(), target_request_id)
    returning pending.session_id into reserved_session_id;
    if not found or reserved_session_id is distinct from accepted.session_id then
      raise exception 'The routing override does not match the admitted canary task.' using errcode = 'PT422';
    end if;
  end if;
  select * into strict owner from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) = (target_workspace_id, actual_factory_id, accepted.session_id);
  select * into admission from public.session_factory_admission_inputs receipt
  where (receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.activation_number, receipt.definition_revision_id) =
    (owner.workspace_id, owner.factory_id, owner.id, expected_activation, reviewed.revision_id)
    and receipt.invoking_actor_member_id = creator_member_id
    and receipt.invoking_actor_service_principal_id is null;
  if not found or admission.routing_decision->>'ruleId' is distinct from selected_rule_id::text
    or (admission.routing_canary_id is null and admission.routing_decision->>'mode' is distinct from 'active')
    or (admission.routing_canary_id is not null and admission.routing_canary_eligible is distinct from true) then
    raise exception 'The reviewed routing rule does not apply to the admitted task class.' using errcode = 'PT422';
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
