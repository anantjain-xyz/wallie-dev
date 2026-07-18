-- Bound the Pipeline dashboard by lane while keeping sessions on their pinned
-- pipeline. One RPC replaces the dashboard's serial table-query waterfall.

create index if not exists sessions_active_lane_attention_updated_id_idx
  on public.sessions (
    workspace_id,
    pipeline_id,
    current_stage_id,
    ((case when phase_status = 'awaiting_review' then 0 else 1 end)),
    updated_at desc,
    id desc
  )
  where archived_at is null;

create or replace function public.get_pipeline_dashboard_page(
  target_workspace_id uuid,
  target_pipeline_id uuid default null,
  target_stage_id uuid default null,
  page_limit integer default 25,
  cursor_seen_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lanes jsonb := '[]'::jsonb;
  v_limit integer := least(greatest(coalesce(page_limit, 25), 1), 25);
  v_seen_ids uuid[] := coalesce(cursor_seen_ids, '{}'::uuid[]);
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
      ps.description,
      ps.id as stage_id,
      ps.name as stage_name,
      ps.position,
      ps.slug
    from public.pipelines p
    join public.pipeline_stages ps
      on ps.pipeline_id = p.id
     and ps.workspace_id = target_workspace_id
    where p.workspace_id = target_workspace_id
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
      ps.description,
      ps.id as stage_id,
      ps.name as stage_name,
      ps.position,
      ps.slug
    from public.pipelines p
    join public.pipeline_stages ps
      on ps.pipeline_id = p.id
     and ps.workspace_id = target_workspace_id
    where p.workspace_id = target_workspace_id
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
      and s.archived_at is null
  ),
  lane_counts as (
    select pipeline_id, current_stage_id as stage_id, count(*)::integer as total_count
    from snapshot_sessions
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
    from snapshot_sessions ss
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
    ) prs on true
  ),
  lane_pages as (
    select
      ld.*,
      coalesce(lc.total_count, 0) as total_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'createdAt', cr.created_at,
            'currentStageId', cr.current_stage_id,
            'id', cr.id,
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
      ld.description,
      ld.stage_id,
      ld.stage_name,
      ld.position,
      ld.slug,
      lc.total_count
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'cards', lp.cards,
        'cursor', lp.next_cursor,
        'description', lp.description,
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

revoke all on function public.get_pipeline_dashboard_page(
  uuid,
  uuid,
  uuid,
  integer,
  uuid[]
) from public;

grant execute on function public.get_pipeline_dashboard_page(
  uuid,
  uuid,
  uuid,
  integer,
  uuid[]
) to authenticated;
