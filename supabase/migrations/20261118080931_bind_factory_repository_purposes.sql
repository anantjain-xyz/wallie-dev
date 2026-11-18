-- The factory definition binds repository purposes. Its existing repositoryId
-- remains the default writer; only writableRepositoryIds can override it.
create function internal.factory_allows_writable_repository(p_definition jsonb, p_repository_id uuid)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_repository_id = (p_definition->>'repositoryId')::uuid or exists (
    select 1 from jsonb_array_elements_text(p_definition->'writableRepositoryIds') as writable(id)
    where writable.id::uuid = p_repository_id
  ), false)
$$;
revoke all on function internal.factory_allows_writable_repository(jsonb, uuid)
  from public, anon, authenticated, service_role;

-- The live session FK may be cleared by a disconnected installation. The
-- admission receipt retains the exact repository identity through that change.
create function internal.session_writable_repository_id(p_session public.sessions)
returns uuid language sql stable set search_path = '' as $$
  select case when p_session.execute_pinned_definition then (
    select case when admission.session_id is null then p_session.github_repository_id
      else admission.github_repository_id end
    from (values (p_session.id)) as session(id)
    left join public.session_factory_admission_inputs admission on
      (admission.session_id, admission.workspace_id, admission.factory_id, admission.definition_revision_id) =
      (session.id, p_session.workspace_id, p_session.factory_id, p_session.factory_definition_revision_id)
  ) else p_session.github_repository_id end
$$;
revoke all on function internal.session_writable_repository_id(public.sessions)
  from public, anon, authenticated, service_role;

create or replace function internal.assert_factory_definition_resource_scope(
  p_workspace_id uuid, p_factory_id uuid, p_definition jsonb
) returns void language plpgsql set search_path = '' as $$
declare
  default_repository_id uuid := (p_definition->>'repositoryId')::uuid;
  additional_repository_ids uuid[];
begin
  if exists (
    select 1 from public.pipelines pipeline
    where pipeline.id = (p_definition->>'pipelineId')::uuid
      and pipeline.workspace_id = p_workspace_id and pipeline.factory_id <> p_factory_id
  ) then
    raise exception 'The definition pipeline is outside the factory scope.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from public.github_repositories repository
    where repository.id = default_repository_id
      and (repository.workspace_id, repository.factory_id) <> (p_workspace_id, p_factory_id)
  ) then
    raise exception 'The definition repository is outside the factory scope.' using errcode = 'PT422';
  end if;
  if (p_definition ? 'writableRepositoryIds'
      and jsonb_typeof(p_definition->'writableRepositoryIds') is distinct from 'array')
    or (p_definition ? 'readContextRepositoryIds'
      and jsonb_typeof(p_definition->'readContextRepositoryIds') is distinct from 'array') then
    raise exception 'Factory repository bindings must be arrays.' using errcode = 'PT422';
  end if;
  select array_agg(binding.id::uuid) into additional_repository_ids
  from (
    select additional.id from jsonb_array_elements_text(p_definition->'writableRepositoryIds') as additional(id)
    union all
    select context.id from jsonb_array_elements_text(p_definition->'readContextRepositoryIds') as context(id)
  ) binding;
  if array_position(additional_repository_ids, null) is not null
    or default_repository_id = any(additional_repository_ids)
    or cardinality(additional_repository_ids) <> (
      select count(distinct repository_id) from unnest(additional_repository_ids) as ids(repository_id)
    ) then
    raise exception 'Each repository can have only one factory binding.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from unnest(additional_repository_ids) as binding(repository_id)
    left join public.github_repositories repository on
      (repository.id, repository.workspace_id, repository.factory_id) =
      (binding.repository_id, p_workspace_id, p_factory_id)
    where repository.id is null
  ) then
    raise exception 'A bound repository is outside the factory scope.' using errcode = 'PT422';
  end if;
  if p_definition ? 'implementationAgent' then
    perform internal.assert_factory_agent_snapshot(p_workspace_id, p_factory_id, p_definition->'implementationAgent');
  end if;
  perform internal.assert_factory_skill_bundle_available(p_workspace_id, p_factory_id, p_definition->'skillIds');
end;
$$;

