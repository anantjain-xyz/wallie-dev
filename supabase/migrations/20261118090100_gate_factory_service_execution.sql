-- Give each newly admitted pinned session an explicit attribution receipt.
-- Pre-existing receipts retain their original, unknown attribution.
alter table public.session_factory_admission_inputs
  add column execution_grant_id uuid,
  add column execution_grant_version bigint,
  add column invoking_actor_member_id uuid,
  add column credential_owner_member_id uuid,
  add column credential_owner_service_principal_id uuid,
  add column budget_payer_member_id uuid,
  add constraint factory_admission_execution_attribution check (
    (
      execution_grant_id is null and execution_grant_version is null
      and credential_owner_service_principal_id is null
      and (
        (invoking_actor_member_id is null and credential_owner_member_id is null and budget_payer_member_id is null)
        or (invoking_actor_member_id is not null
          and credential_owner_member_id is not distinct from invoking_actor_member_id
          and budget_payer_member_id is not distinct from invoking_actor_member_id)
      )
    ) or (
      execution_grant_id is not null and execution_grant_version is not null and execution_grant_version > 0
      and invoking_actor_member_id is not null and credential_owner_member_id is null
      and credential_owner_service_principal_id is not null and budget_payer_member_id is not null
      and execution_policy_revision_id is not null
    )
  );

-- These identities are evidence of an admission. Member removal and subsequent
-- grant changes must not erase or rewrite them.
comment on column public.session_factory_admission_inputs.execution_grant_version is
  'Exact grant version admitted before the first execution was queued.';
comment on column public.session_factory_admission_inputs.invoking_actor_member_id is
  'Human workspace member who initiated the session.';
comment on column public.session_factory_admission_inputs.credential_owner_member_id is
  'Admitted personal credential owner for a human execution.';
comment on column public.session_factory_admission_inputs.credential_owner_service_principal_id is
  'Factory service principal to which grant-backed credentials must belong.';
comment on column public.session_factory_admission_inputs.budget_payer_member_id is
  'Human budget sponsor recorded separately from the invoker and credential owner.';

create function internal.resolve_definition_execution_grant(
  p_workspace_id uuid, p_factory_id uuid, p_definition jsonb,
  p_repository_id uuid, p_execution_policy_revision_id uuid
) returns public.factory_execution_grants language plpgsql set search_path = '' as $$
declare
  grant_ref jsonb := p_definition->'executionGrant';
