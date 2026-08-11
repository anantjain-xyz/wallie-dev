-- Keep stage rows as durable session history while letting managers remove
-- them from the active pipeline used by future sessions.
alter table public.pipeline_stages
  add column archived_at timestamptz;

create index pipeline_stages_active_pipeline_position_idx
  on public.pipeline_stages (pipeline_id, position)
  where archived_at is null;

-- Rewrite the desired active stage list atomically. Archived stages reserve
-- their current position slots so archiving a stage by itself cannot reorder
-- an existing session. Active stages fill the remaining slots in payload
-- order; restoring a stage simply includes its durable id again.
create or replace function public.rewrite_default_pipeline(
  target_workspace_id uuid,
  pipeline_name text,
  stage_payload jsonb,
  operating_rules_md text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pipeline_id uuid;
  duplicate_stage_ids uuid[];
  duplicate_stage_slugs text[];
  archived_stage_slug_conflicts text[];
  invalid_member_ids uuid[];
  existing_stage_count integer;
begin
  if coalesce(jsonb_typeof(stage_payload), '') <> 'array'
     or jsonb_array_length(stage_payload) = 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'invalid_stage_payload'
    );
  end if;

  select p.id
  into target_pipeline_id
  from public.pipelines p
  where p.workspace_id = target_workspace_id
    and p.is_default = true
  for update;

  if target_pipeline_id is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'pipeline_not_found'
    );
  end if;

  with input_stages as (
    select nullif(payload.stage ->> 'id', '')::uuid as id
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(duplicate_ids.id order by duplicate_ids.id), '{}'::uuid[])
  into duplicate_stage_ids
  from (
    select i.id
    from input_stages i
    where i.id is not null
    group by i.id
    having count(*) > 1
  ) duplicate_ids;

  if cardinality(duplicate_stage_ids) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'duplicate_stage_id',
      'duplicate_stage_ids', to_jsonb(duplicate_stage_ids)
    );
  end if;

  with input_stages as (
    select payload.stage ->> 'slug' as slug
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(duplicate_slugs.slug order by duplicate_slugs.slug), '{}'::text[])
  into duplicate_stage_slugs
  from (
    select i.slug
    from input_stages i
    group by i.slug
    having count(*) > 1
  ) duplicate_slugs;

  if cardinality(duplicate_stage_slugs) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'duplicate_stage_slug',
      'duplicate_stage_slugs', to_jsonb(duplicate_stage_slugs)
    );
  end if;

  -- Archived slugs remain reserved because artifacts and prompt variables use
  -- slug snapshots. The archived row must be restored rather than duplicated.
  with input_stages as (
    select
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(distinct ps.slug order by ps.slug), '{}'::text[])
  into archived_stage_slug_conflicts
  from public.pipeline_stages ps
  join input_stages i on i.slug = ps.slug
  where ps.pipeline_id = target_pipeline_id
    and i.id is distinct from ps.id
    -- A submitted durable row may release its old slug in the same rewrite
    -- (for example an atomic slug swap). Every other existing owner is either
    -- already archived or will be archived by this payload and must be restored.
    and not exists (
      select 1
      from input_stages owner
      where owner.id = ps.id
        and owner.slug is distinct from ps.slug
    );

  if cardinality(archived_stage_slug_conflicts) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'archived_stage_slug_conflict',
      'archived_stage_slugs', to_jsonb(archived_stage_slug_conflicts)
    );
  end if;

  with input_stages as (
    select array(
      select ids.member_id::uuid
      from jsonb_array_elements_text(
        coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
      ) with ordinality as ids(member_id, member_ordinality)
      order by ids.member_ordinality
    )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(distinct ids.member_id order by ids.member_id), '{}'::uuid[])
  into invalid_member_ids
  from (
    select unnest(i.approver_member_ids) as member_id
    from input_stages i
  ) ids
  where not exists (
    select 1
    from public.workspace_members wm
    where wm.id = ids.member_id
      and wm.workspace_id = target_workspace_id
  );

  if cardinality(invalid_member_ids) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'unknown_approver_member_ids',
      'invalid_approver_member_ids', to_jsonb(invalid_member_ids)
    );
  end if;

  select count(*)::integer
  into existing_stage_count
  from public.pipeline_stages ps
  where ps.pipeline_id = target_pipeline_id;

  set constraints
    public.pipeline_stages_pipeline_slug_unique,
    public.pipeline_stages_pipeline_position_unique
    deferred;

  update public.pipelines p
  set
    name = coalesce(pipeline_name, 'Default'),
    operating_rules_md = coalesce(
      rewrite_default_pipeline.operating_rules_md,
      p.operating_rules_md
    )
  where p.id = target_pipeline_id;

  -- Archive every omitted row, preserving its original timestamp and position.
  with input_stages as (
    select nullif(payload.stage ->> 'id', '')::uuid as id
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  update public.pipeline_stages ps
  set archived_at = coalesce(ps.archived_at, statement_timestamp())
  where ps.pipeline_id = target_pipeline_id
    and not exists (
      select 1
      from input_stages i
      where i.id = ps.id
    );

  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug,
      payload.stage ->> 'name' as name,
      coalesce(payload.stage ->> 'description', '') as description,
      coalesce(payload.stage ->> 'promptTemplateMd', '') as prompt_template_md,
      array(
        select ids.member_id::uuid
        from jsonb_array_elements_text(
          coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
        ) with ordinality as ids(member_id, member_ordinality)
        order by ids.member_ordinality
      )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  update public.pipeline_stages ps
  set
    approver_member_ids = i.approver_member_ids,
    archived_at = null,
    description = i.description,
    name = i.name,
    prompt_template_md = i.prompt_template_md,
    slug = i.slug
  from input_stages i
  where ps.id = i.id
    and ps.pipeline_id = target_pipeline_id;

  -- New stages start beyond the old range and receive their final slot below.
  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug,
      payload.stage ->> 'name' as name,
      coalesce(payload.stage ->> 'description', '') as description,
      coalesce(payload.stage ->> 'promptTemplateMd', '') as prompt_template_md,
      array(
        select ids.member_id::uuid
        from jsonb_array_elements_text(
          coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
        ) with ordinality as ids(member_id, member_ordinality)
        order by ids.member_ordinality
      )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  insert into public.pipeline_stages (
    pipeline_id,
    workspace_id,
    position,
    slug,
    name,
    description,
    prompt_template_md,
    approver_member_ids,
    archived_at
  )
  select
    target_pipeline_id,
    target_workspace_id,
    existing_stage_count + i.input_index,
    i.slug,
    i.name,
    i.description,
    i.prompt_template_md,
    i.approver_member_ids,
    null
  from input_stages i
  where i.id is null
    or not exists (
      select 1
      from public.pipeline_stages ps
      where ps.id = i.id
        and ps.pipeline_id = target_pipeline_id
    );

  -- Fill every non-reserved position with active rows in payload order.
  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  ),
  active_rows as (
    select ps.id, i.input_index
    from input_stages i
    join public.pipeline_stages ps
      on ps.pipeline_id = target_pipeline_id
     and ps.archived_at is null
     and (
       ps.id = i.id
       or (
         (i.id is null or not exists (
           select 1
           from public.pipeline_stages known
           where known.id = i.id
             and known.pipeline_id = target_pipeline_id
         ))
         and ps.slug = i.slug
       )
     )
  ),
  available_slots as (
    select
      slot.position,
      row_number() over (order by slot.position)::integer as input_index
    from generate_series(
      1,
      (select count(*)::integer from public.pipeline_stages where pipeline_id = target_pipeline_id)
    ) as slot(position)
    where not exists (
      select 1
      from public.pipeline_stages archived
      where archived.pipeline_id = target_pipeline_id
        and archived.archived_at is not null
        and archived.position = slot.position
    )
  )
  update public.pipeline_stages ps
  set position = slots.position
  from active_rows active
  join available_slots slots on slots.input_index = active.input_index
  where ps.id = active.id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.rewrite_default_pipeline(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.rewrite_default_pipeline(uuid, text, jsonb, text)
  to service_role;

-- New sessions can only select the active stage set. Existing sessions retain
-- their durable selected-stage rows and continue to resolve archived stages.
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
  first_stage public.pipeline_stages%rowtype;
  pinned_pipeline_id uuid;
  resolved_stage_ids uuid[];
begin
  if nullif(btrim(session_title), '') is null then
    raise exception 'Session title must not be blank' using errcode = '23514';
  end if;

  if nullif(btrim(session_prompt_md), '') is null then
    raise exception 'Session prompt must not be blank' using errcode = '23514';
  end if;

  if nullif(btrim(agent_model_provider), '') is null
     or nullif(btrim(agent_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    where wm.id = creator_member_id
      and wm.workspace_id = target_workspace_id
      and wm.kind = 'human'
      and wm.is_active = true
  ) then
    raise exception 'Creator is not an active human member of workspace %', target_workspace_id
      using errcode = '42501';
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

  -- Serialize active-stage selection with Settings rewrites. Without the same
  -- pipeline-row lock used by rewrite_default_pipeline, a concurrent create
  -- could snapshot a stage immediately before that stage is archived.
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

  select stage.*
  into first_stage
  from public.pipeline_stages stage
  where stage.id = resolved_stage_ids[1];

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
    github_repository_id
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
    first_stage.id,
    'in_progress',
    session_github_repository_id
  )
  returning id into created_session_id;

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
    first_stage.id,
    first_stage.slug,
    first_stage.name,
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
    first_stage.id,
    first_stage.slug,
    first_stage.name,
    case when session_github_repository_id is null then 'project' else 'code' end,
    btrim(agent_model_provider),
    btrim(agent_model_name),
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

revoke all on function public.create_session_with_first_job(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid, uuid[]
) from public, anon, authenticated;

grant execute on function public.create_session_with_first_job(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid, uuid[]
) to service_role;
