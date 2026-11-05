-- Release admission is paused by default. Recovery of already-produced code is
-- deliberately independent of this gate; no production enablement is performed.
create table internal.git_continuity_release_control (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  revision bigint not null default 1 check(revision>0),
  reason text not null check(length(btrim(reason)) between 1 and 500),
  updated_at timestamptz not null default clock_timestamp()
);
create table internal.git_continuity_release_audit (
  revision bigint primary key check(revision>0),
  enabled boolean not null,
  reason text not null check(length(btrim(reason)) between 1 and 500),
  changed_at timestamptz not null
);
alter table internal.git_continuity_release_control enable row level security;
alter table internal.git_continuity_release_audit enable row level security;
revoke all on internal.git_continuity_release_control,internal.git_continuity_release_audit from public,anon,authenticated,service_role;
insert into internal.git_continuity_release_control(singleton,enabled,revision,reason)
values(true,false,1,'Initial release pause');
insert into internal.git_continuity_release_audit select revision,enabled,reason,updated_at from internal.git_continuity_release_control;

create table public.session_git_continuity_enrollments (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  release_version integer not null default 1 check(release_version=1),
  created_at timestamptz not null default clock_timestamp()
);
create index session_git_continuity_enrollments_workspace_idx on public.session_git_continuity_enrollments(workspace_id);
alter table public.session_git_continuity_enrollments enable row level security;
revoke all on public.session_git_continuity_enrollments from public,anon,authenticated,service_role;
grant select on public.session_git_continuity_enrollments to authenticated,service_role;
create policy session_git_continuity_enrollments_read_members on public.session_git_continuity_enrollments for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));

create function internal.guard_git_continuity_enrollment()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' and (not exists(select 1 from public.sessions where id=old.session_id)
    or not exists(select 1 from public.workspaces where id=old.workspace_id)) then return old; end if;
  if tg_op<>'INSERT' then raise exception 'Git continuity enrollment is immutable.' using errcode='23514'; end if;
  if not exists(select 1 from public.sessions where id=new.session_id and workspace_id=new.workspace_id) then
    raise exception 'Git continuity enrollment does not match its session.' using errcode='23514'; end if;
  return new;
end;
$$;
revoke all on function internal.guard_git_continuity_enrollment() from public,anon,authenticated,service_role;
create trigger guard_git_continuity_enrollment before insert or update or delete on public.session_git_continuity_enrollments
  for each row execute function internal.guard_git_continuity_enrollment();
create function internal.enroll_fresh_git_continuity_session()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.session_git_continuity_enrollments(session_id,workspace_id) values(new.id,new.workspace_id);
  return new;
end;
$$;
revoke all on function internal.enroll_fresh_git_continuity_session() from public,anon,authenticated,service_role;
create trigger enroll_fresh_git_continuity_session after insert on public.sessions
  for each row execute function internal.enroll_fresh_git_continuity_session();
comment on table public.session_git_continuity_enrollments is
  'Fresh sessions created after controlled continuity rollout. No legacy sessions are imported or assigned guessed code provenance.';