create function internal.preserve_session_writable_repository()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.execute_pinned_definition and new.github_repository_id is distinct from old.github_repository_id
    and not (
      new.github_repository_id is null and not exists (
        select 1 from public.github_repositories repository where repository.id = old.github_repository_id
      )
    ) then
    raise exception 'The admitted writable repository cannot change.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.preserve_session_writable_repository()
  from public, anon, authenticated, service_role;
create trigger sessions_preserve_writable_repository before update of github_repository_id on public.sessions
  for each row execute function internal.preserve_session_writable_repository();

create or replace function internal.guard_factory_definition_resource_scope()
returns trigger language plpgsql set search_path = '' as $$
declare
  definition jsonb;
  bound_repository_ids uuid[];
  available_repositories integer;
begin
  if tg_table_name = 'factory_definition_activations' then
    select revision.definition_json::jsonb into definition
    from public.factory_definition_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id) =
      (new.workspace_id, new.factory_id, new.revision_id);
  elsif tg_table_name = 'factory_definition_smoke_tests' then
    if new.target_kind = 'draft' then
      select draft.definition_json::jsonb into definition
      from public.factory_definition_drafts draft
      where (draft.workspace_id, draft.factory_id, draft.id) =
        (new.workspace_id, new.factory_id, new.target_id);
    else
      select revision.definition_json::jsonb into definition
      from public.factory_definition_revisions revision
      where (revision.workspace_id, revision.factory_id, revision.id) =
        (new.workspace_id, new.factory_id, new.target_id);
    end if;
  else
    definition := new.definition_json::jsonb;
  end if;
  perform internal.assert_factory_definition_resource_scope(new.workspace_id, new.factory_id, definition);

  if tg_table_name = 'factory_definition_activations' and (
    definition ? 'writableRepositoryIds' or definition ? 'readContextRepositoryIds'
  ) then
    select array_agg(binding.id::uuid) into bound_repository_ids
    from (
      select definition->>'repositoryId' as id
      union all
      select writable.id from jsonb_array_elements_text(definition->'writableRepositoryIds') as writable(id)
      union all
      select context.id from jsonb_array_elements_text(definition->'readContextRepositoryIds') as context(id)
    ) binding;
    -- GitHub disconnect can hold these rows while waiting on session locks.
    begin
      perform installation.id from public.github_installations installation
      where installation.workspace_id = new.workspace_id and not installation.suspended
      for share nowait;
      perform repository.id from public.github_repositories repository
      join public.github_installations installation
        on (installation.id, installation.workspace_id) = (repository.github_installation_id, repository.workspace_id)
      where repository.id = any(bound_repository_ids)
        and (repository.workspace_id, repository.factory_id) = (new.workspace_id, new.factory_id)
        and not repository.is_archived and not installation.suspended
      order by repository.id for share of repository nowait;
      get diagnostics available_repositories = row_count;
      if available_repositories <> cardinality(bound_repository_ids) then
        raise exception 'A bound repository is unavailable.' using errcode = 'PT422';
      end if;
    exception when lock_not_available then
      raise exception 'Repository access is changing. Reload the factory before retrying.' using errcode = 'PT409';
    end;
  end if;
  return new;
end;
$$;

create or replace function internal.guard_factory_session_admission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare definition jsonb;
begin
  -- Workspace operators already have factory access. Ordinary creators need an
  -- explicit active grant in the exact factory that will own the session.
  if new.creator_member_id is not null and not exists (
    select 1 from public.workspace_members creator
    where creator.id = new.creator_member_id
      and creator.workspace_id = new.workspace_id
      and creator.kind = 'human'
      and creator.is_active
      and (
        creator.role in ('owner', 'admin')
        or exists (
          select 1 from public.factory_members member
          where member.workspace_id = new.workspace_id
            and member.factory_id = new.factory_id
            and member.member_id = creator.id
            and member.revoked_at is null
        )
      )
  ) then
    raise exception 'Session creator is not authorized for this factory.' using errcode = '42501';
  end if;
  -- Links selected during admission must already live in the session factory.
  -- This stops a caller from steering default-factory work at a restricted
  -- sibling repository or pipeline by supplying a known UUID.
  if new.pipeline_id is not null and not exists (
    select 1 from public.pipelines pipeline
    where pipeline.id = new.pipeline_id
      and pipeline.workspace_id = new.workspace_id
      and pipeline.factory_id = new.factory_id
  ) then
    raise exception 'Session pipeline is outside the factory scope.' using errcode = '42501';
  end if;
  if new.github_repository_id is not null and not exists (
    select 1 from public.github_repositories repository
    where repository.id = new.github_repository_id
      and repository.workspace_id = new.workspace_id
      and repository.factory_id = new.factory_id
  ) then
    raise exception 'Session repository is outside the factory scope.' using errcode = '42501';
  end if;
  if new.execute_pinned_definition then
    definition := internal.pinned_session_execution_definition(new);
    if (new.github_repository_id is not null or definition->>'repositoryId' is not null)
      and not internal.factory_allows_writable_repository(definition, new.github_repository_id) then
      raise exception 'The session repository must have a writable factory binding.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

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
      and (not s.execute_pinned_definition or (
        new.original_title is not null
        and new.factory_id = s.factory_id
        and new.github_repository_id is not distinct from s.github_repository_id
      ))
  ) then
    raise exception 'Factory admission inputs must match the session pin.' using errcode = '23514';
  end if;
  return new;
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

