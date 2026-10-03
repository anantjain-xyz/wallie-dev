do $cutover$
begin
  -- The old worker can write without an attempt identity. This cutover must be
  -- deployed while producers and old workers are stopped, never as a rolling
  -- update. Freeze mutations while checking readiness and removing old APIs.
  lock table public.sessions, public.agent_jobs, public.agent_runs, public.session_artifacts in share mode;

  if exists (select 1 from public.agent_jobs where status in ('started', 'running'))
     or exists (select 1 from public.agent_runs where status in ('started', 'running')) then
    raise exception 'Worker ownership cutover requires all started/running jobs and runs to drain'
      using errcode = '55000',
        hint = 'Stop queue producers and old workers, drain or explicitly cancel active executions, then retry this migration.';
  end if;

  if exists (
    select 1 from public.session_artifacts artifact
    join public.sessions session on session.id = artifact.session_id
    join public.pipeline_stages stage on stage.id = session.current_stage_id
    where artifact.stage_slug = stage.slug
      and artifact.version > session.current_artifact_version
  ) then
    raise exception 'Worker ownership cutover found unpublished current-stage artifacts'
      using errcode = '55000',
        hint = 'Export and reconcile the colliding artifact rows using docs/PIPELINE-WORKER-LIFECYCLE.md before retrying. Never overwrite or discard reviewed markdown.';
  end if;

  drop function if exists "public"."publish_session_stage_artifact"(p_session_id uuid, p_workspace_id uuid, p_stage_id uuid, p_stage_slug text, p_expected_artifact_version integer, p_version integer, p_artifact_json text);

  drop function if exists "public"."schedule_job_retry"(target_job_id uuid, base_delay_ms integer, max_backoff_ms integer);
end;
$cutover$;
