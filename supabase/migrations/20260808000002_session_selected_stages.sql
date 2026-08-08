-- Freeze pipeline-stage membership per session while continuing to resolve the
-- selected stages' live names, prompts, approvers, and positions.
create table public.session_selected_stages (
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  stage_id uuid not null references public.pipeline_stages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, stage_id)
);

create index session_selected_stages_stage_id_idx
  on public.session_selected_stages (stage_id);

create or replace function internal.enforce_session_selected_stage_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  session_pipeline_id uuid;
  session_workspace_id uuid;
  stage_pipeline_id uuid;
  stage_workspace_id uuid;
begin
  select session.pipeline_id, session.workspace_id
  into session_pipeline_id, session_workspace_id
  from public.sessions session
  where session.id = new.session_id;

  select stage.pipeline_id, stage.workspace_id
  into stage_pipeline_id, stage_workspace_id
  from public.pipeline_stages stage
  where stage.id = new.stage_id;

  if session_pipeline_id is null or stage_pipeline_id is null then
    raise exception 'Selected session stage references a missing session or stage'
      using errcode = '23503';
  end if;

  if new.workspace_id is distinct from session_workspace_id
     or stage_workspace_id is distinct from session_workspace_id
     or stage_pipeline_id is distinct from session_pipeline_id then
    raise exception 'Selected stage must belong to the session workspace and pipeline'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger session_selected_stages_enforce_refs
before insert or update on public.session_selected_stages
for each row
execute function internal.enforce_session_selected_stage_refs();

-- Existing sessions selected every stage implicitly. Capture their current
-- pipeline membership so later additions do not change their shape.
insert into public.session_selected_stages (session_id, workspace_id, stage_id)
select session.id, session.workspace_id, stage.id
from public.sessions session
join public.pipeline_stages stage
  on stage.pipeline_id = session.pipeline_id
 and stage.workspace_id = session.workspace_id;

alter table public.session_selected_stages enable row level security;

revoke all on public.session_selected_stages from public, anon, authenticated;
grant select on public.session_selected_stages to authenticated;
grant all on public.session_selected_stages to service_role;

create policy session_selected_stages_select_membership
  on public.session_selected_stages
  for select
  to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));

-- The extra trailing argument intentionally replaces the prior signature.
-- NULL keeps stale clients compatible by selecting the entire pinned pipeline.
drop function public.create_session_with_first_job(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid
);