create or replace function public.restart_session_once_with_first_job(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  source_session_id uuid, session_title text, session_prompt_md text, agent_model_provider text,
  agent_model_name text, session_attachment_ids uuid[], session_linear_issue_id text default null,
  session_linear_issue_url text default null, session_github_repository_id uuid default null,
  selected_pipeline_id uuid default null, selected_stage_ids uuid[] default null
)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  result record;
  source_issue_id text;
  source_uses_pin boolean;
  source_repository_id uuid;
begin
  -- Share the existing creation-request lock so ordinary creation and an
  -- explicit restart cannot both commit under one request ID.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text
      || ':' || target_request_id::text, 0));
  select * into result from public.find_session_creation_request(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash);
  if found then
    if not exists (
      select 1 from public.session_restart_lineages lineage
      where (lineage.workspace_id, lineage.session_id, lineage.source_session_id) =
        (target_workspace_id, result.session_id, restart_session_once_with_first_job.source_session_id)
    ) then
      raise exception 'This creation request was already used for different session input' using errcode = 'P0005';
    end if;
  else
    -- Retain the existing Linear owner when the fresh session cites the same
    -- issue as context. The new session can still link to the original URL.
    perform internal.lock_factory_session_creation_attachments(target_workspace_id, creator_member_id, session_attachment_ids);
    perform internal.assert_workspace_accepts_work(target_workspace_id);
    select coalesce(source.linear_issue_id, prior.linear_issue_context_id), source.execute_pinned_definition,
      case when source.execute_pinned_definition then admission.github_repository_id end
    into source_issue_id, source_uses_pin, source_repository_id
    from public.sessions source
    left join public.session_restart_lineages prior
      on (prior.workspace_id, prior.session_id) = (source.workspace_id, source.id)
    left join public.session_factory_admission_inputs admission
      on (admission.session_id, admission.workspace_id, admission.factory_id, admission.definition_revision_id) =
      (source.id, source.workspace_id, source.factory_id, source.factory_definition_revision_id)
    where (source.workspace_id, source.id) =
      (target_workspace_id, restart_session_once_with_first_job.source_session_id)
      and exists (
        select 1 from public.workspace_members creator
        where creator.id = restart_session_once_with_first_job.creator_member_id
          and creator.workspace_id = source.workspace_id
          and creator.kind = 'human' and creator.is_active
          and (
            creator.role in ('owner', 'admin')
            or exists (
              select 1 from public.factory_members member
              where (member.workspace_id, member.factory_id, member.member_id) =
                (source.workspace_id, source.factory_id, creator.id)
                and member.revoked_at is null
            )
          )
      )
    for key share of source;
    if not found then
      raise exception 'Source session is unavailable in this workspace.' using errcode = 'PT404';
    end if;
    if source_uses_pin and session_github_repository_id is null and source_repository_id is null then
      raise exception 'The source session writable repository is unavailable. Choose a writable repository.' using errcode = 'P0003';
    end if;
    select * into strict result from public.create_session_once_with_first_job(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      case when source_issue_id = session_linear_issue_id then null else session_linear_issue_id end,
      session_linear_issue_url, coalesce(session_github_repository_id, source_repository_id),
      selected_pipeline_id, selected_stage_ids);
    insert into public.session_restart_lineages (session_id, workspace_id, source_session_id, linear_issue_context_id)
    values (result.session_id, target_workspace_id, restart_session_once_with_first_job.source_session_id,
      case when source_issue_id = session_linear_issue_id then source_issue_id end);
  end if;
  return query select result.session_id::uuid, result.session_number::integer,
    result.workspace_slug::text, result.job_id::uuid, result.run_id::uuid;
