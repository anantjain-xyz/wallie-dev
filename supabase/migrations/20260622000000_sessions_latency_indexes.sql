-- Faster session list/detail reads for workspace-scoped authenticated pages.

alter table public.sessions
  add column if not exists search_document tsvector
  generated always as (
    to_tsvector(
      'simple',
      coalesce(title, '') || ' ' ||
      coalesce(linear_issue_id, '') || ' ' ||
      coalesce(prompt_md, '')
    )
  ) stored;

alter table public.sessions
  add column if not exists search_text text
  generated always as (
    lower(
      coalesce(title, '') || ' ' ||
      coalesce(linear_issue_id, '') || ' ' ||
      coalesce(prompt_md, '')
    )
  ) stored;

create index if not exists sessions_workspace_updated_at_id_desc_idx
  on public.sessions (workspace_id, updated_at desc, id desc);

create index if not exists sessions_workspace_active_updated_at_id_desc_idx
  on public.sessions (workspace_id, updated_at desc, id desc)
  where archived_at is null;

create index if not exists sessions_workspace_archived_updated_at_id_desc_idx
  on public.sessions (workspace_id, updated_at desc, id desc)
  where archived_at is not null;

create index if not exists sessions_workspace_stage_updated_at_id_desc_idx
  on public.sessions (workspace_id, current_stage_id, updated_at desc, id desc);

create index if not exists sessions_search_document_idx
  on public.sessions using gin (search_document);

create index if not exists sessions_search_text_trgm_idx
  on public.sessions using gin (search_text extensions.gin_trgm_ops);

create index if not exists session_pull_requests_workspace_session_created_at_desc_idx
  on public.session_pull_requests (workspace_id, session_id, created_at desc);

create index if not exists session_artifacts_session_version_desc_idx
  on public.session_artifacts (session_id, version desc);

