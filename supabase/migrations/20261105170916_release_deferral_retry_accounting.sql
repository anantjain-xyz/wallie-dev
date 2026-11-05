-- Release-only admission deferrals consume claim identities, not execution
-- retry budget. Do not infer credits from historical gaps in run history:
-- runless setup failures and timeouts remain real failures.
create table internal.session_job_release_deferrals (
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check(attempt_count>0),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  -- Pre-release/uncertain claims can legitimately lack a captured revision.
  release_revision bigint check(release_revision>0),
  deferred_at timestamptz not null default clock_timestamp(),
  primary key(job_id,attempt_count)
);
create index session_job_release_deferrals_workspace_idx on internal.session_job_release_deferrals(workspace_id);
create index session_job_release_deferrals_session_idx on internal.session_job_release_deferrals(session_id);
alter table internal.session_job_release_deferrals enable row level security;
revoke all on internal.session_job_release_deferrals from public,anon,authenticated,service_role;
comment on table internal.session_job_release_deferrals is
  'Immutable successful release-only deferral receipts. Each captured claim can earn one retry-budget credit only as part of its fenced atomic requeue. Claim attempt identities are never decremented or reused; real runless failures receive no credit.';

create function internal.guard_session_job_release_deferral()
returns trigger language plpgsql security invoker set search_path='' as $$
declare job public.agent_jobs; owner_session public.sessions; control internal.git_continuity_release_control;
begin
  if tg_op='DELETE' and (not exists(select 1 from public.agent_jobs where id=old.job_id)
    or not exists(select 1 from public.sessions where id=old.session_id)
    or not exists(select 1 from public.workspaces where id=old.workspace_id)) then return old; end if;
  if tg_op<>'INSERT' then
    raise exception 'Release deferral receipts are immutable.' using errcode='23514'; end if;
  select * into job from public.agent_jobs where id=new.job_id;
  if not found or job.workspace_id is distinct from new.workspace_id or job.session_id is distinct from new.session_id
    or job.attempt_count is distinct from new.attempt_count or job.status not in('started','running')
    or job.git_continuity_release_revision is distinct from new.release_revision then
    raise exception 'Release deferral does not match the captured job claim.' using errcode='23514'; end if;
  select * into owner_session from public.sessions where id=new.session_id and workspace_id=new.workspace_id;
  if not found or owner_session.pipeline_id is null then
    raise exception 'Release deferral does not match a pipeline session.' using errcode='23514'; end if;
  select * into strict control from internal.git_continuity_release_control where singleton;
  if control.enabled and job.git_continuity_release_revision=control.revision
    and exists(select 1 from public.session_git_continuity_enrollments where session_id=new.session_id and workspace_id=new.workspace_id) then
    raise exception 'An admitted execution cannot receive a release deferral credit.' using errcode='23514'; end if;
  if exists(select 1 from public.agent_runs where agent_job_id=new.job_id
    and ((attempt_count=new.attempt_count and status in('queued','started','running','success'))
      or (attempt_count is null and status in('started','running')))) then
    raise exception 'An executing claim cannot receive a release deferral credit.' using errcode='23514'; end if;
  return new;
end;
$$;
revoke all on function internal.guard_session_job_release_deferral() from public,anon,authenticated,service_role;
create trigger guard_session_job_release_deferral before insert or update or delete on internal.session_job_release_deferrals
  for each row execute function internal.guard_session_job_release_deferral();

-- The failure RPC already owns session -> job -> run locks when reading this
-- count. A concurrent deferral must own the same job lock, so accounting is
-- consistent without another locking order or mutable public counter.
create function internal.git_continuity_effective_attempt_count(
  p_job_id uuid,p_workspace_id uuid,p_session_id uuid,p_attempt_count integer
) returns integer language plpgsql stable security definer set search_path='' as $$
declare deferred_claims integer;
begin
  perform internal.assert_checkpoint_publication_service();
  select count(*)::integer into deferred_claims from internal.session_job_release_deferrals
    where job_id=p_job_id and workspace_id=p_workspace_id and session_id=p_session_id
      and attempt_count<=p_attempt_count;
  -- Distinct positive claim numbers <= p_attempt_count bound the subtraction.
  -- Never add credits to p_max_retries, which could overflow its integer range.
  return greatest(0,p_attempt_count-deferred_claims);
end;
$$;
revoke all on function internal.git_continuity_effective_attempt_count(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function internal.git_continuity_effective_attempt_count(uuid,uuid,uuid,integer) to service_role;

create or replace function internal.defer_session_job_for_continuity_release(p_job_id uuid,p_attempt_count integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare session public.sessions; job public.agent_jobs; control internal.git_continuity_release_control; owner_workspace uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  -- SHARE before lifecycle locks matches claim/start admission and the setter.
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  select workspace_id into owner_workspace from public.agent_jobs where id=p_job_id;
  if not found then return false; end if;
  perform 1 from public.workspaces where id=owner_workspace and deletion_requested_at is null for share;
  if not found then return false; end if;
  select owner.* into session from public.sessions owner join public.agent_jobs j on j.session_id=owner.id
    where j.id=p_job_id for no key update of owner;
  if not found or session.pipeline_id is null or session.workspace_id is distinct from owner_workspace then return false; end if;
  select * into job from public.agent_jobs where id=p_job_id for update;
  if not found or p_attempt_count is null or p_attempt_count<=0 or job.attempt_count<>p_attempt_count or job.status not in('started','running')
    or job.workspace_id<>session.workspace_id then return false; end if;
  if control.enabled and job.git_continuity_release_revision=control.revision
    and exists(select 1 from public.session_git_continuity_enrollments e where e.session_id=session.id and e.workspace_id=session.workspace_id) then return false; end if;
  perform 1 from public.agent_runs where agent_job_id=job.id order by id for update;
  if exists(select 1 from public.agent_runs where agent_job_id=job.id
    and ((attempt_count=p_attempt_count and status in('queued','started','running','success'))
      or (attempt_count is null and status in('started','running')))) then return false; end if;
  -- The successful deferral and its one-per-claim credit are one transaction.
  -- A lost reply or duplicate request cannot mint a second credit.
  insert into internal.session_job_release_deferrals(job_id,attempt_count,workspace_id,session_id,release_revision)
  values(job.id,p_attempt_count,job.workspace_id,job.session_id,job.git_continuity_release_revision)
  on conflict(job_id,attempt_count) do nothing;
  update public.agent_jobs set status='queued',started_at=null,finished_at=null,scheduled_at=null,
    last_error=null,git_continuity_release_revision=null where id=job.id;
  delete from public.worker_dispatches where job_id=job.id and attempt_count=p_attempt_count;
  return true;
end;
$$;

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
  -- Claim identities remain monotonic. Only successful release-only
  -- deferrals are excluded from the execution retry budget and delay.
  effective_attempt_count:=internal.git_continuity_effective_attempt_count(j.id,s.workspace_id,s.id,j.attempt_count);
  retrying := coalesce(p_retry, false) and effective_attempt_count < greatest(coalesce(p_max_retries, 0), 0)
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
    scheduled_at = case when retrying then now() + make_interval(secs => least(300, 5 * power(2, least(effective_attempt_count, 10)))::double precision) else null end,
    last_error = p_error
  where id = j.id;
  if current_stage_owner then
    update public.sessions set phase_status = 'rejected' where id = s.id;
  end if;
  return case when retrying then 'queued' else 'error' end;
end;
$function$
;
