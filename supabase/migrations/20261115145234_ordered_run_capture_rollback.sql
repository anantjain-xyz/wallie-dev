-- Ordered events are the sole transcript format. Capture can be paused
-- while preserving the same execution ownership and liveness checks.
create function internal.lock_agent_run_event_owner(
  p_job_id uuid,
  p_run_id uuid,
  p_attempt_count integer
) returns public.agent_runs language plpgsql security invoker set search_path = '' as $$
declare
  s public.sessions;
  j public.agent_jobs;
  r public.agent_runs;
begin
  if p_attempt_count is null or p_attempt_count <= 0 then return null; end if;

  -- Match the lifecycle lock order even when recording liveness only.
  select owner.* into s from public.sessions owner
    join public.agent_jobs candidate on candidate.session_id = owner.id
    where candidate.id = p_job_id for no key update of owner;
  if not found then return null; end if;
  select * into j from public.agent_jobs
    where id = p_job_id and session_id = s.id and workspace_id = s.workspace_id for update;
  if not found or j.attempt_count is distinct from p_attempt_count
    or j.status not in ('started', 'running') then return null; end if;
  select * into r from public.agent_runs
    where id = p_run_id and agent_job_id = j.id and session_id = s.id and workspace_id = s.workspace_id
    for update;
  if not found or r.attempt_count is distinct from p_attempt_count or r.status <> 'running' then
    return null;
  end if;

  return r;
end;
$$;
revoke all on function internal.lock_agent_run_event_owner(uuid,uuid,integer)
  from public, anon, authenticated, service_role;

drop function public.append_agent_run_event(uuid,uuid,integer,integer,text,jsonb,boolean,integer,text);

create function public.append_agent_run_event(
  p_job_id uuid,
  p_run_id uuid,
  p_attempt_count integer,
  p_sequence integer,
  p_kind text,
  p_payload jsonb,
  p_truncated boolean,
  p_causation_sequence integer default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  r public.agent_runs;
  existing public.agent_run_events;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_attempt_count is null or p_attempt_count <= 0 then return false; end if;
  if p_sequence is null or p_sequence <= 0
    or p_kind is null or p_kind not in (
      'text', 'progress', 'tool_call', 'tool_result', 'terminal', 'usage', 'capture_gap', 'capture_end'
    )
    or p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 16384
    or p_truncated is null
    or (p_causation_sequence is not null and (p_causation_sequence <= 0 or p_causation_sequence >= p_sequence)) then
    raise exception 'Invalid run event envelope.' using errcode = '23514';
  end if;

  r := internal.lock_agent_run_event_owner(p_job_id, p_run_id, p_attempt_count);
  if r.id is null then return false; end if;

  select * into existing from public.agent_run_events
    where agent_run_id = r.id and attempt_count = p_attempt_count and sequence = p_sequence;
  if found then
    return existing.workspace_id = r.workspace_id
      and existing.kind = p_kind
      and existing.payload = p_payload
      and existing.truncated = p_truncated
      and existing.causation_sequence is not distinct from p_causation_sequence;
  end if;

  insert into public.agent_run_events(
    agent_run_id, workspace_id, attempt_count, sequence, causation_sequence, kind, payload, truncated
  ) values (
    r.id, r.workspace_id, p_attempt_count, p_sequence, p_causation_sequence, p_kind, p_payload, p_truncated
  );
  update public.agent_runs set last_activity_at = clock_timestamp() where id = r.id;
  return true;
end;
$$;

create function public.touch_agent_run_activity(
  p_job_id uuid,
  p_run_id uuid,
  p_attempt_count integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  r public.agent_runs;
begin
  perform internal.assert_checkpoint_publication_service();
  r := internal.lock_agent_run_event_owner(p_job_id, p_run_id, p_attempt_count);
  if r.id is null then return false; end if;

  update public.agent_runs set last_activity_at = clock_timestamp() where id = r.id;
  return true;
end;
$$;

revoke all on function public.append_agent_run_event(uuid,uuid,integer,integer,text,jsonb,boolean,integer),
  public.touch_agent_run_activity(uuid,uuid,integer) from public, anon, authenticated, service_role;
grant execute on function public.append_agent_run_event(uuid,uuid,integer,integer,text,jsonb,boolean,integer),
  public.touch_agent_run_activity(uuid,uuid,integer) to service_role;
