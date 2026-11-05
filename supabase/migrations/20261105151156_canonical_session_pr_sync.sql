-- Accepted checkpoints enqueue PR work; remote I/O never participates in artifact adoption.
create table public.session_pr_sync (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  current_epoch_id uuid,
  desired_checkpoint_run_id uuid not null references public.session_git_checkpoints(run_id) on delete cascade,
  target_generation bigint not null default 1 check(target_generation>0),
  status text not null check(status in ('not_needed','pending','synced','conflict','error','successor_required')),
  observed_head_sha text check(observed_head_sha ~ '^[a-f0-9]{40}$'),
  observed_fence_sha text check(observed_fence_sha ~ '^[a-f0-9]{40}$'),
  observed_pr_head_sha text check(observed_pr_head_sha ~ '^[a-f0-9]{40}$'),
  last_error_code text check(last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  next_attempt_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index session_pr_sync_workspace_idx on public.session_pr_sync(workspace_id);
create index session_pr_sync_checkpoint_idx on public.session_pr_sync(desired_checkpoint_run_id);
create index session_pr_sync_due_idx on public.session_pr_sync(next_attempt_at,session_id) where status in ('pending','error');

create table public.session_pr_epochs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  epoch_number integer not null check(epoch_number>0),
  repository_id uuid references public.github_repositories(id) on delete set null,
  repository_full_name text not null,
  github_repository_id bigint not null check(github_repository_id between 1 and 9007199254740991),
  base_branch text not null check(nullif(btrim(base_branch),'') is not null),
  branch_name text not null,
  fence_branch text not null,
  pr_number integer check(pr_number>0),
  pr_url text,
  pr_state text check(pr_state in ('open','closed','merged')),
  is_draft boolean,
  pr_updated_at timestamptz,
  pr_head_sha text check(pr_head_sha ~ '^[a-f0-9]{40}$'),
  create_attempted boolean not null default false,
  acknowledged_head_sha text check(acknowledged_head_sha ~ '^[a-f0-9]{40}$'),
  acknowledged_fence_sha text check(acknowledged_fence_sha ~ '^[a-f0-9]{40}$'),
  observation_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique(session_id,epoch_number),
  unique(workspace_id,repository_id,branch_name),
  check((acknowledged_head_sha is null)=(acknowledged_fence_sha is null)),
  check((pr_number is null)=(pr_url is null)),
  check(internal.is_git_branch_ref('refs/heads/'||branch_name)),
  check(internal.is_git_branch_ref('refs/heads/'||fence_branch))
);
alter table public.session_pr_sync add constraint session_pr_sync_epoch_fkey
  foreign key(current_epoch_id) references public.session_pr_epochs(id) on delete set null;
create index session_pr_sync_epoch_idx on public.session_pr_sync(current_epoch_id);
create index session_pr_epochs_workspace_idx on public.session_pr_epochs(workspace_id);
create index session_pr_epochs_connection_idx on public.session_pr_epochs(repository_id);
create unique index session_pr_epochs_observation_idx on public.session_pr_epochs(observation_id) where observation_id is not null;

create table public.session_pr_operations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  epoch_id uuid not null references public.session_pr_epochs(id) on delete cascade,
  checkpoint_run_id uuid not null references public.session_git_checkpoints(run_id) on delete cascade,
  target_generation bigint not null check(target_generation>0),
  desired_sha text not null check(desired_sha ~ '^[a-f0-9]{40}$'),
  source_ref text not null check(internal.is_git_branch_ref(source_ref)),
  expected_head_sha text check(expected_head_sha ~ '^[a-f0-9]{40}$'),
  expected_fence_sha text check(expected_fence_sha ~ '^[a-f0-9]{40}$'),
  desired_fence_sha text not null check(desired_fence_sha ~ '^[a-f0-9]{40}$'),
  fence_commit_body text not null,
  status text not null default 'pending' check(status in ('pending','claimed','succeeded','terminal','conflict')),
  claim_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text check(last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  receipt_head_sha text check(receipt_head_sha ~ '^[a-f0-9]{40}$'),
  receipt_fence_sha text check(receipt_fence_sha ~ '^[a-f0-9]{40}$'),
  receipt_pr_number integer,
  receipt_pr_head_sha text,
  receipt_pr_state text,
  receipt_observation_id uuid,
  receipted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check((expected_head_sha is null)=(expected_fence_sha is null)),
  check((claim_id is null)=(lease_expires_at is null)),
  check(status<>'claimed' or claim_id is not null)
);
create unique index session_pr_operations_unresolved_idx on public.session_pr_operations(epoch_id) where status in ('pending','claimed');
create unique index session_pr_operations_claim_idx on public.session_pr_operations(claim_id) where claim_id is not null;
create index session_pr_operations_workspace_idx on public.session_pr_operations(workspace_id);
create index session_pr_operations_session_idx on public.session_pr_operations(session_id);
create index session_pr_operations_checkpoint_idx on public.session_pr_operations(checkpoint_run_id);

create table internal.session_pr_successor_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid not null,
  request_id uuid not null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  expected_epoch_id uuid not null,
  successor_epoch_id uuid not null references public.session_pr_epochs(id) on delete cascade,
  primary key(workspace_id,actor_user_id,request_id)
);
create index session_pr_successor_requests_session_idx on internal.session_pr_successor_requests(session_id);
create index session_pr_successor_requests_epoch_idx on internal.session_pr_successor_requests(successor_epoch_id);

alter table public.session_pr_sync enable row level security;
alter table public.session_pr_epochs enable row level security;
alter table public.session_pr_operations enable row level security;
alter table internal.session_pr_successor_requests enable row level security;
revoke all on public.session_pr_sync,public.session_pr_epochs,public.session_pr_operations,internal.session_pr_successor_requests
  from public,anon,authenticated,service_role;
grant select on public.session_pr_sync,public.session_pr_epochs to authenticated,service_role;
grant select on public.session_pr_operations to service_role;
create policy session_pr_sync_select_membership on public.session_pr_sync for select to authenticated
  using(workspace_id in (select internal.current_user_workspace_ids()));
create policy session_pr_epochs_select_membership on public.session_pr_epochs for select to authenticated
  using(workspace_id in (select internal.current_user_workspace_ids()));

