-- Create a session and its first queued run as one transaction. The route owns
-- user-facing preflight checks; this service-role boundary owns every write.
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
  selected_pipeline_id uuid default null
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

  select stage.*
  into first_stage
  from public.pipeline_stages stage
  where stage.pipeline_id = pinned_pipeline_id
  order by stage.position
  limit 1;

  if first_stage.id is null then
    raise exception 'Selected pipeline has no stages configured'
      using errcode = 'P0002';
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
  uuid, uuid, text, text, text, text, text, text, uuid, uuid
) from public, anon, authenticated;

grant execute on function public.create_session_with_first_job(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid
) to service_role;
