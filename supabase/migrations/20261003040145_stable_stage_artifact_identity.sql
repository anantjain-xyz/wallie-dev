-- Stage IDs identify artifacts and completed prompt inputs across live renames.
-- Keep stored publication labels unchanged and skip occupied historical versions.
-- Completion labels are historical snapshots, not decision identities. Drop
-- only label uniqueness; preserve every legacy completion, including multiple
-- old labels for one stable stage. The approval session lock serializes writes.
alter table public.session_phase_completions
  drop constraint session_phase_completions_unique_stage;

set check_function_bodies = on;

CREATE OR REPLACE FUNCTION public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid, expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text, p_agent_model_name text, p_run_type text DEFAULT 'project'::text)
 RETURNS TABLE(id uuid, pipeline_id uuid, current_stage_id uuid, current_stage_slug text, phase_status public.pipeline_phase_status, workspace_id uuid, linear_issue_url text, archived_at timestamp with time zone, current_artifact_version integer, rejection_count integer, job_id uuid, run_id uuid, job_created boolean)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  reviewed_session public.sessions%rowtype;
  reviewed_stage public.pipeline_stages%rowtype;
  reviewer public.workspace_members%rowtype;
  next_stage public.pipeline_stages%rowtype;
  active_job public.agent_jobs%rowtype;
  published_run public.agent_runs%rowtype;
  queued_job_id uuid;
  queued_run_id uuid;
  queued_job_created boolean := false;
  approved_at_now timestamptz := now();
