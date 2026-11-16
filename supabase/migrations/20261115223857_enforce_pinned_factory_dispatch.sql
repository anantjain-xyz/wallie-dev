-- Both worker runtimes share this claim. Keep the same release, workspace,
-- provider mutation and job ownership fences while taking an enrolled job's
-- capacity and provider from its immutable definition.
create or replace function public.claim_next_agent_job(
  default_concurrency_limit int default 2
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.agent_jobs%rowtype;
  configured_limit int;
  effective_limit int;
  running_count int;
  selected_provider text;
  release_state internal.git_continuity_release_control%rowtype;
  pipeline_job boolean;
  session_owner public.sessions;
  definition jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict release_state from internal.git_continuity_release_control where singleton for share;
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();

  for candidate in
    select * from public.agent_jobs
    where status = 'queued' and (scheduled_at is null or scheduled_at <= now())
      and (exists(select 1 from public.sessions s where s.id=agent_jobs.session_id and s.pipeline_id is null)
        or (release_state.enabled and exists(select 1 from public.session_git_continuity_enrollments e
          where e.session_id=agent_jobs.session_id and e.workspace_id=agent_jobs.workspace_id)))
    order by created_at asc
  loop
    perform 1 from public.workspaces where id=candidate.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    select * into candidate from public.agent_jobs where id=candidate.id and status='queued'
      and (scheduled_at is null or scheduled_at<=now()) for update skip locked;
    if not found then continue; end if;
    select * into session_owner from public.sessions
      where (workspace_id, id) = (candidate.workspace_id, candidate.session_id);
    if not found then continue; end if;
    pipeline_job := session_owner.pipeline_id is not null;
    perform pg_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0));

    definition := internal.pinned_session_execution_definition(session_owner);
    if definition is not null then
      selected_provider := definition->>'sandboxProvider';
      configured_limit := (definition #>> '{agent,concurrencyLimit}')::integer;
    else
      select active_provider into selected_provider
      from public.workspace_sandbox_settings where workspace_id = candidate.workspace_id;
      selected_provider := coalesce(selected_provider, 'vercel');

      select value_json::integer into configured_limit
      from public.workspace_agent_config
      where workspace_id = candidate.workspace_id
        and key = 'concurrency_limit'
        and jsonb_typeof(value_json) = 'number';
    end if;

    if exists (
      select 1 from public.workspace_sandbox_connection_mutations
      where workspace_id = candidate.workspace_id
        and provider = selected_provider
        and expires_at > now()
    ) then continue; end if;

    effective_limit := coalesce(configured_limit, default_concurrency_limit);
    select count(*) into running_count from public.agent_jobs
    where workspace_id = candidate.workspace_id and status = 'running';
    if running_count >= effective_limit then continue; end if;

    return query
    update public.agent_jobs
    set status = 'running', attempt_count = attempt_count + 1, last_error = null,
        started_at = now(), scheduled_at = null,
        git_continuity_release_revision=case when pipeline_job then release_state.revision else null end
    where id = candidate.id and status = 'queued'
    returning *;
    return;
  end loop;
  return;
end;
$$;


revoke all on function public.claim_next_agent_job(integer) from public,anon,authenticated;
grant execute on function public.claim_next_agent_job(integer) to service_role;

-- Enforce the admitted repair cap for every failure caller, including worker
-- recovery and callers that have not loaded the current attempt's definition.
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
  retry_limit integer;
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
  retry_limit := p_max_retries;
  if s.execute_pinned_definition and coalesce(p_retry, false) then
    retry_limit := (internal.pinned_session_execution_definition(s) #>> '{agent,maxRetries}')::integer;
  end if;
  retrying := coalesce(p_retry, false) and effective_attempt_count < greatest(coalesce(retry_limit, 0), 0)
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

-- Resolve recovery policy by exact job so mixed revisions in one workspace keep
-- independent stall deadlines.
create view public.pinned_job_recovery_settings with (security_invoker = true) as
  select job.id as job_id, (definition #>> '{agent,stallTimeoutMs}')::integer as stall_timeout_ms,
    (definition #>> '{agent,maxRetries}')::integer as max_retries
  from public.agent_jobs job
  join public.sessions owner on (owner.workspace_id, owner.id) = (job.workspace_id, job.session_id)
  cross join lateral (select internal.pinned_session_execution_definition(owner) as definition) recipe
  where owner.execute_pinned_definition;

revoke all on public.pinned_job_recovery_settings from public, anon, authenticated, service_role;
grant select on public.pinned_job_recovery_settings to service_role;