create function internal.guard_session_pr_protocol()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.sessions where id=old.session_id)
      or not exists(select 1 from public.workspaces where id=old.workspace_id) then return old; end if;
    raise exception 'Canonical PR history is retained until session cleanup.' using errcode='23514';
  end if;
  if tg_op='UPDATE' and (not exists(select 1 from public.sessions where id=old.session_id)
    or not exists(select 1 from public.workspaces where id=old.workspace_id)) then return new; end if;
  if not exists(select 1 from public.sessions where id=new.session_id and workspace_id=new.workspace_id) then
    raise exception 'Canonical PR scope does not match its session.' using errcode='23514';
  end if;
  if tg_op='UPDATE' then
    if new.session_id is distinct from old.session_id or new.workspace_id is distinct from old.workspace_id then
      raise exception 'Canonical PR identity is immutable.' using errcode='23514';
    end if;
    if tg_table_name='session_pr_epochs' then
      if new.id is distinct from old.id or new.epoch_number is distinct from old.epoch_number
        or (new.repository_id is distinct from old.repository_id and new.repository_id is not null)
        or new.repository_full_name is distinct from old.repository_full_name
        or new.github_repository_id is distinct from old.github_repository_id
        or new.base_branch is distinct from old.base_branch or new.branch_name is distinct from old.branch_name
        or new.fence_branch is distinct from old.fence_branch or new.created_at is distinct from old.created_at
        or (old.pr_number is not null and (new.pr_number is distinct from old.pr_number or new.pr_url is distinct from old.pr_url))
        or (old.pr_state='merged' and new.pr_state is distinct from 'merged')
        or (old.pr_state='closed' and new.pr_state is distinct from 'closed' and new.pr_state is distinct from 'merged') then
        raise exception 'Canonical PR epoch identity and terminal state are immutable.' using errcode='23514';
      end if;
    elsif tg_table_name='session_pr_operations' then
      if new.id is distinct from old.id or new.epoch_id is distinct from old.epoch_id
        or new.checkpoint_run_id is distinct from old.checkpoint_run_id or new.target_generation is distinct from old.target_generation
        or new.desired_sha is distinct from old.desired_sha or new.source_ref is distinct from old.source_ref
        or new.expected_head_sha is distinct from old.expected_head_sha or new.expected_fence_sha is distinct from old.expected_fence_sha
        or new.desired_fence_sha is distinct from old.desired_fence_sha or new.fence_commit_body is distinct from old.fence_commit_body
        or new.created_at is distinct from old.created_at
        or (old.receipted_at is not null and (new.receipted_at is distinct from old.receipted_at
          or new.receipt_head_sha is distinct from old.receipt_head_sha or new.receipt_fence_sha is distinct from old.receipt_fence_sha
          or new.receipt_pr_number is distinct from old.receipt_pr_number or new.receipt_pr_head_sha is distinct from old.receipt_pr_head_sha
          or new.receipt_pr_state is distinct from old.receipt_pr_state
          or new.receipt_observation_id is distinct from old.receipt_observation_id or new.status is distinct from old.status)) then
        raise exception 'Canonical PR operation and accepted receipt are immutable.' using errcode='23514';
      end if;
    end if;
  end if;
  if tg_table_name='session_pr_sync' then
    if not exists(select 1 from public.session_git_heads h where h.session_id=new.session_id and h.workspace_id=new.workspace_id
      and h.checkpoint_run_id=new.desired_checkpoint_run_id) then
      raise exception 'Canonical PR target is not the accepted session checkpoint.' using errcode='23514';
    end if;
    if new.current_epoch_id is not null and not exists(select 1 from public.session_pr_epochs e
      where e.id=new.current_epoch_id and e.session_id=new.session_id and e.workspace_id=new.workspace_id) then
      raise exception 'Canonical PR epoch belongs to another session.' using errcode='23514';
    end if;
  elsif tg_table_name='session_pr_epochs' then
    if not exists(select 1 from public.session_git_roots r where r.session_id=new.session_id and r.workspace_id=new.workspace_id
      and r.repository_full_name=new.repository_full_name and r.base_branch=new.base_branch
      and (new.repository_id is null or r.repository_id=new.repository_id))
      or new.branch_name<>'wallie/sessions/'||new.session_id::text||'/'||new.id::text
      or new.fence_branch<>'wallie/session-fences/'||new.id::text then
      raise exception 'Canonical PR epoch does not match its session repository.' using errcode='23514';
    end if;
  elsif tg_table_name='session_pr_operations' then
    if not exists(select 1 from public.session_pr_epochs e join public.session_git_checkpoints c on c.run_id=new.checkpoint_run_id
      where e.id=new.epoch_id and e.session_id=new.session_id and e.workspace_id=new.workspace_id
        and c.session_id=new.session_id and c.workspace_id=new.workspace_id
        and (e.repository_id is null or c.repository_id=e.repository_id) and c.repository_full_name=e.repository_full_name
        and c.output_sha=new.desired_sha) then
      raise exception 'Canonical PR operation does not match its checkpoint and epoch.' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_session_pr_protocol() from public,anon,authenticated,service_role;
create trigger guard_session_pr_sync before insert or update or delete on public.session_pr_sync
  for each row execute function internal.guard_session_pr_protocol();
create trigger guard_session_pr_epochs before insert or update or delete on public.session_pr_epochs
  for each row execute function internal.guard_session_pr_protocol();
create trigger guard_session_pr_operations before insert or update or delete on public.session_pr_operations
  for each row execute function internal.guard_session_pr_protocol();

create function internal.enqueue_session_pr_sync()
returns trigger language plpgsql security definer set search_path='' as $$
declare checkpoint public.session_git_checkpoints; producer public.session_job_git_inputs; effective_ref text;
begin
  select * into strict checkpoint from public.session_git_checkpoints where run_id=new.checkpoint_run_id;
  select * into strict producer from public.session_job_git_inputs where job_id=checkpoint.job_id;
  effective_ref:=case when checkpoint.output_kind='code' then checkpoint.output_ref else producer.input_ref end;
  -- Do not call checkpoint_execution_input here: adoption has inserted the
  -- checkpoint but its private publication receipt is not yet marked adopted.
  insert into public.session_pr_sync(session_id,workspace_id,desired_checkpoint_run_id,status)
  values(new.session_id,new.workspace_id,new.checkpoint_run_id,case when effective_ref is null then 'not_needed' else 'pending' end)
  on conflict(session_id) do update set desired_checkpoint_run_id=excluded.desired_checkpoint_run_id,
    target_generation=session_pr_sync.target_generation+1,
    status=case when exists(select 1 from public.session_pr_epochs e where e.id=session_pr_sync.current_epoch_id and e.pr_state in ('closed','merged'))
      then 'successor_required' when effective_ref is null and session_pr_sync.current_epoch_id is null then 'not_needed' else 'pending' end,
    last_error_code=null,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp();
  return new;
end;
$$;
revoke all on function internal.enqueue_session_pr_sync() from public,anon,authenticated,service_role;
create trigger enqueue_session_pr_sync after insert or update of checkpoint_run_id on public.session_git_heads
  for each row execute function internal.enqueue_session_pr_sync();

-- Eligibility contains no job/run/head locks. All mutators acquire session ->
-- sync -> epoch -> operation; accepted checkpoint insertion already owns session.
create function internal.session_pr_is_eligible(p_session_id uuid,p_workspace_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.sessions s join public.workspaces w on w.id=s.workspace_id
    where s.id=p_session_id and s.workspace_id=p_workspace_id and w.deletion_requested_at is null
      and (s.archived_at is null or s.phase_status='approved'));
$$;

create function internal.lock_session_pr_operation(p_operation_id uuid)
returns public.session_pr_operations language plpgsql security definer set search_path='' as $$
declare identity record; operation public.session_pr_operations;
begin
  perform internal.assert_checkpoint_publication_service();
  select session_id,epoch_id into identity from public.session_pr_operations where id=p_operation_id;
  if not found then return null; end if;
  perform 1 from public.sessions where id=identity.session_id for no key update;
  if not found then return null; end if;
  perform 1 from public.session_pr_sync where session_id=identity.session_id for update;
  if not found then return null; end if;
  perform 1 from public.session_pr_epochs where id=identity.epoch_id for update;
  if not found then return null; end if;
  select * into operation from public.session_pr_operations where id=p_operation_id for update;
  return operation;