end;
$$;

-- The persisted root is the authority used by downstream inputs and
-- checkpoint publication. Guard its direct insert path as well as the RPC.
create function internal.guard_session_git_root_repository()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.sessions session
    where (session.id, session.workspace_id) = (new.session_id, new.workspace_id)
      and session.execute_pinned_definition
      and internal.session_writable_repository_id(session) is distinct from new.repository_id
  ) then
    raise exception 'Git lineage repository does not match the session.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_session_git_root_repository()
  from public, anon, authenticated, service_role;
create trigger guard_session_git_roots_writable_repository before insert on public.session_git_roots
  for each row execute function internal.guard_session_git_root_repository();

create or replace function internal.pin_session_job_git_input(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_repository_id uuid,p_base_branch text,p_observed_sha text
) returns setof public.session_job_git_inputs language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype;
  root public.session_git_roots%rowtype; pinned public.session_job_git_inputs%rowtype;
  repository public.github_repositories%rowtype; selected record;
begin
  perform internal.assert_checkpoint_publication_service();
  select owner.* into s from public.sessions owner
    join public.agent_jobs candidate on candidate.session_id=owner.id
    where candidate.id=p_job_id for no key update of owner;
  if not found then return; end if;
  select * into j from public.agent_jobs where id=p_job_id for update;
  if not found or p_attempt_count is null or p_attempt_count<=0 or j.attempt_count<>p_attempt_count
    or j.status not in ('started','running') or j.workspace_id<>s.workspace_id
    or s.archived_at is not null or s.phase_status<>'in_progress'
    or j.stage_id is distinct from s.current_stage_id then return; end if;
  select * into r from public.agent_runs where id=p_run_id for update;
  if not found or r.agent_job_id is distinct from j.id or r.attempt_count is distinct from p_attempt_count
    or r.workspace_id<>s.workspace_id or r.session_id<>s.id or r.stage_id is distinct from j.stage_id
    or r.status<>'running' then return; end if;
  perform internal.assert_workspace_accepts_work(s.workspace_id);
  select candidate.* into repository from public.github_repositories candidate
    join public.github_installations installation
      on (installation.id, installation.workspace_id) = (candidate.github_installation_id, candidate.workspace_id)
    where candidate.id=p_repository_id and candidate.workspace_id=s.workspace_id
      and candidate.factory_id=s.factory_id and not candidate.is_archived and not installation.suspended;
  if not found or (
    (s.execute_pinned_definition or s.github_repository_id is not null)
    and internal.session_writable_repository_id(s) is distinct from p_repository_id
  ) then
    raise exception 'Git lineage repository does not match the session.' using errcode='23514';
  end if;
  if p_observed_sha is null or p_observed_sha !~ '^[a-f0-9]{40}$' or nullif(btrim(p_base_branch),'') is null then
    raise exception 'Invalid Git execution input.' using errcode='23514';
  end if;
  select * into root from public.session_git_roots where session_id=s.id;
  if not found then
    insert into public.session_git_roots(session_id,workspace_id,repository_id,repository_full_name,base_branch,initial_base_sha)
    values(s.id,s.workspace_id,repository.id,repository.full_name,p_base_branch,p_observed_sha) returning * into root;
  elsif root.repository_id<>repository.id or root.repository_full_name<>repository.full_name then
    raise exception 'Git execution repository is already pinned.' using errcode='23514';
  end if;
  select * into pinned from public.session_job_git_inputs where job_id=j.id;
  if found then
    if pinned.repository_id<>repository.id or pinned.repository_full_name<>repository.full_name or pinned.base_branch<>p_base_branch then
      raise exception 'Git execution input is already pinned.' using errcode='23514';
    end if;
    if pinned.input_sha is distinct from p_observed_sha then
      raise exception 'Observed Git input does not match the selected checkpoint.' using errcode='23514';
    end if;
    if pinned.pinned_run_id is null then
      update public.session_job_git_inputs set pinned_run_id=r.id,pinned_attempt_count=p_attempt_count
        where job_id=j.id returning * into pinned;
    end if;
    return next pinned;
    return;
  end if;
  select * into selected from internal.session_execution_input(s.id,s.workspace_id);
  if not found then raise exception 'Git execution input is unavailable.' using errcode='55000'; end if;
  if selected.input_sha is distinct from p_observed_sha then
    raise exception 'Observed Git input does not match the selected checkpoint.' using errcode='23514';
  end if;
  insert into public.session_job_git_inputs(job_id,workspace_id,session_id,repository_id,repository_full_name,
    base_branch,initial_base_sha,input_sha,input_ref,source_checkpoint_run_id,pinned_run_id,pinned_attempt_count)
  values(j.id,s.workspace_id,s.id,selected.repository_id,selected.repository_full_name,selected.base_branch,
    selected.initial_base_sha,selected.input_sha,selected.input_ref,selected.source_checkpoint_run_id,r.id,p_attempt_count) returning * into pinned;
  return next pinned;