create function internal.get_git_continuity_release_state()
returns table(enabled boolean,revision bigint,reason text,updated_at timestamptz)
language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return query select c.enabled,c.revision,c.reason,c.updated_at from internal.git_continuity_release_control c where c.singleton;
end;
$$;
create function internal.set_git_continuity_release(p_enabled boolean,p_expected_revision bigint,p_reason text)
returns table(enabled boolean,revision bigint,reason text,updated_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_enabled is null or p_expected_revision is null or p_expected_revision<=0
    or p_reason is null or length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'A release state, expected revision, and bounded reason are required.' using errcode='22023'; end if;
  -- This setter locks only the control row. It never waits on lifecycle rows.
  select * into strict control from internal.git_continuity_release_control where singleton for update;
  if control.revision<>p_expected_revision then return; end if;
  if control.enabled is distinct from p_enabled then
    update internal.git_continuity_release_control set enabled=p_enabled,revision=control.revision+1,
      reason=btrim(p_reason),updated_at=clock_timestamp() where singleton returning * into control;
    insert into internal.git_continuity_release_audit(revision,enabled,reason,changed_at)
      values(control.revision,control.enabled,control.reason,control.updated_at);
  end if;
  return query select control.enabled,control.revision,control.reason,control.updated_at;
end;
$$;
create function public.get_git_continuity_release_state()
returns table(enabled boolean,revision bigint,reason text,updated_at timestamptz)
language sql security invoker set search_path='' as $$select * from internal.get_git_continuity_release_state();$$;
create function public.set_git_continuity_release(p_enabled boolean,p_expected_revision bigint,p_reason text)
returns table(enabled boolean,revision bigint,reason text,updated_at timestamptz)
language sql security invoker set search_path='' as $$select * from internal.set_git_continuity_release(p_enabled,p_expected_revision,p_reason);$$;
revoke all on function internal.get_git_continuity_release_state(),internal.set_git_continuity_release(boolean,bigint,text),
  public.get_git_continuity_release_state(),public.set_git_continuity_release(boolean,bigint,text) from public,anon,authenticated;
grant execute on function internal.get_git_continuity_release_state(),internal.set_git_continuity_release(boolean,bigint,text),
  public.get_git_continuity_release_state(),public.set_git_continuity_release(boolean,bigint,text) to service_role;

create function internal.get_session_git_continuity_state(p_session_id uuid)
returns table(enabled boolean,revision bigint,state text)
language plpgsql security definer set search_path='' as $$
declare session public.sessions; control internal.git_continuity_release_control;
begin
  select * into session from public.sessions where id=p_session_id;
  if not found then return; end if;
  if current_setting('role',true) is distinct from 'service_role'
    and not(current_setting('role',true) in('none','postgres','supabase_admin') and session_user in('postgres','supabase_admin'))
    and not exists(select 1 from public.workspace_members m where m.workspace_id=session.workspace_id
      and m.user_id=auth.uid() and m.is_active) then return; end if;
  select * into strict control from internal.git_continuity_release_control where singleton;
  return query select case when session.pipeline_id is null then true else control.enabled end,control.revision,
    case when session.pipeline_id is null then 'enabled'
      when not exists(select 1 from public.session_git_continuity_enrollments e where e.session_id=session.id and e.workspace_id=session.workspace_id)
        then 'fresh_start_required' when not control.enabled then 'release_paused' else 'enabled' end;
end;
$$;
create function public.get_session_git_continuity_state(p_session_id uuid)
returns table(enabled boolean,revision bigint,state text)
language sql security invoker set search_path='' as $$select * from internal.get_session_git_continuity_state(p_session_id);$$;
revoke all on function internal.get_session_git_continuity_state(uuid),public.get_session_git_continuity_state(uuid) from public,anon;
grant execute on function internal.get_session_git_continuity_state(uuid),public.get_session_git_continuity_state(uuid) to authenticated,service_role;

alter table public.agent_jobs add column git_continuity_release_revision bigint check(git_continuity_release_revision>0);
alter table public.session_pr_operations add column git_continuity_release_revision bigint check(git_continuity_release_revision>0);

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
    select pipeline_id is not null into pipeline_job from public.sessions where id=candidate.session_id;
    perform pg_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0));

    select active_provider into selected_provider
    from public.workspace_sandbox_settings where workspace_id = candidate.workspace_id;
    selected_provider := coalesce(selected_provider, 'vercel');

    if exists (
      select 1 from public.workspace_sandbox_connection_mutations
      where workspace_id = candidate.workspace_id
        and provider = selected_provider
        and expires_at > now()
    ) then continue; end if;

    configured_limit := null;
    select (value_json)::int into configured_limit
    from public.workspace_agent_config
    where workspace_id = candidate.workspace_id
      and key = 'concurrency_limit'
      and jsonb_typeof(value_json) = 'number';

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