end;
$$;

create function internal.claim_session_pr_sync(p_session_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare candidate record; sync public.session_pr_sync; epoch public.session_pr_epochs; operation public.session_pr_operations;
  selected record; operation_id uuid; new_epoch_id uuid; claim uuid; body text; number integer;
begin
  perform internal.assert_checkpoint_publication_service();
  for candidate in select session_id,workspace_id from public.session_pr_sync
    where (p_session_id is null or session_id=p_session_id) and status in ('pending','error') and next_attempt_at<=clock_timestamp()
    order by next_attempt_at,session_id
  loop
    -- Admission precedes lifecycle locks: workspace deletion must observe the
    -- committed claim, never wait on our session while holding its delete lock.
    perform 1 from public.workspaces where id=candidate.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions where id=candidate.session_id for no key update skip locked;
    if not found then continue; end if;
    select * into sync from public.session_pr_sync where session_id=candidate.session_id for update skip locked;
    if not found or sync.status not in ('pending','error') or sync.next_attempt_at>clock_timestamp()
      or not internal.session_pr_is_eligible(sync.session_id,sync.workspace_id) then continue; end if;
    -- Existing legacy claims must become quiescent before this epoch starts.
    if exists(select 1 from public.session_source_deliveries d where d.session_id=sync.session_id
      and d.status='claimed' and d.lease_expires_at>clock_timestamp()) then continue; end if;
    select * into selected from internal.checkpoint_execution_input(sync.desired_checkpoint_run_id,sync.session_id,sync.workspace_id);
    if selected.input_ref is null then
      if sync.current_epoch_id is null then update public.session_pr_sync set status='not_needed' where session_id=sync.session_id; end if;
      continue;
    end if;
    if not exists(select 1 from public.github_repositories r join public.github_installations i on i.id=r.github_installation_id
      where r.id=selected.repository_id and r.workspace_id=sync.workspace_id and not r.is_archived
        and r.full_name=selected.repository_full_name and i.workspace_id=sync.workspace_id and not i.suspended) then
      update public.session_pr_sync set status='error',last_error_code='repository_unavailable',next_attempt_at=clock_timestamp()+interval '1 minute'
        where session_id=sync.session_id;
      continue;
    end if;
    if sync.current_epoch_id is null then
      -- An expired legacy lease is not proof that a POST failed. Preserve
      -- existing open/unknown PRs and uncertain attempts instead of duplicating
      -- them under a fresh canonical identity.
      if exists(select 1 from public.session_pull_requests link where link.session_id=sync.session_id
        and link.workspace_id=sync.workspace_id and (link.pull_request_state is null or link.pull_request_state not in ('closed','merged'))
        and not exists(select 1 from public.session_pr_epochs known where known.session_id=sync.session_id and known.branch_name=link.branch_name))
        or exists(select 1 from public.session_source_deliveries d where d.session_id=sync.session_id and d.workspace_id=sync.workspace_id
          and d.delivery_attempt_count>0 and d.status<>'delivered') then
        update public.session_pr_sync set status='error',last_error_code='legacy_pr_cutover_required',
          next_attempt_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() where session_id=sync.session_id;
        continue;
      end if;
      select coalesce(max(epoch_number),0)+1 into number from public.session_pr_epochs where session_id=sync.session_id;
      new_epoch_id:=pg_catalog.gen_random_uuid();
      insert into public.session_pr_epochs(id,session_id,workspace_id,epoch_number,repository_id,github_repository_id,repository_full_name,
        base_branch,branch_name,fence_branch)
      values(new_epoch_id,sync.session_id,sync.workspace_id,number,selected.repository_id,
        (select repo_id from public.github_repositories where id=selected.repository_id),selected.repository_full_name,
        selected.base_branch,'wallie/sessions/'||sync.session_id::text||'/'||new_epoch_id::text,
        'wallie/session-fences/'||new_epoch_id::text) returning * into epoch;
      update public.session_pr_sync set current_epoch_id=epoch.id where session_id=sync.session_id;
    else
      select * into epoch from public.session_pr_epochs where id=sync.current_epoch_id for update;
    end if;
    if epoch.pr_state in ('closed','merged') then
      update public.session_pr_sync set status='successor_required' where session_id=sync.session_id;
      continue;
    end if;
    select * into operation from public.session_pr_operations where epoch_id=epoch.id and status in ('pending','claimed') for update;
    if found then
      if operation.next_attempt_at>clock_timestamp() or (operation.status='claimed' and operation.lease_expires_at>clock_timestamp()) then continue; end if;
    else
      operation_id:=pg_catalog.gen_random_uuid();
      body:='tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904'||chr(10)
        ||case when epoch.acknowledged_fence_sha is null then '' else 'parent '||epoch.acknowledged_fence_sha||chr(10) end
        ||'author Wallie <noreply@wallie.dev> 946684800 +0000'||chr(10)
        ||'committer Wallie <noreply@wallie.dev> 946684800 +0000'||chr(10)||chr(10)
        ||'Wallie canonical publication '||operation_id::text||chr(10);
      insert into public.session_pr_operations(id,session_id,workspace_id,epoch_id,checkpoint_run_id,target_generation,
        desired_sha,source_ref,expected_head_sha,expected_fence_sha,desired_fence_sha,fence_commit_body)
      values(operation_id,sync.session_id,sync.workspace_id,epoch.id,sync.desired_checkpoint_run_id,sync.target_generation,
        selected.input_sha,selected.input_ref,epoch.acknowledged_head_sha,epoch.acknowledged_fence_sha,
        encode(extensions.digest(convert_to('commit '||octet_length(convert_to(body,'UTF8'))::text,'UTF8')||decode('00','hex')||convert_to(body,'UTF8'),'sha1'),'hex'),body)
      returning * into operation;
    end if;
    claim:=pg_catalog.gen_random_uuid();
    update public.session_pr_operations set status='claimed',claim_id=claim,lease_expires_at=clock_timestamp()+interval '2 minutes',
      attempt_count=attempt_count+1,last_error_code=null where id=operation.id;
    return claim;
  end loop;
  return null;
end;
$$;

create function internal.assert_session_pr_sync_claim(p_operation_id uuid,p_claim_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return exists(select 1 from public.session_pr_operations o join public.session_pr_sync s on s.session_id=o.session_id
    join public.session_pr_epochs e on e.id=o.epoch_id where o.id=p_operation_id and o.claim_id=p_claim_id and o.status='claimed'
      and o.lease_expires_at>clock_timestamp() and s.current_epoch_id=e.id and e.pr_state is distinct from 'closed'
      and e.pr_state is distinct from 'merged' and internal.session_pr_is_eligible(o.session_id,o.workspace_id));
end;
$$;

create function internal.arm_session_pr_creation(p_epoch_id uuid,p_operation_id uuid,p_claim_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare operation public.session_pr_operations;
begin
  operation:=internal.lock_session_pr_operation(p_operation_id);
  if operation.id is null or operation.epoch_id is distinct from p_epoch_id
    or not internal.assert_session_pr_sync_claim(p_operation_id,p_claim_id) then return false; end if;
  update public.session_pr_epochs set create_attempted=true where id=p_epoch_id and not create_attempted
    and pr_number is null and pr_state is null;
  return found;
end;
$$;

create function internal.finish_session_pr_sync(
  p_operation_id uuid,p_claim_id uuid,p_observed_head_sha text,p_observed_fence_sha text,
  p_pr_number integer,p_pr_url text,p_pr_state text,p_is_draft boolean,p_pr_head_sha text,p_pr_updated_at timestamptz,
  p_observation_id uuid default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare operation public.session_pr_operations; epoch public.session_pr_epochs; sync public.session_pr_sync; terminal boolean;
begin
  operation:=internal.lock_session_pr_operation(p_operation_id);
  if operation.id is null then return false; end if;
  if operation.receipted_at is not null then
    return operation.claim_id is not distinct from p_claim_id and p_claim_id is not null
      and operation.receipt_head_sha is not distinct from p_observed_head_sha
      and operation.receipt_fence_sha is not distinct from p_observed_fence_sha
      and operation.receipt_pr_number is not distinct from p_pr_number
      and operation.receipt_pr_state is not distinct from p_pr_state
      and operation.receipt_pr_head_sha is not distinct from p_pr_head_sha
      and p_observation_id is not null and operation.receipt_observation_id=p_observation_id;
  end if;
  select * into sync from public.session_pr_sync where session_id=operation.session_id;
  select * into epoch from public.session_pr_epochs where id=operation.epoch_id;
  if operation.status<>'claimed' or operation.claim_id is distinct from p_claim_id or p_claim_id is null
    or operation.lease_expires_at<=clock_timestamp() or sync.current_epoch_id is distinct from epoch.id
    or not internal.session_pr_is_eligible(operation.session_id,operation.workspace_id) then return false; end if;
  if p_pr_number is null or p_pr_number<=0 or p_pr_url is null
    or lower(p_pr_url)<>lower('https://github.com/'||epoch.repository_full_name||'/pull/'||p_pr_number::text)
    or p_pr_state is null or p_pr_state not in ('open','closed','merged') or p_is_draft is null
    or p_pr_updated_at is null or not isfinite(p_pr_updated_at)
    or (p_pr_head_sha is not null and p_pr_head_sha !~ '^[a-f0-9]{40}$') then
    raise exception 'Invalid canonical PR snapshot.' using errcode='22023';
  end if;
  if epoch.pr_number is not null and (epoch.pr_number<>p_pr_number or epoch.pr_url<>p_pr_url) then
    raise exception 'Canonical PR identity does not match the pinned epoch.' using errcode='23514';
  end if;
  if epoch.pr_state='merged' and p_pr_state<>'merged' then return false; end if;
  if epoch.pr_state='closed' and p_pr_state='open' then return false; end if;
  -- The token is reserved before the publisher's final GET and shares its
  -- namespace with webhook observations. A later begin supersedes this read,
  -- including when the later read has already completed and cleared the token.
  if p_observation_id is null or epoch.observation_id is distinct from p_observation_id
    or p_pr_updated_at<epoch.pr_updated_at then return false; end if;
  terminal:=p_pr_state in ('closed','merged');
  -- A PR discovered terminal before any push must pin this epoch without
  -- inventing acknowledgement of refs that may never have existed.
  if not terminal and (p_observed_head_sha is distinct from operation.desired_sha
    or p_observed_fence_sha is distinct from operation.desired_fence_sha) then
    raise exception 'Exact canonical head and operation fence proof are required.' using errcode='23514';
  end if;
  if not terminal and p_pr_head_sha is null then
    raise exception 'Exact canonical PR head observation is required.' using errcode='23514';
  end if;
  update public.session_pr_epochs set pr_number=p_pr_number,pr_url=p_pr_url,pr_state=p_pr_state,is_draft=p_is_draft,
    pr_updated_at=greatest(pr_updated_at,p_pr_updated_at),pr_head_sha=p_pr_head_sha,observation_id=null,
    acknowledged_head_sha=case when terminal then acknowledged_head_sha else p_observed_head_sha end,
    acknowledged_fence_sha=case when terminal then acknowledged_fence_sha else p_observed_fence_sha end
    where id=epoch.id;
  -- Preserve the established PR relation as display/history metadata. The
  -- canonical state/epoch is authoritative; generic legacy writers are fenced.
  insert into public.session_pull_requests(session_id,workspace_id,github_repository_id,branch_name,pull_request_number,
    pull_request_url,pull_request_state,is_draft,github_updated_at)
  values(operation.session_id,operation.workspace_id,epoch.repository_id,epoch.branch_name,p_pr_number,p_pr_url,p_pr_state,p_is_draft,p_pr_updated_at)
  on conflict(workspace_id,branch_name) do update set pull_request_number=excluded.pull_request_number,
    pull_request_url=excluded.pull_request_url,pull_request_state=excluded.pull_request_state,is_draft=excluded.is_draft,
    github_updated_at=greatest(session_pull_requests.github_updated_at,excluded.github_updated_at)
    where session_pull_requests.session_id=excluded.session_id
      and session_pull_requests.github_repository_id is not distinct from excluded.github_repository_id;
  if not found then raise exception 'Canonical PR metadata belongs to another session.' using errcode='23514'; end if;
  update public.session_pr_operations set status=case when terminal then 'terminal' else 'succeeded' end,
    receipt_head_sha=p_observed_head_sha,receipt_fence_sha=p_observed_fence_sha,receipt_pr_number=p_pr_number,
    receipt_pr_head_sha=p_pr_head_sha,receipt_pr_state=p_pr_state,receipt_observation_id=p_observation_id,receipted_at=clock_timestamp()
    where id=operation.id;
  update public.session_pr_sync set observed_head_sha=p_observed_head_sha,observed_fence_sha=p_observed_fence_sha,
    observed_pr_head_sha=p_pr_head_sha,
    status=case when terminal then 'successor_required'
      when p_pr_head_sha<>operation.desired_sha then 'conflict'
      when target_generation=operation.target_generation and desired_checkpoint_run_id=operation.checkpoint_run_id then 'synced'
      else 'pending' end,
    last_error_code=case when terminal then 'successor_required' when p_pr_head_sha<>operation.desired_sha then 'pr_head_mismatch' else null end,
    next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where session_id=operation.session_id;
  if clock_timestamp()>=operation.lease_expires_at then
    raise exception 'Canonical PR operation lease expired before receipt.' using errcode='57014';
  end if;
  return true;
end;
$$;

create function internal.fail_session_pr_sync(
  p_operation_id uuid,p_claim_id uuid,p_error_code text,p_is_conflict boolean default false,p_retry_creation_safe boolean default false
) returns boolean language plpgsql security definer set search_path='' as $$
declare operation public.session_pr_operations;
begin
  operation:=internal.lock_session_pr_operation(p_operation_id);
  if operation.id is null or operation.status<>'claimed' or operation.claim_id is distinct from p_claim_id
    or p_claim_id is null or operation.lease_expires_at<=clock_timestamp()
    or not internal.assert_session_pr_sync_claim(p_operation_id,p_claim_id) then return false; end if;
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'A safe canonical PR error code is required.' using errcode='22023';
  end if;
  if p_retry_creation_safe and p_error_code='pr_creation_rejected' then
    update public.session_pr_epochs set create_attempted=false where id=operation.epoch_id and pr_number is null and pr_state is null;
  end if;
  update public.session_pr_operations set status=case when p_is_conflict then 'conflict' else 'pending' end,
    claim_id=null,lease_expires_at=null,last_error_code=p_error_code,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,5*power(2,least(attempt_count,6)))::integer)
    where id=operation.id;
  update public.session_pr_sync set status=case when p_is_conflict then 'conflict' else 'error' end,last_error_code=p_error_code,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,5*power(2,least(operation.attempt_count,6)))::integer),
    updated_at=clock_timestamp() where session_id=operation.session_id;
  return true;
