-- Remove Has PR filter from sessions ledger RPC.
-- Previously supported 'has-pr' scope; now only 'all', 'active', 'archived'.

drop function if exists public.get_session_list_page(
  text, text, text, text, integer, timestamptz, uuid
);

create or replace function public.get_session_list_page(
  target_workspace_slug text,
  session_scope text default 'all',
  stage_filter_slug text default null,
  search_query text default null,
  page_limit integer default 50,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null,
  sort_key text default 'updated',
  cursor_number integer default null
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
    when session_scope in ('all', 'active', 'archived') then session_scope
    else 'all'
  end;
  v_sort text := case
    when sort_key in ('updated', 'oldest', 'number') then sort_key
    else 'updated'
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
      gr.full_name as repository_full_name,
      coalesce(prs.pull_request_count, 0)::integer as pull_request_count,
      coalesce(prs.pull_requests, '[]'::jsonb) as pull_requests
    from public.sessions s
    join public.pipeline_stages ps
      on ps.id = s.current_stage_id
    left join public.github_repositories gr
      on gr.id = s.github_repository_id
     and gr.workspace_id = v_workspace_id
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
            'repositoryFullName', repo.full_name,
            'repositoryHtmlUrl', repo.html_url,
            'updatedAt', spr.updated_at
          )
          order by spr.created_at desc
        ) as pull_requests
      from public.session_pull_requests spr
      left join public.github_repositories repo
        on repo.id = spr.github_repository_id
       and repo.workspace_id = v_workspace_id
      where spr.workspace_id = v_workspace_id
        and spr.session_id = s.id
    ) prs on true
    where s.workspace_id = v_workspace_id
      and (v_scope <> 'active' or s.archived_at is null)
      and (v_scope <> 'archived' or s.archived_at is not null)
      and (v_stage_slug is null or ps.slug = v_stage_slug)
      and (
        v_search_raw is null
        or s.search_document @@ v_search_query
        or s.search_text like v_search_like_pattern escape '\'
      )
      and (
        cursor_id is null
        or (
          v_sort = 'updated'
          and cursor_updated_at is not null
          and (
            s.updated_at < cursor_updated_at
            or (s.updated_at = cursor_updated_at and s.id < cursor_id)
          )
        )
        or (
          v_sort = 'oldest'
          and cursor_updated_at is not null
          and (
            s.updated_at > cursor_updated_at
            or (s.updated_at = cursor_updated_at and s.id > cursor_id)
          )
        )
        or (
          v_sort = 'number'
          and cursor_number is not null
          and (
            s.number < cursor_number
            or (s.number = cursor_number and s.id < cursor_id)
          )
        )
      )
    order by
      case when v_sort = 'updated' then s.updated_at end desc nulls last,
      case when v_sort = 'updated' then s.id::text end desc nulls last,
      case when v_sort = 'oldest' then s.updated_at end asc nulls last,
      case when v_sort = 'oldest' then s.id::text end asc nulls last,
      case when v_sort = 'number' then s.number end desc nulls last,
      case when v_sort = 'number' then s.id::text end desc nulls last
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
          'repositoryFullName', repository_full_name,
          'title', title,
          'updatedAt', updated_at,
          'workspaceId', workspace_id
        )
        order by rn
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

revoke all on function public.get_session_list_page(
  text, text, text, text, integer, timestamptz, uuid, text, integer
) from public, anon;

grant execute on function public.get_session_list_page(
  text, text, text, text, integer, timestamptz, uuid, text, integer
) to authenticated, service_role;
