create function public.get_filtered_pipeline_dashboard_page(
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

revoke all on function public.get_filtered_pipeline_dashboard_page(uuid, uuid, uuid, integer, uuid[], uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_filtered_pipeline_dashboard_page(uuid, uuid, uuid, integer, uuid[], uuid, text, text)
  to authenticated;

-- Keep the original RPC callable by deployed clients during a rolling release.
create or replace function public.get_pipeline_dashboard_page(
  target_workspace_id uuid,
  target_pipeline_id uuid default null,
  target_stage_id uuid default null,
  page_limit integer default 25,
  cursor_seen_ids uuid[] default null,
  target_factory_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select public.get_filtered_pipeline_dashboard_page(
    target_workspace_id, target_pipeline_id, target_stage_id, page_limit,
    cursor_seen_ids, target_factory_id
  );
$$;