begin
  if grant_ref is null then return null; end if;
  if jsonb_typeof(grant_ref) is distinct from 'object'
    or jsonb_typeof(grant_ref->'id') is distinct from 'string'
    or (grant_ref->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(grant_ref->'version') is distinct from 'number'
    or (grant_ref->>'version') !~ '^[1-9][0-9]{0,15}$'
    or grant_ref - 'id' - 'version' <> '{}'::jsonb then
    raise exception 'The factory definition execution grant is invalid.' using errcode = 'PT422';
  end if;
  if (grant_ref->>'version')::bigint > 9007199254740991
    or p_definition ? 'writableRepositoryIds'
    or p_execution_policy_revision_id is null then
    raise exception 'A grant-backed definition requires one writer and an explicit execution budget.' using errcode = 'PT422';
  end if;
  return internal.require_current_factory_execution_grant(
    p_workspace_id, p_factory_id, (grant_ref->>'id')::uuid, (grant_ref->>'version')::bigint,
    p_repository_id,
    array(select id::uuid from jsonb_array_elements_text(p_definition->'readContextRepositoryIds') as ids(id)),
    array(select id from jsonb_array_elements_text(p_definition->'toolIds') as ids(id)),
    p_execution_policy_revision_id
  );
end;
$$;
revoke all on function internal.resolve_definition_execution_grant(uuid, uuid, jsonb, uuid, uuid)
  from public, anon, authenticated, service_role;

-- Call after resolving the grant so its factory fence also serializes factory
-- membership decisions. Avoid waiting on a workspace member removal that is
-- itself taking that factory fence.
create function internal.assert_factory_grant_invoker(p_workspace_id uuid, p_factory_id uuid, p_member_id uuid)
returns void language plpgsql set search_path = '' as $$
declare actor public.workspace_members;
begin
  select * into actor from public.workspace_members member
  where (member.workspace_id, member.id) = (p_workspace_id, p_member_id)
    and member.kind = 'human' and member.is_active
  for share nowait;
  if not found then
    raise exception 'The service execution invoker no longer has factory access.' using errcode = '42501';
  end if;
  if actor.role in ('owner', 'admin') then return; end if;
  perform 1 from public.factory_members membership
  where (membership.workspace_id, membership.factory_id, membership.member_id) =
    (p_workspace_id, p_factory_id, p_member_id) and membership.revoked_at is null
  for share nowait;
  if not found then
    raise exception 'The service execution invoker no longer has factory access.' using errcode = '42501';
  end if;
exception when lock_not_available then
  raise exception 'Factory invoker access is changing. Retry shortly.' using errcode = 'PT409';
end;
$$;
revoke all on function internal.assert_factory_grant_invoker(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function internal.guard_service_grant_activation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare definition jsonb;
begin
  select revision.definition_json::jsonb into definition
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (new.workspace_id, new.factory_id, new.revision_id);
  if definition ? 'executionGrant' then
    perform internal.resolve_definition_execution_grant(new.workspace_id, new.factory_id, definition,
      (definition->>'repositoryId')::uuid, (definition->>'executionPolicyRevisionId')::uuid);
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_service_grant_activation() from public, anon, authenticated, service_role;
create trigger factory_definition_activations_grant_scope before insert on public.factory_definition_activations
  for each row execute function internal.guard_service_grant_activation();

create or replace function internal.guard_session_factory_admission_inputs()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  session public.sessions;
  definition jsonb;
  execution_grant public.factory_execution_grants;
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.workspaces where id = old.workspace_id)
  ) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Session factory admission inputs are immutable.' using errcode = '23514';
  end if;
  select s.* into session
  from public.sessions s
  join public.factory_definition_activations a
    on (a.workspace_id, a.factory_id, a.activation_number, a.revision_id) =
       (s.workspace_id, new.factory_id, new.activation_number, s.factory_definition_revision_id)
  join public.factory_definition_revisions r
    on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
  where (s.id, s.workspace_id, s.factory_definition_revision_id) =
    (new.session_id, new.workspace_id, new.definition_revision_id)
    and r.canonical_digest = new.definition_digest
    and (not s.execute_pinned_definition or (
      new.original_title is not null
      and new.factory_id = s.factory_id
      and new.github_repository_id is not distinct from s.github_repository_id
      and new.execution_policy_revision_id is not distinct from s.execution_policy_revision_id
    ));
  if not found then
    raise exception 'Factory admission inputs must match the session pin.' using errcode = '23514';
  end if;

  -- Derive every identity from the authorized session and immutable definition.
  -- The caller cannot supply an invoker, credential owner, payer or grant pin.
  new.execution_grant_id := null;
  new.execution_grant_version := null;
  new.invoking_actor_member_id := null;
  new.credential_owner_member_id := null;
  new.credential_owner_service_principal_id := null;
  new.budget_payer_member_id := null;
  if not session.execute_pinned_definition then return new; end if;

  definition := internal.pinned_session_execution_definition(session);
  new.invoking_actor_member_id := session.creator_member_id;
  if definition ? 'executionGrant' then
    if session.creator_member_id is null then
      raise exception 'A human invoker is required for service execution.' using errcode = '42501';
    end if;
    execution_grant := internal.resolve_definition_execution_grant(session.workspace_id, session.factory_id,
      definition, session.github_repository_id, session.execution_policy_revision_id);
    perform internal.assert_factory_grant_invoker(session.workspace_id, session.factory_id, session.creator_member_id);
    new.execution_grant_id := execution_grant.id;
    new.execution_grant_version := execution_grant.version;
    new.credential_owner_service_principal_id := execution_grant.service_principal_id;
    new.budget_payer_member_id := execution_grant.budget_payer_member_id;
  else
    new.credential_owner_member_id := session.creator_member_id;
    new.budget_payer_member_id := session.creator_member_id;
  end if;
  return new;
end;
$$;

create function internal.recheck_session_execution_grant(p_session public.sessions)
returns void language plpgsql set search_path = '' as $$
declare
  definition jsonb;
  admission public.session_factory_admission_inputs;
  execution_grant public.factory_execution_grants;
