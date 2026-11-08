-- A terminal failure is independent of agent error/test narration. Dedicated,
-- immutable-per-run metadata is readable under the existing message RLS policy.
-- Historical messages cannot establish a terminal cause and are not backfilled.
create unique index agent_run_messages_terminal_failure_unique
  on public.agent_run_messages(agent_run_id) where kind='run_failure';

-- Do not copy p_error into client-readable history. Even unrecognized database,
-- provider, or agent payloads can contain credentials or private prompt text.
create function internal.terminal_run_failure(p_error text) returns jsonb
language sql immutable set search_path='' as $$
  with classified as (
    select case
      when p_error ilike 'Session%execution budget exhausted%'
        then 'budget'
      when p_error like 'Checkpoint publication %'
        or p_error like 'Checkpoint candidate expired before adoption.%'
        or p_error like 'Source checkpoint could not be recorded.%'
        or p_error like 'Runtime prompt or credential material cannot be included in a code checkpoint.%'
        or p_error like 'Changed Git LFS files require external payload storage%'
        or p_error like 'Changed Git submodules require separate object storage%'
        or p_error like 'Git content filters or normalization attributes cannot be included%'
        then 'publication'
      when p_error ~ '^Stalled: no activity for [0-9]+s'
        or p_error ~ '^Worker attempt exceeded its [0-9]+ms deadline\.'
        or p_error in ('Worker attempt deadline expired before execution.',
          'Worker attempt deadline expired before dispatch.')
        or p_error='Stalled: claimed job has no execution for this attempt'
        then 'timeout'
      when p_error ~* '^(Codex|Claude Code|Cursor|OpenCode) is not connected'
        or p_error like 'Session has no active human owner in this workspace with a %'
        or p_error='Session has no active human owner in this workspace connected to Cursor.'
        or p_error like 'OpenCode provider % is not connected for user %'
        or p_error like 'Codex authentication needs to be reconnected%'
        or p_error like 'Codex ChatGPT authentication %'
        or p_error='The saved ChatGPT Codex sign-in needs to be refreshed. Reconnect Codex in Settings.'
        or p_error='Cursor needs to be reconnected in Settings.'
        or p_error='The Cursor connection expired. Reconnect Cursor in Settings.'
        or p_error ~* '^The saved (Codex|Claude Code|Cursor|OpenCode) credential'
        or p_error ~* '^(Codex|ClaudeCode|Cursor|OpenCode)Runner requires (a Codex credential|an Anthropic API key|a Cursor API key|an OpenCode|an API key for provider)'
        or p_error ~* '^Reconnect (Codex|Claude Code|Cursor|OpenCode)'
        then 'credentials'
      when p_error ~ '^Connect (Vercel|E2B|Daytona) before starting Wallie runs\.'
        or p_error ~ '^The saved (Vercel|E2B|Daytona) connection is invalid\.'
        or p_error ~ '^Run a successful (Vercel|E2B|Daytona) capability check for this repository'
        or p_error ~ '^(Vercel|E2B|Daytona) is disabled in this Wallie deployment\.'
        then 'sandbox_configuration'
      when p_error like 'No GitHub installation%'
        or p_error like 'No repository%'
        or p_error like 'Session has no GitHub repository%'
        then 'repository_configuration'
      when p_error like 'Failed to load workspace agent configuration.%'
        or p_error like 'Unknown agent provider:%'
        or p_error like 'Workspace max_turns must %'
        or p_error like 'Workspace default_model must %'
        then 'agent_configuration'
      when p_error ~* '^(codex|claude|opencode|cursor) CLI exited with code [0-9]+'
        then 'agent_exit'
      when p_error in ('Agent stopped before completing the task.',
        'Agent ended without a successful completion event.',
        'Claude Code ended without a successful result.')
        or p_error like '% did not produce reviewable output. Wallie only received runner bookkeeping, so no artifact was created.'
        then 'agent_incomplete'
      else 'unknown'
    end as code
  )
  select pg_catalog.jsonb_build_object('version',1,'code',code,'category',
    case when code in ('credentials','sandbox_configuration','repository_configuration','agent_configuration') then 'configuration'
      when code='agent_incomplete' then 'agent_exit' else code end)
  from classified;
