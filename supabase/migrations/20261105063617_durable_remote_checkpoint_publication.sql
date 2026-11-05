-- Private publication intents survive worker loss before remote publication.
-- No historical rows are backfilled: older receipts retain their actual history.
create table public.session_checkpoint_publications (
  run_id uuid primary key references public.session_source_deliveries(run_id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check(attempt_count>0),
  expected_artifact_version integer not null check(expected_artifact_version>=0),
  artifact_md text not null check(nullif(btrim(artifact_md),'') is not null),
  deadline_at timestamptz not null,
  retained_ref text check(internal.is_git_branch_ref(retained_ref)),
  remote_verified_ref text,
  remote_verified_sha text check(remote_verified_sha ~ '^[a-f0-9]{40}$'),
  remote_verified_at timestamptz,
  status text not null default 'pending' check(status in ('pending','claimed','adopted','stale')),
  claim_id uuid,
  lease_expires_at timestamptz,
  publication_attempt_count integer not null default 0 check(publication_attempt_count>=0),
  next_attempt_at timestamptz not null default now(),
  last_error_code text check(last_error_code in ('remote_publication_failed','publication_deadline_exceeded','stale_execution')),
  artifact_id uuid unique references public.session_artifacts(id) on delete cascade,
  created_at timestamptz not null default now(),
  adopted_at timestamptz,
  check((status='claimed')=(claim_id is not null and lease_expires_at is not null)
    or (status='adopted' and claim_id is not null and lease_expires_at is not null)),
  check((remote_verified_sha is null and remote_verified_ref is null and remote_verified_at is null)
    or (remote_verified_sha is not null and remote_verified_ref is not null and remote_verified_at is not null)),
  check((status='adopted')=(artifact_id is not null and adopted_at is not null))
);
create index session_checkpoint_publications_due_idx on public.session_checkpoint_publications(next_attempt_at,created_at)
  where status in ('pending','claimed');
-- Claim IDs are lookup keys in the worker, including committed idempotent receipts.
create unique index session_checkpoint_publications_claim_idx on public.session_checkpoint_publications(claim_id)
  where claim_id is not null;
create index session_checkpoint_publications_workspace_idx on public.session_checkpoint_publications(workspace_id);
create index session_checkpoint_publications_session_idx on public.session_checkpoint_publications(session_id);
create index session_checkpoint_publications_job_idx on public.session_checkpoint_publications(job_id);
alter table public.session_checkpoint_publications enable row level security;
revoke all on public.session_checkpoint_publications from public,anon,authenticated,service_role;
grant select on public.session_checkpoint_publications to service_role;
comment on table public.session_checkpoint_publications is
  'Private immutable artifact and source publication intent. A trusted worker verifies an exact retained Git ref before atomic artifact adoption. Browser roles have no access; service role mutations use fenced RPCs only.';

create function internal.assert_checkpoint_publication_service()
returns void language plpgsql security invoker set search_path='' as $$
begin
  if current_setting('role',true) is distinct from 'service_role'
    and session_user not in ('postgres','supabase_admin') then
    raise exception 'Service role is required for checkpoint publication.' using errcode='42501';
  end if;
end;
$$;

create function internal.checkpoint_publication_is_current(p public.session_checkpoint_publications)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(
    select 1 from public.sessions s
    join public.workspaces w on w.id=s.workspace_id
    join public.agent_jobs j on j.id=p.job_id and j.session_id=s.id and j.workspace_id=w.id
    join public.agent_runs r on r.id=p.run_id and r.agent_job_id=j.id and r.session_id=s.id and r.workspace_id=w.id
    join public.session_source_deliveries d on d.run_id=r.id and d.job_id=j.id and d.session_id=s.id and d.workspace_id=w.id
    join public.session_job_git_inputs i on i.job_id=j.id and i.session_id=s.id and i.workspace_id=w.id
    join public.github_repositories repo on repo.id=d.repository_id and repo.workspace_id=w.id and not repo.is_archived
    join public.github_installations installation on installation.id=repo.github_installation_id
      and installation.workspace_id=w.id and not installation.suspended and installation.installation_id=d.installation_id
    where s.id=p.session_id and w.id=p.workspace_id and w.deletion_requested_at is null
      and s.archived_at is null and s.phase_status='in_progress'
      and s.current_stage_id=j.stage_id and s.current_artifact_version=p.expected_artifact_version
      and j.status in ('started','running') and j.attempt_count=p.attempt_count
      and r.status='running' and r.attempt_count=p.attempt_count and r.stage_id=j.stage_id
      and d.attempt_count=p.attempt_count and d.branch_name=r.branch_name
      and i.repository_id=d.repository_id and i.repository_full_name=d.repository_full_name
      and repo.full_name=d.repository_full_name and i.base_branch=d.base_branch and i.input_sha=d.base_sha
      and (s.github_repository_id is null or s.github_repository_id=d.repository_id)
      and (d.base_sha=d.head_sha or (d.bundle_sha256 is not null and (d.checkpoint_path is not null or d.bundle_base64 is not null)))
      and p.retained_ref is not distinct from case when d.base_sha<>d.head_sha
        then 'refs/heads/wallie/checkpoints/'||r.id::text||'/'||d.head_sha end
  );
$$;

create function internal.guard_checkpoint_publication()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id)
      or not exists(select 1 from public.sessions where id=old.session_id) then return old; end if;
    raise exception 'Checkpoint publication intent is immutable.' using errcode='23514';
  end if;
  if tg_op='UPDATE' then
    if new.run_id is distinct from old.run_id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id or new.job_id is distinct from old.job_id
      or new.attempt_count is distinct from old.attempt_count
      or new.expected_artifact_version is distinct from old.expected_artifact_version
      or new.artifact_md is distinct from old.artifact_md or new.deadline_at is distinct from old.deadline_at
      or new.retained_ref is distinct from old.retained_ref or new.created_at is distinct from old.created_at
      or (old.remote_verified_at is not null and (new.remote_verified_at is distinct from old.remote_verified_at
        or new.remote_verified_ref is distinct from old.remote_verified_ref or new.remote_verified_sha is distinct from old.remote_verified_sha))
      or (old.status='adopted' and new is distinct from old) then
      raise exception 'Checkpoint publication intent is immutable.' using errcode='23514';
    end if;
  elsif not internal.checkpoint_publication_is_current(new) then
    raise exception 'Checkpoint publication does not match the current execution.' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger guard_checkpoint_publication before insert or update or delete on public.session_checkpoint_publications
  for each row execute function internal.guard_checkpoint_publication();