create or replace function public.get_session_list_page(
  target_workspace_slug text,
  session_scope text default 'all',
  stage_filter_slug text default null,
  search_query text default null,
  page_limit integer default 50,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_workspace_id uuid;
  v_limit integer := least(greatest(coalesce(page_limit, 50), 1), 100);
  v_scope text := case
    when session_scope in ('all', 'active', 'archived', 'has-pr') then session_scope
    else 'all'
  end;
  v_stage_slug text := nullif(stage_filter_slug, '');
  v_search_raw text := nullif(trim(coalesce(search_query, '')), '');
  v_search_query tsquery := null;
  v_search_like_pattern text := null;
  v_rows jsonb := '[]'::jsonb;
  v_stage_facets jsonb := '[]'::jsonb;
  v_has_any_session boolean := false;
  v_has_more boolean := false;
begin
  if v_search_raw is not null then
    v_search_query := websearch_to_tsquery('simple', v_search_raw);
    v_search_like_pattern := '%' ||
      replace(
        replace(
          replace(lower(v_search_raw), '\', '\\'),
          '%',
          '\%'
        ),
        '_',
        '\_'
      ) ||
      '%';
  end if;

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
    return null;
  end if;

  select exists (
    select 1
    from public.sessions s
    where s.workspace_id = v_workspace_id
  )
  into v_has_any_session;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'count', session_count,
        'name', name,
        'position', position,
        'slug', slug
      )
      order by position asc, name asc
    ),
    '[]'::jsonb
  )
  into v_stage_facets
  from (
    select
      (array_agg(name order by updated_at desc, created_at desc, id desc))[1] as name,
      (array_agg(position order by updated_at desc, created_at desc, id desc))[1] as position,
      slug,
      count(*)::integer as session_count
    from (
      select
        ps.created_at,
        ps.id,
        ps.name,
        ps.position,
        ps.slug,
        ps.updated_at
      from public.sessions s
      join public.pipeline_stages ps
        on ps.id = s.current_stage_id
      where s.workspace_id = v_workspace_id
        and (v_scope <> 'active' or s.archived_at is null)
        and (v_scope <> 'archived' or s.archived_at is not null)
        and (
          v_scope <> 'has-pr'
          or exists (
            select 1
            from public.session_pull_requests spr
            where spr.workspace_id = v_workspace_id
              and spr.session_id = s.id
          )
        )
        and (
          v_search_raw is null
          or s.search_document @@ v_search_query
          or s.search_text like v_search_like_pattern escape '\'
        )
    ) stage_rows
    group by slug
  ) facets;

  with filtered as (
    select
      s.id,
      s.archived_at,
      s.created_at,
      s.current_artifact_version,
      s.current_stage_id,
      s.linear_issue_id,
      s.linear_issue_url,
      s.number,
      s.phase_status,
      s.pipeline_id,
      s.rejection_count,
      s.title,
      s.updated_at,
      s.workspace_id,
      ps.name as current_stage_name,
      ps.position as current_stage_position,
      ps.slug as current_stage_slug,
      coalesce(prs.pull_request_count, 0)::integer as pull_request_count,
      coalesce(prs.pull_requests, '[]'::jsonb) as pull_requests
    from public.sessions s
    join public.pipeline_stages ps
      on ps.id = s.current_stage_id
    left join lateral (
      select
        count(*)::integer as pull_request_count,
        jsonb_agg(
          jsonb_build_object(
            'branchName', spr.branch_name,
            'id', spr.id,
            'isDraft', spr.is_draft,
            'pullRequestNumber', spr.pull_request_number,
            'pullRequestState', spr.pull_request_state,
            'pullRequestUrl', spr.pull_request_url,
            'repositoryFullName', gr.full_name,
            'repositoryHtmlUrl', gr.html_url,
            'updatedAt', spr.updated_at
          )
          order by spr.created_at desc
        ) as pull_requests
      from public.session_pull_requests spr
      left join public.github_repositories gr
        on gr.id = spr.github_repository_id
       and gr.workspace_id = v_workspace_id
      where spr.workspace_id = v_workspace_id
        and spr.session_id = s.id
    ) prs on true
    where s.workspace_id = v_workspace_id
      and (v_scope <> 'active' or s.archived_at is null)
      and (v_scope <> 'archived' or s.archived_at is not null)
      and (v_scope <> 'has-pr' or prs.pull_request_count > 0)
      and (v_stage_slug is null or ps.slug = v_stage_slug)
      and (
        v_search_raw is null
        or s.search_document @@ v_search_query
        or s.search_text like v_search_like_pattern escape '\'
      )
      and (
        cursor_updated_at is null
        or cursor_id is null
        or s.updated_at < cursor_updated_at
        or (s.updated_at = cursor_updated_at and s.id < cursor_id)
      )
    order by s.updated_at desc, s.id desc
    limit v_limit + 1
  ),
  numbered as (
    select filtered.*, row_number() over () as rn
    from filtered
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'archivedAt', archived_at,
          'createdAt', created_at,
          'currentArtifactVersion', current_artifact_version,
          'currentStageId', current_stage_id,
          'currentStageName', current_stage_name,
          'currentStagePosition', current_stage_position,
          'currentStageSlug', current_stage_slug,
          'id', id,
          'linearIssueId', linear_issue_id,
          'linearIssueUrl', linear_issue_url,
          'number', number,
          'phaseStatus', phase_status,
          'pipelineId', pipeline_id,
          'pullRequestCount', pull_request_count,
          'pullRequests', pull_requests,
          'rejectionCount', rejection_count,
          'title', title,
          'updatedAt', updated_at,
          'workspaceId', workspace_id
        )
        order by updated_at desc, id desc
      ) filter (where rn <= v_limit),
      '[]'::jsonb
    ),
    count(*) > v_limit
  into v_rows, v_has_more
  from numbered;

  return jsonb_build_object(
    'hasAnySession', v_has_any_session,
    'hasMore', v_has_more,
    'sessions', v_rows,
    'stageFacets', v_stage_facets,
    'workspaceId', v_workspace_id
  );
