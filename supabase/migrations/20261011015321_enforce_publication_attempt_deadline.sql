-- The optional argument supports a rolling worker deployment. Updated workers
-- always supply their captured absolute deadline; no client abort is a rollback.
drop function public.publish_session_job_attempt(uuid,integer,uuid,integer,text);

CREATE OR REPLACE FUNCTION public.publish_session_job_attempt(p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_expected_artifact_version integer, p_artifact_json text, p_deadline_at timestamptz default null)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype; next_version integer; published_artifact_id uuid;
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
  -- Use wall-clock time after waiting for ownership locks. Transaction now()
  -- would admit a request that began before its deadline and waited past it.
  if p_deadline_at is not null and clock_timestamp() >= p_deadline_at then
    raise exception 'Worker attempt exceeded its publication deadline.' using errcode = '57014';
  end if;
  -- Stage names are mutable snapshots and the retained uniqueness constraint
  -- still reserves (session, slug, version). Allocate above both the durable
  -- stage's history and the publishing job's captured label, without rewriting
  -- either. The session lock serializes allocation with other publishers.
  select greatest(p_expected_artifact_version, coalesce(max(artifact.version), 0)) + 1
  into next_version from public.session_artifacts artifact
  where artifact.session_id = s.id and (artifact.stage_id = j.stage_id or artifact.stage_slug = j.stage_slug);
  insert into public.session_artifacts(workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
  values(s.workspace_id, s.id, j.stage_id, j.stage_slug, next_version, to_jsonb(p_artifact_json))
  returning session_artifacts.id into published_artifact_id;
  update public.sessions set phase_status = 'awaiting_review', current_artifact_version = next_version,
    current_artifact_id = published_artifact_id
  where id = s.id;
  update public.agent_runs set status = 'success', finished_at = now(), last_activity_at = now()
  where id = r.id;
  -- A trigger or another write lock can also delay these writes; aborting here
  -- rolls back the artifact and all state transitions together.
  if p_deadline_at is not null and clock_timestamp() >= p_deadline_at then
    raise exception 'Worker attempt exceeded its publication deadline.' using errcode = '57014';
  end if;
  return true;
end;
$function$
;

revoke all on function public.publish_session_job_attempt(uuid,integer,uuid,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function public.publish_session_job_attempt(uuid,integer,uuid,integer,text,timestamptz) to service_role;

-- Apply the same Claude turn-budget limits to direct service-role writes.
alter table public.workspace_agent_config add constraint workspace_agent_config_max_turns check (
  key <> 'max_turns' or case when jsonb_typeof(value_json) = 'number' then
    (value_json::text)::numeric = floor((value_json::text)::numeric)
    and (value_json::text)::numeric between 1 and 100
  else false end
);
