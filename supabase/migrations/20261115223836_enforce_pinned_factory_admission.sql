-- OP-543 captured the definition alongside live execution inputs. Sessions
-- already admitted retain that behavior, even when they have a recorded pin.
alter table public.sessions
  add column execute_pinned_definition boolean not null default false,
  add column pinned_delivery_policy_revision_id uuid references public.delivery_policy_revisions(id),
  add constraint sessions_pinned_execution_requires_definition
    check (not execute_pinned_definition or factory_definition_provenance = 'pinned'),
  add constraint sessions_delivery_policy_requires_pinned_execution
    check (execute_pinned_definition or pinned_delivery_policy_revision_id is null);
create index sessions_pinned_delivery_policy_idx on public.sessions(pinned_delivery_policy_revision_id)
  where pinned_delivery_policy_revision_id is not null;

-- Retain the text already stored on an admitted session because mutable session
-- metadata must not change a retry's prompt. Historical receipts have no text.
alter table public.session_factory_admission_inputs
  add column original_title text,
  add column original_prompt_md text,
  add constraint session_factory_admission_original_text_matches_hashes check (
    (original_title is null and original_prompt_md is null)
    or (
      original_title is not null and original_prompt_md is not null
      and title_sha256 = encode(sha256(convert_to(original_title, 'UTF8')), 'hex')
      and prompt_sha256 = encode(sha256(convert_to(original_prompt_md, 'UTF8')), 'hex')
    )
  );

create or replace function internal.preserve_session_factory_definition_pin()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (
    new.factory_definition_provenance is distinct from old.factory_definition_provenance
    or new.factory_definition_revision_id is distinct from old.factory_definition_revision_id
    or new.execute_pinned_definition is distinct from old.execute_pinned_definition
    or new.pinned_delivery_policy_revision_id is distinct from old.pinned_delivery_policy_revision_id
    or (old.execute_pinned_definition and (new.pipeline_id, new.workspace_id) is distinct from (old.pipeline_id, old.workspace_id))
  ) then
    raise exception 'Session factory definition provenance is immutable.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new.pinned_delivery_policy_revision_id is not null and not exists (
    select 1 from public.delivery_policy_revisions revision
    where (revision.workspace_id, revision.pipeline_id, revision.id) =
      (new.workspace_id, new.pipeline_id, new.pinned_delivery_policy_revision_id)
  ) then
    raise exception 'Delivery policy does not belong to the session workspace and pipeline.' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger preserve_session_factory_definition_pin on public.sessions;
create trigger preserve_session_factory_definition_pin
  before insert or update of factory_definition_provenance, factory_definition_revision_id,
    execute_pinned_definition, pinned_delivery_policy_revision_id, workspace_id, pipeline_id on public.sessions
  for each row execute function internal.preserve_session_factory_definition_pin();

create or replace function internal.guard_session_factory_admission_inputs()
returns trigger language plpgsql security invoker set search_path = '' as $$
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
  if not exists (
    select 1 from public.sessions s
    join public.factory_definition_activations a
      on (a.workspace_id, a.factory_id, a.activation_number, a.revision_id) =
         (s.workspace_id, new.factory_id, new.activation_number, s.factory_definition_revision_id)
    join public.factory_definition_revisions r
      on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
    where (s.id, s.workspace_id, s.factory_definition_revision_id) =
      (new.session_id, new.workspace_id, new.definition_revision_id)
      and r.canonical_digest = new.definition_digest
      and (not s.execute_pinned_definition or new.original_title is not null)
  ) then
    raise exception 'Factory admission inputs must match the session pin.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.pin_session_execution_policy()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='INSERT' then
    if new.execution_policy_revision_id is null and not new.execute_pinned_definition then
      select current_revision_id into new.execution_policy_revision_id from public.execution_policies
        where workspace_id=new.workspace_id;
    end if;
  elsif new.execution_policy_revision_id is distinct from old.execution_policy_revision_id
    or new.execution_repair_attempts<old.execution_repair_attempts
    or (old.execution_exhausted_at is not null and (new.execution_exhausted_at is distinct from old.execution_exhausted_at
      or new.execution_exhaustion_code is distinct from old.execution_exhaustion_code
      or new.execution_exhaustion_detail is distinct from old.execution_exhaustion_detail)) then
    raise exception 'Session execution policy and exhaustion history are immutable.' using errcode='23514';
  end if;
  if new.execution_policy_revision_id is not null and not exists(
    select 1 from public.execution_policy_revisions where id=new.execution_policy_revision_id and workspace_id=new.workspace_id) then
    raise exception 'Execution policy does not belong to the session workspace.' using errcode='23514';
  end if;
  if (new.execution_exhausted_at is null)<>(new.execution_exhaustion_code is null)
    or (new.execution_exhausted_at is null and new.execution_exhaustion_detail is not null) then
    raise exception 'Execution exhaustion requires a coherent reason.' using errcode='23514';
  end if;
  return new;