create function internal.prepare_session_checkpoint_publication(
  p_run_id uuid,p_expected_artifact_version integer,p_artifact_md text,p_deadline_at timestamptz default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype;
  d public.session_source_deliveries%rowtype; prior public.session_checkpoint_publications%rowtype;
  new_intent public.session_checkpoint_publications%rowtype;
begin
  perform internal.assert_checkpoint_publication_service();
  select owner.* into s from public.sessions owner join public.agent_runs observed_run on observed_run.session_id=owner.id
    where observed_run.id=p_run_id for no key update of owner;
  if not found then return false; end if;
  select job.* into j from public.agent_jobs job join public.agent_runs observed_run on observed_run.agent_job_id=job.id
    where observed_run.id=p_run_id for update of job;
  if not found then return false; end if;
  select * into r from public.agent_runs where id=p_run_id for update;
  if not found then return false; end if;
  select * into d from public.session_source_deliveries where run_id=p_run_id for update;
  if not found then return false; end if;
  select * into prior from public.session_checkpoint_publications where run_id=p_run_id for update;
  if found then
    if prior.expected_artifact_version is distinct from p_expected_artifact_version
      or prior.artifact_md is distinct from p_artifact_md
      or (p_deadline_at is not null and prior.deadline_at is distinct from p_deadline_at) then
      raise exception 'Checkpoint publication intent is immutable.' using errcode='23514';
    end if;
    return true;
  end if;
  new_intent.run_id:=p_run_id; new_intent.workspace_id:=s.workspace_id; new_intent.session_id:=s.id;
  new_intent.job_id:=j.id; new_intent.attempt_count:=r.attempt_count;
  new_intent.expected_artifact_version:=p_expected_artifact_version; new_intent.artifact_md:=p_artifact_md;
  new_intent.deadline_at:=coalesce(p_deadline_at,r.started_at+interval '30 minutes');
  new_intent.retained_ref:=case when d.base_sha<>d.head_sha then 'refs/heads/wallie/checkpoints/'||r.id::text||'/'||d.head_sha end;
  if not internal.checkpoint_publication_is_current(new_intent) then return false; end if;
  perform internal.assert_workspace_accepts_work(s.workspace_id);
  insert into public.session_checkpoint_publications(run_id,workspace_id,session_id,job_id,attempt_count,
    expected_artifact_version,artifact_md,deadline_at,retained_ref)
  values(new_intent.run_id,new_intent.workspace_id,new_intent.session_id,new_intent.job_id,new_intent.attempt_count,
    new_intent.expected_artifact_version,new_intent.artifact_md,new_intent.deadline_at,new_intent.retained_ref);
  return true;
end;
$$;

create function internal.claim_session_checkpoint_publication(p_run_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare candidate record; p public.session_checkpoint_publications%rowtype; new_claim uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  -- Scan identities without claiming their rows first. Lifecycle locks always
  -- precede the private intent lock, including maintenance and stale cleanup.
  for candidate in select run_id,session_id,job_id from public.session_checkpoint_publications
    where (p_run_id is null or run_id=p_run_id) and status in ('pending','claimed')
      and (deadline_at<=clock_timestamp() or next_attempt_at<=clock_timestamp())
    order by created_at,run_id
  loop
    perform 1 from public.sessions where id=candidate.session_id for no key update skip locked;
    if not found then continue; end if;
    perform 1 from public.agent_jobs where id=candidate.job_id for update skip locked;
    if not found then continue; end if;
    perform 1 from public.agent_runs where id=candidate.run_id for update skip locked;
    if not found then continue; end if;
    select * into p from public.session_checkpoint_publications where run_id=candidate.run_id for update skip locked;
    if not found or p.status not in ('pending','claimed') then continue; end if;
    if not internal.checkpoint_publication_is_current(p) then
      update public.session_checkpoint_publications set status='stale',claim_id=null,lease_expires_at=null,last_error_code='stale_execution'
        where run_id=p.run_id;
      continue;
    end if;
    if p.deadline_at<=clock_timestamp() then
      perform public.fail_session_job_attempt(p.job_id,p.attempt_count,'Checkpoint publication deadline exceeded.',false,0,p.run_id);
      update public.session_checkpoint_publications set status='stale',claim_id=null,lease_expires_at=null,last_error_code='publication_deadline_exceeded'
        where run_id=p.run_id;
      continue;
    end if;
    if p.next_attempt_at>clock_timestamp() or (p.status='claimed' and p.lease_expires_at>clock_timestamp()) then continue; end if;
    new_claim:=pg_catalog.gen_random_uuid();
    update public.session_checkpoint_publications set status='claimed',claim_id=new_claim,
      lease_expires_at=least(clock_timestamp()+interval '2 minutes',p.deadline_at),
      publication_attempt_count=publication_attempt_count+1,last_error_code=null where run_id=p.run_id;
    update public.agent_runs set last_activity_at=clock_timestamp() where id=p.run_id;
    return new_claim;
  end loop;
  return null;
end;
$$;

create function internal.assert_session_checkpoint_publication_claim(p_run_id uuid,p_claim_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare p public.session_checkpoint_publications%rowtype;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into p from public.session_checkpoint_publications where run_id=p_run_id;
  return found and p_claim_id is not null and p.status='claimed' and p.claim_id=p_claim_id and p.lease_expires_at>clock_timestamp()
    and p.deadline_at>clock_timestamp() and internal.checkpoint_publication_is_current(p);
end;
$$;

create function internal.adopt_session_checkpoint_publication(
  p_run_id uuid,p_claim_id uuid,p_remote_ref text default null,p_remote_sha text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare p public.session_checkpoint_publications%rowtype; d public.session_source_deliveries%rowtype; accepted uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  perform 1 from public.sessions s join public.session_checkpoint_publications candidate on candidate.session_id=s.id
    where candidate.run_id=p_run_id for no key update of s;
  if not found then return false; end if;
  perform 1 from public.agent_jobs j join public.session_checkpoint_publications candidate on candidate.job_id=j.id
    where candidate.run_id=p_run_id for update of j;
  if not found then return false; end if;
  perform 1 from public.agent_runs where id=p_run_id for update;
  if not found then return false; end if;
  select * into p from public.session_checkpoint_publications where run_id=p_run_id for update;
  if not found then return false; end if;
  if p.status='adopted' then
    return p_claim_id is not null and p.claim_id=p_claim_id and p.remote_verified_ref is not distinct from p_remote_ref
      and p.remote_verified_sha is not distinct from p_remote_sha;
  end if;
  if p.status<>'claimed' or p.claim_id is distinct from p_claim_id
    or p.lease_expires_at<=clock_timestamp() or p.deadline_at<=clock_timestamp()
    or not internal.checkpoint_publication_is_current(p) then return false; end if;
  perform internal.assert_workspace_accepts_work(p.workspace_id);
  select * into d from public.session_source_deliveries where run_id=p_run_id for update;
  if d.base_sha<>d.head_sha then
    if p_remote_ref is distinct from p.retained_ref or p_remote_sha is distinct from d.head_sha then
      raise exception 'Exact retained remote checkpoint proof is required.' using errcode='23514';
    end if;
    update public.session_checkpoint_publications set remote_verified_ref=p_remote_ref,remote_verified_sha=p_remote_sha,
      remote_verified_at=clock_timestamp() where run_id=p_run_id;
  elsif p_remote_ref is not null or p_remote_sha is not null then
    raise exception 'No-code checkpoint must not fabricate a remote ref or SHA.' using errcode='23514';
  end if;
  if not public.publish_session_job_with_source(p.job_id,p.attempt_count,p.run_id,p.expected_artifact_version,p.artifact_md,p.deadline_at) then
    raise exception 'Checkpoint adoption lost execution ownership.' using errcode='23514';
  end if;
  -- Separate statements guarantee the checkpoint insert precedes completion;
  -- do not rely on expression evaluation order for lifecycle mutations.
  if not public.complete_session_job_attempt(p.job_id,p.attempt_count,p.run_id) then
    raise exception 'Checkpoint adoption lost execution ownership.' using errcode='23514';
  end if;
  select current_artifact_id into accepted from public.sessions where id=p.session_id;
  update public.session_checkpoint_publications set status='adopted',artifact_id=accepted,adopted_at=clock_timestamp()
    where run_id=p.run_id;
  if clock_timestamp()>=p.deadline_at or clock_timestamp()>=p.lease_expires_at then
    raise exception 'Checkpoint publication lease or deadline expired before adoption.' using errcode='57014';
  end if;
  return true;
end;
$$;

create function internal.release_session_checkpoint_publication(p_run_id uuid,p_claim_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare p public.session_checkpoint_publications%rowtype;
begin
  perform internal.assert_checkpoint_publication_service();
  perform 1 from public.sessions s join public.session_checkpoint_publications candidate on candidate.session_id=s.id
    where candidate.run_id=p_run_id for no key update of s;
  if not found then return false; end if;
  perform 1 from public.agent_jobs j join public.session_checkpoint_publications candidate on candidate.job_id=j.id
    where candidate.run_id=p_run_id for update of j;
  if not found then return false; end if;
  perform 1 from public.agent_runs where id=p_run_id for update;
  if not found then return false; end if;
  select * into p from public.session_checkpoint_publications where run_id=p_run_id for update;
  if not found or p.status<>'claimed' or p.claim_id is distinct from p_claim_id then return false; end if;
  if not internal.checkpoint_publication_is_current(p) then
    update public.session_checkpoint_publications set status='stale',claim_id=null,lease_expires_at=null,last_error_code='stale_execution'
      where run_id=p.run_id;
    return false;
  end if;
  if p.lease_expires_at<=clock_timestamp() or p.deadline_at<=clock_timestamp() then return false; end if;
  update public.session_checkpoint_publications set status='pending',claim_id=null,lease_expires_at=null,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,5*power(2,least(p.publication_attempt_count,6)))::integer),
    last_error_code='remote_publication_failed' where run_id=p.run_id;
  return true;
end;
$$;

-- Only these small public invoker wrappers are exposed through PostgREST.
create function public.prepare_session_checkpoint_publication(p_run_id uuid,p_expected_artifact_version integer,p_artifact_md text,p_deadline_at timestamptz default null)
returns boolean language sql security invoker set search_path='' as $$select internal.prepare_session_checkpoint_publication(p_run_id,p_expected_artifact_version,p_artifact_md,p_deadline_at);$$;
create function public.claim_session_checkpoint_publication(p_run_id uuid default null)
returns uuid language sql security invoker set search_path='' as $$select internal.claim_session_checkpoint_publication(p_run_id);$$;
create function public.assert_session_checkpoint_publication_claim(p_run_id uuid,p_claim_id uuid)
returns boolean language sql security invoker set search_path='' as $$select internal.assert_session_checkpoint_publication_claim(p_run_id,p_claim_id);$$;
create function public.adopt_session_checkpoint_publication(p_run_id uuid,p_claim_id uuid,p_remote_ref text default null,p_remote_sha text default null)
returns boolean language sql security invoker set search_path='' as $$select internal.adopt_session_checkpoint_publication(p_run_id,p_claim_id,p_remote_ref,p_remote_sha);$$;
create function public.release_session_checkpoint_publication(p_run_id uuid,p_claim_id uuid)
returns boolean language sql security invoker set search_path='' as $$select internal.release_session_checkpoint_publication(p_run_id,p_claim_id);$$;

revoke all on function internal.assert_checkpoint_publication_service(),internal.checkpoint_publication_is_current(public.session_checkpoint_publications),internal.guard_checkpoint_publication(),internal.prepare_session_checkpoint_publication(uuid,integer,text,timestamptz),internal.claim_session_checkpoint_publication(uuid),internal.assert_session_checkpoint_publication_claim(uuid,uuid),internal.adopt_session_checkpoint_publication(uuid,uuid,text,text),internal.release_session_checkpoint_publication(uuid,uuid),public.prepare_session_checkpoint_publication(uuid,integer,text,timestamptz),public.claim_session_checkpoint_publication(uuid),public.assert_session_checkpoint_publication_claim(uuid,uuid),public.adopt_session_checkpoint_publication(uuid,uuid,text,text),public.release_session_checkpoint_publication(uuid,uuid) from public,anon,authenticated;
grant execute on function internal.assert_checkpoint_publication_service(),internal.checkpoint_publication_is_current(public.session_checkpoint_publications),internal.guard_checkpoint_publication(),internal.prepare_session_checkpoint_publication(uuid,integer,text,timestamptz),internal.claim_session_checkpoint_publication(uuid),internal.assert_session_checkpoint_publication_claim(uuid,uuid),internal.adopt_session_checkpoint_publication(uuid,uuid,text,text),internal.release_session_checkpoint_publication(uuid,uuid),public.prepare_session_checkpoint_publication(uuid,integer,text,timestamptz),public.claim_session_checkpoint_publication(uuid),public.assert_session_checkpoint_publication_claim(uuid,uuid),public.adopt_session_checkpoint_publication(uuid,uuid,text,text),public.release_session_checkpoint_publication(uuid,uuid) to service_role;

alter table public.session_git_checkpoints alter column output_ref drop not null;
comment on column public.session_git_checkpoints.output_ref is
  'For new code checkpoints, the exact immutable retained remote ref verified before artifact adoption. New no-code output has NULL; older rows retain their original historical intended target.';

-- Forward replacements preserve the original tenant and producer guards.
create or replace function internal.guard_git_lineage()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  s public.sessions%rowtype;
  j public.agent_jobs%rowtype;
  r public.agent_runs%rowtype;
  root public.session_git_roots%rowtype;
  pinned public.session_job_git_inputs%rowtype;
  d public.session_source_deliveries%rowtype;
  repository public.github_repositories%rowtype;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Git lineage is immutable.' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id)
      or not exists(select 1 from public.sessions where id=old.session_id) then return old; end if;
    raise exception 'Git lineage is immutable.' using errcode = '23514';
  end if;
  perform internal.assert_workspace_accepts_work(new.workspace_id);
  select * into s from public.sessions where id=new.session_id and workspace_id=new.workspace_id for no key update;
  if not found then raise exception 'Git lineage session is not in the workspace.' using errcode='23514'; end if;
  if tg_table_name='session_git_roots' then
    select * into repository from public.github_repositories
      where id=new.repository_id and workspace_id=new.workspace_id and not is_archived;
    if not found or repository.full_name is distinct from new.repository_full_name
      or (s.github_repository_id is not null and s.github_repository_id<>new.repository_id) then
      raise exception 'Git lineage repository does not match the session.' using errcode='23514';
    end if;
  elsif tg_table_name='session_job_git_inputs' then
    select * into root from public.session_git_roots where session_id=s.id;
    select * into j from public.agent_jobs where id=new.job_id for update;
    select * into r from public.agent_runs where id=new.pinned_run_id for update;
    if root.workspace_id is distinct from new.workspace_id or root.repository_id is distinct from new.repository_id
      or root.repository_full_name is distinct from new.repository_full_name
      or root.initial_base_sha is distinct from new.initial_base_sha or root.base_branch is distinct from new.base_branch
      or new.input_sha is distinct from root.initial_base_sha
      or j.session_id is distinct from s.id or j.workspace_id is distinct from s.workspace_id
      or j.status not in ('started','running') or j.attempt_count is distinct from new.pinned_attempt_count
      or j.stage_id is distinct from s.current_stage_id
      or r.agent_job_id is distinct from j.id or r.workspace_id is distinct from s.workspace_id
      or r.session_id is distinct from s.id or r.stage_id is distinct from j.stage_id
      or r.attempt_count is distinct from j.attempt_count or r.status is distinct from 'running'
      or s.archived_at is not null or s.phase_status is distinct from 'in_progress' then
      raise exception 'Git input does not match the current execution.' using errcode='23514';
    end if;
  else
    select * into pinned from public.session_job_git_inputs where job_id=new.job_id;
    select * into j from public.agent_jobs where id=new.job_id for update;
    select * into r from public.agent_runs where id=new.run_id for update;
    select * into d from public.session_source_deliveries where run_id=new.run_id;
    if pinned.session_id is distinct from s.id or pinned.workspace_id is distinct from s.workspace_id
      or pinned.repository_id is distinct from new.repository_id
      or pinned.repository_full_name is distinct from new.repository_full_name
      or pinned.initial_base_sha is distinct from new.initial_base_sha or pinned.input_sha is distinct from new.input_sha
      or (s.github_repository_id is not null and s.github_repository_id<>new.repository_id)
      or j.session_id is distinct from s.id or j.workspace_id is distinct from s.workspace_id
      or j.attempt_count is distinct from new.attempt_count or j.status not in ('started','running')
      or r.agent_job_id is distinct from j.id or r.workspace_id is distinct from s.workspace_id
      or r.session_id is distinct from s.id or r.stage_id is distinct from j.stage_id
      or r.attempt_count is distinct from j.attempt_count or r.status is distinct from 'success'
      or s.current_artifact_id is distinct from new.artifact_id
      or not exists(select 1 from public.session_artifacts a where a.id=new.artifact_id
        and a.workspace_id=s.workspace_id and a.session_id=s.id and a.stage_id=r.stage_id)
      or d.job_id is distinct from j.id or d.attempt_count is distinct from new.attempt_count
      or d.workspace_id is distinct from s.workspace_id or d.session_id is distinct from s.id
      or d.repository_id is distinct from new.repository_id or d.repository_full_name is distinct from new.repository_full_name
      or d.base_sha is distinct from new.input_sha or d.head_sha is distinct from new.output_sha
      or d.branch_name is distinct from r.branch_name
      or (d.base_sha=d.head_sha and new.output_ref is not null)
      or (d.base_sha<>d.head_sha and not exists(select 1 from public.session_checkpoint_publications p
        where p.run_id=r.id and p.status='claimed' and p.claim_id is not null
          and p.workspace_id=s.workspace_id and p.session_id=s.id and p.job_id=j.id and p.attempt_count=r.attempt_count
          and p.remote_verified_sha=d.head_sha and p.remote_verified_ref=p.retained_ref
          and p.retained_ref=new.output_ref and p.remote_verified_at is not null
          and p.lease_expires_at>clock_timestamp() and p.deadline_at>clock_timestamp()))
      or d.checkpoint_path is distinct from new.checkpoint_path or d.bundle_sha256 is distinct from new.bundle_sha256 then
      raise exception 'Git checkpoint does not match the accepted execution and artifact.' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.publish_session_job_with_source(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_expected_artifact_version integer,p_artifact_json text,
  p_deadline_at timestamptz default null
) returns boolean language plpgsql security invoker set search_path='' as $$
declare pinned public.session_job_git_inputs%rowtype; d public.session_source_deliveries%rowtype;
  accepted_artifact uuid; proof public.session_checkpoint_publications%rowtype;
begin
  -- The primitive takes session -> job -> run locks, checks the exact claim,
  -- inserts the artifact and marks its run successful. A later exception rolls
  -- all of those writes back, including deadline failures during adoption.
  if not exists(select 1 from public.session_source_deliveries where run_id=p_run_id
    and job_id=p_job_id and attempt_count=p_attempt_count) then
    raise exception 'Source checkpoint is required before publication.' using errcode='23514';
  end if;
  select * into d from public.session_source_deliveries where run_id=p_run_id;
  select * into proof from public.session_checkpoint_publications where run_id=p_run_id;
  if d.base_sha<>d.head_sha or found then
    if proof.run_id is null or proof.status<>'claimed' or proof.claim_id is null
      or (d.base_sha<>d.head_sha and (proof.remote_verified_ref is distinct from proof.retained_ref
        or proof.remote_verified_sha is distinct from d.head_sha or proof.remote_verified_at is null))
      or proof.lease_expires_at<=clock_timestamp() or proof.deadline_at<=clock_timestamp()
      or proof.job_id is distinct from p_job_id or proof.attempt_count is distinct from p_attempt_count
      or proof.expected_artifact_version is distinct from p_expected_artifact_version
      or proof.artifact_md is distinct from p_artifact_json
      or not internal.checkpoint_publication_is_current(proof) then
      raise exception 'Exact retained remote checkpoint proof is required.' using errcode='23514';
    end if;
  end if;
  if not public.publish_session_job_attempt(p_job_id,p_attempt_count,p_run_id,p_expected_artifact_version,p_artifact_json,p_deadline_at) then
    return false;
  end if;
  select * into pinned from public.session_job_git_inputs where job_id=p_job_id;
  select * into d from public.session_source_deliveries where run_id=p_run_id for update;
  if pinned.job_id is null or d.repository_id is distinct from pinned.repository_id
    or d.base_sha is distinct from pinned.input_sha or d.base_branch is distinct from pinned.base_branch then
    raise exception 'Source does not match the pinned Git input.' using errcode='23514';
  end if;
  select current_artifact_id into accepted_artifact from public.sessions where id=pinned.session_id;
  insert into public.session_git_checkpoints(run_id,workspace_id,session_id,job_id,attempt_count,repository_id,
    repository_full_name,initial_base_sha,input_sha,output_sha,output_kind,artifact_id,output_ref,checkpoint_path,bundle_sha256)
  values(p_run_id,pinned.workspace_id,pinned.session_id,p_job_id,p_attempt_count,pinned.repository_id,
    pinned.repository_full_name,pinned.initial_base_sha,pinned.input_sha,d.head_sha,
    case when pinned.input_sha=d.head_sha then 'no-code' else 'code' end,accepted_artifact,
    case when pinned.input_sha<>d.head_sha then proof.retained_ref end,d.checkpoint_path,d.bundle_sha256);
  if p_deadline_at is not null and clock_timestamp()>=p_deadline_at then
    raise exception 'Worker attempt exceeded its publication deadline.' using errcode='57014';
  end if;
  return true;
end;
$$;


create or replace function internal.guard_accepted_git_delivery()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if (exists(select 1 from public.session_git_checkpoints where run_id=old.run_id)
      or exists(select 1 from public.session_checkpoint_publications where run_id=old.run_id))
    and (new.run_id is distinct from old.run_id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id or new.job_id is distinct from old.job_id
      or new.attempt_count is distinct from old.attempt_count
      or (new.repository_id is distinct from old.repository_id and new.repository_id is not null)
      or new.repository_full_name is distinct from old.repository_full_name
      or new.installation_id is distinct from old.installation_id or new.branch_name is distinct from old.branch_name
      or new.base_branch is distinct from old.base_branch or new.base_sha is distinct from old.base_sha
      or new.head_sha is distinct from old.head_sha or new.checkpoint_path is distinct from old.checkpoint_path
      or new.bundle_sha256 is distinct from old.bundle_sha256
      or (new.bundle_base64 is distinct from old.bundle_base64 and not (
        (new.bundle_base64 is null and new.status='delivered')
        or (new.bundle_base64 is not null and octet_length(decode(new.bundle_base64,'base64'))<=4194304
          and encode(extensions.digest(decode(new.bundle_base64,'base64'),'sha256'),'hex')=old.bundle_sha256)
      ))) then
    raise exception 'Accepted Git source identity is immutable.' using errcode='23514';
  end if;
  return new;
end;
$$;

-- The legacy artifact primitive must not bypass remote proof simply by skipping
-- the source-aware wrapper. Bare historical callers without source are retained.
create function internal.guard_source_artifact_publication()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if exists(
    select 1 from public.sessions s
    join public.agent_jobs j on j.session_id=s.id and j.workspace_id=s.workspace_id
    join public.agent_runs r on r.agent_job_id=j.id and r.attempt_count=j.attempt_count
      and r.session_id=s.id and r.workspace_id=s.workspace_id
    join public.session_job_git_inputs i on i.job_id=j.id
    join public.session_source_deliveries d on d.run_id=r.id
    where s.id=new.session_id and s.workspace_id=new.workspace_id
      and j.status in ('started','running') and r.status='running'
      and (d.base_sha<>d.head_sha or exists(select 1 from public.session_checkpoint_publications prepared where prepared.run_id=r.id))
      and not exists(select 1 from public.session_checkpoint_publications p
        where p.run_id=r.id and internal.checkpoint_publication_is_current(p)
          and p.status='claimed' and p.claim_id is not null
          and (d.base_sha=d.head_sha or (p.remote_verified_ref=p.retained_ref and p.remote_verified_sha=d.head_sha
            and p.remote_verified_at is not null)) and p.lease_expires_at>clock_timestamp() and p.deadline_at>clock_timestamp()
          and new.stage_id=j.stage_id and new.artifact_json=to_jsonb(p.artifact_md))
  ) then
    raise exception 'Exact retained remote checkpoint proof is required.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_source_artifact_publication() from public,anon,authenticated;
grant execute on function internal.guard_source_artifact_publication() to service_role;
create trigger guard_source_artifact_publication before insert on public.session_artifacts
  for each row execute function internal.guard_source_artifact_publication();

-- Persist recovery bytes and the complete artifact candidate as one obligation.
-- If intent admission fails, raising here rolls back source insertion and the
-- source_recovery_required change made by the existing source preparation API.
create function public.prepare_session_source_and_checkpoint_publication(
  p_run_id uuid,p_repository_id uuid,p_base_branch text,p_base_sha text,p_head_sha text,
  p_title text,p_body text,p_checkpoint_path text,p_bundle_sha256 text,p_bundle_base64 text,
  p_expected_artifact_version integer,p_artifact_md text,p_deadline_at timestamptz default null,
  p_input_tokens bigint default null,p_output_tokens bigint default null
) returns boolean language plpgsql security invoker set search_path='' as $$
declare owner_session public.sessions%rowtype; owned_job public.agent_jobs%rowtype; owned_run public.agent_runs%rowtype;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_input_tokens<0 or p_output_tokens<0 then
    raise exception 'Token usage must not be negative.' using errcode='23514';
  end if;
  -- Take the complete lifecycle chain before either preparation API can
  -- mutate a run or intent. This order also holds when a legacy implementation
  -- of source preparation is still installed during a rolling deployment.
  select s.* into owner_session from public.sessions s join public.agent_runs observed_run
    on observed_run.session_id=s.id and observed_run.workspace_id=s.workspace_id
    where observed_run.id=p_run_id for no key update of s;
  if not found then return false; end if;
  select j.* into owned_job from public.agent_jobs j join public.agent_runs observed_run on observed_run.agent_job_id=j.id
    where observed_run.id=p_run_id and j.session_id=owner_session.id and j.workspace_id=owner_session.workspace_id
    for update of j;
  if not found then return false; end if;
  select * into owned_run from public.agent_runs where id=p_run_id and agent_job_id=owned_job.id
    and session_id=owner_session.id and workspace_id=owner_session.workspace_id for update;
  if not found or owned_run.attempt_count is distinct from owned_job.attempt_count
    or owned_run.status<>'running' or owned_job.status not in ('started','running')
    or owned_run.stage_id is distinct from owned_job.stage_id or owned_job.stage_id is distinct from owner_session.current_stage_id
    or owner_session.archived_at is not null or owner_session.phase_status<>'in_progress' then return false; end if;
  if not public.prepare_session_source_delivery(p_run_id,p_repository_id,p_base_branch,p_base_sha,p_head_sha,
    p_title,p_body,p_checkpoint_path,p_bundle_sha256,p_bundle_base64) then return false; end if;
  if not internal.prepare_session_checkpoint_publication(p_run_id,p_expected_artifact_version,p_artifact_md,p_deadline_at) then
    raise exception 'Checkpoint publication intent could not be prepared.' using errcode='23514';
  end if;
  -- Save usage before remote work or a pending return. A maintenance worker
  -- may perform adoption later without the original processor's memory.
  update public.agent_runs set input_tokens=coalesce(p_input_tokens,input_tokens),
    output_tokens=coalesce(p_output_tokens,output_tokens)
    where id=owned_run.id and workspace_id=owner_session.workspace_id and session_id=owner_session.id
      and agent_job_id=owned_job.id and attempt_count=owned_job.attempt_count and status='running';
  if not found then
    raise exception 'Checkpoint preparation lost execution ownership.' using errcode='23514';
  end if;
  return true;
end;
$$;
revoke all on function public.prepare_session_source_and_checkpoint_publication(uuid,uuid,text,text,text,text,text,text,text,text,integer,text,timestamptz,bigint,bigint)
  from public,anon,authenticated;
grant execute on function public.prepare_session_source_and_checkpoint_publication(uuid,uuid,text,text,text,text,text,text,text,text,integer,text,timestamptz,bigint,bigint)
  to service_role;

-- A stall detector's preliminary read is advisory. Serialize the decision with
-- publication preparation, cancellation and adoption before retiring anything.
create function internal.fail_stalled_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_error text,p_retry boolean,p_max_retries integer,p_run_id uuid default null
) returns text language plpgsql security definer set search_path='' as $$
declare owner_session uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  select s.id into owner_session from public.sessions s join public.agent_jobs j on j.session_id=s.id
    where j.id=p_job_id for no key update of s;
  if not found then return 'stale'; end if;
  perform 1 from public.agent_jobs where id=p_job_id for update;
  if not found then return 'stale'; end if;
  if p_run_id is null then
    perform 1 from public.agent_runs where agent_job_id=p_job_id order by id for update;
  else
    perform 1 from public.agent_runs where id=p_run_id and agent_job_id=p_job_id and session_id=owner_session for update;
    if not found then return 'stale'; end if;
  end if;
  if exists(select 1 from public.session_checkpoint_publications p
    where p.job_id=p_job_id and p.attempt_count=p_attempt_count and (p_run_id is null or p.run_id=p_run_id)
      and p.status in ('pending','claimed') and p.deadline_at>clock_timestamp()
      and internal.checkpoint_publication_is_current(p)) then
    return 'stale';
  end if;
  return public.fail_session_job_attempt(p_job_id,p_attempt_count,p_error,p_retry,p_max_retries,p_run_id);
end;
$$;
create function public.fail_stalled_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_error text,p_retry boolean,p_max_retries integer,p_run_id uuid default null
) returns text language sql security invoker set search_path='' as $$
  select internal.fail_stalled_session_job_attempt(p_job_id,p_attempt_count,p_error,p_retry,p_max_retries,p_run_id);
$$;
revoke all on function internal.fail_stalled_session_job_attempt(uuid,integer,text,boolean,integer,uuid),
  public.fail_stalled_session_job_attempt(uuid,integer,text,boolean,integer,uuid) from public,anon,authenticated;
grant execute on function internal.fail_stalled_session_job_attempt(uuid,integer,text,boolean,integer,uuid),
  public.fail_stalled_session_job_attempt(uuid,integer,text,boolean,integer,uuid) to service_role;