begin
  if not p_session.execute_pinned_definition then return; end if;
  definition := internal.pinned_session_execution_definition(p_session);
  if not (definition ? 'executionGrant') then return; end if;
  select * into admission from public.session_factory_admission_inputs receipt
  where (receipt.session_id, receipt.workspace_id, receipt.factory_id, receipt.definition_revision_id) =
    (p_session.id, p_session.workspace_id, p_session.factory_id, p_session.factory_definition_revision_id);
  if not found or admission.execution_grant_id is null
    or admission.github_repository_id is distinct from p_session.github_repository_id
    or admission.execution_policy_revision_id is distinct from p_session.execution_policy_revision_id then
    raise exception 'The session service execution receipt is unavailable.' using errcode = '42501';
  end if;
  execution_grant := internal.resolve_definition_execution_grant(p_session.workspace_id, p_session.factory_id,
    definition, admission.github_repository_id, admission.execution_policy_revision_id);
  perform internal.assert_factory_grant_invoker(p_session.workspace_id, p_session.factory_id, admission.invoking_actor_member_id);
  if (admission.execution_grant_id, admission.execution_grant_version,
      admission.credential_owner_service_principal_id, admission.budget_payer_member_id) is distinct from
    (execution_grant.id, execution_grant.version,
      execution_grant.service_principal_id, execution_grant.budget_payer_member_id) then
    raise exception 'The session service execution receipt is unavailable.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function internal.recheck_session_execution_grant(public.sessions) from public, anon, authenticated, service_role;

-- Queue admission delegates the grant-backed receipt to the insert guard.
create or replace function public.create_session_with_first_job(
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
  selected_stage_ids uuid[] default null
)
returns table (
  session_id uuid,
  session_number integer,
  workspace_slug text,
  job_id uuid,
  run_id uuid
)
language plpgsql
security definer
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
  select a.factory_id, a.activation_number, a.revision_id, r.canonical_digest, r.definition_json::jsonb
  into admitted_factory_id, admitted_activation_number, admitted_revision_id, admitted_definition_digest, admitted_definition
  from public.factories f
  join public.factory_definition_activations a on (a.workspace_id, a.factory_id) = (f.workspace_id, f.id)
  join public.factory_definition_revisions r on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
  where f.workspace_id = target_workspace_id and f.is_default
  order by a.activation_number desc
  limit 1;

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
  select member.user_id into creator_user_id from public.workspace_members member
  where member.id = creator_member_id and member.workspace_id = target_workspace_id
    and member.kind = 'human' and member.is_active for share;
  if not found then
    raise exception 'Creator is not an active human member of workspace %', target_workspace_id
      using errcode = '42501';
  end if;

  if admitted_revision_id is not null and not (admitted_definition ? 'executionGrant') then
    perform internal.assert_current_factory_agent_credential(creator_user_id, model_provider, model_name);
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
    number,
    title,
    prompt_md,
    creator_member_id,
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
    allocated_number,
    btrim(session_title),
    btrim(session_prompt_md),
    creator_member_id,
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

-- Recheck every claimed generation or retry after locking the exact session.
create or replace function internal.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control; job public.agent_jobs; session public.sessions; execution_id uuid;
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
  select owner.* into session from public.sessions owner
  where (owner.id, owner.workspace_id) = (job.session_id, job.workspace_id) for no key update;
  if not found then return null; end if;
  perform internal.recheck_session_execution_grant(session);
  if not internal.session_execution_admissible(session.id,session.workspace_id) then return null; end if;
  execution_id:=internal.start_session_job_attempt_before_release(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
    p_model_provider,p_model_name,p_run_type,p_branch_name);
  if execution_id is not null then perform internal.bind_manual_retry_feedback(p_job_id); end if;
  return execution_id;
end;
$$;