$$;
revoke all on function internal.terminal_run_failure(text) from public,anon,authenticated;
grant execute on function internal.terminal_run_failure(text) to service_role;

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
  effective_attempt_count integer;
  failure_error text:=p_error;
  failed_run_ids uuid[]:='{}';
begin
  select owner.* into s from public.sessions owner join public.agent_jobs candidate on candidate.session_id = owner.id
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
  effective_attempt_count:=internal.git_continuity_effective_attempt_count(j.id,s.workspace_id,s.id,j.attempt_count);
  retrying := coalesce(p_retry, false) and effective_attempt_count < greatest(coalesce(p_max_retries, 0), 0)
    and s.archived_at is null and stage_matches and s.execution_exhausted_at is null
    and (s.phase_status in ('in_progress', 'rejected')
      or (p_run_id is null and s.phase_status = 'awaiting_review'
          and not exists(select 1 from public.agent_runs where agent_job_id = j.id and status = 'success')));
  -- Finalize the failed run before deciding whether its unknown usage can be
  -- followed by another repair. Otherwise a missing-usage run could slip a
  -- queued retry through before the subsequent exhaustion refresh.
  if p_run_id is not null then
    update public.agent_runs set status = 'error', finished_at = now() where id = r.id;
    failed_run_ids:=array[r.id];
  else
    with failed as (
      update public.agent_runs set status = 'error', finished_at = now()
      where agent_job_id = j.id and attempt_count is null and status in ('queued', 'started', 'running')
      returning id
    ) select coalesce(array_agg(id),'{}') into failed_run_ids from failed;
  end if;
  if internal.refresh_session_execution_exhaustion(s.id,s.workspace_id) is not null then
    if retrying then failure_error:=coalesce(nullif(btrim(p_error),'')||E'\n','')||'Execution budget exhausted; no automatic repair was queued.'; end if;
    retrying:=false;
  end if;
  if retrying then
    retrying:=internal.reserve_session_repair_attempt(s.id,s.workspace_id);
    if not retrying then failure_error:=coalesce(nullif(btrim(p_error),'')||E'\n','')||'Execution budget exhausted; no automatic repair was queued.'; end if;
  end if;
  update public.agent_jobs set
    status = case when retrying then 'queued'::public.agent_job_status else 'error'::public.agent_job_status end,
    finished_at = case when retrying then null else now() end,
    scheduled_at = case when retrying then now() + make_interval(secs => least(300, 5 * power(2, least(effective_attempt_count, 10)))::double precision) else null end,
    last_error = failure_error
  where id = j.id;
  if current_stage_owner then update public.sessions set phase_status = 'rejected' where id = s.id; end if;
  -- Persist the terminal explanation in the same transaction as its exact
  -- run/job outcome. Job last_error is mutable across attempts and cannot be
  -- used as historical run data. Only allowlisted metadata crosses into history.
  insert into public.agent_run_messages(agent_run_id,workspace_id,kind,message_md)
  -- Retry suppression can append a budget warning to failure_error. Preserve
  -- the original run cause rather than replacing it with that later outcome.
  select history.id,history.workspace_id,'run_failure',internal.terminal_run_failure(p_error)::text
  from public.agent_runs history
  where history.agent_job_id=j.id and history.workspace_id=s.workspace_id and history.session_id=s.id
    and history.status='error' and history.id=any(failed_run_ids)
  on conflict (agent_run_id) where kind='run_failure' do nothing;
  return case when retrying then 'queued' else 'error' end;
end;
$function$;
revoke all on function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid) from public,anon,authenticated;
grant execute on function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid) to service_role;
