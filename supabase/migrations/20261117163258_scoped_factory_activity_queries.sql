-- Scope aggregate activity before calculating counts, facets, or page bounds.
-- Calls without a factory ID retain the authorized workspace aggregate.
-- The list and board still check live factory access inside their definer bodies.
-- The run catalog retains invoker execution and filters by the owning session.

drop function public.get_session_list_page(text, text, text, text, integer, timestamptz, uuid, text, integer);

create function public.get_session_list_page(
  target_workspace_slug text,
  session_scope text default 'all',
  stage_filter_slug text default null,
  search_query text default null,
  page_limit integer default 50,
  cursor_updated_at timestamptz default null,
  cursor_id uuid default null,
  sort_key text default 'updated',
  cursor_number integer default null,
  target_factory_id uuid default null
)
returns jsonb
language plpgsql
security definer
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
        and s.factory_id = any(v_factory_ids)
        and (v_scope <> 'active' or s.archived_at is null)
        and (v_scope <> 'archived' or s.archived_at is not null)
        and (
          v_search_raw is null
          or s.number = v_search_number
          or s.search_document @@ v_search_query
          or s.search_text like v_search_like_pattern escape '\'
        )
    ) stage_rows
    group by slug
  ) facets;

  -- Scope counts ignore the scope filter itself so every option keeps a total.
  select jsonb_build_object(
    'active', count(*) filter (where s.archived_at is null)::integer,
    'archived', count(*) filter (where s.archived_at is not null)::integer,
    'all', count(*)::integer
  )
  into v_scope_facets
  from public.sessions s
  join public.pipeline_stages ps
    on ps.id = s.current_stage_id
  where s.workspace_id = v_workspace_id
    and s.factory_id = any(v_factory_ids)
    and (v_stage_slug is null or ps.slug = v_stage_slug)
    and (
      v_search_raw is null
      or s.number = v_search_number
      or s.search_document @@ v_search_query
      or s.search_text like v_search_like_pattern escape '\'
    );

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
    where s.workspace_id = v_workspace_id
      and s.factory_id = any(v_factory_ids)
      and (v_scope <> 'active' or s.archived_at is null)
      and (v_scope <> 'archived' or s.archived_at is not null)
      and (v_stage_slug is null or ps.slug = v_stage_slug)
      and (
        v_search_raw is null
        or s.number = v_search_number
        or s.search_document @@ v_search_query
        or s.search_text like v_search_like_pattern escape '\'
      )
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
    select numbered.*, lr.latest_run_status
    from numbered
    left join lateral (
      select ar.status as latest_run_status
      from public.agent_runs ar
      where ar.workspace_id = v_workspace_id
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
    count(*) > v_limit
  into v_rows, v_has_more
  from with_latest_run;

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

revoke all on function public.get_session_list_page(text, text, text, text, integer, timestamptz, uuid, text, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_session_list_page(text, text, text, text, integer, timestamptz, uuid, text, integer, uuid)
  to authenticated;

drop function public.get_pipeline_dashboard_page(uuid, uuid, uuid, integer, uuid[]);

create function public.get_pipeline_dashboard_page(
  target_workspace_id uuid,
  target_pipeline_id uuid default null,
  target_stage_id uuid default null,
  page_limit integer default 25,
  cursor_seen_ids uuid[] default null,
  target_factory_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lanes jsonb := '[]'::jsonb;
  v_factory_ids uuid[];
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

revoke all on function public.get_pipeline_dashboard_page(uuid, uuid, uuid, integer, uuid[], uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_pipeline_dashboard_page(uuid, uuid, uuid, integer, uuid[], uuid)
  to authenticated;

drop function public.list_workspace_run_catalog(uuid, timestamptz, uuid, uuid, public.agent_run_status, text, uuid, uuid, integer);

create function public.list_workspace_run_catalog(
  p_workspace_id uuid,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_session_id uuid default null,
  p_status public.agent_run_status default null,
  p_provider text default null,
  p_stage_id uuid default null,
  p_run_id uuid default null,
  p_limit integer default 20,
  p_factory_id uuid default null
) returns table (
  run_id uuid,
  session_id uuid,
  session_number integer,
  session_title text,
  job_id uuid,
  attempt_count integer,
  stage_id uuid,
  stage_name text,
  model_provider text,
  model_name text,
  status public.agent_run_status,
  created_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_activity_at timestamptz,
  source_recovery_required boolean,
  has_events boolean,
  capture_ended boolean,
  capture_interrupted boolean,
  failure_receipt text,
  input_tokens bigint,
  output_tokens bigint,
  total_cost_usd numeric,
  token_provenance text,
  cost_provenance text,
  usage_finalized_at timestamptz,
  transcript_expired_at timestamptz
) language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
begin
  if not exists(select 1 from public.workspaces w
    where w.id = p_workspace_id and w.deletion_requested_at is null) then
    raise exception 'Run catalog workspace is unavailable.' using errcode = 'P0002';
  end if;
  -- RLS applies independently to runs, sessions, messages and events. The
  -- bounded page is selected before any per-run transcript metadata lookup.
  return query
  with page as materialized (
    select r.id, r.session_id, s.number, left(s.title, 200) as title,
      r.agent_job_id, r.attempt_count, r.stage_id, left(r.stage_name, 128) as stage_name,
      left(r.model_provider, 64) as model_provider, left(r.model_name, 128) as model_name,
      r.status, r.created_at, r.started_at, r.finished_at, r.last_activity_at,
      r.source_recovery_required, r.input_tokens, r.output_tokens, r.total_cost_usd,
      r.token_provenance, r.cost_provenance, r.usage_finalized_at
    from public.agent_runs r
    join public.sessions s on s.id = r.session_id and s.workspace_id = r.workspace_id
    where r.workspace_id = p_workspace_id
      and (p_factory_id is null or s.factory_id = p_factory_id)
      and (p_session_id is null or r.session_id = p_session_id)
      and (p_status is null or r.status = p_status)
      and (p_provider is null or r.model_provider = p_provider)
      and (p_stage_id is null or r.stage_id = p_stage_id)
      and (p_run_id is null or r.id = p_run_id)
      and ((p_before_created_at is null and p_before_id is null)
        or (p_before_created_at is not null and p_before_id is not null
          and (r.created_at, r.id) < (p_before_created_at, p_before_id)))
    order by r.created_at desc, r.id desc
    limit least(greatest(coalesce(p_limit, 20), 1), 51)
  )
  select p.id, p.session_id, p.number, p.title, p.agent_job_id, p.attempt_count,
    p.stage_id, p.stage_name, p.model_provider, p.model_name, p.status,
    p.created_at, p.started_at, p.finished_at, p.last_activity_at, p.source_recovery_required,
    event_presence.present is true,
    capture_end.sequence is not null,
    coalesce(capture_end.status = 'interrupted', false),
    case when receipt.value->'version' = '1'::jsonb
      and (receipt.value->>'category', receipt.value->>'code') in (
        ('configuration', 'credentials'), ('configuration', 'sandbox_configuration'),
        ('configuration', 'repository_configuration'), ('configuration', 'agent_configuration'),
        ('agent_exit', 'agent_exit'), ('agent_exit', 'agent_incomplete'),
        ('timeout', 'timeout'), ('budget', 'budget'), ('publication', 'publication'), ('unknown', 'unknown'))
      then jsonb_build_object('version', 1, 'category', receipt.value->>'category',
        'code', receipt.value->>'code')::text
      else null end,
    p.input_tokens, p.output_tokens, p.total_cost_usd,
    p.token_provenance, p.cost_provenance, p.usage_finalized_at, expiry.expired_at
  from page p
  left join public.agent_run_transcript_expirations expiry
    on expiry.run_id = p.id and expiry.workspace_id = p_workspace_id
  left join lateral (
    select true as present from public.agent_run_events e
    where e.agent_run_id = p.id and e.workspace_id = p_workspace_id
      and e.attempt_count = p.attempt_count
    limit 1
  ) event_presence on true
  left join lateral (
    select e.sequence, e.payload->>'status' as status
    from public.agent_run_events e
    where e.agent_run_id = p.id and e.workspace_id = p_workspace_id
      and e.attempt_count = p.attempt_count and e.kind = 'capture_end'
    order by e.sequence desc limit 1
  ) capture_end on true
  left join lateral (
    select case when octet_length(m.message_md) <= 512 then
      case when m.message_md is json object then m.message_md::jsonb else null end
      else null end as value
    from public.agent_run_messages m
    where m.agent_run_id = p.id and m.workspace_id = p_workspace_id and m.kind = 'run_failure'
    limit 1
  ) receipt on true
  order by p.created_at desc, p.id desc;
end;
$$;

revoke all on function public.list_workspace_run_catalog(uuid, timestamptz, uuid, uuid, public.agent_run_status, text, uuid, uuid, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_workspace_run_catalog(uuid, timestamptz, uuid, uuid, public.agent_run_status, text, uuid, uuid, integer, uuid)
  to authenticated;

comment on function public.list_workspace_run_catalog(uuid, timestamptz, uuid, uuid, public.agent_run_status, text, uuid, uuid, integer, uuid)
  is 'Scoped run metadata only, at most 51 rows. Preserve timestamp precision in the descending created_at/id cursor; refresh the head for concurrent appends.';