end;
$$;

create function internal.begin_session_pr_observation(p_workspace_id uuid,p_repository_id uuid,p_branch_name text,p_pr_number integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare identity record; epoch public.session_pr_epochs; observation uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  select id,session_id into identity from public.session_pr_epochs where workspace_id=p_workspace_id and repository_id=p_repository_id
    and branch_name=p_branch_name and pr_number=p_pr_number;
  if not found then return null; end if;
  perform 1 from public.sessions where id=identity.session_id for no key update;
  if not found then return null; end if;
  perform 1 from public.session_pr_sync where session_id=identity.session_id for update;
  select * into epoch from public.session_pr_epochs where id=identity.id for update;
  if epoch.pr_number is distinct from p_pr_number or epoch.repository_id is distinct from p_repository_id then return null; end if;
  observation:=pg_catalog.gen_random_uuid();
  update public.session_pr_epochs set observation_id=observation where id=epoch.id;
  update public.session_pr_sync set status=case when epoch.pr_state in ('closed','merged') then 'successor_required' else 'pending' end,
    updated_at=clock_timestamp() where session_id=epoch.session_id and current_epoch_id=epoch.id;
  return observation;
end;
$$;

create function internal.finish_session_pr_observation(
  p_observation_id uuid,p_pr_url text,p_pr_state text,p_is_draft boolean,p_pr_head_sha text,p_pr_updated_at timestamptz
) returns boolean language plpgsql security definer set search_path='' as $$
declare identity record; epoch public.session_pr_epochs;
begin
  perform internal.assert_checkpoint_publication_service();
  select id,session_id into identity from public.session_pr_epochs where observation_id=p_observation_id;
  if not found or p_observation_id is null then return false; end if;
  perform 1 from public.sessions where id=identity.session_id for no key update;
  if not found then return false; end if;
  perform 1 from public.session_pr_sync where session_id=identity.session_id for update;
  select * into epoch from public.session_pr_epochs where id=identity.id for update;
  if epoch.observation_id is distinct from p_observation_id then return false; end if;
  if p_pr_url is distinct from epoch.pr_url or p_pr_state is null or p_pr_state not in ('open','closed','merged')
    or p_is_draft is null or p_pr_updated_at is null or not isfinite(p_pr_updated_at)
    or (p_pr_head_sha is not null and p_pr_head_sha !~ '^[a-f0-9]{40}$')
    or (p_pr_state='open' and p_pr_head_sha is null) then
    raise exception 'Invalid canonical PR snapshot.' using errcode='22023';
  end if;
  if p_pr_updated_at<epoch.pr_updated_at or (epoch.pr_state='merged' and p_pr_state<>'merged')
    or (epoch.pr_state='closed' and p_pr_state='open') then return false; end if;
  update public.session_pr_epochs set pr_state=p_pr_state,is_draft=p_is_draft,pr_updated_at=p_pr_updated_at,
    pr_head_sha=p_pr_head_sha,observation_id=null where id=epoch.id;
  update public.session_pull_requests set pull_request_state=p_pr_state,is_draft=p_is_draft,github_updated_at=p_pr_updated_at
    where session_id=epoch.session_id and workspace_id=epoch.workspace_id and branch_name=epoch.branch_name
      and pull_request_number=epoch.pr_number;
  update public.session_pr_sync set observed_pr_head_sha=p_pr_head_sha,
    status=case when p_pr_state in ('closed','merged') then 'successor_required' else 'pending' end,
    last_error_code=case when p_pr_state in ('closed','merged') then 'successor_required' else 'pr_observation_changed' end,
    next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
    where session_id=epoch.session_id and current_epoch_id=epoch.id;
  if p_pr_state in ('closed','merged') then
    -- Session and epoch locks precede operation locks, including webhook paths.
    perform 1 from public.session_pr_operations where epoch_id=epoch.id and status in ('pending','claimed') order by id for update;
    update public.session_pr_operations set status='terminal',claim_id=null,lease_expires_at=null,last_error_code='successor_required'
      where epoch_id=epoch.id and status in ('pending','claimed');
  end if;
  return true;
end;
$$;

create function internal.authorize_session_pr_successor(p_actor_user_id uuid,p_session_id uuid,p_expected_epoch_id uuid,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare session public.sessions; sync public.session_pr_sync; epoch public.session_pr_epochs;
  request internal.session_pr_successor_requests; owner_workspace uuid; next_epoch uuid; number integer; selected record;
begin
  perform internal.assert_checkpoint_publication_service();
  select workspace_id into owner_workspace from public.sessions where id=p_session_id;
  if not found or p_request_id is null or p_actor_user_id is null then return null; end if;
  perform 1 from public.workspaces where id=owner_workspace and deletion_requested_at is null for share;
  if not found then return null; end if;
  select * into session from public.sessions where id=p_session_id for no key update;
  if not found or session.workspace_id is distinct from owner_workspace then return null; end if;
  if not exists(select 1 from public.workspace_members m where m.workspace_id=session.workspace_id
    and m.user_id=p_actor_user_id and m.kind='human' and m.is_active) then
    raise exception 'Active human membership is required for a PR successor.' using errcode='42501';
  end if;
  select * into request from internal.session_pr_successor_requests
    where workspace_id=session.workspace_id and actor_user_id=p_actor_user_id and request_id=p_request_id;
  if found then
    if request.session_id is distinct from p_session_id or request.expected_epoch_id is distinct from p_expected_epoch_id then
      raise exception 'PR successor request was reused with different content.' using errcode='23505';
    end if;
    return request.successor_epoch_id;
  end if;
  select * into sync from public.session_pr_sync where session_id=session.id for update;
  if not found or sync.current_epoch_id is distinct from p_expected_epoch_id
    or not internal.session_pr_is_eligible(session.id,session.workspace_id) then return null; end if;
  select * into epoch from public.session_pr_epochs where id=p_expected_epoch_id for update;
  if epoch.pr_state is null or epoch.pr_state not in ('closed','merged') then
    raise exception 'Only a closed or merged canonical PR can authorize a successor.' using errcode='55000';
  end if;
  select * into selected from internal.checkpoint_execution_input(sync.desired_checkpoint_run_id,session.id,session.workspace_id);
  if selected.input_ref is null then raise exception 'A successor requires accepted code.' using errcode='55000'; end if;
  if epoch.repository_id is null or epoch.repository_id<>selected.repository_id or epoch.repository_full_name<>selected.repository_full_name then
    raise exception 'Canonical PR repository connection is unavailable.' using errcode='55000';
  end if;
  select coalesce(max(epoch_number),0)+1 into number from public.session_pr_epochs where session_id=session.id;
  next_epoch:=pg_catalog.gen_random_uuid();
  insert into public.session_pr_epochs(id,session_id,workspace_id,epoch_number,repository_id,github_repository_id,repository_full_name,
    base_branch,branch_name,fence_branch)
  values(next_epoch,session.id,session.workspace_id,number,epoch.repository_id,epoch.github_repository_id,epoch.repository_full_name,
    epoch.base_branch,'wallie/sessions/'||session.id::text||'/'||next_epoch::text,
    'wallie/session-fences/'||next_epoch::text) returning id into next_epoch;
  insert into internal.session_pr_successor_requests(workspace_id,actor_user_id,request_id,session_id,expected_epoch_id,successor_epoch_id)
  values(session.workspace_id,p_actor_user_id,p_request_id,session.id,p_expected_epoch_id,next_epoch);
  update public.session_pr_sync set current_epoch_id=next_epoch,status='pending',observed_head_sha=null,observed_fence_sha=null,
    observed_pr_head_sha=null,last_error_code=null,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where session_id=session.id;
  return next_epoch;
end;
$$;

create function public.claim_session_pr_sync(p_session_id uuid default null) returns uuid
language sql security invoker set search_path='' as $$select internal.claim_session_pr_sync(p_session_id);$$;
revoke all on function internal.claim_session_pr_sync(uuid),public.claim_session_pr_sync(uuid) from public,anon,authenticated;
grant execute on function internal.claim_session_pr_sync(uuid),public.claim_session_pr_sync(uuid) to service_role;

create function public.assert_session_pr_sync_claim(p_operation_id uuid,p_claim_id uuid) returns boolean
language sql security invoker set search_path='' as $$select internal.assert_session_pr_sync_claim(p_operation_id,p_claim_id);$$;
revoke all on function internal.assert_session_pr_sync_claim(uuid,uuid),public.assert_session_pr_sync_claim(uuid,uuid) from public,anon,authenticated;
grant execute on function internal.assert_session_pr_sync_claim(uuid,uuid),public.assert_session_pr_sync_claim(uuid,uuid) to service_role;

create function public.arm_session_pr_creation(p_epoch_id uuid,p_operation_id uuid,p_claim_id uuid) returns boolean
language sql security invoker set search_path='' as $$select internal.arm_session_pr_creation(p_epoch_id,p_operation_id,p_claim_id);$$;
revoke all on function internal.arm_session_pr_creation(uuid,uuid,uuid),public.arm_session_pr_creation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function internal.arm_session_pr_creation(uuid,uuid,uuid),public.arm_session_pr_creation(uuid,uuid,uuid) to service_role;

create function public.finish_session_pr_sync(p_operation_id uuid,p_claim_id uuid,p_observed_head_sha text,p_observed_fence_sha text,p_pr_number integer,p_pr_url text,p_pr_state text,p_is_draft boolean,p_pr_head_sha text,p_pr_updated_at timestamptz,p_observation_id uuid default null) returns boolean
language sql security invoker set search_path='' as $$select internal.finish_session_pr_sync(p_operation_id,p_claim_id,p_observed_head_sha,p_observed_fence_sha,p_pr_number,p_pr_url,p_pr_state,p_is_draft,p_pr_head_sha,p_pr_updated_at,p_observation_id);$$;
revoke all on function internal.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid),public.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function internal.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid),public.finish_session_pr_sync(uuid,uuid,text,text,integer,text,text,boolean,text,timestamptz,uuid) to service_role;