-- Preserve the original lifecycle implementation behind one service-only gate.
alter function public.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text) set schema internal;
alter function internal.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text) rename to start_session_job_attempt_before_release;
revoke all on function internal.start_session_job_attempt_before_release(uuid,integer,uuid,integer,text,text,text,text) from public,anon,authenticated,service_role;
create function internal.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control; job public.agent_jobs; session public.sessions;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  select * into job from public.agent_jobs where id=p_job_id;
  -- A refused/unclaimed identity never reaches release admission. Preserve
  -- the original NULL receipt rather than labeling unrelated stale work paused.
  if not found or p_attempt_count is null or p_attempt_count<=0 or job.attempt_count<>p_attempt_count
    or job.status not in('started','running') then return null; end if;
  select * into session from public.sessions where id=job.session_id and workspace_id=job.workspace_id;
  if not found then return null; end if;
  if session.pipeline_id is not null and (not control.enabled or job.git_continuity_release_revision is distinct from control.revision
    or not exists(select 1 from public.session_git_continuity_enrollments e where e.session_id=session.id and e.workspace_id=session.workspace_id)) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode='P499P';
  end if;
  perform 1 from public.workspaces where id=job.workspace_id for share;
  if not found then return null; end if;
  perform internal.assert_workspace_accepts_work(job.workspace_id);
  return internal.start_session_job_attempt_before_release(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
    p_model_provider,p_model_name,p_run_type,p_branch_name);
end;
$$;
create function public.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language sql security invoker set search_path='' as $$
  select internal.start_session_job_attempt(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
    p_model_provider,p_model_name,p_run_type,p_branch_name);
$$;
revoke all on function internal.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text),
  public.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text) from public,anon,authenticated;
grant execute on function internal.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text),
  public.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text) to service_role;

create function internal.defer_session_job_for_continuity_release(p_job_id uuid,p_attempt_count integer)
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
  update public.agent_jobs set status='queued',started_at=null,finished_at=null,scheduled_at=null,
    last_error=null,git_continuity_release_revision=null where id=job.id;
  delete from public.worker_dispatches where job_id=job.id and attempt_count=p_attempt_count;
  return true;
end;
$$;
create function public.defer_session_job_for_continuity_release(p_job_id uuid,p_attempt_count integer)
returns boolean language sql security invoker set search_path='' as $$select internal.defer_session_job_for_continuity_release(p_job_id,p_attempt_count);$$;
revoke all on function internal.defer_session_job_for_continuity_release(uuid,integer),public.defer_session_job_for_continuity_release(uuid,integer) from public,anon,authenticated;
grant execute on function internal.defer_session_job_for_continuity_release(uuid,integer),public.defer_session_job_for_continuity_release(uuid,integer) to service_role;

-- Recovery after an uncertain P499P reply must defer, not fail an unstarted job.
alter function internal.fail_stalled_session_job_attempt(uuid,integer,text,boolean,integer,uuid) rename to fail_stalled_session_job_attempt_before_release;
revoke all on function internal.fail_stalled_session_job_attempt_before_release(uuid,integer,text,boolean,integer,uuid) from public,anon,authenticated,service_role;
create function internal.fail_stalled_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_error text,p_retry boolean,p_max_retries integer,p_run_id uuid default null
) returns text language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if internal.defer_session_job_for_continuity_release(p_job_id,p_attempt_count) then return 'stale'; end if;
  return internal.fail_stalled_session_job_attempt_before_release(p_job_id,p_attempt_count,p_error,p_retry,p_max_retries,p_run_id);
end;
$$;
revoke all on function internal.fail_stalled_session_job_attempt(uuid,integer,text,boolean,integer,uuid) from public,anon,authenticated;
grant execute on function internal.fail_stalled_session_job_attempt(uuid,integer,text,boolean,integer,uuid) to service_role;
create or replace function public.fail_stalled_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_error text,p_retry boolean,p_max_retries integer,p_run_id uuid default null
) returns text language sql security invoker set search_path='' as $$select internal.fail_stalled_session_job_attempt(p_job_id,p_attempt_count,p_error,p_retry,p_max_retries,p_run_id);$$;