-- The synthetic factory smoke and activation share the same authority check.
create or replace function internal.assert_factory_authority(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_definition jsonb,
  p_definition_digest text,
  p_enabled_sandbox_providers text[],
  p_required_probes text[],
  p_settings_metadata jsonb
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_pipeline_id uuid := (p_definition ->> 'pipelineId')::uuid;
  v_repository_id uuid := (p_definition ->> 'repositoryId')::uuid;
  v_execution_revision_id uuid := (p_definition ->> 'executionPolicyRevisionId')::uuid;
  v_delivery_revision_id uuid := (p_definition ->> 'deliveryPolicyRevisionId')::uuid;
  v_agent_provider text := p_definition #>> '{agent,provider}';
  v_agent_model text := p_definition #>> '{agent,model}';
  v_sandbox_provider text := p_definition ->> 'sandboxProvider';
  v_pipeline_available boolean;
  v_factory_id uuid;
  v_named_approvers uuid[];
  v_eligible_approvers integer;
  v_installation_id uuid;
  v_connection_revision uuid;
  v_capability public.sandbox_capability_checks;
begin
  -- Pipeline rewrites and member removal lock pipelines before membership.
  select p.factory_id into v_factory_id from public.pipelines p
    where p.id = v_pipeline_id and p.workspace_id = p_workspace_id for share;
  v_pipeline_available := found;
  perform 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id
      and m.kind = 'human' and m.is_active and m.role in ('owner', 'admin')
    for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  if not v_pipeline_available then
    raise exception 'The definition pipeline is unavailable.' using errcode = 'PT422';
  end if;

  select array_agg(distinct member_id.value::uuid) into v_named_approvers
    from jsonb_array_elements(p_definition -> 'stages') stage
    cross join lateral jsonb_array_elements_text(stage.value -> 'approverMemberIds') member_id;
  perform m.id from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.id = any(v_named_approvers)
      and m.kind = 'human' and m.is_active
    order by m.id for share;
  get diagnostics v_eligible_approvers = row_count;
  if v_eligible_approvers <> coalesce(cardinality(v_named_approvers), 0) then
    raise exception 'A definition approver is no longer eligible.' using errcode = 'PT422';
  end if;

  if v_execution_revision_id is not null and not exists (
    select 1 from public.execution_policy_revisions r
      where r.id = v_execution_revision_id and r.workspace_id = p_workspace_id
  ) and not (
    (p_settings_metadata #>> '{executionPolicy,id}')::uuid is not distinct from v_execution_revision_id
    and internal.valid_execution_requirements(p_settings_metadata #> '{executionPolicy,requirements}') is true
    and not exists (select 1 from public.execution_policy_revisions r where r.id = v_execution_revision_id)
  ) then
    raise exception 'The execution policy revision is unavailable.' using errcode = 'PT422';
  end if;
  if v_delivery_revision_id is not null and not exists (
    select 1 from public.delivery_policy_revisions r
      where r.id = v_delivery_revision_id and r.workspace_id = p_workspace_id
        and r.pipeline_id = v_pipeline_id
  ) and not (
    (p_settings_metadata #>> '{deliveryPolicy,id}')::uuid is not distinct from v_delivery_revision_id
    and internal.valid_delivery_requirements(p_settings_metadata #> '{deliveryPolicy,requirements}') is true
    and not exists (select 1 from public.delivery_policy_revisions r where r.id = v_delivery_revision_id)
  ) then
    raise exception 'The delivery policy revision is unavailable for this pipeline.' using errcode = 'PT422';
  end if;

  -- A GitHub disconnect can cascade to sessions locked by workers waiting for
  -- the workspace fence. Retry if that write already owns either GitHub row.
  begin
    select i.id into v_installation_id from public.github_installations i
      where i.workspace_id = p_workspace_id and not i.suspended for share nowait;
    perform 1 from public.github_repositories r
      where r.id = v_repository_id and r.workspace_id = p_workspace_id
        and r.github_installation_id = v_installation_id and not r.is_archived
      for share nowait;
    if not found then
      raise exception 'The definition repository is unavailable.' using errcode = 'PT422';
    end if;
  exception when lock_not_available then
    raise exception 'Repository access is changing. Reload the factory before retrying.' using errcode = 'PT409';
  end;

  if v_sandbox_provider not in ('vercel', 'e2b', 'daytona')
    or (v_sandbox_provider = any(p_enabled_sandbox_providers)) is distinct from true then
    raise exception 'The sandbox provider is disabled for this deployment.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from public.workspace_sandbox_connection_mutations m
      where m.workspace_id = p_workspace_id and m.provider = v_sandbox_provider
        and m.expires_at > clock_timestamp()
  ) then
    raise exception 'The sandbox connection is being updated.' using errcode = 'PT422';
  end if;

  -- Connection updates already take the workspace lock. A separate connection
  -- row lock here would reverse their row/workspace lock order.
  v_connection_revision := internal.factory_connected_sandbox_revision(p_workspace_id, v_sandbox_provider);
  if v_connection_revision is null then
    raise exception 'The sandbox credential is unavailable.' using errcode = 'PT422';
  end if;

  -- Prefer this immutable candidate's probe. Live receipts remain useful
  -- when their selected runtime already matches and no candidate was checked.
  select c.* into v_capability from public.sandbox_capability_checks c
    where c.workspace_id = p_workspace_id and c.github_repository_id = v_repository_id
      and c.factory_definition_digest = p_definition_digest
    order by c.checked_at desc, c.id desc limit 1 for share;
  if not found then
    select c.* into v_capability from public.sandbox_capability_checks c
      where c.workspace_id = p_workspace_id and c.github_repository_id = v_repository_id
        and c.factory_definition_digest is null
      order by c.checked_at desc, c.id desc limit 1 for share;
  end if;
  if not found or v_capability.status is distinct from 'success'
    or v_capability.sandbox_provider is distinct from v_sandbox_provider
    or v_capability.sandbox_connection_revision is distinct from v_connection_revision
    or v_capability.agent_provider is distinct from v_agent_provider
    or v_capability.agent_model is distinct from v_agent_model
    or coalesce(cardinality(p_required_probes), 0) = 0
    or exists (
      select 1 from unnest(p_required_probes) required(probe)
        where v_capability.capabilities #> array[required.probe, 'ok'] is distinct from 'true'::jsonb
    ) then
    raise exception 'A current capability check is required for this repository, sandbox, and agent.' using errcode = 'PT422';
  end if;

  if p_definition ? 'executionGrant' then
    begin
      perform internal.resolve_definition_execution_grant(p_workspace_id, v_factory_id, p_definition,
        v_repository_id, v_execution_revision_id);
    exception when insufficient_privilege then
      raise exception 'The selected factory execution grant is unavailable.' using errcode = 'PT422';
    end;
  else
    perform internal.assert_current_factory_agent_credential(p_actor_user_id, v_agent_provider, v_agent_model);
  end if;
  if p_settings_metadata ? 'newStageIds' then
    perform internal.assert_factory_smoke_stage_reservations(
      p_workspace_id, v_pipeline_id, p_definition, p_settings_metadata->'newStageIds');
  else
    perform internal.read_factory_definition_stage_ids(p_workspace_id, v_pipeline_id, p_definition);
  end if;
end;
$$;

-- A new capability reservation may start a sandbox and touch repository
-- source. Historical probe inspection needs no live execution authority.
create or replace function public.start_factory_definition_capability_check(
  target_workspace_id uuid, target_github_repository_id uuid, target_actor_user_id uuid,
  target_sandbox_provider text, target_agent_provider text, target_agent_model text,
  target_definition_digest text
) returns public.sandbox_capability_checks
language plpgsql security definer set search_path = '' as $$
declare
  result public.sandbox_capability_checks;
  connection_revision uuid;
  repository_factory_id uuid;
  definition jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  perform 1 from public.workspace_members m where m.workspace_id = target_workspace_id
    and m.user_id = target_actor_user_id and m.kind = 'human' and m.is_active and m.role in ('owner', 'admin') for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  select r.factory_id into repository_factory_id
  from public.github_repositories r join public.github_installations i
    on (i.id, i.workspace_id) = (r.github_installation_id, r.workspace_id)
  where (r.id, r.workspace_id) = (target_github_repository_id, target_workspace_id)
    and not r.is_archived and not i.suspended;
  if not found then
    raise exception 'The definition repository is unavailable.' using errcode = 'PT422';
  end if;
  select saved.definition into definition from (
    select d.factory_id, d.definition_json::jsonb as definition from public.factory_definition_drafts d
    where (d.workspace_id, d.canonical_digest) = (target_workspace_id, target_definition_digest)
    union all
    select r.factory_id, r.definition_json::jsonb from public.factory_definition_revisions r
    where (r.workspace_id, r.canonical_digest) = (target_workspace_id, target_definition_digest)
  ) saved join public.factories f on (f.workspace_id, f.id) = (target_workspace_id, saved.factory_id)
  where f.is_default and f.id = repository_factory_id
    and saved.definition->>'sandboxProvider' = target_sandbox_provider
    and saved.definition #>> '{agent,provider}' = target_agent_provider
    and saved.definition #>> '{agent,model}' = target_agent_model
    and internal.factory_allows_writable_repository(saved.definition, target_github_repository_id)
  limit 1;
  if not found then
    raise exception 'The selected factory definition is unavailable for this check.' using errcode = 'P0002';
  end if;
  if definition ? 'executionGrant' then
    begin
      perform internal.resolve_definition_execution_grant(target_workspace_id, repository_factory_id, definition,
        target_github_repository_id, (definition->>'executionPolicyRevisionId')::uuid);
    exception when insufficient_privilege then
      raise exception 'The selected factory execution grant is unavailable.' using errcode = 'PT422';
    end;
  end if;
  if exists (
    select 1 from public.workspace_sandbox_connection_mutations m
      where m.workspace_id = target_workspace_id and m.provider = target_sandbox_provider
        and m.expires_at > clock_timestamp()
  ) then
    raise exception 'The sandbox connection is being updated.' using errcode = 'PT409';
  end if;
  connection_revision := internal.factory_connected_sandbox_revision(target_workspace_id, target_sandbox_provider);
  if connection_revision is null then
    raise exception 'The sandbox credential is unavailable.' using errcode = 'PT422';
  end if;
  insert into public.sandbox_capability_checks(
    workspace_id, github_repository_id, status, sandbox_provider, agent_provider, agent_model,
    sandbox_connection_revision, factory_definition_digest
  ) values (target_workspace_id, target_github_repository_id, 'running', target_sandbox_provider,
    target_agent_provider, target_agent_model, connection_revision, target_definition_digest)
  returning * into result;
  return result;
end;
$$;
