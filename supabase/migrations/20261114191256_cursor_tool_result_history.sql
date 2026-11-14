-- Cursor's completed tool records already appear in Run history. Keep that
-- projection when the ordered transcript separates calls from their results.
create or replace function public.append_agent_run_event(
  p_job_id uuid,
  p_run_id uuid,
  p_attempt_count integer,
  p_sequence integer,
  p_kind text,
  p_payload jsonb,
  p_truncated boolean,
  p_causation_sequence integer default null,
  p_legacy_message_md text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  s public.sessions;
  j public.agent_jobs;
  r public.agent_runs;
  existing public.agent_run_events;
  legacy public.agent_run_messages;
  legacy_id uuid;
  legacy_kind text;
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

  if p_legacy_message_md is not null then
    legacy_kind := case
      when p_kind in ('text', 'progress') then p_kind
      when p_kind in ('tool_call', 'tool_result') then 'tool_use'
      when p_kind = 'terminal' and p_payload->>'status' in ('completed', 'incomplete') then 'completion'
      when p_kind = 'terminal' and p_payload->>'status' = 'failed' then 'error'
      else null
    end;
    if legacy_kind is null then
      raise exception 'Invalid legacy run event projection.' using errcode = '23514';
    end if;
  end if;

  -- Match lifecycle lock order. Neither a guessed run nor a superseded claim
  -- can append to a replacement execution, including during retry or cancel.
  select owner.* into s from public.sessions owner
    join public.agent_jobs candidate on candidate.session_id = owner.id
    where candidate.id = p_job_id for no key update of owner;
  if not found then return false; end if;
  select * into j from public.agent_jobs
    where id = p_job_id and session_id = s.id and workspace_id = s.workspace_id for update;
  if not found or j.attempt_count is distinct from p_attempt_count
    or j.status not in ('started', 'running') then return false; end if;
  select * into r from public.agent_runs
    where id = p_run_id and agent_job_id = j.id and session_id = s.id and workspace_id = s.workspace_id
    for update;
  if not found or r.attempt_count is distinct from p_attempt_count or r.status <> 'running' then
    return false;
  end if;

  -- A deterministic projection ID binds retries to the same legacy message
  -- without another mutable pointer or a second independent write.
  legacy_id := md5('agent_run_event:' || r.id::text || ':' || p_attempt_count::text || ':' || p_sequence::text)::uuid;
  select * into existing from public.agent_run_events
    where agent_run_id = r.id and attempt_count = p_attempt_count and sequence = p_sequence;
  if found then
    if existing.workspace_id is distinct from s.workspace_id
      or existing.kind is distinct from p_kind
      or existing.payload is distinct from p_payload
      or existing.truncated is distinct from p_truncated
      or existing.causation_sequence is distinct from p_causation_sequence then
      return false;
    end if;
    select * into legacy from public.agent_run_messages where id = legacy_id;
    if p_legacy_message_md is null then return not found; end if;
    return found and legacy.agent_run_id = r.id and legacy.workspace_id = s.workspace_id
      and legacy.kind = legacy_kind and legacy.message_md = p_legacy_message_md;
  end if;

  insert into public.agent_run_events(
    agent_run_id, workspace_id, attempt_count, sequence, causation_sequence, kind, payload, truncated
  ) values (
    r.id, s.workspace_id, p_attempt_count, p_sequence, p_causation_sequence, p_kind, p_payload, p_truncated
  );
  if p_legacy_message_md is not null then
    insert into public.agent_run_messages(id, agent_run_id, workspace_id, kind, message_md)
    values (legacy_id, r.id, s.workspace_id, legacy_kind, p_legacy_message_md);
  end if;
  update public.agent_runs set last_activity_at = clock_timestamp() where id = r.id;
  return true;
end;
$$;