end;
$$;

create or replace function public.record_session_pull_request(
  target_session_id uuid, target_workspace_id uuid, target_repository_id uuid,
  target_branch_name text, source_pull_request_number integer,
  source_pull_request_url text, source_pull_request_state text,
  source_is_draft boolean, source_updated_at timestamptz
) returns public.session_pull_requests
language plpgsql security definer set search_path = '' as $$
declare
  link public.session_pull_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(source_pull_request_url, '') is null
    or nullif(target_branch_name, '') is null then
    raise exception 'Invalid GitHub pull request snapshot' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sessions session
    join public.github_repositories repository on repository.id = target_repository_id
      and repository.workspace_id = session.workspace_id
    where session.id = target_session_id and session.workspace_id = target_workspace_id
      and (
        (not session.execute_pinned_definition and session.github_repository_id is null)
        or internal.session_writable_repository_id(session) = target_repository_id
      )) then
    raise exception 'Pull request repository must match its session' using errcode = '23514';
  end if;

  if exists(select 1 from public.session_pr_sync where session_id=target_session_id and workspace_id=target_workspace_id) then
    raise exception 'Managed session PR metadata requires the canonical publisher.' using errcode='23514';
  end if;
  insert into public.session_pull_requests (
    session_id, workspace_id, github_repository_id, branch_name, pull_request_number,
    pull_request_url, pull_request_state, is_draft, github_updated_at
  ) values (
    target_session_id, target_workspace_id, target_repository_id, target_branch_name,
    source_pull_request_number, source_pull_request_url, source_pull_request_state,
    source_is_draft, source_updated_at
  ) on conflict (workspace_id, branch_name) do nothing returning * into link;
  if found then return link; end if;

  select * into link from public.session_pull_requests
  where workspace_id = target_workspace_id and branch_name = target_branch_name for update;
  if not found then
    raise exception 'Pull request link changed concurrently; retry' using errcode = '40001';
  end if;
  if link.session_id <> target_session_id
    or (link.github_repository_id is not null and link.github_repository_id <> target_repository_id) then
    raise exception 'Pull request branch belongs to another session or repository' using errcode = '23514';
  end if;

  if link.github_repository_id is null or link.pull_request_number is null
    or source_pull_request_number > link.pull_request_number
    or (source_pull_request_number = link.pull_request_number
      and internal.github_pull_request_is_fresh(link.pull_request_state,
        link.github_updated_at, source_pull_request_state, source_updated_at)) then
    update public.session_pull_requests set
      github_repository_id = target_repository_id,
      pull_request_number = source_pull_request_number,
      pull_request_url = source_pull_request_url,
      pull_request_state = source_pull_request_state,
      is_draft = source_is_draft,
      github_updated_at = source_updated_at
    where id = link.id returning * into link;
  end if;
  return link;
end;
$$;