create function public.fail_session_pr_sync(p_operation_id uuid,p_claim_id uuid,p_error_code text,p_is_conflict boolean default false,p_retry_creation_safe boolean default false) returns boolean
language sql security invoker set search_path='' as $$select internal.fail_session_pr_sync(p_operation_id,p_claim_id,p_error_code,p_is_conflict,p_retry_creation_safe);$$;
revoke all on function internal.fail_session_pr_sync(uuid,uuid,text,boolean,boolean),public.fail_session_pr_sync(uuid,uuid,text,boolean,boolean) from public,anon,authenticated;
grant execute on function internal.fail_session_pr_sync(uuid,uuid,text,boolean,boolean),public.fail_session_pr_sync(uuid,uuid,text,boolean,boolean) to service_role;

create function public.begin_session_pr_observation(p_workspace_id uuid,p_repository_id uuid,p_branch_name text,p_pr_number integer) returns uuid
language sql security invoker set search_path='' as $$select internal.begin_session_pr_observation(p_workspace_id,p_repository_id,p_branch_name,p_pr_number);$$;
revoke all on function internal.begin_session_pr_observation(uuid,uuid,text,integer),public.begin_session_pr_observation(uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function internal.begin_session_pr_observation(uuid,uuid,text,integer),public.begin_session_pr_observation(uuid,uuid,text,integer) to service_role;

create function public.finish_session_pr_observation(p_observation_id uuid,p_pr_url text,p_pr_state text,p_is_draft boolean,p_pr_head_sha text,p_pr_updated_at timestamptz) returns boolean
language sql security invoker set search_path='' as $$select internal.finish_session_pr_observation(p_observation_id,p_pr_url,p_pr_state,p_is_draft,p_pr_head_sha,p_pr_updated_at);$$;
revoke all on function internal.finish_session_pr_observation(uuid,text,text,boolean,text,timestamptz),public.finish_session_pr_observation(uuid,text,text,boolean,text,timestamptz) from public,anon,authenticated;
grant execute on function internal.finish_session_pr_observation(uuid,text,text,boolean,text,timestamptz),public.finish_session_pr_observation(uuid,text,text,boolean,text,timestamptz) to service_role;

create function public.authorize_session_pr_successor(p_actor_user_id uuid,p_session_id uuid,p_expected_epoch_id uuid,p_request_id uuid) returns uuid
language sql security invoker set search_path='' as $$select internal.authorize_session_pr_successor(p_actor_user_id,p_session_id,p_expected_epoch_id,p_request_id);$$;
revoke all on function internal.authorize_session_pr_successor(uuid,uuid,uuid,uuid),public.authorize_session_pr_successor(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function internal.authorize_session_pr_successor(uuid,uuid,uuid,uuid),public.authorize_session_pr_successor(uuid,uuid,uuid,uuid) to service_role;

revoke all on function internal.session_pr_is_eligible(uuid,uuid),internal.lock_session_pr_operation(uuid) from public,anon,authenticated;
grant execute on function internal.session_pr_is_eligible(uuid,uuid),internal.lock_session_pr_operation(uuid) to service_role;

-- A managed session never creates another per-attempt PR. Historical source
-- bytes/actual refs remain intact, and current legacy leases must quiesce.
create or replace function internal.source_delivery_is_eligible(delivery public.session_source_deliveries)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.agent_runs r
    join public.agent_jobs j on j.id=delivery.job_id
    join public.sessions s on s.id=delivery.session_id
    join public.workspaces w on w.id=delivery.workspace_id
    where r.id=delivery.run_id and r.status='success' and r.agent_job_id=j.id
      and r.attempt_count=delivery.attempt_count and j.attempt_count=delivery.attempt_count
      and r.workspace_id=w.id and j.workspace_id=w.id and s.workspace_id=w.id
      and r.session_id=s.id and j.session_id=s.id and j.status in ('started','running','success')
      and (s.archived_at is null or (s.phase_status='approved' and j.status='success'))
      and w.deletion_requested_at is null and delivery.repository_id is not null
      and not exists(select 1 from public.session_pr_sync managed where managed.session_id=s.id and managed.workspace_id=w.id));
$$;

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
    or exists(select 1 from storage.objects where bucket_id in ('workspace-avatars','session-attachments','session-source-checkpoints')
      and split_part(name,'/',1)=p_workspace_id::text) then return false; end if;
  delete from public.workspaces where id=p_workspace_id;
  return true;
end;
$$;


create or replace function public.record_session_pull_request(
  target_session_id uuid, target_workspace_id uuid, target_repository_id uuid,
  target_branch_name text, source_pull_request_number integer,
  source_pull_request_url text, source_pull_request_state text,
  source_is_draft boolean, source_updated_at timestamptz
) returns public.session_pull_requests
language plpgsql security definer set search_path = '' as $$
declare
  link public.session_pull_requests%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(source_pull_request_url, '') is null
    or nullif(target_branch_name, '') is null then
    raise exception 'Invalid GitHub pull request snapshot' using errcode = '22023';
  end if;
  if not exists (select 1 from public.sessions session
    join public.github_repositories repository on repository.id = target_repository_id
      and repository.workspace_id = session.workspace_id
    where session.id = target_session_id and session.workspace_id = target_workspace_id
      and (session.github_repository_id is null or session.github_repository_id = target_repository_id)) then
    raise exception 'Pull request repository must match its session' using errcode = '23514';
  end if;

  if exists(select 1 from public.session_pr_sync where session_id=target_session_id and workspace_id=target_workspace_id) then
    raise exception 'Managed session PR metadata requires the canonical publisher.' using errcode='23514';
  end if;
  insert into public.session_pull_requests (
    session_id, workspace_id, github_repository_id, branch_name, pull_request_number,
    pull_request_url, pull_request_state, is_draft, github_updated_at
  ) values (
    target_session_id, target_workspace_id, target_repository_id, target_branch_name,
    source_pull_request_number, source_pull_request_url, source_pull_request_state,
    source_is_draft, source_updated_at
  ) on conflict (workspace_id, branch_name) do nothing returning * into link;
  if found then return link; end if;

  select * into link from public.session_pull_requests
  where workspace_id = target_workspace_id and branch_name = target_branch_name for update;
  if not found then
    raise exception 'Pull request link changed concurrently; retry' using errcode = '40001';
  end if;
  if link.session_id <> target_session_id
    or (link.github_repository_id is not null and link.github_repository_id <> target_repository_id) then
    raise exception 'Pull request branch belongs to another session or repository' using errcode = '23514';
  end if;

  if link.github_repository_id is null or link.pull_request_number is null
    or source_pull_request_number > link.pull_request_number
    or (source_pull_request_number = link.pull_request_number
      and internal.github_pull_request_is_fresh(link.pull_request_state,
        link.github_updated_at, source_pull_request_state, source_updated_at)) then
    update public.session_pull_requests set
      github_repository_id = target_repository_id,
      pull_request_number = source_pull_request_number,
      pull_request_url = source_pull_request_url,
      pull_request_state = source_pull_request_state,
      is_draft = source_is_draft,
      github_updated_at = source_updated_at
    where id = link.id returning * into link;
  end if;
  return link;
end;
$$;


create or replace function public.apply_github_pull_request_event(
  target_workspace_id uuid, target_repository_id uuid, target_branch_name text,
  source_pull_request_number integer, source_pull_request_url text,
  source_pull_request_state text, source_is_draft boolean, source_updated_at timestamptz,
  source_head_repository_matches boolean default false
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  onboarding public.repository_onboarding_status%rowtype;
  affected integer;
  has_conflicts boolean;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(source_pull_request_url, '') is null
    or nullif(target_branch_name, '') is null then
    raise exception 'Invalid GitHub pull request snapshot' using errcode = '22023';
  end if;
  if not exists (select 1 from public.github_repositories
    where id = target_repository_id and workspace_id = target_workspace_id) then
    return false;
  end if;

  select * into onboarding from public.repository_onboarding_status
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and setup_branch_name = target_branch_name and setup_pr_number = source_pull_request_number
  for update;
  if found then
    if internal.github_pull_request_is_fresh(onboarding.setup_pr_state,
      onboarding.setup_pr_updated_at, source_pull_request_state, source_updated_at) then
      has_conflicts := onboarding.status = 'conflict'
        or case when jsonb_typeof(onboarding.conflict_report) = 'array'
          then jsonb_array_length(onboarding.conflict_report) > 0 else false end;
      update public.repository_onboarding_status set
        setup_pr_url = source_pull_request_url,
        setup_pr_updated_at = source_updated_at,
        setup_pr_state = source_pull_request_state,
        conflict_report = case when source_pull_request_state = 'merged' and not has_conflicts
          then '[]'::jsonb else onboarding.conflict_report end,
        status = case
          when source_pull_request_state = 'closed' then 'error'
          when has_conflicts then 'conflict'
          when source_pull_request_state = 'merged' then 'ready'
          else 'pr_open' end,
        last_error = case when source_pull_request_state = 'closed'
          then 'Setup PR was closed without merging.' else null end
      where id = onboarding.id;
    end if;
    return true;
  end if;

  if exists(select 1 from public.session_pr_epochs e where e.workspace_id=target_workspace_id
    and e.repository_id=target_repository_id and (e.branch_name=target_branch_name or e.pr_number=source_pull_request_number)) then
    return false;
  end if;
  -- Existing identities match by repository/number. A not-yet-linked branch is
  -- eligible only with positive repository evidence from the link or its session.
  update public.session_pull_requests link set
    github_repository_id = target_repository_id,
    pull_request_number = source_pull_request_number,
    pull_request_url = source_pull_request_url,
    pull_request_state = source_pull_request_state,
    is_draft = source_is_draft,
    github_updated_at = source_updated_at
  where link.workspace_id = target_workspace_id
    and (link.github_repository_id = target_repository_id
      or (link.github_repository_id is null and link.pull_request_number is null and exists (
        select 1 from public.sessions session where session.id = link.session_id
          and session.workspace_id = target_workspace_id
          and session.github_repository_id = target_repository_id)))
    and (link.pull_request_number = source_pull_request_number
      or (link.pull_request_number is null and source_head_repository_matches
        and link.branch_name = target_branch_name))
    and internal.github_pull_request_is_fresh(link.pull_request_state,
      link.github_updated_at, source_pull_request_state, source_updated_at);
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;


create or replace function public.begin_github_pull_request_observation(
  target_workspace_id uuid, target_repository_id uuid, target_branch_name text,
  source_pull_request_number integer, source_pull_request_state text,
  source_is_draft boolean, source_updated_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  onboarding public.repository_onboarding_status%rowtype;
  observation uuid := gen_random_uuid();
  affected integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(target_branch_name, '') is null then
    raise exception 'Invalid GitHub pull request snapshot' using errcode = '22023';
  end if;

  select * into onboarding from public.repository_onboarding_status
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and setup_branch_name = target_branch_name and setup_pr_number = source_pull_request_number
  for update;
  if found then
    if onboarding.setup_pr_state is distinct from 'merged'
      and onboarding.setup_pr_updated_at = source_updated_at
      and (onboarding.setup_pr_state is distinct from source_pull_request_state
        or onboarding.setup_pr_observation_token is not null) then
      update public.repository_onboarding_status set setup_pr_observation_token = observation
      where id = onboarding.id;
      return observation;
    end if;
    return null;
  end if;

  if exists(select 1 from public.session_pr_epochs e where e.workspace_id=target_workspace_id
    and e.repository_id=target_repository_id and (e.branch_name=target_branch_name or e.pr_number=source_pull_request_number)) then
    return null;
  end if;
  update public.session_pull_requests set github_observation_token = observation
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and pull_request_number = source_pull_request_number
    and pull_request_state is distinct from 'merged' and github_updated_at = source_updated_at
    and (pull_request_state is distinct from source_pull_request_state
      or is_draft is distinct from source_is_draft or github_observation_token is not null);
  get diagnostics affected = row_count;
  return case when affected > 0 then observation else null end;
end;
$$;


create or replace function public.finish_github_pull_request_observation(
  target_workspace_id uuid, target_repository_id uuid, target_branch_name text,
  source_pull_request_number integer, source_pull_request_url text,
  source_pull_request_state text, source_is_draft boolean, source_updated_at timestamptz,
  observation_token uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  onboarding public.repository_onboarding_status%rowtype;
  has_conflicts boolean;
  affected integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required' using errcode = '42501';
  end if;
  if source_updated_at is null or not isfinite(source_updated_at)
    or source_pull_request_number is null or source_pull_request_number <= 0
    or source_pull_request_state is null or source_pull_request_state not in ('open', 'closed', 'merged')
    or source_is_draft is null or nullif(source_pull_request_url, '') is null
    or nullif(target_branch_name, '') is null or observation_token is null then
    raise exception 'Invalid GitHub pull request observation' using errcode = '22023';
  end if;

  select * into onboarding from public.repository_onboarding_status
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and setup_branch_name = target_branch_name and setup_pr_number = source_pull_request_number
  for update;
  if found then
    if onboarding.setup_pr_observation_token is distinct from observation_token
      or source_updated_at < onboarding.setup_pr_updated_at
      or (onboarding.setup_pr_state = 'merged' and source_pull_request_state <> 'merged') then
      return false;
    end if;
    has_conflicts := onboarding.status = 'conflict'
      or case when jsonb_typeof(onboarding.conflict_report) = 'array'
        then jsonb_array_length(onboarding.conflict_report) > 0 else false end;
    update public.repository_onboarding_status set
      setup_pr_url = source_pull_request_url,
      setup_pr_updated_at = source_updated_at,
      setup_pr_state = source_pull_request_state,
      setup_pr_observation_token = null,
      conflict_report = case when source_pull_request_state = 'merged' and not has_conflicts
        then '[]'::jsonb else onboarding.conflict_report end,
      status = case
        when source_pull_request_state = 'closed' then 'error'
        when has_conflicts then 'conflict'
        when source_pull_request_state = 'merged' then 'ready'
        else 'pr_open' end,
      last_error = case when source_pull_request_state = 'closed'
        then 'Setup PR was closed without merging.' else null end
    where id = onboarding.id;
    return true;
  end if;

  if exists(select 1 from public.session_pr_epochs e where e.workspace_id=target_workspace_id
    and e.repository_id=target_repository_id and (e.branch_name=target_branch_name or e.pr_number=source_pull_request_number)) then
    return false;
  end if;
  update public.session_pull_requests set
    pull_request_url = source_pull_request_url,
    pull_request_state = source_pull_request_state,
    is_draft = source_is_draft,
    github_updated_at = source_updated_at,
    github_observation_token = null
  where workspace_id = target_workspace_id and github_repository_id = target_repository_id
    and pull_request_number = source_pull_request_number
    and github_observation_token = observation_token
    and source_updated_at >= github_updated_at
    and (pull_request_state is distinct from 'merged' or source_pull_request_state = 'merged');
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;


-- Publisher and webhook final reads use the same causal admission token. Pin
-- identity before the GET so a racing webhook can invalidate that publisher.
create function internal.begin_session_pr_sync_observation(
  p_operation_id uuid,p_claim_id uuid,p_pr_number integer,p_pr_url text
) returns uuid language plpgsql security definer set search_path='' as $$
declare operation public.session_pr_operations; epoch public.session_pr_epochs; observation uuid;
begin
  operation:=internal.lock_session_pr_operation(p_operation_id);
  if operation.id is null or not internal.assert_session_pr_sync_claim(p_operation_id,p_claim_id) then return null; end if;
  select * into epoch from public.session_pr_epochs where id=operation.epoch_id;
  if p_pr_number is null or p_pr_number<=0 or p_pr_url is null
    or lower(p_pr_url)<>lower('https://github.com/'||epoch.repository_full_name||'/pull/'||p_pr_number::text) then
    raise exception 'Invalid canonical PR snapshot.' using errcode='22023';
  end if;
  if epoch.pr_number is not null and (epoch.pr_number<>p_pr_number or epoch.pr_url<>p_pr_url) then
    raise exception 'Canonical PR identity does not match the pinned epoch.' using errcode='23514';
  end if;
  observation:=pg_catalog.gen_random_uuid();
  update public.session_pr_epochs set pr_number=p_pr_number,pr_url=p_pr_url,observation_id=observation where id=epoch.id;
  update public.session_pr_sync set status='pending',updated_at=clock_timestamp() where session_id=operation.session_id;
  return observation;
end;
$$;
create function public.begin_session_pr_sync_observation(
  p_operation_id uuid,p_claim_id uuid,p_pr_number integer,p_pr_url text
) returns uuid language sql security invoker set search_path='' as $$
  select internal.begin_session_pr_sync_observation(p_operation_id,p_claim_id,p_pr_number,p_pr_url);
$$;
revoke all on function internal.begin_session_pr_sync_observation(uuid,uuid,integer,text),
  public.begin_session_pr_sync_observation(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function internal.begin_session_pr_sync_observation(uuid,uuid,integer,text),
  public.begin_session_pr_sync_observation(uuid,uuid,integer,text) to service_role;