end;
$$;

-- Existing stages keep stable FK identities for sessions, jobs, artifacts and
-- completions. A compiled stage uses that identity and owns its own contents.
-- Archived backing rows remain available to definitions that reference them.
create function internal.read_factory_definition_stage_ids(p_workspace_id uuid, p_pipeline_id uuid, p_definition jsonb)
returns uuid[] language plpgsql stable security invoker set search_path = '' as $$
declare stage_ids uuid[];
begin
  select array_agg((stage.value ->> 'id')::uuid order by stage.ordinality) into stage_ids
  from jsonb_array_elements(p_definition -> 'stages') with ordinality stage(value, ordinality);
  if coalesce(cardinality(stage_ids), 0) = 0 or cardinality(stage_ids) <> (
    select count(*) from public.pipeline_stages stage
    where (stage.workspace_id, stage.pipeline_id) = (p_workspace_id, p_pipeline_id)
      and stage.id = any(stage_ids)
  ) then
    raise exception 'The factory definition has stages unavailable in its pipeline.' using errcode = 'PT422';
  end if;
  return stage_ids;
end;
$$;
revoke all on function internal.read_factory_definition_stage_ids(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

-- Activation authorizes the publisher and new session admission authorizes its
-- own creator. Both use the same metadata-only check at the write boundary.
create function internal.assert_current_factory_agent_credential(p_user_id uuid, p_agent_provider text, p_agent_model text)
returns void language plpgsql security invoker set search_path = '' as $$
declare credential_available boolean;
begin
  case p_agent_provider
    when 'codex' then
      perform 1 from public.user_codex_credentials c where c.user_id = p_user_id
        and (c.access_token_expires_at is null or c.access_token_expires_at > clock_timestamp())
        and (c.credential_type <> 'chatgpt_auth_json' or not c.auth_reconnect_required)
        for share;
      credential_available := found;
    when 'claude-code' then
      perform 1 from public.user_claude_code_credentials c where c.user_id = p_user_id for share;
      credential_available := found;
    when 'cursor' then
      perform 1 from public.user_cursor_credentials c where c.user_id = p_user_id
        and not c.reconnect_required and c.api_key_expires_at > clock_timestamp() for share;
      credential_available := found;
    when 'opencode' then
      if split_part(p_agent_model, '/', 1) = 'opencode' then
        perform 1 from public.user_opencode_credentials c where c.user_id = p_user_id for share;
      else
        perform 1 from public.user_opencode_provider_credentials c where c.user_id = p_user_id
          and c.provider_id = split_part(p_agent_model, '/', 1) for share;
      end if;
      credential_available := found;
    else
      credential_available := false;
  end case;
  if not credential_available then
    raise exception 'A current personal credential is required for this agent.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_current_factory_agent_credential(uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function internal.assert_factory_activation_authority(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_definition jsonb,
  p_definition_digest text,
  p_enabled_sandbox_providers text[],
  p_required_probes text[]
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
  v_named_approvers uuid[];
  v_eligible_approvers integer;
  v_installation_id uuid;
  v_connection_revision uuid;
  v_capability public.sandbox_capability_checks;
begin
  -- Pipeline rewrites and member removal lock pipelines before membership.
  perform 1 from public.pipelines p
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
  ) then
    raise exception 'The execution policy revision is unavailable.' using errcode = 'PT422';
  end if;
  if v_delivery_revision_id is not null and not exists (
    select 1 from public.delivery_policy_revisions r
      where r.id = v_delivery_revision_id and r.workspace_id = p_workspace_id
        and r.pipeline_id = v_pipeline_id
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

  perform internal.assert_current_factory_agent_credential(p_actor_user_id, v_agent_provider, v_agent_model);
  perform internal.read_factory_definition_stage_ids(p_workspace_id, v_pipeline_id, p_definition);
end;
$$;

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
    repository_id := (admitted_definition ->> 'repositoryId')::uuid;
    model_provider := admitted_definition #>> '{agent,provider}';
    model_name := admitted_definition #>> '{agent,model}';
    admitted_execution_policy_revision_id := (admitted_definition ->> 'executionPolicyRevisionId')::uuid;
    admitted_delivery_policy_revision_id := (admitted_definition ->> 'deliveryPolicyRevisionId')::uuid;

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
        and not repository.is_archived and not installation.suspended
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

  if admitted_revision_id is not null then
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