create function public.create_session_with_first_job(
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

  if selected_pipeline_id is null then
    select pipeline.id
    into pinned_pipeline_id
    from public.pipelines pipeline
    where pipeline.workspace_id = target_workspace_id
      and pipeline.is_default = true;
  else
    select pipeline.id
    into pinned_pipeline_id
    from public.pipelines pipeline
    where pipeline.id = selected_pipeline_id
      and pipeline.workspace_id = target_workspace_id;
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
      and stage.workspace_id = target_workspace_id;
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
    'agent_generating',
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

-- Preserve the approval CAS and authorization rules while advancing only
-- through this session's selected stage membership.
create or replace function public.approve_session_stage(
  target_session_id uuid,
  expected_workspace_id uuid,
  expected_version integer,
  approver_member_id uuid default null
)
returns table (
  id uuid,
  pipeline_id uuid,
  current_stage_id uuid,
  current_stage_slug text,
  phase_status public.pipeline_phase_status,
  workspace_id uuid,
  linear_issue_url text,
  archived_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  session_pipeline_id uuid;
  current_stage_id_v uuid;
  current_stage_slug_v text;
  current_position integer;
  approver_list uuid[];
  anyone_can_approve_v boolean;
  approver_role public.member_role;
  approver_active boolean;
  approver_workspace uuid;
  next_stage_id uuid;
  approved_at_now timestamptz := now();
begin
  select s.pipeline_id, s.current_stage_id
  into session_pipeline_id, current_stage_id_v
  from public.sessions s
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
    and s.archived_at is null;

  if current_stage_id_v is null then
    return;
  end if;

  select ps.position, ps.slug, ps.approver_member_ids, ps.anyone_can_approve
  into current_position, current_stage_slug_v, approver_list, anyone_can_approve_v
  from public.pipeline_stages ps
  where ps.id = current_stage_id_v;

  if approver_member_id is not null then
    select wm.role, wm.is_active, wm.workspace_id
    into approver_role, approver_active, approver_workspace
    from public.workspace_members wm
    where wm.id = approver_member_id;

    if not coalesce(approver_active, false)
       or approver_workspace is distinct from expected_workspace_id then
      return;
    end if;
  end if;

  if coalesce(anyone_can_approve_v, false) then
    if approver_member_id is null then
      return;
    end if;
  elsif coalesce(array_length(approver_list, 1), 0) > 0 then
    if approver_member_id is null
       or not (approver_member_id = any(approver_list)) then
      return;
    end if;
  else
    if approver_member_id is null
       or approver_role is null
       or approver_role not in ('owner', 'admin') then
      return;
    end if;
  end if;

  update public.sessions s
  set phase_status = 'approved'
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
    and s.archived_at is null;

  if not found then
    return;
  end if;

  insert into public.session_phase_completions (
    session_id,
    workspace_id,
    stage_id,
    stage_slug,
    completed_at,
    completed_by_member_id
  )
  values (
    target_session_id,
    expected_workspace_id,
    current_stage_id_v,
    current_stage_slug_v,
    approved_at_now,
    approver_member_id
  )
  on conflict (session_id, stage_slug) do nothing;

  select ps.id into next_stage_id
  from public.pipeline_stages ps
  join public.session_selected_stages selection
    on selection.stage_id = ps.id
   and selection.session_id = target_session_id
   and selection.workspace_id = expected_workspace_id
  where ps.pipeline_id = session_pipeline_id
    and ps.position > current_position
  order by ps.position asc
  limit 1;

  if next_stage_id is null then
    update public.sessions s
    set archived_at = approved_at_now
    where s.id = target_session_id;
  else
    update public.sessions s
    set current_stage_id = next_stage_id,
        phase_status = 'agent_generating',
        current_artifact_version = 0,
        rejection_count = 0
    where s.id = target_session_id;
  end if;

  return query
    select
      s.id,
      s.pipeline_id,
      s.current_stage_id,
      ps.slug,
      s.phase_status,
      s.workspace_id,
      s.linear_issue_url,
      s.archived_at
    from public.sessions s
    join public.pipeline_stages ps on ps.id = s.current_stage_id
    where s.id = target_session_id;
end;
$$;

revoke all on function public.approve_session_stage(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.approve_session_stage(uuid, uuid, integer, uuid)
  to service_role;

-- Keep the narrow session-detail payload, but expose only stages this session
-- can actually run so the existing timeline naturally hides skipped stages.
create or replace function public.get_session_detail_page(
  target_workspace_slug text,
  target_session_number integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  select *
  into v_current_stage
  from public.pipeline_stages ps
  where ps.id = v_session.current_stage_id
    and ps.workspace_id = v_workspace_id;

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
  from public.pipeline_stages ps
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
          'createdAt', sa.created_at,
          'payload', sa.artifact_json,
          'stageSlug', sa.stage_slug,
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
      and sa.stage_slug = v_current_stage.slug
      and sa.version = v_session.current_artifact_version;
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
    values (1, v_session.github_repository_id)
    union all
    select 2, github_repository_id
    from latest_pull_request_repository
    union all
    select 3, wrp.github_repository_id
    from public.workspace_repository_profiles wrp
    where wrp.workspace_id = v_workspace_id
      and wrp.is_primary
    union all
    select 4, wo.selected_github_repository_id
    from public.workspace_onboarding wo
    where wo.workspace_id = v_workspace_id
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
$$;

revoke all on function public.get_session_detail_page(text, integer) from public;
grant execute on function public.get_session_detail_page(text, integer) to authenticated;