begin
  -- This lock serializes review, publication, rejection, and canonical enqueue.
  -- NO KEY UPDATE also permits a legacy producer's session FK KEY SHARE lock.
  select s.* into reviewed_session from public.sessions s
  where s.id = target_session_id and s.workspace_id = expected_workspace_id
  for no key update;
  if not found or reviewed_session.archived_at is not null
     or reviewed_session.phase_status <> 'awaiting_review'
     or reviewed_session.current_stage_id is distinct from expected_stage_id
     or reviewed_session.current_artifact_version is distinct from expected_version then
    return;
  end if;

  select stage.* into reviewed_stage from public.pipeline_stages stage
  where stage.id = expected_stage_id and stage.workspace_id = expected_workspace_id
    and stage.pipeline_id = reviewed_session.pipeline_id;
  if not found or not exists (
    select 1 from public.session_selected_stages selection
    where selection.session_id = reviewed_session.id
      and selection.workspace_id = reviewed_session.workspace_id
      and selection.stage_id = reviewed_stage.id
  ) then return; end if;
  -- Stage/version values can recur after an external reroute. The immutable
  -- artifact identity binds the decision to the markdown the reviewer saw.
  -- Slugs are editable labels; stored artifact slugs remain publication history.
  if not exists (
    select 1 from public.session_artifacts artifact
    where artifact.id = expected_artifact_id
      and artifact.session_id = reviewed_session.id
      and artifact.workspace_id = reviewed_session.workspace_id
      and artifact.stage_id = reviewed_stage.id
      and artifact.version = expected_version
  ) then return; end if;

  select member.* into reviewer from public.workspace_members member
  where member.id = approver_member_id and member.workspace_id = expected_workspace_id
    and member.is_active and member.kind = 'human';
  if not found then return; end if;
  if coalesce(reviewed_stage.anyone_can_approve, false) then
    null;
  elsif coalesce(array_length(reviewed_stage.approver_member_ids, 1), 0) > 0 then
    if not (reviewer.id = any(reviewed_stage.approver_member_ids)) then return; end if;
  elsif reviewer.role not in ('owner', 'admin') then
    return;
  end if;

  -- A publishing worker may still own the session's active queue key during
  -- PR delivery. Only its exact successful attempt is safe to complete here;
  -- queued/unpublished work is a competing intent, never silently canceled.
  select job.* into active_job from public.agent_jobs job
  where job.session_id = reviewed_session.id and job.workspace_id = expected_workspace_id
    and job.status in ('queued', 'started', 'running')
  for update;
  if found then
    select run.* into published_run from public.agent_runs run
    where run.agent_job_id = active_job.id
      and run.attempt_count = active_job.attempt_count
      and run.session_id = reviewed_session.id and run.workspace_id = expected_workspace_id
      and run.stage_id = reviewed_stage.id and run.status = 'success'
    for update;
    if not found or active_job.stage_id is distinct from reviewed_stage.id
       or not public.complete_session_job_attempt(active_job.id, active_job.attempt_count, published_run.id) then
      raise exception 'Session has active work that has not published the reviewed artifact.' using errcode = '55000';
    end if;
  end if;

  -- The session lock above also serializes this existence check with approval
  -- and Linear invalidation. Retain the first valid fact for the stable stage,
  -- including its original label, without discarding legacy decision history.
  insert into public.session_phase_completions (
    session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id
  )
  select reviewed_session.id, expected_workspace_id, reviewed_stage.id, reviewed_stage.slug,
    approved_at_now, reviewer.id
  where not exists (
    select 1 from public.session_phase_completions completion
    where completion.session_id = reviewed_session.id and completion.stage_id = reviewed_stage.id
  );

  select stage.* into next_stage from public.pipeline_stages stage
  join public.session_selected_stages selection
    on selection.stage_id = stage.id and selection.session_id = reviewed_session.id
      and selection.workspace_id = expected_workspace_id
  where stage.pipeline_id = reviewed_session.pipeline_id
    and stage.workspace_id = expected_workspace_id and stage.position > reviewed_stage.position
  order by stage.position asc limit 1;

  if next_stage.id is null then
    update public.sessions s set phase_status = 'approved',
      archived_at = case when s.linear_issue_id is null or not exists (
        select 1 from public.workspace_linear_routing routing
        where routing.workspace_id = expected_workspace_id and routing.land_stage_slug is null
      ) then approved_at_now else s.archived_at end
    where s.id = reviewed_session.id;
  else
    update public.sessions s set current_stage_id = next_stage.id, phase_status = 'in_progress',
      current_artifact_version = coalesce((
        select max(artifact.version) from public.session_artifacts artifact
        where artifact.session_id = reviewed_session.id and artifact.stage_id = next_stage.id
      ), 0), rejection_count = 0
    where s.id = reviewed_session.id;

    select queued.job_id, queued.run_id, queued.created
    into queued_job_id, queued_run_id, queued_job_created
    from public.enqueue_session_job_with_run(
      reviewed_session.id, expected_workspace_id, next_stage.id, reviewer.id, 'assignment',
      p_agent_model_provider, p_agent_model_name, p_run_type
    ) queued;
    if queued_run_id is null then
      -- A concurrent legacy producer can win the queue-key INSERT without a
      -- run. The canonical helper holds its job lock; only queued work can be
      -- given a placeholder safely, before any worker claim/bootstrap.
      select job.* into active_job from public.agent_jobs job
      where job.id = queued_job_id and job.session_id = reviewed_session.id
        and job.workspace_id = expected_workspace_id for update;
      if not found or active_job.status <> 'queued' then
        raise exception 'Next stage job has no queued execution.' using errcode = '55000';
      end if;
      insert into public.agent_runs(
        workspace_id, session_id, agent_job_id, triggered_by_member_id,
        stage_id, stage_slug, stage_name, run_type, model_provider, model_name, status
      ) values (
        expected_workspace_id, reviewed_session.id, queued_job_id, reviewer.id,
        next_stage.id, next_stage.slug, next_stage.name, p_run_type,
        btrim(p_agent_model_provider), btrim(p_agent_model_name), 'queued'
      ) returning agent_runs.id into queued_run_id;
    end if;
  end if;

  return query select s.id, s.pipeline_id, s.current_stage_id, stage.slug, s.phase_status,
    s.workspace_id, s.linear_issue_url, s.archived_at, s.current_artifact_version, s.rejection_count,
    queued_job_id, queued_run_id, queued_job_created
  from public.sessions s join public.pipeline_stages stage on stage.id = s.current_stage_id
  where s.id = reviewed_session.id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_session_detail_page(target_workspace_slug text, target_session_number integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
        'id', spc.id,
        'stageId', spc.stage_id,
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
          'id', sa.id,
          'createdAt', sa.created_at,
          'payload', sa.artifact_json,
          'stageSlug', v_current_stage.slug,
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
      and sa.stage_id = v_current_stage.id
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
$function$
;

CREATE OR REPLACE FUNCTION internal.preserve_session_artifact_version_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.current_stage_id is distinct from old.current_stage_id then
    perform 1 from public.pipeline_stages
    where id = new.current_stage_id and workspace_id = new.workspace_id and pipeline_id = new.pipeline_id;
    if not found then raise exception 'Session stage is outside its workspace pipeline' using errcode = '23514'; end if;
    new.current_artifact_version := greatest(new.current_artifact_version, coalesce((
      select max(version) from public.session_artifacts
      where session_id = new.id and stage_id = new.current_stage_id
    ), 0));
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.apply_linear_session_transition(p_session_id uuid, p_workspace_id uuid, p_linear_issue_id text, p_expected_session_updated_at timestamp with time zone, p_expected_routing_updated_at timestamp with time zone, p_source_span_id text, p_source_started_at timestamp with time zone, p_source_state_id text, p_source_issue_updated_at timestamp with time zone, p_status_name text, p_agent_model_provider text DEFAULT NULL::text, p_agent_model_name text DEFAULT NULL::text, p_run_type text DEFAULT 'project'::text)
 RETURNS TABLE(outcome text, job_ids uuid[], run_ids uuid[], job_id uuid, run_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  s public.sessions%rowtype;
  config public.workspace_linear_routing%rowtype;
  receipt internal.session_linear_transition_receipts%rowtype;
  target public.pipeline_stages%rowtype;
  pipeline_id uuid;
  config_key jsonb;
  route_key text;
  candidate text;
  target_slug text;
  normalized_name text := lower(regexp_replace(btrim(p_status_name), '\s+', ' ', 'g'));
  canceled_jobs uuid[] := '{}';
  canceled_runs uuid[] := '{}';
  queued_job uuid;
  queued_run uuid;
  result text := 'observed';
  initial_baseline boolean;
begin
  if nullif(btrim(p_source_span_id), '') is null or nullif(btrim(p_source_state_id), '') is null
     or nullif(normalized_name, '') is null or p_source_started_at is null or p_source_issue_updated_at is null
     or p_source_started_at > p_source_issue_updated_at then
    raise exception 'A coherent Linear state span is required' using errcode = '22023';
  end if;
  select session.pipeline_id into pipeline_id from public.sessions session
  where session.id = p_session_id and session.workspace_id = p_workspace_id;
  if not found then return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return; end if;
  -- Pipeline rewrites lock this row before stages/config. Match that order.
  perform 1 from public.pipelines pipeline
  where pipeline.id = pipeline_id and pipeline.workspace_id = p_workspace_id for share;
  select * into config from public.workspace_linear_routing where workspace_id = p_workspace_id for share;
  if not found then raise exception 'Linear routing configuration is missing' using errcode = '55000'; end if;
  if config.updated_at is distinct from p_expected_routing_updated_at then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  -- A corrupt configuration is never interpreted as a destructive default.
  foreach candidate in array array['backlog','todo','in_progress','in_review','rework','merging','done','canceled'] loop
    if jsonb_typeof(config.status_mappings -> candidate) is distinct from 'array'
       or jsonb_array_length(config.status_mappings -> candidate) = 0 then
      raise exception 'Linear routing configuration is invalid' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(config.status_mappings -> candidate) value
      where jsonb_typeof(value) <> 'string' or btrim(value #>> '{}') = '') then
      raise exception 'Linear routing configuration is invalid' using errcode = '22023';
    end if;
    if route_key is null and exists (
      select 1 from jsonb_array_elements_text(config.status_mappings -> candidate) name
      where lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = normalized_name
    ) then route_key := candidate; end if;
  end loop;
  config_key := jsonb_build_object('route', route_key, 'target', case
    when route_key = 'rework' then config.rework_stage_slug
    when route_key in ('merging','done') then config.land_stage_slug else null end);
  select * into s from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if s.pipeline_id is distinct from pipeline_id or s.linear_issue_id is distinct from p_linear_issue_id
     or ((s.updated_at is distinct from p_expected_session_updated_at or s.archived_at is not null)
         and not (s.archived_at is not null and route_key = 'done')) then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  insert into internal.session_linear_transition_receipts(session_id, baseline_at)
  values(s.id, s.created_at) on conflict do nothing;
  select * into receipt from internal.session_linear_transition_receipts where session_id = s.id;
  if receipt.source_started_at is not null and (
      p_source_started_at < receipt.source_started_at
      or p_source_issue_updated_at < receipt.issue_updated_at
      or (p_source_started_at = receipt.source_started_at and p_source_span_id <> receipt.source_span_id
          and p_source_issue_updated_at <= receipt.issue_updated_at)
    ) then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  if receipt.source_span_id = p_source_span_id and (receipt.source_state_id is distinct from p_source_state_id
      or receipt.source_started_at is distinct from p_source_started_at) then
    raise exception 'Linear state span identity changed' using errcode = '22023';
  end if;
  if receipt.source_span_id = p_source_span_id and receipt.routing_config = config_key then
    update internal.session_linear_transition_receipts set issue_updated_at = p_source_issue_updated_at,
      observed_at = now() where session_id = s.id;
    return query select 'duplicate', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  initial_baseline := receipt.source_span_id is null and p_source_started_at <= receipt.baseline_at;
  if route_key = 'rework' then target_slug := config.rework_stage_slug;
  elsif route_key in ('merging','done') then target_slug := config.land_stage_slug; end if;
  if target_slug is not null then
    select stage.* into target from public.pipeline_stages stage
    join public.session_selected_stages selected on selected.stage_id = stage.id and selected.session_id = s.id
    where stage.workspace_id = s.workspace_id and stage.pipeline_id = s.pipeline_id
      and stage.slug = target_slug for share of stage;
    if not found and route_key <> 'done' then
      return query select 'missing_stage', canceled_jobs, canceled_runs, queued_job, queued_run; return;
    end if;
  end if;
  if s.archived_at is not null and target.id is not null then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  if route_key = 'canceled' or (route_key = 'done' and target.id is null) then
    select archived.job_ids, archived.run_ids into canceled_jobs, canceled_runs
    from public.archive_session_job_attempts(s.id, s.workspace_id,
      'Linear issue moved to "' || p_status_name || '".', route_key = 'done') archived;
    result := case when route_key = 'done' then 'completed' else 'archived' end;
  elsif not initial_baseline and target.id is not null then
    select canceled.job_ids, canceled.run_ids into canceled_jobs, canceled_runs
    from public.cancel_session_job_attempts(s.id, s.workspace_id,
      'Linear issue moved to "' || p_status_name || '".', null, false) canceled;
    delete from public.session_artifact_feedback feedback using public.pipeline_stages stage
    where feedback.session_id = s.id and feedback.stage_id = stage.id
      and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
    delete from public.session_phase_completions completion using public.pipeline_stages stage
    where completion.session_id = s.id and completion.stage_id = stage.id
      and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
    update public.sessions set current_stage_id = target.id,
      current_artifact_version = coalesce((select max(version) from public.session_artifacts
        where session_id = s.id and stage_id = target.id), 0),
      phase_status = 'rejected', rejection_count = 0 where id = s.id;
    select queued.job_id, queued.run_id into queued_job, queued_run
    from public.enqueue_session_job_with_run(s.id,s.workspace_id,target.id,null,'assignment',
      p_agent_model_provider,p_agent_model_name,p_run_type) queued;
    if queued_run is null then raise exception 'Linear replacement needs an atomic queued run' using errcode = '55000'; end if;
    result := 'routed';
  elsif not initial_baseline and route_key in ('todo','in_progress')
      and s.phase_status in ('in_progress','rejected') then
    select queued.job_id, queued.run_id into queued_job, queued_run
    from public.enqueue_session_job_with_run(s.id,s.workspace_id,s.current_stage_id,null,'assignment',
      p_agent_model_provider,p_agent_model_name,p_run_type) queued;
    result := 'queued';
  end if;
  update internal.session_linear_transition_receipts set source_span_id = p_source_span_id,
    source_started_at = p_source_started_at, source_state_id = p_source_state_id,
    issue_updated_at = p_source_issue_updated_at, routing_config = config_key, observed_at = now()
  where session_id = s.id;
  return query select result, canceled_jobs, canceled_runs, queued_job, queued_run;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_session_job_attempt(p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_expected_artifact_version integer, p_artifact_json text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype; next_version integer;
begin
  if nullif(btrim(p_artifact_json), '') is null then
    raise exception 'Artifact markdown must not be blank' using errcode = '23514';
  end if;
  select owner.* into s from public.sessions owner
  join public.agent_jobs candidate on candidate.session_id = owner.id
  where candidate.id = p_job_id for no key update of owner;
  if not found then return false; end if;
  select * into j from public.agent_jobs where id = p_job_id for update;
  if not found or p_attempt_count is null or j.attempt_count <> p_attempt_count
     or j.status not in ('started', 'running') or j.session_id <> s.id or j.workspace_id <> s.workspace_id
     or s.archived_at is not null or s.current_stage_id is distinct from j.stage_id
     or s.phase_status <> 'in_progress' or p_expected_artifact_version is null
     or s.current_artifact_version <> p_expected_artifact_version then return false; end if;
  select * into r from public.agent_runs where id = p_run_id for update;
  if not found or r.agent_job_id is distinct from j.id or r.attempt_count is distinct from p_attempt_count
     or r.workspace_id <> s.workspace_id or r.session_id <> s.id
     or r.stage_id is distinct from j.stage_id or r.status <> 'running' then return false; end if;
  -- Stage names are mutable snapshots and the retained uniqueness constraint
  -- still reserves (session, slug, version). Allocate above both the durable
  -- stage's history and the publishing job's captured label, without rewriting
  -- either. The session lock serializes allocation with other publishers.
  select greatest(p_expected_artifact_version, coalesce(max(artifact.version), 0)) + 1
  into next_version from public.session_artifacts artifact
  where artifact.session_id = s.id and (artifact.stage_id = j.stage_id or artifact.stage_slug = j.stage_slug);
  insert into public.session_artifacts(workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
  values(s.workspace_id, s.id, j.stage_id, j.stage_slug, next_version, to_jsonb(p_artifact_json));
  update public.sessions set phase_status = 'awaiting_review', current_artifact_version = next_version
  where id = s.id;
  update public.agent_runs set status = 'success', finished_at = now(), last_activity_at = now()
  where id = r.id;
  return true;
end;
$function$
;

revoke all on function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text) to service_role;
revoke all on function public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text) from public,anon,authenticated;
grant execute on function public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text) to service_role;
revoke all on function public.publish_session_job_attempt(uuid,integer,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.publish_session_job_attempt(uuid,integer,uuid,integer,text) to service_role;
revoke all on function internal.preserve_session_artifact_version_history() from public,anon,authenticated;
revoke all on function public.get_session_detail_page(text,integer) from public;
grant execute on function public.get_session_detail_page(text,integer) to authenticated;