end;
$$;

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
  v_session public.sessions%rowtype;
  v_pipeline public.pipelines%rowtype;
  v_current_stage public.pipeline_stages%rowtype;
  v_stages jsonb := '[]'::jsonb;
  v_phase_completions jsonb := '[]'::jsonb;
  v_artifacts jsonb := '[]'::jsonb;
  v_pull_requests jsonb := '[]'::jsonb;
  v_pull_request_count integer := 0;
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
    return null;
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
  into v_pipeline
  from public.pipelines p
  where p.id = v_session.pipeline_id
    and p.workspace_id = v_workspace_id;

  if not found then
    raise exception 'Session % references missing pipeline %', v_session.id, v_session.pipeline_id;
  end if;

  select *
  into v_current_stage
  from public.pipeline_stages ps
  where ps.id = v_session.current_stage_id
    and ps.workspace_id = v_workspace_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'approverMemberIds', ps.approver_member_ids,
        'description', ps.description,
        'id', ps.id,
        'name', ps.name,
        'pipelineId', ps.pipeline_id,
        'position', ps.position,
        'promptTemplateMd', ps.prompt_template_md,
        'slug', ps.slug
      )
      order by ps.position asc
    ),
    '[]'::jsonb
  )
  into v_stages
  from public.pipeline_stages ps
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

  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'branchName', spr.branch_name,
          'id', spr.id,
          'isDraft', spr.is_draft,
          'pullRequestNumber', spr.pull_request_number,
          'pullRequestState', spr.pull_request_state,
          'pullRequestUrl', spr.pull_request_url,
          'repositoryFullName', gr.full_name,
          'repositoryHtmlUrl', gr.html_url,
          'updatedAt', spr.updated_at
        )
        order by spr.created_at desc
      ),
      '[]'::jsonb
    )
  into v_pull_request_count, v_pull_requests
  from public.session_pull_requests spr
  left join public.github_repositories gr
    on gr.id = spr.github_repository_id
   and gr.workspace_id = v_workspace_id
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
    'creatorMemberId', v_session.creator_member_id,
    'sessionGithubRepositoryId', v_effective_repository_id,
    'repository', v_repository,
    'session', jsonb_build_object(
      'archivedAt', v_session.archived_at,
      'artifacts', v_artifacts,
      'createdAt', v_session.created_at,
      'currentArtifactVersion', v_session.current_artifact_version,
      'currentStageId', v_session.current_stage_id,
      'currentStageName', coalesce(v_current_stage.name, 'Unknown'),
      'currentStagePosition', coalesce(v_current_stage.position, 2147483647),
      'currentStageSlug', coalesce(v_current_stage.slug, 'unknown'),
      'id', v_session.id,
      'linearIssueId', v_session.linear_issue_id,
      'linearIssueUrl', v_session.linear_issue_url,
      'number', v_session.number,
      'phaseStatus', v_session.phase_status,
      'phaseCompletions', v_phase_completions,
      'pipeline', jsonb_build_object(
        'id', v_pipeline.id,
        'isDefault', v_pipeline.is_default,
        'name', v_pipeline.name,
        'operatingRulesMd', coalesce(v_pipeline.operating_rules_md, ''),
        'stages', v_stages
      ),
      'pipelineId', v_session.pipeline_id,
      'promptMd', v_session.prompt_md,
      'pullRequestCount', v_pull_request_count,
      'pullRequests', v_pull_requests,
      'rejectionCount', v_session.rejection_count,
      'title', v_session.title,
      'updatedAt', v_session.updated_at,
      'workspaceId', v_session.workspace_id
    )
  );
end;
$$;

revoke all on function public.get_session_list_page(
  text,
  text,
  text,
  text,
  integer,
  timestamptz,
  uuid
) from public;
revoke all on function public.get_session_detail_page(text, integer) from public;

grant execute on function public.get_session_list_page(
  text,
  text,
  text,
  text,
  integer,
  timestamptz,
  uuid
) to authenticated;
grant execute on function public.get_session_detail_page(text, integer) to authenticated;
