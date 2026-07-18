-- Keep the critical session-review RSC contract deliberately narrow. Wallie
-- activity consumes the server-only `activity` context behind Suspense.
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
  into v_current_stage
  from public.pipeline_stages ps
  where ps.id = v_session.current_stage_id
    and ps.workspace_id = v_workspace_id;

  select coalesce(wm.full_name, wm.username, 'Unknown member')
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
