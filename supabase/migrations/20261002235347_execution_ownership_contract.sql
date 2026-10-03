-- Additive execution ownership contract; production callers are unchanged.
-- NULL run attempts identify legacy/unstarted rows. Workers must adopt these
-- service-role-only APIs in the separate consumer cutover.

alter table "public"."agent_runs" add column "attempt_count" integer;

CREATE UNIQUE INDEX agent_runs_job_attempt_idx ON public.agent_runs USING btree (agent_job_id, attempt_count) WHERE (attempt_count IS NOT NULL);

alter table "public"."agent_runs" add constraint "agent_runs_attempt_count_positive" CHECK (((attempt_count IS NULL) OR (attempt_count > 0))) not valid;

alter table "public"."agent_runs" validate constraint "agent_runs_attempt_count_positive";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.archive_session_job_attempts(p_session_id uuid, p_workspace_id uuid, p_reason text, p_completed boolean DEFAULT false)
 RETURNS TABLE(job_ids uuid[], run_ids uuid[])
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare s public.sessions%rowtype; canceled_jobs uuid[]; canceled_runs uuid[];
begin
  select * into s from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if not found then return query select '{}'::uuid[], '{}'::uuid[]; return; end if;
  select canceled.job_ids, canceled.run_ids into canceled_jobs, canceled_runs
  from public.cancel_session_job_attempts(s.id, s.workspace_id, p_reason, null, false) canceled;
  if s.archived_at is null then
    update public.sessions set archived_at = now(),
      phase_status = case when p_completed then 'approved'::public.pipeline_phase_status
        when s.phase_status = 'in_progress' then 'rejected'::public.pipeline_phase_status
        else s.phase_status end
    where id = s.id;
  end if;
  return query select canceled_jobs, canceled_runs;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_session_job_attempts(p_session_id uuid, p_workspace_id uuid, p_reason text, p_expected_run_id uuid DEFAULT NULL::uuid, p_park_phase_status boolean DEFAULT true)
 RETURNS TABLE(job_ids uuid[], run_ids uuid[])
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare s public.sessions%rowtype; canceled_jobs uuid[]; canceled_runs uuid[];
begin
  select * into s from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if not found then return query select '{}'::uuid[], '{}'::uuid[]; return; end if;
  perform 1 from public.agent_jobs where session_id = s.id order by id for update;
  perform 1 from public.agent_runs where session_id = s.id order by id for update;
  if p_expected_run_id is not null and not exists (
    select 1 from public.agent_runs r join public.agent_jobs j on j.id = r.agent_job_id
    where r.id = p_expected_run_id and r.session_id = s.id and r.workspace_id = s.workspace_id
      and j.session_id = s.id and j.workspace_id = s.workspace_id
      and r.status in ('queued', 'started', 'running') and j.status in ('queued', 'started', 'running')
      and ((r.attempt_count is not null and r.attempt_count = j.attempt_count)
        or (r.attempt_count is null and r.status = 'queued' and not exists (
          select 1 from public.agent_runs owned where owned.agent_job_id = j.id
            and owned.attempt_count = j.attempt_count)))
  ) then return query select '{}'::uuid[], '{}'::uuid[]; return; end if;
  with canceled as (
    update public.agent_jobs set status = 'canceled', finished_at = now(), last_error = p_reason, scheduled_at = null
    where session_id = s.id and workspace_id = s.workspace_id
      and status in ('queued', 'started', 'running') returning id
  ) select coalesce(array_agg(id order by id), '{}') into canceled_jobs from canceled;
  with canceled as (
    update public.agent_runs set status = 'canceled', finished_at = now()
    where session_id = s.id and workspace_id = s.workspace_id
      and status in ('queued', 'started', 'running') returning id
  ) select coalesce(array_agg(id order by id), '{}') into canceled_runs from canceled;
  -- Publication finishes the run before its job's PR/shutdown work. Retiring
  -- that job must still return its exact successful run for sandbox cleanup,
  -- without rewriting the successful execution or its artifact.
  select coalesce(array_agg(target.id order by target.id), '{}') into canceled_runs
  from (
    select unnest(canceled_runs) as id
    union
    select r.id from public.agent_runs r join public.agent_jobs j on j.id = r.agent_job_id
    where j.id = any(canceled_jobs) and r.attempt_count = j.attempt_count
      and r.session_id = s.id and r.workspace_id = s.workspace_id and r.status = 'success'
  ) target;
  if p_park_phase_status and s.phase_status = 'in_progress' then
    update public.sessions set phase_status = 'rejected' where id = s.id;
  end if;
  return query select canceled_jobs, canceled_runs;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.complete_session_job_attempt(p_job_id uuid, p_attempt_count integer, p_run_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype;
begin
  select owner.* into s from public.sessions owner
  join public.agent_jobs candidate on candidate.session_id = owner.id
  where candidate.id = p_job_id for no key update of owner;
  if not found then return false; end if;
  select * into j from public.agent_jobs where id = p_job_id for update;
  if not found or p_attempt_count is null or j.attempt_count <> p_attempt_count
     or j.status not in ('started', 'running', 'success') or j.session_id <> s.id or j.workspace_id <> s.workspace_id then return false; end if;
  select * into r from public.agent_runs where id = p_run_id for update;
  if not found or r.agent_job_id is distinct from j.id or r.attempt_count is distinct from p_attempt_count
     or r.workspace_id <> s.workspace_id or r.session_id <> s.id or r.status <> 'success' then return false; end if;
  update public.agent_jobs set status = 'success', finished_at = coalesce(finished_at, now()), scheduled_at = null
  where id = j.id;
  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.fail_session_job_attempt(p_job_id uuid, p_attempt_count integer, p_error text, p_retry boolean, p_max_retries integer, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  s public.sessions%rowtype;
  j public.agent_jobs%rowtype;
  r public.agent_runs%rowtype;
  current_stage_owner boolean;
  stage_matches boolean;
  retrying boolean;
begin
  select owner.* into s from public.sessions owner
  join public.agent_jobs candidate on candidate.session_id = owner.id
  where candidate.id = p_job_id for no key update of owner;
  if not found then return 'stale'; end if;
  select * into j from public.agent_jobs where id = p_job_id for update;
  if not found or p_attempt_count is null or p_attempt_count <= 0
     or j.attempt_count <> p_attempt_count or j.status not in ('started', 'running', 'success')
     or j.session_id <> s.id or j.workspace_id <> s.workspace_id then return 'stale'; end if;
  if p_run_id is not null then
    select * into r from public.agent_runs where id = p_run_id for update;
    if not found or r.agent_job_id is distinct from j.id or r.attempt_count is distinct from p_attempt_count
       or r.workspace_id <> s.workspace_id or r.session_id <> s.id then return 'stale'; end if;
    if r.status = 'success' then
      perform public.complete_session_job_attempt(j.id, p_attempt_count, r.id);
      return 'success';
    end if;
    if r.status not in ('queued', 'started', 'running') then return 'stale'; end if;
  else
    -- A caller that already started must name its run. A refused legacy start
    -- may retire unbound rows, but can never guess the current owned run.
    perform 1 from public.agent_runs where agent_job_id = j.id order by id for update;
    if exists (select 1 from public.agent_runs where agent_job_id = j.id and attempt_count = p_attempt_count)
      then return 'stale'; end if;
  end if;
  if j.status = 'success' then return 'stale'; end if;
  stage_matches := (j.stage_id is null or j.stage_id = s.current_stage_id)
    and not exists (select 1 from public.agent_runs history where history.agent_job_id = j.id
      and history.stage_id is not null and history.stage_id <> s.current_stage_id);
  current_stage_owner := s.archived_at is null and stage_matches and j.stage_id = s.current_stage_id
    and s.phase_status in ('in_progress', 'rejected');
  -- Before start, a fresh explicit request can still be waiting at review.
  -- Retrying it preserves review; it does not reclaim a published execution.
  retrying := coalesce(p_retry, false) and j.attempt_count < greatest(coalesce(p_max_retries, 0), 0)
    and s.archived_at is null and stage_matches
    and (s.phase_status in ('in_progress', 'rejected')
      or (p_run_id is null and s.phase_status = 'awaiting_review'
          and not exists(select 1 from public.agent_runs where agent_job_id = j.id and status = 'success')));
  if p_run_id is not null then
    update public.agent_runs set status = 'error', finished_at = now() where id = r.id;
  else
    update public.agent_runs set status = 'error', finished_at = now()
    where agent_job_id = j.id and attempt_count is null and status in ('queued', 'started', 'running');
  end if;
  update public.agent_jobs set
    status = case when retrying then 'queued'::public.agent_job_status else 'error'::public.agent_job_status end,
    finished_at = case when retrying then null else now() end,
    scheduled_at = case when retrying then now() + make_interval(secs => least(300, 5 * power(2, least(j.attempt_count, 10)))::double precision) else null end,
    last_error = p_error
  where id = j.id;
  if current_stage_owner then
    update public.sessions set phase_status = 'rejected' where id = s.id;
  end if;
  return case when retrying then 'queued' else 'error' end;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.publish_session_job_attempt(p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_expected_artifact_version integer, p_artifact_json text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype;
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
  insert into public.session_artifacts(workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
  values(s.workspace_id, s.id, j.stage_id, j.stage_slug, p_expected_artifact_version + 1, to_jsonb(p_artifact_json));
  update public.sessions set phase_status = 'awaiting_review', current_artifact_version = p_expected_artifact_version + 1
  where id = s.id;
  update public.agent_runs set status = 'success', finished_at = now(), last_activity_at = now()
  where id = r.id;
  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.start_session_job_attempt(p_job_id uuid, p_attempt_count integer, p_expected_stage_id uuid, p_expected_artifact_version integer, p_model_provider text, p_model_name text, p_run_type text, p_branch_name text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  s public.sessions%rowtype;
  j public.agent_jobs%rowtype;
  stage public.pipeline_stages%rowtype;
  historical_stage_id uuid;
  execution_id uuid;
begin
  if nullif(btrim(p_model_provider), '') is null or nullif(btrim(p_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
  end if;
  if p_run_type is null or p_run_type not in ('project', 'code') then
    raise exception 'Run type must be project or code' using errcode = '22023';
  end if;
  select owner.* into s from public.sessions owner
  join public.agent_jobs candidate on candidate.session_id = owner.id
  where candidate.id = p_job_id for no key update of owner;
  if not found then return null; end if;
  select * into j from public.agent_jobs where id = p_job_id for update;
  if not found or p_attempt_count is null or p_attempt_count <= 0
     or j.attempt_count <> p_attempt_count or j.status not in ('started', 'running')
     or j.session_id <> s.id or j.workspace_id <> s.workspace_id or s.archived_at is not null
     or s.current_stage_id is distinct from p_expected_stage_id
     or p_expected_artifact_version is null or s.current_artifact_version <> p_expected_artifact_version
     or s.phase_status not in ('in_progress', 'rejected', 'awaiting_review')
     or (j.stage_id is not null and j.stage_id <> s.current_stage_id) then return null; end if;
  select * into stage from public.pipeline_stages
  where id = s.current_stage_id and workspace_id = s.workspace_id and pipeline_id = s.pipeline_id;
  if not found then return null; end if;

  perform 1 from public.agent_runs where agent_job_id = j.id order by id for update;
  select stage_id into historical_stage_id from public.agent_runs
  where agent_job_id = j.id order by created_at desc, id desc limit 1;
  if historical_stage_id is not null and historical_stage_id <> stage.id then return null; end if;
  if exists (
    select 1 from public.agent_runs r where r.agent_job_id = j.id
      and (r.attempt_count = p_attempt_count
        or (r.status in ('queued', 'started', 'running')
            and (r.session_id <> s.id or r.workspace_id <> s.workspace_id
              or (r.stage_id is not null and r.stage_id <> stage.id)
              or (r.attempt_count is null and r.status <> 'queued')
              or r.attempt_count > p_attempt_count)))
  ) then return null; end if;
  -- Retrying a previously published job is not a new review request. Explicit
  -- reruns use a new job ID; a fresh job may legitimately start awaiting_review.
  if s.phase_status = 'awaiting_review' and exists (
    select 1 from public.agent_runs where agent_job_id = j.id and status = 'success'
  ) then return null; end if;
  if (select count(*) from public.agent_runs where agent_job_id = j.id
      and attempt_count is null and status = 'queued') > 1 then return null; end if;

  -- Older bound attempts have lost authority because the queue claimed a newer
  -- attempt. Never reuse their run ID or sandbox identity for the replacement.
  update public.agent_runs set status = 'error', finished_at = coalesce(finished_at, now())
  where agent_job_id = j.id and attempt_count < p_attempt_count
    and status in ('queued', 'started', 'running');
  select id into execution_id from public.agent_runs
  where agent_job_id = j.id and attempt_count is null and status = 'queued';
  update public.agent_jobs set stage_id = stage.id, stage_slug = stage.slug, stage_name = stage.name
  where id = j.id;
  if execution_id is null then
    insert into public.agent_runs(
      workspace_id, session_id, agent_job_id, triggered_by_member_id, attempt_count,
      stage_id, stage_slug, stage_name, model_provider, model_name, run_type,
      branch_name, status, started_at, last_activity_at
    ) values (
      s.workspace_id, s.id, j.id, j.requested_by_member_id, p_attempt_count,
      stage.id, stage.slug, stage.name, btrim(p_model_provider), btrim(p_model_name), p_run_type,
      p_branch_name, 'running', now(), now()
    ) returning id into execution_id;
  else
    update public.agent_runs set attempt_count = p_attempt_count,
      stage_id = stage.id, stage_slug = stage.slug, stage_name = stage.name,
      model_provider = btrim(p_model_provider), model_name = btrim(p_model_name), run_type = p_run_type,
      branch_name = p_branch_name, status = 'running', started_at = now(), last_activity_at = now()
    where id = execution_id;
  end if;
  update public.sessions set phase_status = 'in_progress' where id = s.id;
  return execution_id;
end;
$function$
;

revoke all on function public.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text) from public, anon, authenticated;
revoke all on function public.publish_session_job_attempt(uuid,integer,uuid,integer,text) from public, anon, authenticated;
revoke all on function public.complete_session_job_attempt(uuid,integer,uuid) from public, anon, authenticated;
revoke all on function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid) from public, anon, authenticated;
revoke all on function public.cancel_session_job_attempts(uuid,uuid,text,uuid,boolean) from public, anon, authenticated;
revoke all on function public.archive_session_job_attempts(uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text) to service_role;
grant execute on function public.publish_session_job_attempt(uuid,integer,uuid,integer,text) to service_role;
grant execute on function public.complete_session_job_attempt(uuid,integer,uuid) to service_role;
grant execute on function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid) to service_role;
grant execute on function public.cancel_session_job_attempts(uuid,uuid,text,uuid,boolean) to service_role;
grant execute on function public.archive_session_job_attempts(uuid,uuid,text,boolean) to service_role;
