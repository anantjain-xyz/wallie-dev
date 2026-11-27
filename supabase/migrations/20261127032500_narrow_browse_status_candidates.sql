create or replace function public.get_filtered_pipeline_dashboard_page(
  target_workspace_id uuid,
  target_pipeline_id uuid default null,
  target_stage_id uuid default null,
  page_limit integer default 25,
  cursor_seen_ids uuid[] default null,
  target_factory_id uuid default null,
  search_query text default null,
  status_filter text default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_lanes jsonb := '[]'::jsonb;
  v_factory_ids uuid[];
  v_limit integer := least(greatest(coalesce(page_limit, 25), 1), 25);
  v_seen_ids uuid[] := coalesce(cursor_seen_ids, '{}'::uuid[]);
  v_search text := nullif(lower(btrim(left(search_query, 200))), '');
begin
  if not exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace_id
      and wm.user_id = auth.uid()
      and wm.is_active
      and wm.kind = 'human'
  ) then
    return null;
  end if;

  select coalesce(array_agg(factory.id), '{}'::uuid[])
  into v_factory_ids
  from public.factories factory
  where factory.workspace_id = target_workspace_id
    and (target_factory_id is null or factory.id = target_factory_id)
    and internal.can_access_factory(factory.workspace_id, factory.id);

  if (target_pipeline_id is null) <> (target_stage_id is null) then
    raise exception 'pipeline and stage filters must be provided together';
  end if;

  with lane_definitions as materialized (
    -- Always render every stage from the current default pipeline, including
    -- empty lanes and fully custom stage sets.
    select
      p.id as pipeline_id,
      p.is_default as pipeline_is_default,
      p.name as pipeline_name,
      f.name as factory_name,
      ps.description,
      ps.id as stage_id,
      ps.name as stage_name,
      ps.position,
      ps.slug
    from public.pipelines p
    join public.factories f
      on f.workspace_id = p.workspace_id and f.id = p.factory_id
    join public.pipeline_stages ps
      on ps.pipeline_id = p.id
     and ps.workspace_id = target_workspace_id
    where p.workspace_id = target_workspace_id
      and p.factory_id = any(v_factory_ids)
      and p.is_default
      and (
        target_pipeline_id is null
        or (p.id = target_pipeline_id and ps.id = target_stage_id)
      )

    union

    -- Historical and non-default pipelines contribute their full stage shape
    -- while they still have an active pinned session. The pipeline_id is part
    -- of lane identity; matching stage slugs on different pipelines never merge.
    select distinct
      p.id as pipeline_id,
      p.is_default as pipeline_is_default,
      p.name as pipeline_name,
      f.name as factory_name,
      ps.description,
      ps.id as stage_id,
      ps.name as stage_name,
      ps.position,
      ps.slug
    from public.pipelines p
    join public.factories f
      on f.workspace_id = p.workspace_id and f.id = p.factory_id
    join public.pipeline_stages ps
      on ps.pipeline_id = p.id
     and ps.workspace_id = target_workspace_id
    where p.workspace_id = target_workspace_id
      and p.factory_id = any(v_factory_ids)
      and exists (
        select 1
        from public.sessions s
        where s.workspace_id = target_workspace_id
          and s.pipeline_id = p.id
          and s.archived_at is null
      )
      and (
        target_pipeline_id is null
        or (p.id = target_pipeline_id and ps.id = target_stage_id)
      )
  ),
  snapshot_sessions as materialized (
    select
      s.created_at,
      s.current_stage_id,
      s.factory_id,
      s.id,
      s.linear_issue_id,
      s.linear_issue_url,
      s.number,
      s.phase_status,
      s.pipeline_id,
      s.rejection_count,
      s.title,
      s.updated_at,
      s.workspace_id,
      case when s.phase_status = 'awaiting_review' then 0 else 1 end as attention_rank
    from public.sessions s
    join lane_definitions ld
      on ld.pipeline_id = s.pipeline_id
     and ld.stage_id = s.current_stage_id
    where s.workspace_id = target_workspace_id
      and s.factory_id = any(v_factory_ids)
      and s.archived_at is null
  ),
  matching_sessions as materialized (
    select ss.*
    from snapshot_sessions ss
    left join lateral (
      select ar.status
      from public.agent_runs ar
      where status_filter is not null
        and ar.workspace_id = target_workspace_id
        and ar.session_id = ss.id
      order by ar.created_at desc, ar.id desc
      limit 1
    ) latest on true
    where (
      status_filter is null
      or status_filter = 'failed'
      or ss.phase_status::text = status_filter
    )
    and (
      status_filter is null
      or case when latest.status = 'error' then 'failed' else ss.phase_status::text end = status_filter
    )
    and (
      v_search is null
      or strpos(lower(ss.title), v_search) > 0
      or strpos('#' || ss.number::text, v_search) > 0
      or strpos(lower(ss.linear_issue_id), v_search) > 0
      or exists (
        select 1
        from public.session_pull_requests spr
        left join public.github_repositories repository
          on repository.id = spr.github_repository_id
         and repository.workspace_id = target_workspace_id
         and repository.factory_id = ss.factory_id
        where spr.workspace_id = target_workspace_id
          and spr.session_id = ss.id
          and spr.pull_request_url is not null
          and (spr.github_repository_id is null or repository.id is not null)
          and strpos('pr #' || spr.pull_request_number::text, v_search) > 0
      )
    )
  ),
  active_counts as (
    select pipeline_id, current_stage_id as stage_id, count(*)::integer as active_count
    from snapshot_sessions
    group by pipeline_id, current_stage_id
  ),
  lane_counts as (
    select pipeline_id, current_stage_id as stage_id, count(*)::integer as total_count
    from matching_sessions
    group by pipeline_id, current_stage_id
  ),
  remaining_sessions as (
    select
      ss.*,
      count(*) over (
        partition by ss.pipeline_id, ss.current_stage_id
      )::integer as remaining_count,
      row_number() over (
        partition by ss.pipeline_id, ss.current_stage_id
        order by ss.attention_rank asc, ss.updated_at desc, ss.id desc
      )::integer as page_row
    from matching_sessions ss
    where not (ss.id = any(v_seen_ids))
  ),
  page_sessions as (
    select *
    from remaining_sessions
    where page_row <= v_limit
  ),
  card_rows as (
    select
      ps.*,
      lr.latest_run_id,
      lr.latest_run_status,
      coalesce(prs.pull_requests, '[]'::jsonb) as pull_requests
    from page_sessions ps
    left join lateral (
      select jsonb_agg(
        jsonb_build_object(
          'id', spr.id,
          'pullRequestNumber', spr.pull_request_number,
          'pullRequestUrl', spr.pull_request_url
        )
        order by spr.created_at desc, spr.id desc
      ) as pull_requests
      from public.session_pull_requests spr
      where spr.workspace_id = target_workspace_id
        and spr.session_id = ps.id
        and spr.pull_request_url is not null
        and (spr.github_repository_id is null or exists (
          select 1
          from public.github_repositories repository
          where repository.id = spr.github_repository_id
            and repository.workspace_id = target_workspace_id
            and repository.factory_id = ps.factory_id
        ))
    ) prs on true
    left join lateral (
      select
        ar.id as latest_run_id,
        ar.status as latest_run_status
      from public.agent_runs ar
      where ar.workspace_id = target_workspace_id
        and ar.session_id = ps.id
      order by ar.created_at desc, ar.id desc
      limit 1
    ) lr on true
  ),
  lane_pages as (
    select
      ld.*,
      coalesce(ac.active_count, 0) as active_count,
      coalesce(lc.total_count, 0) as total_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'createdAt', cr.created_at,
            'currentStageId', cr.current_stage_id,
            'id', cr.id,
            'latestRunId', cr.latest_run_id,
            'latestRunStatus', cr.latest_run_status,
            'linearIssueId', cr.linear_issue_id,
            'linearIssueUrl', cr.linear_issue_url,
            'number', cr.number,
            'phaseStatus', cr.phase_status,
            'pipelineId', cr.pipeline_id,
            'pullRequests', cr.pull_requests,
            'rejectionCount', cr.rejection_count,
            'title', cr.title,
            'updatedAt', cr.updated_at,
            'workspaceId', cr.workspace_id
          )
          order by cr.attention_rank asc, cr.updated_at desc, cr.id desc
        ) filter (where cr.id is not null),
        '[]'::jsonb
      ) as cards,
      case
        when coalesce(max(cr.remaining_count), 0) > v_limit then
          jsonb_build_object(
            'pipelineId', ld.pipeline_id,
            'stageId', ld.stage_id
          )
        else null
      end as next_cursor
    from lane_definitions ld
    left join active_counts ac
      on ac.pipeline_id = ld.pipeline_id
     and ac.stage_id = ld.stage_id
    left join lane_counts lc
      on lc.pipeline_id = ld.pipeline_id
     and lc.stage_id = ld.stage_id
    left join card_rows cr
      on cr.pipeline_id = ld.pipeline_id
     and cr.current_stage_id = ld.stage_id
    group by
      ld.pipeline_id,
      ld.pipeline_is_default,
      ld.pipeline_name,
      ld.factory_name,
      ld.description,
      ld.stage_id,
      ld.stage_name,
      ld.position,
      ld.slug,
      ac.active_count,
      lc.total_count
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'activeCount', lp.active_count,
        'cards', lp.cards,
        'cursor', lp.next_cursor,
        'description', lp.description,
        'factoryName', lp.factory_name,
        'id', lp.stage_id,
        'name', lp.stage_name,
        'pipeline', jsonb_build_object(
          'id', lp.pipeline_id,
          'isDefault', lp.pipeline_is_default,
          'name', lp.pipeline_name
        ),
        'position', lp.position,
        'slug', lp.slug,
        'totalCount', lp.total_count
      )
      order by
        lp.pipeline_is_default desc,
        lp.pipeline_name asc,
        lp.pipeline_id asc,
        lp.position asc,
        lp.stage_id asc
    ),
    '[]'::jsonb
  )
  into v_lanes
  from lane_pages lp;

  return jsonb_build_object('lanes', v_lanes);