-- Canonical work captures a release revision with every lease. An old lease
-- cannot revive when the same flag is disabled and subsequently enabled again.
alter function internal.claim_session_pr_sync(uuid) rename to claim_session_pr_sync_before_release;
revoke all on function internal.claim_session_pr_sync_before_release(uuid) from public,anon,authenticated,service_role;
create function internal.claim_session_pr_sync(p_session_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control; candidate record; claim uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  if not control.enabled then return null; end if;
  for candidate in select sync.session_id from public.session_pr_sync sync
    join public.session_git_continuity_enrollments enrollment on enrollment.session_id=sync.session_id and enrollment.workspace_id=sync.workspace_id
    where (p_session_id is null or sync.session_id=p_session_id) and sync.status in('pending','error')
      and sync.next_attempt_at<=clock_timestamp() order by sync.next_attempt_at,sync.session_id
  loop
    claim:=internal.claim_session_pr_sync_before_release(candidate.session_id);
    if claim is not null then
      update public.session_pr_operations set git_continuity_release_revision=control.revision where claim_id=claim;
      return claim;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function internal.claim_session_pr_sync(uuid) from public,anon,authenticated;
grant execute on function internal.claim_session_pr_sync(uuid) to service_role;
create or replace function public.claim_session_pr_sync(p_session_id uuid default null)
returns uuid language sql security invoker set search_path='' as $$select internal.claim_session_pr_sync(p_session_id);$$;
alter function internal.assert_session_pr_sync_claim(uuid,uuid) rename to assert_session_pr_sync_claim_before_release;
revoke all on function internal.assert_session_pr_sync_claim_before_release(uuid,uuid) from public,anon,authenticated,service_role;
create function internal.assert_session_pr_sync_claim(p_operation_id uuid,p_claim_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  -- A preflight read deliberately takes no control lock while lifecycle locks
  -- may already be held. The setter owns no lifecycle rows; network effects
  -- already issued before a pause remain reconcilable on resume.
  return exists(select 1 from internal.git_continuity_release_control c join public.session_pr_operations o on o.id=p_operation_id
    join public.session_git_continuity_enrollments e on e.session_id=o.session_id and e.workspace_id=o.workspace_id
    where c.singleton and c.enabled and o.git_continuity_release_revision=c.revision)
    and internal.assert_session_pr_sync_claim_before_release(p_operation_id,p_claim_id);
end;
$$;
revoke all on function internal.assert_session_pr_sync_claim(uuid,uuid) from public,anon,authenticated;
grant execute on function internal.assert_session_pr_sync_claim(uuid,uuid) to service_role;
create or replace function public.assert_session_pr_sync_claim(p_operation_id uuid,p_claim_id uuid)
returns boolean language sql security invoker set search_path='' as $$select internal.assert_session_pr_sync_claim(p_operation_id,p_claim_id);$$;

-- A database receipt is a mutation too: a preflight alone must not let an old
-- release revision acknowledge work after a disable/re-enable boundary.
alter function internal.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid)
  rename to finish_session_pr_sync_before_release;
revoke all on function internal.finish_session_pr_sync_before_release(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid)
  from public,anon,authenticated,service_role;
create function internal.finish_session_pr_sync(
  p_operation_id uuid,p_claim_id uuid,p_observed_head_sha text,p_observed_fence_sha text,
  p_pr_number integer,p_pr_url text,p_pr_state text,p_is_draft boolean,p_pr_head_sha text,
  p_pr_updated_at timestamptz,p_observation_id uuid default null
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  -- Existing immutable receipts remain readable/idempotent while paused.
  if not exists(select 1 from public.session_pr_operations where id=p_operation_id and receipted_at is not null) then
    perform 1 from internal.git_continuity_release_control where singleton for share;
    if not internal.assert_session_pr_sync_claim(p_operation_id,p_claim_id)
      and not exists(select 1 from public.session_pr_operations where id=p_operation_id and receipted_at is not null) then return false; end if;
  end if;
  return internal.finish_session_pr_sync_before_release(p_operation_id,p_claim_id,p_observed_head_sha,p_observed_fence_sha,
    p_pr_number,p_pr_url,p_pr_state,p_is_draft,p_pr_head_sha,p_pr_updated_at,p_observation_id);
end;
$$;
create or replace function public.finish_session_pr_sync(
  p_operation_id uuid,p_claim_id uuid,p_observed_head_sha text,p_observed_fence_sha text,
  p_pr_number integer,p_pr_url text,p_pr_state text,p_is_draft boolean,p_pr_head_sha text,
  p_pr_updated_at timestamptz,p_observation_id uuid default null
) returns boolean language sql security invoker set search_path='' as $$
  select internal.finish_session_pr_sync(p_operation_id,p_claim_id,p_observed_head_sha,p_observed_fence_sha,
    p_pr_number,p_pr_url,p_pr_state,p_is_draft,p_pr_head_sha,p_pr_updated_at,p_observation_id);
$$;
revoke all on function internal.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid),
  public.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function internal.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid),
  public.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid) to service_role;