create or replace function public.get_session_detail_page(target_workspace_slug text, target_session_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_workspace_id uuid;
  v_has_any_workspace boolean;
  v_session public.sessions%rowtype;
  v_current_stage public.pipeline_stages%rowtype;
  v_creator_display_name text;
  v_stages jsonb := '[]'::jsonb;
  v_phase_completions jsonb := '[]'::jsonb;
  v_artifacts jsonb := '[]'::jsonb;
  v_pull_requests jsonb := '[]'::jsonb;
  v_effective_repository_id uuid;
  v_repository jsonb := null;
begin
  select w.id
  into v_workspace_id
  from public.workspaces w
  join public.workspace_members wm
    on wm.workspace_id = w.id
  where w.slug = target_workspace_slug
    and wm.user_id = auth.uid()
    and wm.is_active
    and wm.kind = 'human'
  limit 1;

  if v_workspace_id is null then
    select exists (
      select 1
      from public.workspace_members wm
      where wm.user_id = auth.uid()
        and wm.is_active
        and wm.kind = 'human'
    )
    into v_has_any_workspace;

    return jsonb_build_object(
      'access', jsonb_build_object(
        'hasAnyWorkspace', v_has_any_workspace
      )
    );
  end if;

  select *
  into v_session
  from public.sessions s
  where s.workspace_id = v_workspace_id
    and s.number = target_session_number;

  if not found then
    return null;
  end if;

  if not internal.can_access_factory(v_session.workspace_id, v_session.factory_id) then
    return null;
  end if;

  select *
  into v_current_stage
  from internal.session_execution_stages(v_session) ps
  where ps.id = v_session.current_stage_id;

  select coalesce(
    nullif(btrim(wm.full_name), ''),
    nullif(btrim(wm.username), ''),
    nullif(btrim(wm.email), ''),
    'Unknown member'
  )
  into v_creator_display_name
  from public.workspace_members wm
  where wm.id = v_session.creator_member_id
    and wm.workspace_id = v_workspace_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'description', ps.description,
        'id', ps.id,
        'name', ps.name,
        'position', ps.position,
        'slug', ps.slug
      )
      order by ps.position asc
    ),
    '[]'::jsonb
  )
  into v_stages
  from internal.session_execution_stages(v_session) ps
  join public.session_selected_stages selection
    on selection.stage_id = ps.id
   and selection.session_id = v_session.id
   and selection.workspace_id = v_workspace_id
  where ps.pipeline_id = v_session.pipeline_id
    and ps.workspace_id = v_workspace_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'completedAt', spc.completed_at,
        'id', spc.id,
        'stageId', spc.stage_id,
        'stageSlug', spc.stage_slug
      )
      order by spc.completed_at asc
    ),
    '[]'::jsonb
  )
  into v_phase_completions
  from public.session_phase_completions spc
  where spc.session_id = v_session.id
    and spc.workspace_id = v_workspace_id;

  if v_current_stage.id is not null and v_session.current_artifact_version > 0 then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', sa.id,
          'createdAt', sa.created_at,
          'payload', sa.artifact_json,
          'stageSlug', v_current_stage.slug,
          'version', sa.version
        )
        order by sa.version desc
      ),
      '[]'::jsonb
    )
    into v_artifacts
    from public.session_artifacts sa
    where sa.session_id = v_session.id
      and sa.workspace_id = v_workspace_id
      and sa.stage_id = v_current_stage.id
      and sa.version = v_session.current_artifact_version
      and sa.id = v_session.current_artifact_id;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', spr.id,
        'pullRequestNumber', spr.pull_request_number,
        'pullRequestUrl', spr.pull_request_url
      )
      order by spr.created_at desc
    ),
    '[]'::jsonb
  )
  into v_pull_requests
  from public.session_pull_requests spr
  where spr.workspace_id = v_workspace_id
    and spr.session_id = v_session.id;

  with latest_pull_request_repository as (
    select spr.github_repository_id
    from public.session_pull_requests spr
    where spr.workspace_id = v_workspace_id
      and spr.session_id = v_session.id
      and spr.github_repository_id is not null
    order by spr.created_at desc
    limit 1
  ),
  expanded_candidates(priority, repository_id) as (
    values (1, internal.session_writable_repository_id(v_session))
    union all
    select 2, spr.github_repository_id
    from latest_pull_request_repository spr
    join public.github_repositories repository
      on repository.id = spr.github_repository_id
     and repository.workspace_id = v_workspace_id
     and repository.factory_id = v_session.factory_id
    where not v_session.execute_pinned_definition
      and internal.can_access_factory(repository.workspace_id, repository.factory_id)
    union all
    select 3, wrp.github_repository_id
    from public.workspace_repository_profiles wrp
    join public.github_repositories repository
      on repository.id = wrp.github_repository_id
     and repository.workspace_id = v_workspace_id
     and repository.factory_id = v_session.factory_id
    where wrp.workspace_id = v_workspace_id
      and wrp.is_primary
      and not v_session.execute_pinned_definition
      and internal.can_access_factory(repository.workspace_id, repository.factory_id)
    union all
    select 4, wo.selected_github_repository_id
    from public.workspace_onboarding wo
    join public.github_repositories repository
      on repository.id = wo.selected_github_repository_id
     and repository.workspace_id = v_workspace_id
     and repository.factory_id = v_session.factory_id
    where wo.workspace_id = v_workspace_id
      and not v_session.execute_pinned_definition
      and internal.can_access_factory(repository.workspace_id, repository.factory_id)
  ),
  first_configured as (
    select repository_id
    from expanded_candidates
    where repository_id is not null
    order by priority
    limit 1
  ),
  resolved as (
    select gr.*
    from expanded_candidates ec
    join public.github_repositories gr
      on gr.id = ec.repository_id
     and gr.workspace_id = v_workspace_id
     and gr.factory_id = v_session.factory_id
    where ec.repository_id is not null
    order by ec.priority
    limit 1
  )
  select
    coalesce((select id from resolved), (select repository_id from first_configured)),
    (
      select jsonb_build_object(
        'defaultBranch', default_branch,
        'defaultProgrammingLanguage', default_programming_language,
        'fullName', full_name,
        'htmlUrl', html_url,
        'id', id,
        'isArchived', is_archived,
        'isPrivate', private
      )
      from resolved
    )
  into v_effective_repository_id, v_repository;

  return jsonb_build_object(
    'activity', jsonb_build_object(
      'repository', v_repository,
      'sessionGithubRepositoryId', v_effective_repository_id,
      'sessionId', v_session.id,
      'workspaceId', v_workspace_id
    ),
    'creatorDisplayName', v_creator_display_name,
    'session', jsonb_build_object(
      'archivedAt', v_session.archived_at,
      'artifacts', v_artifacts,
      'createdAt', v_session.created_at,
      'currentArtifactId', v_session.current_artifact_id,
      'currentArtifactVersion', v_session.current_artifact_version,
      'currentStageId', v_session.current_stage_id,
      'currentStageSlug', coalesce(v_current_stage.slug, 'unknown'),
      'id', v_session.id,
      'linearIssueId', v_session.linear_issue_id,
      'linearIssueUrl', v_session.linear_issue_url,
      'number', v_session.number,
      'phaseCompletions', v_phase_completions,
      'phaseStatus', v_session.phase_status,
      'pipeline', jsonb_build_object('stages', v_stages),
      'promptMd', v_session.prompt_md,
      'pullRequests', v_pull_requests,
      'title', v_session.title,
      'updatedAt', v_session.updated_at
    ),
    'workspaceSlug', target_workspace_slug
  );
end;
$function$;

-- Capability evidence is repository-specific. A factory may separately check
-- any writable target under the candidate configuration it will use.
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
  if not exists (
    select 1 from (
      select d.factory_id, d.definition_json from public.factory_definition_drafts d
        where (d.workspace_id, d.canonical_digest) = (target_workspace_id, target_definition_digest)
      union all
      select r.factory_id, r.definition_json from public.factory_definition_revisions r
        where (r.workspace_id, r.canonical_digest) = (target_workspace_id, target_definition_digest)
    ) saved join public.factories f on f.id = saved.factory_id and f.workspace_id = target_workspace_id
    where f.is_default and f.id = repository_factory_id
      and saved.definition_json::jsonb ->> 'sandboxProvider' = target_sandbox_provider
      and saved.definition_json::jsonb #>> '{agent,provider}' = target_agent_provider
      and saved.definition_json::jsonb #>> '{agent,model}' = target_agent_model
      and internal.factory_allows_writable_repository(saved.definition_json::jsonb, target_github_repository_id)
  ) then
    raise exception 'The selected factory definition is unavailable for this check.' using errcode = 'P0002';
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
