-- Remote candidate refs are collectible only after the original publication
-- deadline plus seven days. Accepted refs and private recovery payloads are
-- retained indefinitely in this first release; cleanup never fabricates delivery.
create table public.session_checkpoint_cleanup (
  run_id uuid primary key references public.session_checkpoint_publications(run_id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check(attempt_count>0),
  repository_id uuid not null,
  repository_full_name text not null,
  github_repository_id bigint check(github_repository_id between 1 and 9007199254740991),
  retained_ref text not null check(internal.is_git_branch_ref(retained_ref)),
  expected_sha text not null check(expected_sha ~ '^[a-f0-9]{40}$'),
  eligible_after timestamptz not null,
  status text not null default 'pending' check(status in ('pending','claimed','deleted','blocked')),
  claim_id uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  cleanup_attempt_count integer not null default 0 check(cleanup_attempt_count>=0),
  last_error_code text check(last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  remote_absent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check((claim_id is null)=(lease_expires_at is null)),
  check(status<>'claimed' or claim_id is not null),
  check((status='deleted')=(remote_absent_at is not null))
);
create index session_checkpoint_cleanup_workspace_idx on public.session_checkpoint_cleanup(workspace_id);
create index session_checkpoint_cleanup_session_idx on public.session_checkpoint_cleanup(session_id);
create index session_checkpoint_cleanup_job_idx on public.session_checkpoint_cleanup(job_id);
create index session_checkpoint_cleanup_source_idx on public.session_checkpoint_cleanup(repository_id,expected_sha);
create unique index session_checkpoint_cleanup_claim_idx on public.session_checkpoint_cleanup(claim_id) where claim_id is not null;
create index session_checkpoint_cleanup_due_idx on public.session_checkpoint_cleanup(next_attempt_at,run_id) where status<>'deleted';
create index session_checkpoint_publications_cleanup_due_idx on public.session_checkpoint_publications(deadline_at,run_id)
  where status<>'adopted' and retained_ref is not null;
create index session_git_checkpoints_output_ref_idx on public.session_git_checkpoints(repository_id,output_ref) where output_ref is not null;
create index session_job_git_inputs_input_ref_idx on public.session_job_git_inputs(repository_id,input_ref) where input_ref is not null;
create index session_job_git_inputs_raw_sha_idx on public.session_job_git_inputs(repository_id,input_sha) where input_ref is null;
create index session_git_roots_initial_sha_idx on public.session_git_roots(repository_id,initial_base_sha);
create index session_pr_operations_source_ref_idx on public.session_pr_operations(source_ref);
create index session_source_deliveries_delivered_ref_idx on public.session_source_deliveries(delivered_ref) where delivered_ref is not null;
alter table public.session_checkpoint_cleanup enable row level security;
revoke all on public.session_checkpoint_cleanup from public,anon,authenticated,service_role;
grant select on public.session_checkpoint_cleanup to service_role;
comment on table public.session_checkpoint_cleanup is
  'Private exact-ref deletion ledger for expired unadopted publication candidates. A positive cleanup_attempt_count is a permanent consumer tombstone, including during retry backoff. Disconnected/deleting tenants require manual recovery; seven days is eligibility, not a network-deletion guarantee. Private source bundles and artifact drafts are not pruned here.';

create function internal.checkpoint_cleanup_lock_key(p_repository_id uuid,p_sha text)
returns bigint language sql immutable security invoker set search_path='' as $$
  select pg_catalog.hashtextextended('wallie:checkpoint-cleanup:'||p_repository_id::text||':'||p_sha,0);
$$;

-- A different OP-496 verified immutable retained ref still keeps the same Git
-- object reachable. Do not turn one discarded candidate into a global SHA ban.
create function internal.checkpoint_cleanup_has_safe_ref(p_repository_id uuid,p_sha text,p_ref text,p_excluded_ref text)
returns boolean language sql stable security invoker set search_path='' as $$
  select p_ref is not null and p_ref is distinct from p_excluded_ref and exists(
    select 1 from public.session_git_checkpoints c join public.session_checkpoint_publications p on p.run_id=c.run_id
    where c.repository_id=p_repository_id and c.output_sha=p_sha and c.output_kind='code'
      and c.output_ref=p_ref and p.status='adopted' and p.remote_verified_ref=p_ref
      and p.remote_verified_sha=p_sha and p.remote_verified_at is not null
      and p_ref='refs/heads/wallie/checkpoints/'||c.run_id::text||'/'||p_sha
  );
$$;

create function internal.checkpoint_cleanup_ref_is_protected(p_repository_id uuid,p_sha text,p_ref text,p_run_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select
    exists(select 1 from public.session_git_checkpoints c where c.repository_id=p_repository_id
      and (c.run_id=p_run_id or c.output_ref=p_ref))
    or exists(select 1 from public.session_job_git_inputs i where i.repository_id=p_repository_id
      and (i.input_ref=p_ref or (i.input_ref is null and i.input_sha=p_sha
        and not internal.checkpoint_cleanup_has_safe_ref(p_repository_id,p_sha,'refs/heads/'||i.base_branch,p_ref))))
    or exists(select 1 from public.session_git_roots r where r.repository_id=p_repository_id and r.initial_base_sha=p_sha
      and not internal.checkpoint_cleanup_has_safe_ref(p_repository_id,p_sha,'refs/heads/'||r.base_branch,p_ref))
    or exists(select 1 from public.session_pr_operations o join public.session_git_checkpoints c on c.run_id=o.checkpoint_run_id
      where c.repository_id=p_repository_id and o.source_ref=p_ref)
    or exists(select 1 from public.session_source_deliveries d join public.session_git_checkpoints c on c.run_id=d.run_id
      where c.repository_id=p_repository_id and d.delivered_ref=p_ref)
    or exists(select 1 from public.session_git_heads h join public.session_git_checkpoints c on c.run_id=h.checkpoint_run_id
      join public.session_job_git_inputs i on i.job_id=c.job_id
      left join public.session_source_deliveries d on d.run_id=c.run_id
      where c.repository_id=p_repository_id and (c.output_ref=p_ref or i.input_ref=p_ref or d.delivered_ref=p_ref))
    or exists(select 1 from public.session_checkpoint_publications p
      join public.session_source_deliveries d on d.run_id=p.run_id
      join public.session_job_git_inputs i on i.job_id=p.job_id
      where i.repository_id=p_repository_id and p.run_id<>p_run_id and p.status in ('pending','claimed')
        and (p.deadline_at>clock_timestamp() or p.lease_expires_at>clock_timestamp())
        and (p.retained_ref=p_ref or d.base_sha=p_sha or d.head_sha=p_sha));
$$;

create function internal.guard_checkpoint_cleanup()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.sessions where id=old.session_id)
      or not exists(select 1 from public.workspaces where id=old.workspace_id) then return old; end if;
    raise exception 'Checkpoint cleanup history is retained until session cleanup.' using errcode='23514';
  end if;
  if tg_op='UPDATE' then
    if not exists(select 1 from public.sessions where id=old.session_id)
      or not exists(select 1 from public.workspaces where id=old.workspace_id) then return new; end if;
    if new.run_id is distinct from old.run_id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id or new.job_id is distinct from old.job_id
      or new.attempt_count is distinct from old.attempt_count or new.repository_id is distinct from old.repository_id
      or new.repository_full_name is distinct from old.repository_full_name or new.github_repository_id is distinct from old.github_repository_id
      or new.retained_ref is distinct from old.retained_ref or new.expected_sha is distinct from old.expected_sha
      or new.eligible_after is distinct from old.eligible_after or new.created_at is distinct from old.created_at
      or new.cleanup_attempt_count<old.cleanup_attempt_count
      or (old.remote_absent_at is not null and (new.remote_absent_at is distinct from old.remote_absent_at or new.status is distinct from old.status)) then
      raise exception 'Checkpoint cleanup identity and accepted receipt are immutable.' using errcode='23514';
    end if;
  end if;
  if not exists(select 1 from public.session_checkpoint_publications p
    join public.session_source_deliveries d on d.run_id=p.run_id join public.session_job_git_inputs i on i.job_id=p.job_id
    where p.run_id=new.run_id and p.workspace_id=new.workspace_id and p.session_id=new.session_id
      and p.job_id=new.job_id and p.attempt_count=new.attempt_count and p.retained_ref=new.retained_ref
      and i.repository_id=new.repository_id and i.repository_full_name=new.repository_full_name
      and d.head_sha=new.expected_sha and d.base_sha<>d.head_sha and new.eligible_after=p.deadline_at+interval '7 days'
      and new.retained_ref='refs/heads/wallie/checkpoints/'||new.run_id::text||'/'||new.expected_sha) then
    raise exception 'Checkpoint cleanup does not match its publication candidate.' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger guard_checkpoint_cleanup before insert or update or delete on public.session_checkpoint_cleanup
  for each row execute function internal.guard_checkpoint_cleanup();

create function internal.guard_checkpoint_cleanup_reference()
returns trigger language plpgsql security definer set search_path='' as $$
declare sha text; explicit_ref text; tombstone public.session_checkpoint_cleanup;
begin
  if tg_table_name='session_git_roots' then sha:=new.initial_base_sha;
  else sha:=new.input_sha; end if;
  -- The existing lineage trigger runs first and takes lifecycle locks. Acquiring
  -- the shared key here avoids an advisory -> session inversion with cleanup.
  perform pg_catalog.pg_advisory_xact_lock(internal.checkpoint_cleanup_lock_key(new.repository_id,sha));
  if tg_table_name='session_git_roots' then explicit_ref:='refs/heads/'||new.base_branch;
  else explicit_ref:=coalesce(new.input_ref,'refs/heads/'||new.base_branch); end if;
  for tombstone in select * from public.session_checkpoint_cleanup
    where repository_id=new.repository_id and expected_sha=sha and cleanup_attempt_count>0
  loop
    if not internal.checkpoint_cleanup_has_safe_ref(new.repository_id,sha,explicit_ref,tombstone.retained_ref) then
      raise exception 'Checkpoint source was retired by retention cleanup. Start a new session with a verified source.' using errcode='23514';
    end if;
  end loop;
  return new;
end;
$$;
create trigger zz_guard_checkpoint_cleanup_reference before insert on public.session_git_roots
  for each row execute function internal.guard_checkpoint_cleanup_reference();
create trigger zz_guard_checkpoint_cleanup_reference before insert on public.session_job_git_inputs
  for each row execute function internal.guard_checkpoint_cleanup_reference();

-- No release-control check belongs here: recovery and bounded cleanup remain
-- available while new execution/canonical promotion is paused.
create function internal.claim_session_checkpoint_cleanup(p_run_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare candidate record; p public.session_checkpoint_publications; j public.agent_jobs; r public.agent_runs;
  d public.session_source_deliveries; pinned public.session_job_git_inputs; cleanup public.session_checkpoint_cleanup;
  repository public.github_repositories; claim uuid; blocked text;
begin
  perform internal.assert_checkpoint_publication_service();
  for candidate in select publication.run_id,publication.workspace_id,publication.session_id,publication.job_id
    from public.session_checkpoint_publications publication left join public.session_checkpoint_cleanup prior on prior.run_id=publication.run_id
    where (p_run_id is null or publication.run_id=p_run_id) and publication.status<>'adopted' and publication.retained_ref is not null
      and publication.deadline_at+interval '7 days'<=clock_timestamp()
      and (prior.run_id is null or (prior.status<>'deleted' and prior.next_attempt_at<=clock_timestamp()
        and (prior.status<>'claimed' or prior.lease_expires_at<=clock_timestamp())))
    order by publication.deadline_at,publication.run_id limit 100
  loop
    perform 1 from public.workspaces where id=candidate.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions where id=candidate.session_id for no key update skip locked;
    if not found then continue; end if;
    select * into j from public.agent_jobs where id=candidate.job_id for update skip locked;
    if not found then continue; end if;
    select * into r from public.agent_runs where id=candidate.run_id for update skip locked;
    if not found then continue; end if;
    select * into p from public.session_checkpoint_publications where run_id=candidate.run_id for update skip locked;
    if not found or p.status='adopted' or p.artifact_id is not null or p.deadline_at+interval '7 days'>clock_timestamp()
      or r.status='success' or exists(select 1 from public.session_git_checkpoints where run_id=p.run_id) then continue; end if;
    select * into d from public.session_source_deliveries where run_id=p.run_id;
    select * into pinned from public.session_job_git_inputs where job_id=p.job_id;
    if not found or p.workspace_id<>j.workspace_id or p.session_id<>j.session_id or r.agent_job_id is distinct from j.id
      or r.workspace_id<>p.workspace_id or r.session_id<>p.session_id or r.attempt_count is distinct from p.attempt_count
      or d.workspace_id<>p.workspace_id or d.session_id<>p.session_id or d.job_id<>p.job_id
      or d.attempt_count<>p.attempt_count or d.base_sha=d.head_sha
      or p.retained_ref is distinct from 'refs/heads/wallie/checkpoints/'||p.run_id::text||'/'||d.head_sha then continue; end if;
    perform pg_catalog.pg_advisory_xact_lock(internal.checkpoint_cleanup_lock_key(pinned.repository_id,d.head_sha));
    select * into cleanup from public.session_checkpoint_cleanup where run_id=p.run_id for update;
    if found and (cleanup.status='deleted' or cleanup.next_attempt_at>clock_timestamp()
      or (cleanup.status='claimed' and cleanup.lease_expires_at>clock_timestamp())) then continue; end if;
    blocked:=null;
    if p.lease_expires_at>clock_timestamp() then blocked:='live_publication_lease'; end if;
    if blocked is null and j.attempt_count=p.attempt_count and j.status in ('started','running') and r.status in ('queued','started','running') then
      perform public.fail_session_job_attempt(j.id,p.attempt_count,'Checkpoint candidate expired before adoption.',false,0,p.run_id);
      select * into j from public.agent_jobs where id=j.id;
      select * into r from public.agent_runs where id=p.run_id;
    end if;
    if blocked is null and j.attempt_count=p.attempt_count and r.status in ('queued','started','running') then blocked:='live_execution'; end if;
    if blocked is null then
      update public.session_checkpoint_publications set status='stale',claim_id=null,lease_expires_at=null,last_error_code='publication_deadline_exceeded'
        where run_id=p.run_id;
      p.status:='stale';
    end if;
    select repo.* into repository from public.github_repositories repo
      join public.github_installations installation on installation.id=repo.github_installation_id
      where repo.id=pinned.repository_id and repo.workspace_id=p.workspace_id and not repo.is_archived
        and repo.full_name=pinned.repository_full_name and installation.workspace_id=p.workspace_id and not installation.suspended
        and repo.repo_id between 1 and 9007199254740991;
    if not found and blocked is null then blocked:='repository_unavailable'; end if;
    if cleanup.run_id is null then
      insert into public.session_checkpoint_cleanup(run_id,workspace_id,session_id,job_id,attempt_count,repository_id,
        repository_full_name,github_repository_id,retained_ref,expected_sha,eligible_after)
      values(p.run_id,p.workspace_id,p.session_id,p.job_id,p.attempt_count,pinned.repository_id,pinned.repository_full_name,
        repository.repo_id,p.retained_ref,d.head_sha,p.deadline_at+interval '7 days') returning * into cleanup;
    end if;
    if cleanup.github_repository_id is null or (repository.id is not null and cleanup.github_repository_id<>repository.repo_id) then
      blocked:=coalesce(blocked,'repository_identity_unknown');
    end if;
    if blocked is null and internal.checkpoint_cleanup_ref_is_protected(cleanup.repository_id,cleanup.expected_sha,cleanup.retained_ref,cleanup.run_id) then
      blocked:='referenced';
    end if;
    if blocked is not null then
      update public.session_checkpoint_cleanup set status='blocked',claim_id=null,lease_expires_at=null,last_error_code=blocked,
        next_attempt_at=clock_timestamp()+interval '1 hour' where run_id=p.run_id;
      continue;
    end if;
    claim:=pg_catalog.gen_random_uuid();
    update public.session_checkpoint_cleanup set status='claimed',claim_id=claim,lease_expires_at=clock_timestamp()+interval '2 minutes',
      cleanup_attempt_count=cleanup_attempt_count+1,last_error_code=null where run_id=p.run_id;
    return claim;
  end loop;
  return null;
end;
$$;

create function internal.assert_session_checkpoint_cleanup_claim(p_run_id uuid,p_claim_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return exists(select 1 from public.session_checkpoint_cleanup c
    join public.session_checkpoint_publications p on p.run_id=c.run_id
    join public.agent_runs r on r.id=c.run_id join public.agent_jobs j on j.id=c.job_id
    join public.workspaces w on w.id=c.workspace_id
    join public.github_repositories repo on repo.id=c.repository_id and repo.workspace_id=c.workspace_id
    join public.github_installations installation on installation.id=repo.github_installation_id and installation.workspace_id=c.workspace_id
    where c.run_id=p_run_id and c.claim_id=p_claim_id and p_claim_id is not null and c.status='claimed'
      and c.lease_expires_at>clock_timestamp() and c.eligible_after<=clock_timestamp()
      and w.deletion_requested_at is null and not repo.is_archived and not installation.suspended
      and repo.repo_id=c.github_repository_id and repo.full_name=c.repository_full_name
      and p.status='stale' and p.artifact_id is null and p.retained_ref=c.retained_ref
      and p.deadline_at+interval '7 days'<=clock_timestamp() and r.status<>'success'
      and not (j.attempt_count=c.attempt_count and r.status in ('queued','started','running'))
      and not internal.checkpoint_cleanup_ref_is_protected(c.repository_id,c.expected_sha,c.retained_ref,c.run_id));
end;
$$;

create function internal.lock_session_checkpoint_cleanup(p_run_id uuid)
returns public.session_checkpoint_cleanup language plpgsql security definer set search_path='' as $$
declare identity record; cleanup public.session_checkpoint_cleanup;
begin
  perform internal.assert_checkpoint_publication_service();
  select workspace_id,session_id,job_id into identity from public.session_checkpoint_cleanup where run_id=p_run_id;
  if not found then return null; end if;
  perform 1 from public.workspaces where id=identity.workspace_id and deletion_requested_at is null for share;
  if not found then return null; end if;
  perform 1 from public.sessions where id=identity.session_id for no key update;
  if not found then return null; end if;
  perform 1 from public.agent_jobs where id=identity.job_id for update;
  if not found then return null; end if;
  perform 1 from public.agent_runs where id=p_run_id for update;
  if not found then return null; end if;
  perform 1 from public.session_checkpoint_publications where run_id=p_run_id for update;
  if not found then return null; end if;
  select * into cleanup from public.session_checkpoint_cleanup where run_id=p_run_id;
  perform pg_catalog.pg_advisory_xact_lock(internal.checkpoint_cleanup_lock_key(cleanup.repository_id,cleanup.expected_sha));
  select * into cleanup from public.session_checkpoint_cleanup where run_id=p_run_id for update;
  return cleanup;
end;
$$;

create function internal.finish_session_checkpoint_cleanup(p_run_id uuid,p_claim_id uuid,p_remote_absent boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare cleanup public.session_checkpoint_cleanup;
begin
  cleanup:=internal.lock_session_checkpoint_cleanup(p_run_id);
  if cleanup.run_id is null or p_remote_absent is distinct from true then return false; end if;
  if cleanup.status='deleted' then return p_claim_id is not null and cleanup.claim_id=p_claim_id; end if;
  if not internal.assert_session_checkpoint_cleanup_claim(p_run_id,p_claim_id) then return false; end if;
  update public.session_checkpoint_cleanup set status='deleted',remote_absent_at=clock_timestamp(),last_error_code=null where run_id=p_run_id;
  if clock_timestamp()>=cleanup.lease_expires_at then
    raise exception 'Checkpoint cleanup lease expired before receipt.' using errcode='57014';
  end if;
  return true;
end;
$$;

create function internal.fail_session_checkpoint_cleanup(p_run_id uuid,p_claim_id uuid,p_error_code text)
returns boolean language plpgsql security definer set search_path='' as $$
declare cleanup public.session_checkpoint_cleanup;
begin
  cleanup:=internal.lock_session_checkpoint_cleanup(p_run_id);
  if cleanup.run_id is null or cleanup.status<>'claimed' or cleanup.claim_id is distinct from p_claim_id
    or p_claim_id is null or cleanup.lease_expires_at<=clock_timestamp() then return false; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'A safe checkpoint cleanup error code is required.' using errcode='22023';
  end if;
  update public.session_checkpoint_cleanup set status=case when p_error_code='remote_ref_conflict' then 'blocked' else 'pending' end,
    claim_id=null,lease_expires_at=null,last_error_code=p_error_code,
    next_attempt_at=clock_timestamp()+case when p_error_code='remote_ref_conflict' then interval '1 day'
      else make_interval(secs=>least(3600,15*power(2,least(cleanup_attempt_count,8)))::integer) end where run_id=p_run_id;
  return true;
end;
$$;

create function public.claim_session_checkpoint_cleanup(p_run_id uuid default null)
returns uuid language sql security invoker set search_path='' as $$select internal.claim_session_checkpoint_cleanup(p_run_id);$$;
create function public.assert_session_checkpoint_cleanup_claim(p_run_id uuid,p_claim_id uuid)
returns boolean language sql security invoker set search_path='' as $$select internal.assert_session_checkpoint_cleanup_claim(p_run_id,p_claim_id);$$;
create function public.finish_session_checkpoint_cleanup(p_run_id uuid,p_claim_id uuid,p_remote_absent boolean)
returns boolean language sql security invoker set search_path='' as $$select internal.finish_session_checkpoint_cleanup(p_run_id,p_claim_id,p_remote_absent);$$;
create function public.fail_session_checkpoint_cleanup(p_run_id uuid,p_claim_id uuid,p_error_code text)
returns boolean language sql security invoker set search_path='' as $$select internal.fail_session_checkpoint_cleanup(p_run_id,p_claim_id,p_error_code);$$;
revoke all on function internal.checkpoint_cleanup_lock_key(uuid,text),internal.checkpoint_cleanup_has_safe_ref(uuid,text,text,text),
  internal.checkpoint_cleanup_ref_is_protected(uuid,text,text,uuid),internal.lock_session_checkpoint_cleanup(uuid),
  internal.claim_session_checkpoint_cleanup(uuid),internal.assert_session_checkpoint_cleanup_claim(uuid,uuid),
  internal.finish_session_checkpoint_cleanup(uuid,uuid,boolean),internal.fail_session_checkpoint_cleanup(uuid,uuid,text),
  public.claim_session_checkpoint_cleanup(uuid),public.assert_session_checkpoint_cleanup_claim(uuid,uuid),
  public.finish_session_checkpoint_cleanup(uuid,uuid,boolean),public.fail_session_checkpoint_cleanup(uuid,uuid,text) from public,anon,authenticated;
grant execute on function internal.checkpoint_cleanup_lock_key(uuid,text),internal.checkpoint_cleanup_has_safe_ref(uuid,text,text,text),
  internal.checkpoint_cleanup_ref_is_protected(uuid,text,text,uuid),internal.lock_session_checkpoint_cleanup(uuid),
  internal.claim_session_checkpoint_cleanup(uuid),internal.assert_session_checkpoint_cleanup_claim(uuid,uuid),
  internal.finish_session_checkpoint_cleanup(uuid,uuid,boolean),internal.fail_session_checkpoint_cleanup(uuid,uuid,text),
  public.claim_session_checkpoint_cleanup(uuid),public.assert_session_checkpoint_cleanup_claim(uuid,uuid),
  public.finish_session_checkpoint_cleanup(uuid,uuid,boolean),public.fail_session_checkpoint_cleanup(uuid,uuid,text) to service_role;
revoke all on function internal.guard_checkpoint_cleanup(),internal.guard_checkpoint_cleanup_reference() from public,anon,authenticated,service_role;

-- Workspace cleanup waits for a deletion capability already sent to a worker.
create or replace function public.finish_workspace_deletion(p_workspace_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
declare target public.workspaces%rowtype;
begin
  select * into target from public.workspaces where id=p_workspace_id for update;
  if not found then return true; end if;
  if target.deletion_requested_at is null then return false; end if;
  if exists(select 1 from public.workspace_resource_operations where workspace_id=p_workspace_id)
    or exists(select 1 from public.workspace_sandbox_connection_mutations where workspace_id=p_workspace_id and expires_at>now())
    or exists(select 1 from public.agent_jobs where workspace_id=p_workspace_id and status in ('queued','started','running'))
    or exists(select 1 from public.agent_runs where workspace_id=p_workspace_id and status in ('queued','started','running'))
    or exists(select 1 from public.session_source_deliveries where workspace_id=p_workspace_id and status='claimed' and lease_expires_at>now())
    or exists(select 1 from public.session_pr_operations where workspace_id=p_workspace_id
      and status='claimed' and lease_expires_at>clock_timestamp())
    or exists(select 1 from public.session_checkpoint_cleanup where workspace_id=p_workspace_id
      and status='claimed' and lease_expires_at>clock_timestamp())
    or exists(select 1 from storage.objects where bucket_id in ('workspace-avatars','session-attachments','session-source-checkpoints')
      and split_part(name,'/',1)=p_workspace_id::text) then return false; end if;
  delete from public.workspaces where id=p_workspace_id;
  return true;
end;
$$;