end;
$$;

create or replace function public.get_session_list_page(
  target_workspace_slug text,
  session_scope text default 'all',
  stage_filter_slug text default null,
  search_query text default null,
  page_limit integer default 50,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null,
  sort_key text default 'updated',
  cursor_number integer default null,
  target_factory_id uuid default null,
  status_filter text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_workspace_id uuid;
  v_factory_ids uuid[];
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
  v_status text := case
    when status_filter in ('awaiting_review', 'in_progress', 'approved', 'rejected', 'failed')
      then status_filter
    else null
  end;
  v_search_raw text := nullif(
    regexp_replace(coalesce(search_query, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'),
    ''
  );
  v_search_digits text := null;
  v_search_number integer := null;
  v_search_query tsquery := null;
  v_search_like_pattern text := null;
  v_rows jsonb := '[]'::jsonb;
  v_stage_facets jsonb := '[]'::jsonb;
  v_scope_facets jsonb := jsonb_build_object('active', 0, 'archived', 0, 'all', 0);
  v_has_any_session boolean := false;
  v_has_more boolean := false;
begin
  if v_search_raw ~ '^#?[0-9]+$' then
    v_search_digits := ltrim(ltrim(v_search_raw, '#'), '0');
    -- Bound the cast first: malformed and arbitrarily large input stays text search.
    if length(v_search_digits) between 1 and 10 then
      if v_search_digits::bigint <= 2147483647 then
        v_search_number := v_search_digits::integer;
        v_search_raw := v_search_digits;
      end if;
    end if;
  end if;

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

  select coalesce(array_agg(factory.id), '{}'::uuid[])
  into v_factory_ids
  from public.factories factory
  where factory.workspace_id = v_workspace_id
    and (target_factory_id is null or factory.id = target_factory_id)
    and internal.can_access_factory(factory.workspace_id, factory.id);

  select exists (
    select 1
    from public.sessions s
    where s.workspace_id = v_workspace_id
      and s.factory_id = any(v_factory_ids)
  )
  into v_has_any_session;

  with matching as materialized (
    select
      s.id,
      s.archived_at,
      ps.id as stage_id,
      ps.created_at as stage_created_at,
      ps.updated_at as stage_updated_at,
      ps.name as stage_name,
      ps.position as stage_position,
      ps.slug as stage_slug,
      lr.latest_run_status
    from public.sessions s
    join public.pipeline_stages ps on ps.id = s.current_stage_id
    left join lateral (
      select ar.status as latest_run_status
      from public.agent_runs ar
      where v_status is not null
        and ar.workspace_id = v_workspace_id
        and ar.session_id = s.id
      order by ar.created_at desc, ar.id desc
      limit 1
    ) lr on true
    where s.workspace_id = v_workspace_id
      and s.factory_id = any(v_factory_ids)
      and (
        v_status is null
        or v_status = 'failed'
        or s.phase_status::text = v_status
      )
      and (
        v_search_raw is null
        or s.number = v_search_number
        or s.search_document @@ v_search_query
        or s.search_text like v_search_like_pattern escape '\'
      )
      and (
        v_status is null
        or v_status = case
          when lr.latest_run_status = 'error' then 'failed'
          else s.phase_status::text
        end
      )
  ), stage_groups as (
    select
      (array_agg(stage_name order by stage_updated_at desc, stage_created_at desc, stage_id desc))[1] as name,
      (array_agg(stage_position order by stage_updated_at desc, stage_created_at desc, stage_id desc))[1] as position,
      stage_slug as slug,
      count(*)::integer as session_count
    from matching
    where (v_scope <> 'active' or archived_at is null)
      and (v_scope <> 'archived' or archived_at is not null)
    group by stage_slug
  ), filtered as (
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
      match.stage_name as current_stage_name,
      match.stage_position as current_stage_position,
      match.stage_slug as current_stage_slug,
      match.latest_run_status as matched_run_status,
      gr.full_name as repository_full_name,
      coalesce(prs.pull_request_count, 0)::integer as pull_request_count,
      coalesce(prs.pull_requests, '[]'::jsonb) as pull_requests
    from matching match
    join public.sessions s on s.id = match.id and s.workspace_id = v_workspace_id
    left join public.github_repositories gr
      on gr.id = s.github_repository_id
     and gr.workspace_id = v_workspace_id
     and gr.factory_id = s.factory_id
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
       and repo.factory_id = s.factory_id
      where spr.workspace_id = v_workspace_id
        and spr.session_id = s.id
        and (spr.github_repository_id is null or repo.id is not null)
    ) prs on true
    where (v_scope <> 'active' or match.archived_at is null)
      and (v_scope <> 'archived' or match.archived_at is not null)
      and (v_stage_slug is null or match.stage_slug = v_stage_slug)
      and (
        cursor_id is null
        or (
          v_search_number is not null
          and cursor_number = v_search_number
          and s.number <> v_search_number
        )
        or (
          coalesce(s.number = v_search_number, false)
            = coalesce(cursor_number = v_search_number, false)
          and (
            (
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
        )
      )
    order by
      coalesce(s.number = v_search_number, false) desc,
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
  ),
  with_latest_run as (
    select numbered.*, coalesce(numbered.matched_run_status, lr.latest_run_status) as latest_run_status
    from numbered
    left join lateral (
      select ar.status as latest_run_status
      from public.agent_runs ar
      where v_status is null
        and ar.workspace_id = v_workspace_id
        and ar.session_id = numbered.id
      order by ar.created_at desc, ar.id desc
      limit 1
    ) lr on true
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
          'latestRunStatus', latest_run_status,
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
    count(*) > v_limit,
    (
      select coalesce(
        jsonb_agg(
          jsonb_build_object('count', session_count, 'name', name, 'position', position, 'slug', slug)
          order by position, name
        ),
        '[]'::jsonb
      )
      from stage_groups
    ),
    (
      select jsonb_build_object(
        'active', count(*) filter (where archived_at is null)::integer,
        'archived', count(*) filter (where archived_at is not null)::integer,
        'all', count(*)::integer
      )
      from matching
      where v_stage_slug is null or stage_slug = v_stage_slug
    )
  into v_rows, v_has_more, v_stage_facets, v_scope_facets
  from with_latest_run;

  if v_stage_slug is not null and not (v_stage_facets @> jsonb_build_array(jsonb_build_object('slug', v_stage_slug))) then
    select v_stage_facets || coalesce((
      select jsonb_build_array(
        jsonb_build_object('count', 0, 'name', ps.name, 'position', ps.position, 'slug', ps.slug)
      )
      from public.pipeline_stages ps
      join public.pipelines pipeline
        on pipeline.id = ps.pipeline_id
       and pipeline.workspace_id = ps.workspace_id
      where pipeline.workspace_id = v_workspace_id
        and pipeline.factory_id = any(v_factory_ids)
        and ps.slug = v_stage_slug
      order by ps.updated_at desc, ps.created_at desc, ps.id desc
      limit 1
    ), '[]'::jsonb)
    into v_stage_facets;
  end if;

  return jsonb_build_object(
    'hasAnySession', v_has_any_session,
    'hasMore', v_has_more,
    'scopeFacets', v_scope_facets,
    'sessions', v_rows,
    'stageFacets', v_stage_facets,
    'workspaceId', v_workspace_id
  );
end;
$$;
