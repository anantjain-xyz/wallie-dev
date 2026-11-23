-- The canonical creation transaction also accepts exact delegated profiles.
-- Only the guarded delegated RPC can request a historical profile. Existing
-- callers keep their exact signature, live activation selection, and permits.
create function internal.create_attributed_session_from_profile(
  target_workspace_id uuid,
  creator_member_id uuid,
  session_title text,
  session_prompt_md text,
  agent_model_provider text,
  agent_model_name text,
  session_linear_issue_id text,
  session_linear_issue_url text,
  session_github_repository_id uuid,
  selected_pipeline_id uuid,
  selected_stage_ids uuid[],
  p_actor internal.session_mutation_actor,
  p_expected_agent_id uuid,
  p_expected_definition_digest text,
  p_frozen_definition_revision_id uuid
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
    if p_frozen_definition_revision_id is null then
      -- Ordinary machine creation must still hold its transaction-scoped permit.
      perform internal.assert_session_mutation_actor(p_actor, 'create');
    end if;
  end if;
  if p_frozen_definition_revision_id is not null and (
    not machine or p_actor.factory_id is null or p_actor.admission_id is not null or p_expected_definition_digest is null
  ) then
    raise exception 'Frozen profile admission authority is unavailable.' using errcode = '42501';
  end if;
  select a.factory_id, a.activation_number, a.revision_id, r.canonical_digest, r.definition_json::jsonb
  into admitted_factory_id, admitted_activation_number, admitted_revision_id, admitted_definition_digest, admitted_definition
  from public.factories f
  join public.factory_definition_activations a on (a.workspace_id, a.factory_id) = (f.workspace_id, f.id)
  join public.factory_definition_revisions r on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
  where f.workspace_id = target_workspace_id
    and case when p_actor.factory_id is null then f.is_default else f.id = p_actor.factory_id end
    and (p_frozen_definition_revision_id is null or a.revision_id = p_frozen_definition_revision_id)
  -- A revision can be activated again by rollback. Its first activation is a
  -- stable provenance for frozen admission; ordinary creation uses the latest.
  order by case when p_frozen_definition_revision_id is null then a.activation_number end desc, a.activation_number
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
    begin
      if p_frozen_definition_revision_id is null then
        select pipeline.id into pinned_pipeline_id from public.pipelines pipeline
        where pipeline.id = (admitted_definition->>'pipelineId')::uuid
          and pipeline.workspace_id = target_workspace_id for share;
      else
        select pipeline.id into pinned_pipeline_id from public.pipelines pipeline
        where (pipeline.id, pipeline.workspace_id, pipeline.factory_id) =
          ((admitted_definition->>'pipelineId')::uuid, target_workspace_id, admitted_factory_id) for share nowait;
      end if;
      if not found then
        raise exception 'The factory definition pipeline is unavailable.' using errcode = 'P0002';
      end if;
    exception when lock_not_available then
      raise exception 'The delegated factory pipeline is changing. Retry admission.' using errcode = 'PT409';
    end;
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

revoke all on function internal.create_attributed_session_from_profile(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid, uuid[], internal.session_mutation_actor, uuid, text, uuid
) from public, anon, authenticated, service_role;

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
  language sql set search_path = '' as $$
  select * from internal.create_attributed_session_from_profile(
    target_workspace_id, creator_member_id, session_title, session_prompt_md, agent_model_provider, agent_model_name,
    session_linear_issue_id, session_linear_issue_url, session_github_repository_id, selected_pipeline_id,
    selected_stage_ids, p_actor, p_expected_agent_id, p_expected_definition_digest, null::uuid);
$$;

-- Prospective OP-647: immutable attempt identities under the existing workflow root lock.
create table internal.factory_workflow_attempt_reservations (
  root_session_id uuid not null references internal.factory_workflow_executions(root_session_id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  session_id uuid not null,
  job_id uuid not null,
  attempt_count integer not null check (attempt_count > 0),
  run_id uuid unique,
  reserved_tokens bigint not null check (reserved_tokens > 0),
  reserved_cost_usd numeric not null check (reserved_cost_usd > 0),
  reported_tokens bigint check (reported_tokens >= 0),
  reported_cost_usd numeric check (reported_cost_usd >= 0),
  token_provenance text not null default 'unavailable'
    check (token_provenance in ('unavailable', 'measured', 'estimated')),
  cost_provenance text not null default 'unavailable'
    check (cost_provenance in ('unavailable', 'measured', 'estimated')),
  check ((reported_tokens is null) = (token_provenance = 'unavailable')),
  check ((reported_cost_usd is null) = (cost_provenance = 'unavailable')),
  primary key (job_id, attempt_count)
);
create index factory_workflow_attempt_reservations_root_idx
  on internal.factory_workflow_attempt_reservations(root_session_id, session_id);
alter table internal.factory_workflow_attempt_reservations enable row level security;
revoke all on internal.factory_workflow_attempt_reservations from public, anon, authenticated, service_role;

-- Queued first attempts and open executions consume the reservation. An attempt
-- retired before starting releases it. A terminal exact run consumes reported
-- usage, or keeps the conservative reservation while usage is unavailable.
create function internal.factory_workflow_attempt_budget(
  p_root_session_id uuid, p_policy jsonb
) returns table (attempts bigint, tokens numeric, spend_usd numeric, active_children bigint)
language sql stable set search_path = '' as $$
  with reserved_attempts as (
    select
      reserve.session_id,
      coalesce(run.status in ('started', 'running'), false)
        or (run.id is null and coalesce(
          (job.status = 'queued' and job.attempt_count < reserve.attempt_count)
          or (job.status in ('started', 'running') and job.attempt_count = reserve.attempt_count), false)
        ) as active,
      reserve.run_id is not null as started,
      reserve.reserved_tokens,
      reserve.reserved_cost_usd,
      reserve.reported_tokens,
      reserve.reported_cost_usd
    from internal.factory_workflow_attempt_reservations reserve
    left join public.agent_jobs job on (job.workspace_id, job.session_id, job.id) =
      (reserve.workspace_id, reserve.session_id, reserve.job_id)
    left join public.agent_runs run on
      (run.workspace_id, run.session_id, run.agent_job_id, run.id, run.attempt_count) =
      (reserve.workspace_id, reserve.session_id, reserve.job_id, reserve.run_id, reserve.attempt_count)
    where reserve.root_session_id = p_root_session_id
  ), existing_root_attempts as (
    -- The root may have started an ordinary serial attempt before enrollment.
    -- Include its exact run once, even though it predates this reservation ledger.
    select
      run.session_id,
      run.status in ('started', 'running') as active,
      true as started,
      (p_policy->>'maxTokensPerAttempt')::bigint as reserved_tokens,
      (p_policy->>'maxCostUsdPerAttempt')::numeric as reserved_cost_usd,
      run.input_tokens + run.output_tokens as reported_tokens,
      run.total_cost_usd as reported_cost_usd
    from public.agent_runs run
    where run.session_id = p_root_session_id and run.attempt_count > 0
      and not exists (
        select 1 from internal.factory_workflow_attempt_reservations reserve
        where (reserve.job_id, reserve.attempt_count) = (run.agent_job_id, run.attempt_count)
      )
  ), attempts as (
    select * from reserved_attempts
    union all
    select * from existing_root_attempts
  )
  select count(*) filter (where active or started),
    coalesce(sum(case when active then greatest(reserved_tokens, reported_tokens)
      when started then coalesce(reported_tokens, reserved_tokens) else 0 end), 0),
    coalesce(sum(case when active then greatest(reserved_cost_usd, reported_cost_usd)
      when started then coalesce(reported_cost_usd, reserved_cost_usd) else 0 end), 0),
    count(distinct session_id) filter (where active and session_id <> p_root_session_id)
  from attempts;
$$;
revoke all on function internal.factory_workflow_attempt_budget(uuid, jsonb)
  from public, anon, authenticated, service_role;

-- The caller holds workspace, factory, root, and then the relevant session/job
-- locks before calling. An admitted or previously claimed attempt reuses its
-- reservation. The queued job and the first reservation commit together.
create function internal.reserve_factory_workflow_attempt(
  p_execution internal.factory_workflow_executions,
  p_session_id uuid, p_job_id uuid, p_attempt_count integer
) returns boolean language plpgsql set search_path = '' as $$
declare
  policy jsonb := p_execution.workflow_json::jsonb->'delegationPolicy';
  consumed record;
  existing internal.factory_workflow_attempt_reservations;
  tokens_per_attempt bigint := (policy->>'maxTokensPerAttempt')::bigint;
  cost_per_attempt numeric := (policy->>'maxCostUsdPerAttempt')::numeric;
  configured_limits jsonb;
  root_tokens bigint;
  root_cost numeric;
  already_reserved boolean;
begin
  if policy is null then return false; end if;
  select * into existing from internal.factory_workflow_attempt_reservations reservation
  where (reservation.job_id, reservation.attempt_count) = (p_job_id, p_attempt_count);
  already_reserved := found;
  if already_reserved and (existing.root_session_id, existing.workspace_id, existing.factory_id, existing.session_id)
    is distinct from (p_execution.root_session_id, p_execution.workspace_id, p_execution.factory_id, p_session_id) then
    return false;
  end if;
  select revision.requirements into configured_limits
  from public.sessions root
  left join public.execution_policy_revisions revision on
    (revision.workspace_id, revision.id) = (root.workspace_id, root.execution_policy_revision_id)
  where (root.id, root.workspace_id, root.factory_id) =
    (p_execution.root_session_id, p_execution.workspace_id, p_execution.factory_id);
  root_tokens := least((configured_limits->>'maxTotalTokens')::bigint, (policy->>'maxTotalTokens')::bigint);
  root_cost := least((configured_limits->>'maxCostUsd')::numeric, (policy->>'maxCostUsd')::numeric);
  select * into consumed from internal.factory_workflow_attempt_budget(p_execution.root_session_id, policy);
  if consumed.attempts + (case when already_reserved then 0 else 1 end) > (policy->>'maxAttempts')::integer
    or consumed.tokens + (case when already_reserved then 0 else tokens_per_attempt end) > root_tokens
    or consumed.spend_usd + (case when already_reserved then 0 else cost_per_attempt end) > root_cost
    or (p_session_id <> p_execution.root_session_id and consumed.active_children +
      (case when already_reserved then 0 else 1 end) > (policy->>'maxConcurrentChildren')::integer) then
    return false;
  end if;
  if already_reserved then return true; end if;
  insert into internal.factory_workflow_attempt_reservations (
    root_session_id, workspace_id, factory_id, session_id, job_id, attempt_count,
    reserved_tokens, reserved_cost_usd
  ) values (
    p_execution.root_session_id, p_execution.workspace_id, p_execution.factory_id,
    p_session_id, p_job_id, p_attempt_count, tokens_per_attempt, cost_per_attempt
  );
  return true;
end;
$$;
revoke all on function internal.reserve_factory_workflow_attempt(
  internal.factory_workflow_executions, uuid, uuid, integer
) from public, anon, authenticated, service_role;

create function internal.bind_factory_workflow_attempt(
  p_root_session_id uuid, p_job_id uuid, p_attempt_count integer, p_run_id uuid
) returns boolean language sql set search_path = '' as $$
  with bound as (
    update internal.factory_workflow_attempt_reservations reserve
    set run_id = run.id
    from public.agent_runs run
    where (reserve.root_session_id, reserve.job_id, reserve.attempt_count) =
      (p_root_session_id, p_job_id, p_attempt_count)
      and (run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.id) =
        (reserve.workspace_id, reserve.session_id, reserve.job_id, reserve.attempt_count, p_run_id)
      and run.status = 'running'
      and (reserve.run_id is null or reserve.run_id = p_run_id)
    returning reserve.run_id
  )
  select exists(select 1 from bound);
$$;
revoke all on function internal.bind_factory_workflow_attempt(uuid, uuid, integer, uuid)
  from public, anon, authenticated, service_role;

-- Provider receipts carry absolute totals for their exact attempt. A measured
-- receipt supersedes an estimate. Reordered receipts of the same provenance
-- can raise the charge and cannot erase prior usage. Null retains unavailable.
-- This does not touch the run or job lifecycle, including after cancellation.
create function internal.charge_factory_workflow_attempt(
  p_root_session_id uuid, p_job_id uuid, p_attempt_count integer, p_run_id uuid,
  p_tokens bigint, p_token_provenance text, p_cost_usd numeric, p_cost_provenance text
) returns boolean language sql set search_path = '' as $$
  with charged as (
    update internal.factory_workflow_attempt_reservations reserve
    set reported_tokens = case
          when p_tokens is null then reserve.reported_tokens
          when p_token_provenance = reserve.token_provenance
            then greatest(p_tokens, reserve.reported_tokens)
          when reserve.token_provenance = 'measured' then reserve.reported_tokens
          else p_tokens
        end,
        token_provenance = case
          when p_tokens is null or reserve.token_provenance = 'measured' then reserve.token_provenance
          else p_token_provenance
        end,
        reported_cost_usd = case
          when p_cost_usd is null then reserve.reported_cost_usd
          when p_cost_provenance = reserve.cost_provenance
            then greatest(p_cost_usd, reserve.reported_cost_usd)
          when reserve.cost_provenance = 'measured' then reserve.reported_cost_usd
          else p_cost_usd
        end,
        cost_provenance = case
          when p_cost_usd is null or reserve.cost_provenance = 'measured' then reserve.cost_provenance
          else p_cost_provenance
        end
    where (reserve.root_session_id, reserve.job_id, reserve.attempt_count, reserve.run_id) =
      (p_root_session_id, p_job_id, p_attempt_count, p_run_id)
    returning reserve.run_id
  )
  select exists(select 1 from charged);
$$;
revoke all on function internal.charge_factory_workflow_attempt(
  uuid, uuid, integer, uuid, bigint, text, numeric, text
) from public, anon, authenticated, service_role;

-- Prospective integration. Install this receipt table in place of the source
-- contract's standalone table, then install the source contract triggers.
-- Claim/start must recheck root and parent grant authority before child execution.
create table internal.factory_workflow_delegations (
  child_session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  root_session_id uuid not null,
  parent_session_id uuid not null,
  target_occurrence_id uuid not null,
  source_route_occurrence_id uuid not null,
  source_route_decision_id uuid not null,
  source_transition_id uuid not null,
  source_checkpoint_run_id uuid not null,
  child_definition_revision_id uuid not null,
  child_definition_digest text not null check (child_definition_digest collate "C" ~ '^[0-9a-f]{64}$'),
  child_job_id uuid not null,
  child_run_id uuid not null,
  title_sha256 text not null check (title_sha256 collate "C" ~ '^[0-9a-f]{64}$'),
  prompt_sha256 text not null check (prompt_sha256 collate "C" ~ '^[0-9a-f]{64}$'),
  recorded_generation bigint not null check (recorded_generation between 1 and 9007199254740991),
  repository_id uuid not null,
  repository_full_name text not null,
  base_branch text not null,
  initial_base_sha text not null,
  input_sha text not null,
  input_ref text,
  created_at timestamptz not null default clock_timestamp(),
  unique (root_session_id, target_occurrence_id),
  check (child_session_id <> parent_session_id and child_session_id <> root_session_id),
  foreign key (child_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  foreign key (parent_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) deferrable initially deferred,
  foreign key (root_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) deferrable initially deferred,
  foreign key (root_session_id, target_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) deferrable initially deferred,
  foreign key (root_session_id, source_route_decision_id)
    references internal.factory_workflow_route_decisions(root_session_id, decision_id) deferrable initially deferred,
  foreign key (root_session_id, source_transition_id)
    references internal.factory_workflow_transition_receipts(root_session_id, transition_id) deferrable initially deferred,
  foreign key (source_checkpoint_run_id)
    references public.session_git_checkpoints(run_id) deferrable initially deferred
);
alter table internal.factory_workflow_delegations enable row level security;
revoke all on table internal.factory_workflow_delegations from public, anon, authenticated, service_role;
create index factory_workflow_delegations_parent_idx on internal.factory_workflow_delegations(parent_session_id);
create index factory_workflow_delegations_source_idx on internal.factory_workflow_delegations(source_checkpoint_run_id);

-- Grants and their effective definition scopes both bound a child. A grant can
-- be wider than the immutable definition that actually exercises it.
create function internal.factory_workflow_delegated_scope_is_subset(
  p_child_grant public.factory_execution_grants, p_ancestor_grant public.factory_execution_grants,
  p_child_definition jsonb, p_ancestor_definition jsonb
) returns boolean language sql immutable set search_path = '' as $$
  select p_child_grant.id is not null and p_ancestor_grant.id is not null
    and (p_child_grant.workspace_id, p_child_grant.factory_id, p_child_grant.service_principal_id,
      p_child_grant.github_repository_id, p_child_grant.execution_policy_revision_id, p_child_grant.budget_payer_member_id) =
      (p_ancestor_grant.workspace_id, p_ancestor_grant.factory_id, p_ancestor_grant.service_principal_id,
        p_ancestor_grant.github_repository_id, p_ancestor_grant.execution_policy_revision_id, p_ancestor_grant.budget_payer_member_id)
    and p_child_grant.expires_at <= p_ancestor_grant.expires_at
    and p_child_grant.read_context_repository_ids <@ p_ancestor_grant.read_context_repository_ids
    and p_child_grant.tool_ids <@ p_ancestor_grant.tool_ids
    and p_child_grant.command_scopes <@ p_ancestor_grant.command_scopes
    and coalesce(p_child_definition->'readContextRepositoryIds', '[]'::jsonb)
      <@ coalesce(p_ancestor_definition->'readContextRepositoryIds', '[]'::jsonb)
    and coalesce(p_child_definition->'toolIds', '[]'::jsonb) <@ coalesce(p_ancestor_definition->'toolIds', '[]'::jsonb)
$$;
revoke all on function internal.factory_workflow_delegated_scope_is_subset(
  public.factory_execution_grants, public.factory_execution_grants, jsonb, jsonb
) from public, anon, authenticated, service_role;

create function public.admit_factory_workflow_delegated_session(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint, p_ownership_token uuid,
  p_parent_session_id uuid, p_target_occurrence_id uuid, p_source_checkpoint_run_id uuid, p_title text, p_prompt_md text
) returns table (child_session_id uuid, job_id uuid, run_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  prior internal.factory_workflow_delegations;
  arrival record;
  root public.sessions;
  parent public.sessions;
  expected_parent_id uuid;
  plan jsonb;
  target_node jsonb;
  target_profile jsonb;
  existing_children bigint;
  child_profile public.factory_definition_revisions;
  root_definition jsonb;
  parent_definition jsonb;
  child_definition jsonb;
  actual_child_definition jsonb;
  root_grant public.factory_execution_grants;
  parent_grant public.factory_execution_grants;
  child_grant public.factory_execution_grants;
  source_repository_id uuid;
  actor internal.session_mutation_actor;
  child record;
  intent_title_hash text;
  intent_prompt_hash text;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if p_title is null or char_length(btrim(p_title)) not between 1 and 200
    or p_prompt_md is null or char_length(btrim(p_prompt_md)) not between 1 and 20000 then
    raise exception 'A bounded delegated title and prompt are required.' using errcode = '22023';
  end if;
  intent_title_hash := encode(sha256(convert_to(btrim(p_title), 'UTF8')), 'hex');
  intent_prompt_hash := encode(sha256(convert_to(btrim(p_prompt_md), 'UTF8')), 'hex');

  select receipt.* into prior from internal.factory_workflow_delegations receipt
  where (receipt.root_session_id, receipt.target_occurrence_id) = (p_root_session_id, p_target_occurrence_id);
  if found then
    if (prior.parent_session_id, prior.source_checkpoint_run_id, prior.title_sha256, prior.prompt_sha256) is distinct from
      (p_parent_session_id, p_source_checkpoint_run_id, intent_title_hash, intent_prompt_hash) then
      raise exception 'The workflow occurrence was already delegated with different input.' using errcode = 'PT409';
    end if;
    return query select prior.child_session_id, prior.child_job_id, prior.child_run_id, false;
    return;
  end if;

  select transition.transition_id, transition.source_occurrence_id, decision.decision_id, target.node_id into arrival
  from internal.factory_workflow_transition_receipts transition
  join internal.factory_workflow_route_decisions decision
    on (decision.root_session_id, decision.route_occurrence_id, decision.selected_edge_id, decision.selected_edge_kind) =
      (transition.root_session_id, transition.source_occurrence_id, transition.edge_id, transition.edge_kind)
  join internal.factory_workflow_node_results result
    on (result.root_session_id, result.occurrence_id, result.result_id) =
      (transition.root_session_id, transition.source_occurrence_id, transition.source_result_id)
  join internal.factory_workflow_node_occurrences target
    on (target.root_session_id, target.occurrence_id, target.node_id) =
      (transition.root_session_id, transition.target_occurrence_id, decision.selected_destination_id)
  where (transition.root_session_id, transition.target_occurrence_id, target.node_kind) =
    (p_root_session_id, p_target_occurrence_id, 'agent') and transition.edge_kind in ('route', 'loop')
    and result.outcome = 'succeeded' and result.evidence_ref = 'route:' || decision.decision_id;
  if not found or execution.graph_revision_id is null then
    raise exception 'An exact routed agent occurrence is required for delegation.' using errcode = 'PT409';
  end if;

  -- Walk occurrence identities, not node IDs. A loop creates new occurrences,
  -- and a sibling's checkpoint cannot become the parent of this route.
  with recursive ancestry(occurrence_id, distance) as (
    select arrival.source_occurrence_id, 0
    union all
    select transition.source_occurrence_id, ancestry.distance + 1
    from ancestry join internal.factory_workflow_transition_receipts transition
      on (transition.root_session_id, transition.target_occurrence_id) = (p_root_session_id, ancestry.occurrence_id)
    where ancestry.distance < 1023
  )
  select coalesce((select marker.child_session_id from ancestry join internal.factory_workflow_delegations marker
    on (marker.root_session_id, marker.target_occurrence_id) = (p_root_session_id, ancestry.occurrence_id)
    order by ancestry.distance limit 1), p_root_session_id) into expected_parent_id;
  if p_parent_session_id is distinct from expected_parent_id then
    raise exception 'The parent does not own the routed occurrence.' using errcode = '42501';
  end if;

  select session.* into strict root from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id);
  select session.* into parent from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_parent_session_id, p_workspace_id, p_factory_id)
    and session.execute_pinned_definition and session.execution_purpose = 'production'
    and (session.archived_at is null or session.phase_status = 'approved')
    and session.phase_status <> 'rejected'
  for no key update;
  if not found or not root.execute_pinned_definition or root.execution_purpose <> 'production'
    or root.phase_status = 'rejected' or (root.archived_at is not null and root.phase_status <> 'approved') then
    raise exception 'The root or parent is unavailable for delegation.' using errcode = 'PT409';
  end if;
  select checkpoint.repository_id into source_repository_id from public.session_git_heads head
  join public.session_git_checkpoints checkpoint
    on (checkpoint.run_id, checkpoint.session_id, checkpoint.workspace_id) = (head.checkpoint_run_id, head.session_id, head.workspace_id)
  where (head.session_id, head.workspace_id, head.checkpoint_run_id) = (parent.id, p_workspace_id, p_source_checkpoint_run_id)
  for share of head;
  if not found then
    raise exception 'Delegation requires the parent’s current accepted checkpoint.' using errcode = 'PT409';
  end if;

  plan := execution.workflow_json::jsonb;
  select node into strict target_node from jsonb_array_elements(plan->'nodes') node where node->>'id' = arrival.node_id;
  target_profile := plan#>array['delegationPolicy', 'targets', arrival.node_id];
  select count(*) into existing_children from internal.factory_workflow_delegations receipt
  where receipt.root_session_id = p_root_session_id;
  if existing_children >= (plan#>>'{delegationPolicy,maxChildren}')::integer then
    raise exception 'The workflow root has no remaining delegated child capacity.' using errcode = 'PT409';
  end if;
  select revision.* into child_profile from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id::text, revision.canonical_digest) =
    (p_workspace_id, p_factory_id, target_profile->>'definitionRevisionId', target_profile->>'definitionDigest')
    and exists (select 1 from public.factory_definition_activations activation
      where (activation.workspace_id, activation.factory_id, activation.revision_id) =
        (revision.workspace_id, revision.factory_id, revision.id));
  child_definition := child_profile.definition_json::jsonb;
  if not found or child_definition#>>'{implementationAgent,promptRevisionId}' is distinct from target_node->>'agentPromptRevisionId'
    or child_definition#>>'{implementationAgent,agentId}' is null
    or child_definition->>'repositoryId' is distinct from source_repository_id::text then
    raise exception 'The frozen child profile does not match the routed agent and parent source.' using errcode = 'PT422';
  end if;
  if exists (select 1 from public.delivery_policy_revisions delivery
    where (delivery.id::text, delivery.workspace_id) = (child_definition->>'deliveryPolicyRevisionId', p_workspace_id)
      and delivery.requirements->>'deliveryMode' = 'code'
      and delivery.requirements->'requireArtifactApprovalForDelivery' = 'true'::jsonb) then
    raise exception 'The child delivery policy requires a pull request that delegated children cannot publish.' using errcode = 'PT422';
  end if;

  perform internal.recheck_session_execution_grant(root);
  root_definition := internal.pinned_session_execution_definition(root);
  select grant_row.* into root_grant from public.session_factory_admission_inputs pin
  join public.factory_execution_grants grant_row on (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.version) =
    (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version)
  where pin.session_id = root.id;
  if parent.id = root.id then
    parent_definition := root_definition;
    parent_grant := root_grant;
  else
    perform internal.recheck_session_execution_grant(parent);
    parent_definition := internal.pinned_session_execution_definition(parent);
    select grant_row.* into parent_grant from public.session_factory_admission_inputs pin
    join public.factory_execution_grants grant_row on (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.version) =
      (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version)
    where pin.session_id = parent.id;
  end if;
  child_grant := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, child_definition,
    source_repository_id, (child_definition->>'executionPolicyRevisionId')::uuid);
  -- The route declaration authorizes the root envelope. The frozen child
  -- profile may bind a distinct grant contained within this envelope.
  if internal.factory_workflow_delegated_scope_is_subset(child_grant, root_grant, child_definition, root_definition) is not true
    or internal.factory_workflow_delegated_scope_is_subset(child_grant, parent_grant, child_definition, parent_definition) is not true
    or (target_node ? 'grantId' and not exists (
      select 1 from jsonb_array_elements(plan->'grants') declared
      where (declared->>'id', declared->'version') = (root_grant.id::text, to_jsonb(root_grant.version))
        and declared->>'id' = target_node->>'grantId'
    )) then
    raise exception 'The frozen child profile exceeds inherited execution authority.' using errcode = '42501';
  end if;
  perform internal.lock_definition_credential_binding(p_workspace_id, p_factory_id, child_definition,
    child_grant.id, child_grant.service_principal_id);

  actor := row(p_workspace_id, p_factory_id, null, child_grant.service_principal_id, null,
    child_grant.id, child_grant.version, source_repository_id, null)::internal.session_mutation_actor;
  select * into strict child from internal.create_attributed_session_from_profile(
    p_workspace_id, null, p_title, p_prompt_md, child_definition#>>'{agent,provider}', child_definition#>>'{agent,model}',
    null, null, source_repository_id, null, null, actor, (child_definition#>>'{implementationAgent,agentId}')::uuid,
    child_profile.canonical_digest, child_profile.id);
  select internal.pinned_session_execution_definition(session) into strict actual_child_definition
  from public.sessions session where session.id = child.session_id;
  if actual_child_definition is distinct from child_definition then
    raise exception 'The admitted child must retain the exact frozen execution profile.' using errcode = 'PT422';
  end if;

  insert into internal.factory_workflow_delegations (
    child_session_id, workspace_id, factory_id, root_session_id, parent_session_id, target_occurrence_id,
    source_route_occurrence_id, source_route_decision_id, source_transition_id, source_checkpoint_run_id,
    child_definition_revision_id, child_definition_digest, child_job_id, child_run_id,
    title_sha256, prompt_sha256, recorded_generation
  ) values (
    child.session_id, p_workspace_id, p_factory_id, p_root_session_id, parent.id, p_target_occurrence_id,
    arrival.source_occurrence_id, arrival.decision_id, arrival.transition_id, p_source_checkpoint_run_id,
    child_profile.id, child_profile.canonical_digest, child.job_id, child.run_id,
    intent_title_hash, intent_prompt_hash, execution.generation
  );
  perform internal.prepare_session_job_git_input(child.job_id);
  if not internal.reserve_factory_workflow_attempt(execution, child.session_id, child.job_id, 1) then
    raise exception 'The workflow root has no remaining child attempt capacity.' using errcode = 'PT409';
  end if;
  return query select child.session_id::uuid, child.job_id::uuid, child.run_id::uuid, true;
end;
$$;
revoke all on function public.admit_factory_workflow_delegated_session(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admit_factory_workflow_delegated_session(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, text, text)
  to service_role;

create function internal.delegated_workflow_git_input(p_child_session_id uuid, p_workspace_id uuid)
returns table(repository_id uuid, repository_full_name text, base_branch text, initial_base_sha text,
  input_sha text, input_ref text, source_checkpoint_run_id uuid)
language sql stable security definer set search_path = '' as $$
  select delegation.repository_id, delegation.repository_full_name, delegation.base_branch,
    delegation.initial_base_sha, delegation.input_sha, delegation.input_ref, delegation.source_checkpoint_run_id
  from internal.factory_workflow_delegations delegation
  where (delegation.child_session_id, delegation.workspace_id) = (p_child_session_id, p_workspace_id)
$$;

create function internal.workflow_session_can_publish_pull_request(p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from internal.factory_workflow_delegations delegation
    where delegation.child_session_id = p_session_id
  )
$$;
revoke all on function internal.delegated_workflow_git_input(uuid, uuid),
  internal.workflow_session_can_publish_pull_request(uuid) from public, anon, authenticated, service_role;
grant execute on function internal.delegated_workflow_git_input(uuid, uuid),
  internal.workflow_session_can_publish_pull_request(uuid) to service_role;

create function internal.freeze_factory_workflow_delegation_source()
returns trigger language plpgsql set search_path = '' as $$
declare child public.sessions; source record;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.sessions where id = old.child_session_id) then return old; end if;
    raise exception 'The delegated workflow source is immutable.' using errcode='23514';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'The delegated workflow source is immutable.' using errcode='23514';
  end if;

  -- Admission must run root, parent, child in this order. None of the source
  -- read paths acquire an ancestor lock after acquiring a child/job lock.
  perform 1 from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (new.root_session_id, new.workspace_id, new.factory_id)
    and session.execution_purpose = 'production'
    and (session.archived_at is null or session.phase_status = 'approved')
    and session.phase_status <> 'rejected'
  for no key update;
  if not found then raise exception 'Delegated workflow root is unavailable.' using errcode='42501'; end if;
  perform 1 from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (new.parent_session_id, new.workspace_id, new.factory_id)
    and session.execution_purpose = 'production'
    and (session.archived_at is null or session.phase_status = 'approved')
    and session.phase_status <> 'rejected'
  for no key update;
  if not found or (new.parent_session_id <> new.root_session_id and not exists (
    select 1 from internal.factory_workflow_delegations parent
    where (parent.child_session_id, parent.workspace_id, parent.factory_id, parent.root_session_id) =
      (new.parent_session_id, new.workspace_id, new.factory_id, new.root_session_id)
  )) then
    raise exception 'Delegated workflow parent is unavailable in this root.' using errcode='42501';
  end if;

  select session.* into child from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (new.child_session_id, new.workspace_id, new.factory_id)
    and session.execution_purpose = 'production' and session.archived_at is null
  for no key update;
  if not found or exists (select 1 from public.session_git_roots where session_id = new.child_session_id)
    or exists (select 1 from public.session_pull_requests where session_id = new.child_session_id)
    or exists (select 1 from public.session_pr_sync where session_id = new.child_session_id)
    or exists (select 1 from public.agent_jobs where session_id = new.child_session_id and status <> 'queued')
  then
    raise exception 'Delegation requires a fresh child session.' using errcode='23514';
  end if;

  select * into strict source from internal.checkpoint_execution_input(
    new.source_checkpoint_run_id, new.parent_session_id, new.workspace_id
  );
  if internal.session_writable_repository_id(child) is distinct from source.repository_id then
    raise exception 'Delegated source repository does not match the child.' using errcode='42501';
  end if;
  new.repository_id := source.repository_id;
  new.repository_full_name := source.repository_full_name;
  new.base_branch := source.base_branch;
  new.initial_base_sha := source.initial_base_sha;
  new.input_sha := source.input_sha;
  new.input_ref := source.input_ref;
  return new;
end;
$$;

create function internal.initialize_factory_workflow_child_git_root()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into public.session_git_roots (
    session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha
  ) values (
    new.child_session_id, new.workspace_id, new.repository_id,
    new.repository_full_name, new.base_branch, new.initial_base_sha
  );
  return new;
end;
$$;

create function internal.require_workflow_pull_request_publisher()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not internal.workflow_session_can_publish_pull_request(new.session_id) then
    raise exception 'A delegated child cannot publish or link a pull request.' using errcode='42501';
  end if;
  return new;
end;
$$;

revoke all on function internal.freeze_factory_workflow_delegation_source(),
  internal.initialize_factory_workflow_child_git_root(), internal.require_workflow_pull_request_publisher()
  from public, anon, authenticated, service_role;
create trigger freeze_factory_workflow_delegation_source before insert or update or delete
  on internal.factory_workflow_delegations for each row
  execute function internal.freeze_factory_workflow_delegation_source();
create trigger initialize_factory_workflow_child_git_root after insert
  on internal.factory_workflow_delegations for each row
  execute function internal.initialize_factory_workflow_child_git_root();

-- These insert guards also cover a legacy direct PR link, even if its RPC
-- reaches an existing branch conflict. Private checkpoint publication is separate.
create trigger require_workflow_pull_request_publisher before insert or update of session_id, workspace_id
  on public.session_pull_requests for each row execute function internal.require_workflow_pull_request_publisher();
create trigger require_workflow_pull_request_publisher before insert or update of session_id, workspace_id
  on public.session_pr_sync for each row execute function internal.require_workflow_pull_request_publisher();
create trigger require_workflow_pull_request_publisher before insert or update of session_id, workspace_id
  on public.session_pr_epochs for each row execute function internal.require_workflow_pull_request_publisher();
create trigger require_workflow_pull_request_publisher before insert or update of session_id, workspace_id
  on public.session_pr_operations for each row execute function internal.require_workflow_pull_request_publisher();
create trigger require_workflow_pull_request_publisher before insert or update of session_id, workspace_id
  on public.session_pr_refresh_queue for each row execute function internal.require_workflow_pull_request_publisher();

create or replace function internal.session_execution_input(p_session_id uuid,p_workspace_id uuid)
returns table(repository_id uuid,repository_full_name text,base_branch text,initial_base_sha text,
  input_sha text,input_ref text,source_checkpoint_run_id uuid)
language plpgsql security invoker set search_path='' as $$
declare s public.sessions%rowtype; root public.session_git_roots%rowtype; head public.session_git_heads%rowtype;
begin
  select * into s from public.sessions where id=p_session_id and workspace_id=p_workspace_id;
  if not found then raise exception 'Session not found.' using errcode='P0002'; end if;
  select * into root from public.session_git_roots where session_id=s.id and workspace_id=s.workspace_id;
  if not found then
    if exists (select 1 from internal.delegated_workflow_git_input(s.id, s.workspace_id)) then
      raise exception 'Delegated Git root is unavailable.' using errcode='55000';
    end if;
    return;
  end if;
  if s.current_artifact_id is not null and not exists(select 1 from public.session_git_checkpoints checkpoint
    where checkpoint.artifact_id=s.current_artifact_id and checkpoint.session_id=s.id and checkpoint.workspace_id=s.workspace_id) then
    raise exception 'Reviewed artifact has no restorable Git checkpoint. Start a new session with the intended source.' using errcode='55000';
  end if;
  select * into head from public.session_git_heads where session_id=s.id and workspace_id=s.workspace_id;
  if found then
    return query select * from internal.checkpoint_execution_input(head.checkpoint_run_id,s.id,s.workspace_id);
    return;
  end if;
  if exists(select 1 from public.session_artifacts artifact where artifact.session_id=s.id)
    or exists(select 1 from public.session_git_checkpoints checkpoint where checkpoint.session_id=s.id) then
    raise exception 'Accepted Git checkpoint is unavailable. Start a new session with the intended source.' using errcode='55000';
  end if;
  return query select * from internal.delegated_workflow_git_input(s.id, s.workspace_id);
  if found then return; end if;
  return query select root.repository_id,root.repository_full_name,root.base_branch,root.initial_base_sha,
    root.initial_base_sha,null::text,null::uuid;
end;
$$;

create or replace function internal.guard_git_lineage()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  s public.sessions%rowtype;
  j public.agent_jobs%rowtype;
  r public.agent_runs%rowtype;
  root public.session_git_roots%rowtype;
  pinned public.session_job_git_inputs%rowtype;
  d public.session_source_deliveries%rowtype;
  repository public.github_repositories%rowtype;
  selected record;
  delegated record;
begin
  if tg_op = 'UPDATE' then
    if tg_table_name<>'session_job_git_inputs' then
      raise exception 'Git lineage is immutable.' using errcode='23514';
    end if;
    if old.pinned_run_id is not null or old.pinned_attempt_count is not null
      or new.pinned_run_id is null or new.pinned_attempt_count is null
      or new.job_id is distinct from old.job_id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id or new.repository_id is distinct from old.repository_id
      or new.repository_full_name is distinct from old.repository_full_name or new.base_branch is distinct from old.base_branch
      or new.initial_base_sha is distinct from old.initial_base_sha or new.input_sha is distinct from old.input_sha
      or new.input_ref is distinct from old.input_ref or new.source_checkpoint_run_id is distinct from old.source_checkpoint_run_id
      or new.created_at is distinct from old.created_at then
      raise exception 'Git lineage is immutable.' using errcode='23514';
    end if;
  end if;
  if tg_op = 'DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id)
      or not exists(select 1 from public.sessions where id=old.session_id) then return old; end if;
    raise exception 'Git lineage is immutable.' using errcode = '23514';
  end if;
  perform internal.assert_workspace_accepts_work(new.workspace_id);
  select * into s from public.sessions where id=new.session_id and workspace_id=new.workspace_id for no key update;
  if not found then raise exception 'Git lineage session is not in the workspace.' using errcode='23514'; end if;
  select * into delegated from internal.delegated_workflow_git_input(s.id, s.workspace_id);
  if tg_table_name='session_git_roots' then
    if delegated.source_checkpoint_run_id is not null and
      (new.repository_id, new.repository_full_name, new.base_branch, new.initial_base_sha) is distinct from
      (delegated.repository_id, delegated.repository_full_name, delegated.base_branch, delegated.initial_base_sha)
    then
      raise exception 'Delegated Git root does not match the frozen source.' using errcode='23514';
    end if;
    select * into repository from public.github_repositories
      where id=new.repository_id and workspace_id=new.workspace_id and not is_archived;
    if not found or repository.full_name is distinct from new.repository_full_name
      or (s.github_repository_id is not null and s.github_repository_id<>new.repository_id) then
      raise exception 'Git lineage repository does not match the session.' using errcode='23514';
    end if;
  elsif tg_table_name='session_job_git_inputs' then
    select * into root from public.session_git_roots where session_id=s.id;
    select * into j from public.agent_jobs where id=new.job_id for update;
    if root.workspace_id is distinct from new.workspace_id or root.repository_id is distinct from new.repository_id
      or root.repository_full_name is distinct from new.repository_full_name
      or root.initial_base_sha is distinct from new.initial_base_sha or root.base_branch is distinct from new.base_branch
      or (s.github_repository_id is not null and s.github_repository_id<>new.repository_id)
      or j.session_id is distinct from s.id or j.workspace_id is distinct from s.workspace_id
      or j.stage_id is distinct from s.current_stage_id or s.archived_at is not null then
      raise exception 'Git input does not match the current execution.' using errcode='23514';
    end if;
    if new.source_checkpoint_run_id is null then
      if delegated.source_checkpoint_run_id is not null
        or new.input_sha is distinct from root.initial_base_sha or new.input_ref is not null
        or (tg_op='INSERT' and exists(select 1 from public.session_git_heads where session_id=s.id)) then
        raise exception 'Git input does not match the current execution.' using errcode='23514';
      end if;
    else
      if new.source_checkpoint_run_id = delegated.source_checkpoint_run_id then
        selected := delegated;
        if tg_op='INSERT' and exists (select 1 from public.session_git_heads
          where session_id=s.id and workspace_id=s.workspace_id) then
          raise exception 'Git input does not match the current execution.' using errcode='23514';
        end if;
      else
        select * into selected from internal.checkpoint_execution_input(new.source_checkpoint_run_id,s.id,s.workspace_id);
        if tg_op='INSERT' and not exists(select 1 from public.session_git_heads
          where session_id=s.id and workspace_id=s.workspace_id and checkpoint_run_id=new.source_checkpoint_run_id) then
          raise exception 'Git input does not match the current execution.' using errcode='23514';
        end if;
      end if;
      if selected.repository_id is distinct from new.repository_id
        or selected.repository_full_name is distinct from new.repository_full_name
        or selected.base_branch is distinct from new.base_branch or selected.initial_base_sha is distinct from new.initial_base_sha
        or selected.input_sha is distinct from new.input_sha or selected.input_ref is distinct from new.input_ref then
        raise exception 'Git input does not match the current execution.' using errcode='23514';
      end if;
    end if;
    if new.pinned_run_id is null and new.pinned_attempt_count is null then
      if tg_op<>'INSERT' or j.status<>'queued' or s.phase_status not in ('in_progress','rejected','awaiting_review') then
        raise exception 'Git input does not match the current execution.' using errcode='23514';
      end if;
    else
      select * into r from public.agent_runs where id=new.pinned_run_id for update;
      if j.status not in ('started','running') or j.attempt_count is distinct from new.pinned_attempt_count
        or r.agent_job_id is distinct from j.id or r.workspace_id is distinct from s.workspace_id
        or r.session_id is distinct from s.id or r.stage_id is distinct from j.stage_id
        or r.attempt_count is distinct from j.attempt_count or r.status is distinct from 'running'
        or s.phase_status is distinct from 'in_progress' then
        raise exception 'Git input does not match the current execution.' using errcode='23514';
      end if;
    end if;
  else
    select * into pinned from public.session_job_git_inputs where job_id=new.job_id;
    select * into j from public.agent_jobs where id=new.job_id for update;
    select * into r from public.agent_runs where id=new.run_id for update;
    select * into d from public.session_source_deliveries where run_id=new.run_id;
    if pinned.pinned_run_id is null or pinned.pinned_attempt_count is null
      or pinned.session_id is distinct from s.id or pinned.workspace_id is distinct from s.workspace_id
      or pinned.repository_id is distinct from new.repository_id
      or pinned.repository_full_name is distinct from new.repository_full_name
      or pinned.initial_base_sha is distinct from new.initial_base_sha or pinned.input_sha is distinct from new.input_sha
      or (s.github_repository_id is not null and s.github_repository_id<>new.repository_id)
      or j.session_id is distinct from s.id or j.workspace_id is distinct from s.workspace_id
      or j.attempt_count is distinct from new.attempt_count or j.status not in ('started','running')
      or r.agent_job_id is distinct from j.id or r.workspace_id is distinct from s.workspace_id
      or r.session_id is distinct from s.id or r.stage_id is distinct from j.stage_id
      or r.attempt_count is distinct from j.attempt_count or r.status is distinct from 'success'
      or s.current_artifact_id is distinct from new.artifact_id
      or not exists(select 1 from public.session_artifacts a where a.id=new.artifact_id
        and a.workspace_id=s.workspace_id and a.session_id=s.id and a.stage_id=r.stage_id)
      or d.job_id is distinct from j.id or d.attempt_count is distinct from new.attempt_count
      or d.workspace_id is distinct from s.workspace_id or d.session_id is distinct from s.id
      or d.repository_id is distinct from new.repository_id or d.repository_full_name is distinct from new.repository_full_name
      or d.base_sha is distinct from new.input_sha or d.head_sha is distinct from new.output_sha
      or d.branch_name is distinct from r.branch_name
      or (d.base_sha=d.head_sha and new.output_ref is not null)
      or (d.base_sha<>d.head_sha and not exists(select 1 from public.session_checkpoint_publications p
        where p.run_id=r.id and p.status='claimed' and p.claim_id is not null
          and p.workspace_id=s.workspace_id and p.session_id=s.id and p.job_id=j.id and p.attempt_count=r.attempt_count
          and p.remote_verified_sha=d.head_sha and p.remote_verified_ref=p.retained_ref
          and p.retained_ref=new.output_ref and p.remote_verified_at is not null
          and p.lease_expires_at>clock_timestamp() and p.deadline_at>clock_timestamp()))
      or d.checkpoint_path is distinct from new.checkpoint_path or d.bundle_sha256 is distinct from new.bundle_sha256 then
      raise exception 'Git checkpoint does not match the accepted execution and artifact.' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function internal.enqueue_session_pr_sync()
returns trigger language plpgsql security definer set search_path='' as $$
declare checkpoint public.session_git_checkpoints; producer public.session_job_git_inputs; effective_ref text;
begin
  if not internal.workflow_session_can_publish_pull_request(new.session_id) then return new; end if;
  select * into strict checkpoint from public.session_git_checkpoints where run_id=new.checkpoint_run_id;
  select * into strict producer from public.session_job_git_inputs where job_id=checkpoint.job_id;
  effective_ref:=case when checkpoint.output_kind='code' then checkpoint.output_ref else producer.input_ref end;
  -- Do not call checkpoint_execution_input here: adoption has inserted the
  -- checkpoint but its private publication receipt is not yet marked adopted.
  insert into public.session_pr_sync(session_id,workspace_id,desired_checkpoint_run_id,status)
  values(new.session_id,new.workspace_id,new.checkpoint_run_id,case when effective_ref is null then 'not_needed' else 'pending' end)
  on conflict(session_id) do update set desired_checkpoint_run_id=excluded.desired_checkpoint_run_id,
    target_generation=session_pr_sync.target_generation+1,
    status=case when exists(select 1 from public.session_pr_epochs e where e.id=session_pr_sync.current_epoch_id and e.pr_state in ('closed','merged'))
      then 'successor_required' when effective_ref is null and session_pr_sync.current_epoch_id is null then 'not_needed' else 'pending' end,
    last_error_code=null,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp();
  return new;
end;
$$;

create or replace function internal.session_pr_is_eligible(p_session_id uuid,p_workspace_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.sessions s join public.workspaces w on w.id=s.workspace_id
    where s.id=p_session_id and s.workspace_id=p_workspace_id and w.deletion_requested_at is null
      and s.execution_purpose = 'production'
      and internal.workflow_session_can_publish_pull_request(s.id)
      and (s.archived_at is null or s.phase_status='approved'));
$$;

create or replace function internal.source_delivery_is_eligible(delivery public.session_source_deliveries)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.agent_runs r
    join public.agent_jobs j on j.id=delivery.job_id
    join public.sessions s on s.id=delivery.session_id
    join public.workspaces w on w.id=delivery.workspace_id
    where r.id=delivery.run_id and r.status='success' and r.agent_job_id=j.id
      and r.attempt_count=delivery.attempt_count and j.attempt_count=delivery.attempt_count
      and r.workspace_id=w.id and j.workspace_id=w.id and s.workspace_id=w.id
      and r.session_id=s.id and j.session_id=s.id and j.status in ('started','running','success')
      and s.execution_purpose = 'production'
      and internal.workflow_session_can_publish_pull_request(s.id)
      and (s.archived_at is null or (s.phase_status='approved' and j.status='success'))
      and w.deletion_requested_at is null and delivery.repository_id is not null
      and not exists(select 1 from public.session_pr_sync managed where managed.session_id=s.id and managed.workspace_id=w.id));
$$;

-- Keep the compiler primary. Enrollment independently enforces the native
-- runtime subset and exact immutable profile references before making work.
create function internal.is_enrollable_factory_workflow_delegation(
  p_workspace_id uuid, p_factory_id uuid, p_plan jsonb
) returns boolean
language plpgsql stable set search_path = '' as $$
declare
  policy jsonb := p_plan->'delegationPolicy';
  targets jsonb := policy->'targets';
  agent_count integer;
begin
  select count(*) into agent_count from jsonb_array_elements(p_plan->'nodes') node
  where node->>'kind' = 'agent';
  if agent_count = 0 then
    return policy is null;
  end if;
  if jsonb_typeof(policy) is distinct from 'object' or jsonb_typeof(targets) is distinct from 'object' then
    return false;
  end if;
  if policy - array['targets', 'maxChildren', 'maxConcurrentChildren', 'maxAttempts',
      'maxTotalTokens', 'maxTokensPerAttempt', 'maxCostUsd', 'maxCostUsdPerAttempt'] <> '{}'::jsonb
    or (select count(*) from jsonb_object_keys(targets)) <> agent_count then
    return false;
  end if;

  if exists (select 1 from unnest(array['maxChildren', 'maxConcurrentChildren', 'maxAttempts',
      'maxTotalTokens', 'maxTokensPerAttempt']) as limit_key(name)
    where jsonb_typeof(policy->limit_key.name) is distinct from 'number'
      or (policy->>limit_key.name) collate "C" !~ '^[1-9][0-9]{0,12}$')
    or jsonb_typeof(policy->'maxCostUsd') is distinct from 'number'
    or jsonb_typeof(policy->'maxCostUsdPerAttempt') is distinct from 'number' then
    return false;
  end if;

  if (policy->>'maxAttempts')::bigint > 1024
    or (policy->>'maxChildren')::bigint > (policy->>'maxAttempts')::bigint
    or (policy->>'maxConcurrentChildren')::bigint > (policy->>'maxChildren')::bigint
    or (policy->>'maxTotalTokens')::bigint > 1000000000000
    or (policy->>'maxTokensPerAttempt')::bigint > (policy->>'maxTotalTokens')::bigint
    or (policy->>'maxCostUsd')::numeric not between 0.000001 and 1000000
    or (policy->>'maxCostUsdPerAttempt')::numeric not between 0.000001 and (policy->>'maxCostUsd')::numeric then
    return false;
  end if;

  return not exists (
    select 1 from jsonb_array_elements(p_plan->'nodes') node
    where node->>'kind' = 'agent' and (
      node->>'id' = p_plan->>'entryNodeId'
      or exists (select 1 from jsonb_array_elements(p_plan->'edges') edge
        where edge->>'to' = node->>'id' and edge->>'kind' not in ('route', 'loop'))
      or not exists (
        select 1 from jsonb_each(targets) target
        join public.factory_definition_revisions revision on
          (revision.workspace_id, revision.factory_id, revision.id::text, revision.canonical_digest) =
          (p_workspace_id, p_factory_id, target.value->>'definitionRevisionId', target.value->>'definitionDigest')
        where target.key = node->>'id'
          and jsonb_typeof(target.value) = 'object'
          and jsonb_typeof(target.value->'definitionRevisionId') = 'string'
          and jsonb_typeof(target.value->'definitionDigest') = 'string'
          and target.value - array['definitionRevisionId', 'definitionDigest'] = '{}'::jsonb
          and revision.definition_json::jsonb#>>'{implementationAgent,promptRevisionId}' = node->>'agentPromptRevisionId'
          and revision.definition_json::jsonb ?& array['executionGrant', 'credentialBindingId']
          and not (revision.definition_json::jsonb ? 'modelRouting')
          and exists (select 1 from public.factory_definition_activations activation
            where (activation.workspace_id, activation.factory_id, activation.revision_id) =
              (revision.workspace_id, revision.factory_id, revision.id))
      )
    )
  );
end;
$$;
revoke all on function internal.is_enrollable_factory_workflow_delegation(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.start_factory_workflow_graph_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_graph_revision_id uuid,
  p_input_run_id uuid default null
) returns table (execution_generation bigint, entry_occurrence_id uuid, created boolean, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  graph internal.factory_workflow_graph_revisions;
  execution internal.factory_workflow_executions;
  input_job_id uuid;
  input_attempt_count integer;
  input_publication public.session_checkpoint_publications;
  plan jsonb;
  entry jsonb;
begin
  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select revision.* into graph from internal.factory_workflow_graph_revisions revision
    join public.session_factory_admission_inputs pin
      on (pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest) =
        (revision.workspace_id, revision.factory_id, revision.definition_revision_id, revision.definition_digest)
    join public.sessions session on session.id = pin.session_id
   where (revision.workspace_id, revision.factory_id, revision.id, pin.session_id) =
     (p_workspace_id, p_factory_id, p_graph_revision_id, p_root_session_id)
     and session.execute_pinned_definition
     and session.factory_definition_revision_id = pin.definition_revision_id;
  if not found then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  select workflow.* into execution from internal.factory_workflow_executions workflow
   where workflow.root_session_id = p_root_session_id;
  if found then
    if (execution.graph_revision_id, execution.graph_input_run_id) is distinct from (graph.id, p_input_run_id) then
      raise exception 'The root session already has a different workflow or input run.' using errcode = 'PT409';
    end if;
    return query select execution.generation, occurrence.occurrence_id, false, null::uuid
      from internal.factory_workflow_node_occurrences occurrence
     where occurrence.root_session_id = p_root_session_id and occurrence.is_entry;
    return;
  end if;

  if exists (select 1 from public.sessions session
    where session.id = p_root_session_id and session.archived_at is not null) then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  -- Existing command and route capabilities, plus guarded routed child admission.
  plan := graph.workflow_json::jsonb;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node
    where coalesce(node->>'kind', '') not in ('deterministic', 'human-gate', 'route', 'agent')
      or (node->>'kind' = 'deterministic' and coalesce(node->>'operation', '') not in ('validation', 'policy', 'checkpoint'))) then
    raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode = 'PT422';
  end if;
  if not internal.is_enrollable_factory_workflow_delegation(p_workspace_id, p_factory_id, plan) then
    raise exception 'The graph requires bounded delegation and exact scoped child profiles.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'kind' = 'route') then
    if not internal.is_bounded_factory_workflow_route_graph(plan) then
      raise exception 'The graph must match a bounded workflow route policy.' using errcode = 'PT422';
    end if;
    if exists (
      select 1 from jsonb_array_elements(plan->'nodes') node
      where node->>'kind' = 'route' and (
        jsonb_typeof(node->'agentPromptRevisionId') is distinct from 'string'
        or not exists (
          select 1 from public.factory_agent_prompt_revisions prompt
          where (prompt.workspace_id, prompt.factory_id, prompt.id::text) =
            (p_workspace_id, p_factory_id, node->>'agentPromptRevisionId')
        )
      )
    ) then
      raise exception 'The graph requires scoped route prompt revisions.' using errcode = 'PT422';
    end if;
  elsif not internal.is_bounded_factory_workflow_next_path(plan) then
    raise exception 'The graph must form one next-only path with at most 128 nodes.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'operation' = 'validation')
    and not exists (
      select 1 from public.sessions session
      join public.delivery_policy_revisions policy
        on (policy.id, policy.workspace_id, policy.pipeline_id) =
          (session.pinned_delivery_policy_revision_id, session.workspace_id, session.pipeline_id)
      where session.id = p_root_session_id and jsonb_array_length(policy.requirements->'requiredEvidence') > 0
        and not exists (
          select 1 from jsonb_array_elements_text(policy.requirements->'requiredEvidence') evidence(key)
          where evidence.key collate "C" !~
            '^([A-Za-z0-9][A-Za-z0-9._/-]{0,199}|browser:(screenshot|video):[A-Za-z0-9][A-Za-z0-9._-]{0,99})$'
        )
    ) then
    raise exception 'The graph requires a pinned delivery policy with valid required evidence.' using errcode = 'PT422';
  end if;
  if p_input_run_id is null and exists (
    select 1 from jsonb_array_elements(plan->'nodes') node
    where node->>'kind' = 'human-gate' or node->>'operation' in ('validation', 'checkpoint')
  ) then
    raise exception 'The graph requires a scoped checkpoint input run.' using errcode = 'PT422';
  end if;
  select node into strict entry from jsonb_array_elements(plan->'nodes') node where node->>'id' = plan->>'entryNodeId';

  if p_input_run_id is not null then
    -- Follow the root, job, run, publication lock order used by checkpoint adoption.
    select job.id, job.attempt_count into input_job_id, input_attempt_count
    from public.agent_jobs job
    join public.agent_runs run on (run.agent_job_id, run.session_id, run.workspace_id) =
      (job.id, job.session_id, job.workspace_id)
    where run.id = p_input_run_id and (job.session_id, job.workspace_id) = (p_root_session_id, p_workspace_id)
      and job.attempt_count > 0
    for share of job;

    perform 1 from public.agent_runs run
    where (run.id, run.agent_job_id, run.session_id, run.workspace_id, run.attempt_count) =
      (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
    for share;
    if found then
      select publication.* into input_publication from public.session_checkpoint_publications publication
      where (publication.run_id, publication.job_id, publication.session_id, publication.workspace_id, publication.attempt_count) =
        (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
      for share;
    end if;
    if input_publication.run_id is null or not (
      input_publication.status = 'adopted'
      or (input_publication.status in ('pending', 'claimed')
        and input_publication.deadline_at > clock_timestamp()
        and internal.checkpoint_publication_is_current(input_publication))
    ) then
      raise exception 'The graph input run has no current scoped checkpoint publication intent.' using errcode = 'PT409';
    end if;
  end if;

  return query
    with enrolled as (
      insert into internal.factory_workflow_executions (
        root_session_id, workspace_id, factory_id, definition_revision_id, definition_digest,
        graph_revision_id, graph_input_run_id, workflow_json, workflow_digest
      ) values (p_root_session_id, p_workspace_id, p_factory_id, graph.definition_revision_id, graph.definition_digest,
        graph.id, p_input_run_id, graph.workflow_json, graph.workflow_digest)
      returning factory_workflow_executions.generation, factory_workflow_executions.ownership_token
    ), admitted as (
      insert into internal.factory_workflow_node_occurrences (
        root_session_id, node_id, node_kind, is_entry, admitted_generation
      ) select p_root_session_id, entry->>'id', (entry->>'kind')::internal.factory_workflow_node_kind, true, enrolled.generation
        from enrolled
      returning occurrence_id
    )
    select enrolled.generation, admitted.occurrence_id, true, enrolled.ownership_token from enrolled cross join admitted;
end;
$$;

create or replace function public.record_factory_workflow_node_result(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_occurrence_id uuid, p_outcome public.factory_workflow_node_outcome,
  p_evidence_ref text default null
) returns table (result_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  node_kind internal.factory_workflow_node_kind;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select occurrence.node_kind into node_kind from internal.factory_workflow_node_occurrences occurrence
  where (occurrence.root_session_id, occurrence.occurrence_id) = (p_root_session_id, p_occurrence_id);
  if not found then raise exception 'Workflow node occurrence is unavailable.' using errcode = 'PT404'; end if;
  if execution.graph_revision_id is not null and node_kind = 'route' then
    raise exception 'This workflow node requires a guarded route decision.' using errcode = '42501';
  end if;
  if execution.graph_revision_id is not null and node_kind in ('deterministic', 'human-gate') then
    raise exception 'This workflow node requires a guarded command result.' using errcode = '42501';
  end if;
  if execution.graph_revision_id is not null and node_kind = 'agent' then
    raise exception 'A delegated agent result requires bound child-session evidence.' using errcode = '42501';
  end if;
  return query select * from internal.insert_factory_workflow_node_result(execution, p_occurrence_id, p_outcome, p_evidence_ref);
end;
$$;

-- Root commands and delegated outcomes share the exact adopted checkpoint proof.
create function internal.factory_workflow_adopted_checkpoint(
  p_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_definition_revision_id uuid,
  p_definition_digest text, p_checkpoint_run_id uuid
) returns public.session_git_checkpoints
language plpgsql set search_path = '' as $$
declare
  accepted public.session_git_checkpoints;
begin
  select checkpoint.* into accepted
  from public.session_git_checkpoints checkpoint
  join public.session_factory_admission_inputs admission
    on (admission.session_id, admission.workspace_id, admission.factory_id, admission.github_repository_id) =
       (checkpoint.session_id, checkpoint.workspace_id, p_factory_id, checkpoint.repository_id)
  join public.agent_runs run
    on (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
       (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id, checkpoint.attempt_count)
  join public.agent_jobs job
    on (job.id, job.workspace_id, job.session_id, job.attempt_count, job.stage_id) =
       (checkpoint.job_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.attempt_count, run.stage_id)
  join public.session_job_git_inputs input
    on (input.job_id, input.workspace_id, input.session_id, input.repository_id, input.repository_full_name,
        input.initial_base_sha, input.input_sha) =
       (checkpoint.job_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.repository_id,
        checkpoint.repository_full_name, checkpoint.initial_base_sha, checkpoint.input_sha)
  join public.session_source_deliveries source
    on (source.run_id, source.workspace_id, source.session_id, source.job_id, source.attempt_count,
        source.repository_id, source.repository_full_name, source.base_branch, source.base_sha, source.head_sha,
        source.branch_name) =
       (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id,
        checkpoint.attempt_count, checkpoint.repository_id, checkpoint.repository_full_name, input.base_branch,
        checkpoint.input_sha, checkpoint.output_sha, run.branch_name)
  join public.session_checkpoint_publications publication
    on (publication.run_id, publication.workspace_id, publication.session_id, publication.job_id,
        publication.attempt_count, publication.artifact_id) =
       (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id,
        checkpoint.attempt_count, checkpoint.artifact_id)
  join public.session_artifacts artifact
    on (artifact.id, artifact.workspace_id, artifact.session_id, artifact.stage_id) =
       (checkpoint.artifact_id, checkpoint.workspace_id, checkpoint.session_id, run.stage_id)
  join public.github_repositories repository
    on (repository.id, repository.workspace_id, repository.factory_id) =
       (checkpoint.repository_id, checkpoint.workspace_id, p_factory_id)
  join public.github_installations installation
    on (installation.id, installation.workspace_id, installation.installation_id) =
       (repository.github_installation_id, checkpoint.workspace_id, source.installation_id)
  where (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id) =
        (p_checkpoint_run_id, p_workspace_id, p_session_id)
    and (admission.definition_revision_id, admission.definition_digest) =
        (p_definition_revision_id, p_definition_digest)
    and run.status = 'success' and job.status = 'success'
    and publication.status = 'adopted' and publication.adopted_at is not null
    and internal.approved_predecessor_artifact_text(artifact.artifact_json) = publication.artifact_md
    and not repository.is_archived and not installation.suspended
    and case checkpoint.output_kind
      when 'code' then checkpoint.output_ref = publication.retained_ref
        and publication.remote_verified_ref = checkpoint.output_ref
        and publication.remote_verified_sha = checkpoint.output_sha
        and publication.remote_verified_at is not null
        and source.bundle_sha256 = checkpoint.bundle_sha256
      when 'no-code' then checkpoint.output_ref is null and publication.retained_ref is null
        and publication.remote_verified_ref is null and publication.remote_verified_sha is null
        and publication.remote_verified_at is null
      else false
    end
  for share of repository, installation nowait;
  return accepted;
exception when lock_not_available then
  -- Integration shutdown may already hold the provider row and wait for this session.
  return null;
end;
$$;

create or replace function internal.factory_workflow_input_checkpoint(
  p_execution internal.factory_workflow_executions
) returns public.session_git_checkpoints
language sql set search_path = '' as $$
  select internal.factory_workflow_adopted_checkpoint(p_execution.root_session_id, p_execution.workspace_id,
    p_execution.factory_id, p_execution.definition_revision_id, p_execution.definition_digest, p_execution.graph_input_run_id)
$$;

revoke all on function internal.factory_workflow_adopted_checkpoint(uuid, uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- The caller holds the workflow root and execution locks. Read the child's
-- current accepted source and exact surviving approval while owning its lock.
create function internal.factory_workflow_delegated_completion_ref(
  p_delegation internal.factory_workflow_delegations
) returns text language plpgsql set search_path = '' as $$
declare
  child public.sessions;
  final_stage jsonb;
  checkpoint_run_id uuid;
  accepted public.session_git_checkpoints;
  approval_id uuid;
begin
  if not exists (select 1 from public.sessions root
    where (root.id, root.workspace_id, root.factory_id) =
      (p_delegation.root_session_id, p_delegation.workspace_id, p_delegation.factory_id)
      and root.phase_status <> 'rejected'
      and (root.archived_at is null or root.phase_status = 'approved')) then
    return null;
  end if;

  select owner.* into child from public.sessions owner
  where (owner.id, owner.workspace_id, owner.factory_id, owner.factory_definition_revision_id) =
    (p_delegation.child_session_id, p_delegation.workspace_id, p_delegation.factory_id, p_delegation.child_definition_revision_id)
    and owner.execute_pinned_definition and owner.execution_purpose = 'production' and owner.phase_status = 'approved'
  for no key update;
  if not found or child.current_artifact_id is null then return null; end if;

  select stage.value into final_stage from public.session_factory_admission_inputs pin
  cross join lateral jsonb_array_elements(internal.pinned_session_execution_definition(child)->'stages') stage(value)
  where (pin.session_id, pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest) =
    (child.id, child.workspace_id, child.factory_id, p_delegation.child_definition_revision_id, p_delegation.child_definition_digest)
    and pin.selected_stage_ids[cardinality(pin.selected_stage_ids)] = child.current_stage_id
    and stage.value->>'id' = child.current_stage_id::text;
  if not found then return null; end if;

  select head.checkpoint_run_id into checkpoint_run_id from public.session_git_heads head
  where (head.session_id, head.workspace_id) = (child.id, child.workspace_id) for share;
  if not found then return null; end if;
  accepted := internal.factory_workflow_adopted_checkpoint(child.id, child.workspace_id, child.factory_id,
    child.factory_definition_revision_id, p_delegation.child_definition_digest, checkpoint_run_id);
  if accepted.run_id is null or accepted.artifact_id is distinct from child.current_artifact_id
    or accepted.repository_id is distinct from p_delegation.repository_id
    or accepted.initial_base_sha is distinct from p_delegation.initial_base_sha then
    return null;
  end if;

  select approval.id into approval_id from public.session_stage_approval_receipts approval
  where (approval.workspace_id, approval.session_id, approval.stage_id, approval.artifact_id, approval.artifact_version) =
    (child.workspace_id, child.id, child.current_stage_id, child.current_artifact_id, child.current_artifact_version)
  order by approval.approval_number desc limit 1;
  if not found or not internal.factory_workflow_human_approval_passes(child, accepted, final_stage, approval_id) then
    return null;
  end if;

  begin
    perform 1 from internal.checkpoint_execution_input(accepted.run_id, child.id, child.workspace_id);
    if not found then return null; end if;
  exception when object_not_in_prerequisite_state or check_violation then
    return null;
  end;
  return 'delegated-checkpoint:' || accepted.run_id;
end;
$$;
revoke all on function internal.factory_workflow_delegated_completion_ref(internal.factory_workflow_delegations)
  from public, anon, authenticated, service_role;

create function public.record_factory_workflow_delegated_result(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_occurrence_id uuid
) returns table (result_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  delegation internal.factory_workflow_delegations;
  prior internal.factory_workflow_node_results;
  completion_ref text;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.graph_revision_id is null or not exists (
    select 1 from internal.factory_workflow_node_occurrences occurrence
    where (occurrence.root_session_id, occurrence.occurrence_id, occurrence.node_kind) =
      (p_root_session_id, p_occurrence_id, 'agent')
  ) then
    raise exception 'Workflow delegated agent occurrence is unavailable.' using errcode = 'PT404';
  end if;

  select marker.* into delegation from internal.factory_workflow_delegations marker
  where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.target_occurrence_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_occurrence_id);
  if not found then return; end if;

  select result.* into prior from internal.factory_workflow_node_results result
  where (result.root_session_id, result.occurrence_id) = (p_root_session_id, p_occurrence_id);
  if found then
    if prior.outcome <> 'succeeded' or not coalesce(prior.evidence_ref collate "C" ~
      '^delegated-checkpoint:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) then
      raise exception 'The workflow node already has a different result.' using errcode = 'PT409';
    end if;
    return query select prior.result_id, false;
    return;
  end if;

  completion_ref := internal.factory_workflow_delegated_completion_ref(delegation);
  if completion_ref is null then return; end if;
  return query select * from internal.insert_factory_workflow_node_result(execution, p_occurrence_id, 'succeeded', completion_ref);
end;
$$;
revoke all on function public.record_factory_workflow_delegated_result(uuid, uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_factory_workflow_delegated_result(uuid, uuid, uuid, bigint, uuid, uuid)
  to service_role;


create or replace function public.admit_factory_workflow_next(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_source_occurrence_id uuid, p_edge_id text, p_expected_result_id uuid
) returns table (transition_id uuid, target_occurrence_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  source_node_id text;
  source_node_kind internal.factory_workflow_node_kind;
  evidence_ref text;
  completion_ref text;
  command jsonb;
  target_node jsonb;
  edge jsonb;
  target_id uuid;
  receipt internal.factory_workflow_transition_receipts;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select occurrence.node_id, occurrence.node_kind, result.evidence_ref
    into source_node_id, source_node_kind, evidence_ref
    from internal.factory_workflow_node_occurrences occurrence
    join internal.factory_workflow_node_results result
      on (result.root_session_id, result.occurrence_id) = (occurrence.root_session_id, occurrence.occurrence_id)
   where (occurrence.root_session_id, occurrence.occurrence_id, result.result_id) =
     (p_root_session_id, p_source_occurrence_id, p_expected_result_id)
     and result.outcome = 'succeeded';
  if not found then
    raise exception 'The expected successful predecessor result is unavailable.' using errcode = 'PT409';
  end if;

  if execution.graph_revision_id is not null and source_node_kind = 'route' then
    raise exception 'This workflow node requires a guarded route decision.' using errcode = '42501';
  end if;

  select candidate into edge
    from jsonb_array_elements(execution.workflow_json::jsonb->'edges') candidate
   where candidate->>'from' = source_node_id and candidate->>'id' = p_edge_id and candidate->>'kind' = 'next';
  if not found then
    raise exception 'The workflow has no matching next edge.' using errcode = '22023';
  end if;

  select transition.* into receipt from internal.factory_workflow_transition_receipts transition
   where (transition.root_session_id, transition.source_occurrence_id, transition.edge_id) =
     (p_root_session_id, p_source_occurrence_id, p_edge_id);
  if found then
    return query select receipt.transition_id, receipt.target_occurrence_id, false;
    return;
  end if;

  if execution.graph_revision_id is not null and exists (
    select 1 from public.sessions root where root.id = p_root_session_id
      and root.archived_at is not null and root.phase_status <> 'approved'
  ) then return; end if;

  if execution.graph_revision_id is not null and source_node_kind in ('deterministic', 'human-gate') then
    command := internal.factory_workflow_occurrence_command(execution, p_source_occurrence_id);
    if not internal.factory_workflow_command_evidence_is_current(execution, command, evidence_ref) then
      return;
    end if;
    if command->>'operation' is distinct from 'policy'
      and internal.refresh_session_execution_exhaustion(p_root_session_id, p_workspace_id) is not null then
      return;
    end if;
  elsif execution.graph_revision_id is not null and source_node_kind = 'agent' then
    select internal.factory_workflow_delegated_completion_ref(marker) into completion_ref
    from internal.factory_workflow_delegations marker
    where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.target_occurrence_id) =
      (p_root_session_id, p_workspace_id, p_factory_id, p_source_occurrence_id);
    if completion_ref is null or completion_ref is distinct from evidence_ref then return; end if;
  end if;

  perform internal.assert_factory_workflow_route_capacity(execution, edge);
  select node into strict target_node
    from jsonb_array_elements(execution.workflow_json::jsonb->'nodes') node
   where node->>'id' = edge->>'to';
  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  values (p_root_session_id, target_node->>'id', (target_node->>'kind')::internal.factory_workflow_node_kind, p_expected_generation)
  returning occurrence_id into target_id;
  insert into internal.factory_workflow_transition_receipts(
    root_session_id, source_occurrence_id, source_result_id, target_occurrence_id, edge_id, edge_kind, recorded_generation
  ) values (p_root_session_id, p_source_occurrence_id, p_expected_result_id, target_id, p_edge_id, 'next', p_expected_generation)
  returning * into receipt;
  return query select receipt.transition_id, receipt.target_occurrence_id, true;
end;
$$;

create function internal.find_factory_workflow_budget_root(p_session_id uuid)
returns uuid language sql stable set search_path = '' as $$
  select execution.root_session_id
  from internal.factory_workflow_executions execution
  where execution.root_session_id = coalesce((
    select delegation.root_session_id from internal.factory_workflow_delegations delegation
    where delegation.child_session_id = p_session_id
  ), p_session_id)
    and execution.workflow_json::jsonb ? 'delegationPolicy';
$$;
revoke all on function internal.find_factory_workflow_budget_root(uuid) from public, anon, authenticated, service_role;


create or replace function public.claim_next_agent_job(
  accept_benchmark_trials boolean,
  default_concurrency_limit int,
  p_worker_runtime text
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.agent_jobs%rowtype;
  configured_limit int;
  factory_limit int;
  scheduled_trial public.factory_benchmark_schedule_trials;
  effective_limit int;
  running_count int;
  selected_provider text;
  release_state internal.git_continuity_release_control%rowtype;
  pipeline_job boolean;
  session_owner public.sessions;
  definition jsonb;
  budget_root_id uuid;
  budget_execution internal.factory_workflow_executions;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_worker_runtime not in ('node','workerd') or p_worker_runtime is null then
    raise exception 'A supported worker runtime is required.' using errcode = '22023';
  end if;
  select * into strict release_state from internal.git_continuity_release_control where singleton for share;
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();

  for candidate in
    select ready.* from public.agent_jobs ready
    join public.sessions owner on (owner.workspace_id, owner.id) = (ready.workspace_id, ready.session_id)
    where ready.status = 'queued' and (ready.scheduled_at is null or ready.scheduled_at <= now())
      and (
        (owner.execution_purpose = 'production'
          and (not owner.execute_pinned_definition or coalesce(internal.effective_factory_routing_execution(
            owner.workspace_id, owner.factory_id, owner.id)#>>'{configuration,workerRuntime}', p_worker_runtime) = p_worker_runtime)
          and (owner.pipeline_id is null or (release_state.enabled
          and exists (select 1 from public.session_git_continuity_enrollments enrolled
            where (enrolled.workspace_id, enrolled.session_id) = (owner.workspace_id, owner.id)))))
        or (accept_benchmark_trials is true and owner.execution_purpose = 'benchmark'
          and ready.attempt_count = 0 and exists (select 1 from public.factory_benchmark_trials trial
            where (trial.workspace_id, trial.session_id, trial.job_id, trial.status) =
              (owner.workspace_id, owner.id, ready.id, 'queued')
              and (trial.runner_revision = 'recorded-fixture-v1' or
                (trial.runner_revision = 'openai-responses-v1' and p_worker_runtime = 'workerd'))))
      )
    order by (owner.execution_purpose = 'benchmark'), ready.created_at, ready.id
  loop
    perform 1 from public.workspaces where id=candidate.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    select * into session_owner from public.sessions
      where (workspace_id, id) = (candidate.workspace_id, candidate.session_id);
    if not found then continue; end if;
    pipeline_job := session_owner.execution_purpose = 'production' and session_owner.pipeline_id is not null;

    -- A pause or cancel owns the schedule before changing any job. Standalone
    -- fixture trials, which have no experiment reservation, keep their old path.
    if session_owner.execution_purpose = 'benchmark' then
      select scheduled.* into scheduled_trial from public.factory_benchmark_schedule_trials scheduled
      join public.factory_benchmark_trials trial on trial.id = scheduled.trial_id
      where trial.job_id = candidate.id;
      if found then
        perform 1 from public.factory_benchmark_schedules schedule
        where (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
          (scheduled_trial.workspace_id, scheduled_trial.factory_id, scheduled_trial.experiment_id)
          and schedule.state = 'active' for share skip locked;
        if not found then continue; end if;
      end if;
    end if;

    budget_root_id := internal.find_factory_workflow_budget_root(session_owner.id);
    if budget_root_id is not null then
      perform 1 from public.factories factory
      where (factory.workspace_id, factory.id, factory.status) =
        (candidate.workspace_id, session_owner.factory_id, 'active')
      for share skip locked;
      if not found then continue; end if;
      perform 1 from public.sessions root
      where (root.id, root.workspace_id, root.factory_id) =
        (budget_root_id, candidate.workspace_id, session_owner.factory_id)
        and (root.archived_at is null or root.phase_status = 'approved')
        and (root.id = candidate.session_id or root.phase_status <> 'rejected')
      for no key update skip locked;
      if not found then continue; end if;
      select workflow.* into budget_execution from internal.factory_workflow_executions workflow
      where workflow.root_session_id = budget_root_id for no key update skip locked;
      if not found then continue; end if;
    end if;

    select * into candidate from public.agent_jobs where id = candidate.id and status = 'queued'
      and (scheduled_at is null or scheduled_at <= now()) for update skip locked;
    if not found then continue; end if;
    if not pg_try_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0)) then continue; end if;

    definition := internal.pinned_session_execution_definition(session_owner);
    if definition is not null then
      selected_provider := definition->>'sandboxProvider';
      configured_limit := (definition #>> '{agent,concurrencyLimit}')::integer;
    else
      select active_provider into selected_provider
      from public.workspace_sandbox_settings where workspace_id = candidate.workspace_id;
      selected_provider := coalesce(selected_provider, 'vercel');

      select value_json::integer into configured_limit
      from public.workspace_agent_config
      where workspace_id = candidate.workspace_id
        and key = 'concurrency_limit'
        and jsonb_typeof(value_json) = 'number';
    end if;

    if session_owner.execution_purpose = 'benchmark' then selected_provider := 'vercel'; end if;
    if exists (
      select 1 from public.workspace_sandbox_connection_mutations
      where workspace_id = candidate.workspace_id
        and provider = selected_provider
        and expires_at > now()
    ) then continue; end if;

    effective_limit := coalesce(configured_limit, default_concurrency_limit);
    select count(*) into running_count from public.agent_jobs
    where workspace_id = candidate.workspace_id and status in ('started', 'running');
    if running_count >= effective_limit then continue; end if;
    if session_owner.execution_purpose = 'benchmark' then
      if effective_limit > 1 and running_count >= effective_limit - 1 then continue; end if;

      -- A pinned production job can have a smaller limit than today's
      -- workspace default. Drain existing benchmark claims for that workspace.
      if exists (
        select 1 from public.agent_jobs waiting
        join public.sessions owner on (owner.workspace_id, owner.id) = (waiting.workspace_id, waiting.session_id)
        where waiting.workspace_id = candidate.workspace_id and waiting.status = 'queued'
          and (waiting.scheduled_at is null or waiting.scheduled_at <= now())
          and owner.execution_purpose = 'production'
          and (owner.pipeline_id is null or (release_state.enabled
            and exists (select 1 from public.session_git_continuity_enrollments enrolled
              where (enrolled.workspace_id, enrolled.session_id) = (owner.workspace_id, owner.id))))
      ) then continue; end if;

      select min(schedule.factory_concurrency_limit) into factory_limit
      from public.factory_benchmark_schedules schedule
      where (schedule.workspace_id, schedule.factory_id) = (candidate.workspace_id, session_owner.factory_id)
        and schedule.state = 'active'
        and exists (
          select 1 from public.factory_benchmark_schedule_trials scheduled
          join public.factory_benchmark_trials outstanding
            on (outstanding.id, outstanding.run_id) = (scheduled.trial_id, scheduled.run_id)
          where (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
            (schedule.workspace_id, schedule.factory_id, schedule.experiment_id)
            and outstanding.status in ('queued', 'running')
        );
      if factory_limit is not null and (select count(*)
        from public.factory_benchmark_trials trial join public.agent_jobs running on running.id = trial.job_id
        where (trial.workspace_id, trial.factory_id) = (candidate.workspace_id, session_owner.factory_id)
          and running.status in ('started', 'running')) >= factory_limit
      then continue; end if;
    end if;

    if budget_root_id is not null and not internal.reserve_factory_workflow_attempt(
      budget_execution, session_owner.id, candidate.id, candidate.attempt_count + 1
    ) then continue; end if;

    return query
    update public.agent_jobs
    set status = 'running', attempt_count = attempt_count + 1, last_error = null,
        started_at = now(), scheduled_at = null, claimed_worker_runtime = p_worker_runtime,
        git_continuity_release_revision=case when pipeline_job then release_state.revision else null end
    where id = candidate.id and status = 'queued'
    returning *;
    return;
  end loop;
  return;
end;
$$;

create or replace function internal.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control; job public.agent_jobs; session public.sessions; execution_id uuid; routing jsonb;
  budget_root_id uuid;
  budget_execution internal.factory_workflow_executions;
  budget_root public.sessions;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  select * into job from public.agent_jobs where id=p_job_id;
  if not found or p_attempt_count is null or p_attempt_count<=0 or job.attempt_count<>p_attempt_count
    or job.status not in('started','running') then return null; end if;
  select * into session from public.sessions where id=job.session_id and workspace_id=job.workspace_id;
  if not found then return null; end if;
  if session.pipeline_id is not null and (not control.enabled or job.git_continuity_release_revision is distinct from control.revision
    or not exists(select 1 from public.session_git_continuity_enrollments e where e.session_id=session.id and e.workspace_id=session.workspace_id)) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode='P499P';
  end if;
  perform 1 from public.workspaces where id=job.workspace_id for share;
  if not found then return null; end if;
  perform internal.assert_workspace_accepts_work(job.workspace_id);
  budget_root_id := internal.find_factory_workflow_budget_root(session.id);
  if budget_root_id is not null then
    perform internal.lock_factory_workflow_root(budget_root_id, session.workspace_id, session.factory_id);
    select * into strict budget_root from public.sessions where id = budget_root_id;
    if (budget_root.id <> session.id and budget_root.phase_status = 'rejected') or (
      budget_root.archived_at is not null and budget_root.phase_status <> 'approved'
    ) then return null; end if;
    perform internal.recheck_session_execution_grant(budget_root);
    select workflow.* into budget_execution from internal.factory_workflow_executions workflow
    where workflow.root_session_id = budget_root_id for no key update;
    if not found or not internal.reserve_factory_workflow_attempt(
      budget_execution, session.id, p_job_id, p_attempt_count
    ) then return null; end if;
  end if;
  select owner.* into session from public.sessions owner
  where (owner.id, owner.workspace_id) = (job.session_id, job.workspace_id) for no key update;
  if not found then return null; end if;
  if session.execution_purpose = 'production' and session.execute_pinned_definition then
    routing := internal.effective_factory_routing_execution(session.workspace_id, session.factory_id, session.id);
    if routing is not null and (job.claimed_worker_runtime, p_model_provider, p_model_name) is distinct from
      (routing#>>'{configuration,workerRuntime}', routing#>>'{configuration,harness}', routing->>'modelName') then
      raise exception 'The claimed attempt does not match the pinned routing configuration.' using errcode = '23514';
    end if;
  end if;
  perform internal.recheck_session_execution_grant(session);
  if not internal.session_execution_admissible(session.id,session.workspace_id) then return null; end if;
  execution_id:=internal.start_session_job_attempt_before_release(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
    p_model_provider,p_model_name,p_run_type,p_branch_name);
  if execution_id is not null then
    if budget_root_id is not null and not internal.bind_factory_workflow_attempt(
      budget_root_id, p_job_id, p_attempt_count, execution_id
    ) then
      raise exception 'The workflow attempt reservation is unavailable.' using errcode = 'PT409';
    end if;
    perform internal.bind_manual_retry_feedback(p_job_id);
  end if;
  return execution_id;
end;
$$;

alter function public.record_session_run_usage(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean) set schema internal;
alter function internal.record_session_run_usage(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean) rename to record_session_run_usage_before_workflow;
revoke all on function internal.record_session_run_usage_before_workflow(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean) from public, anon, authenticated, service_role;

create function public.record_session_run_usage(p_job_id uuid,p_attempt_count integer,p_run_id uuid,
  p_input_tokens bigint default null,p_output_tokens bigint default null,p_token_provenance text default 'unavailable',
  p_cost_usd numeric default null,p_cost_provenance text default 'unavailable',p_estimation_revision text default null,
  p_finalize boolean default false)
returns table(accepted boolean,exhaustion_code text) language plpgsql security definer set search_path='' as $$
declare
  reservation internal.factory_workflow_attempt_reservations;
  normal_receipt record;
  execution internal.factory_workflow_executions;
  policy jsonb;
  budget record;
begin
  perform internal.assert_checkpoint_publication_service();
  select hold.* into reservation from internal.factory_workflow_attempt_reservations hold
  where (hold.job_id, hold.attempt_count, hold.run_id) = (p_job_id, p_attempt_count, p_run_id);
  if found then
    -- Preserve the admission lock order for existing attempts. Archived or
    -- deleting scopes still accept accounting until their rows are erased.
    perform 1 from public.workspaces workspace where workspace.id = reservation.workspace_id for share;
    if not found then return query select false, null::text; return; end if;
    perform 1 from public.factories factory
    where (factory.workspace_id, factory.id) = (reservation.workspace_id, reservation.factory_id) for share;
    if not found then return query select false, null::text; return; end if;
    perform 1 from public.sessions root where (root.id, root.workspace_id, root.factory_id) =
      (reservation.root_session_id, reservation.workspace_id, reservation.factory_id) for no key update;
    if not found then return query select false, null::text; return; end if;
  end if;
  select * into strict normal_receipt from internal.record_session_run_usage_before_workflow(
    p_job_id, p_attempt_count, p_run_id, p_input_tokens, p_output_tokens, p_token_provenance,
    p_cost_usd, p_cost_provenance, p_estimation_revision, p_finalize
  );
  if reservation.root_session_id is null then
    return query select normal_receipt.accepted, normal_receipt.exhaustion_code;
    return;
  end if;
  perform internal.charge_factory_workflow_attempt(
    reservation.root_session_id, p_job_id, p_attempt_count, p_run_id,
    p_input_tokens + p_output_tokens, p_token_provenance, p_cost_usd, p_cost_provenance
  );
  if not normal_receipt.accepted or normal_receipt.exhaustion_code is not null then
    return query select normal_receipt.accepted, normal_receipt.exhaustion_code;
    return;
  end if;
  select * into strict execution from internal.factory_workflow_executions
  where root_session_id = reservation.root_session_id;
  policy := execution.workflow_json::jsonb->'delegationPolicy';
  select * into strict budget from internal.factory_workflow_attempt_budget(execution.root_session_id, policy);
  return query select true, case
    when p_input_tokens + p_output_tokens > reservation.reserved_tokens
      or budget.tokens > (policy->>'maxTotalTokens')::bigint then 'tokens'
    when p_cost_usd > reservation.reserved_cost_usd
      or budget.spend_usd > (policy->>'maxCostUsd')::numeric then 'spend'
    else null::text end;
end;
$$;
revoke all on function public.record_session_run_usage(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean) from public, anon, authenticated, service_role;
grant execute on function public.record_session_run_usage(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean) to service_role;
