-- A retry checkpoint is private attempt work. Only the ordinary publication
-- path can create an accepted Git checkpoint, artifact, or PR operation.
create function internal.is_retry_checkpoint_path(p_path text,p_workspace_id uuid,p_run_id uuid,p_attempt_count integer)
returns boolean language sql immutable set search_path='' as $$
  select p_path ~ ('^'||p_workspace_id::text||'/'||p_run_id::text||'-retry-'||p_attempt_count::text||
    '-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}[.]bundle$');
$$;
revoke all on function internal.is_retry_checkpoint_path(text,uuid,uuid,integer) from public,anon,authenticated,service_role;

create table public.session_retry_checkpoints (
  source_run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_attempt_count integer not null check(source_attempt_count>0),
  rejection_count integer not null check(rejection_count>=0),
  input_sha text not null check(input_sha ~ '^[a-f0-9]{40}$'),
  head_sha text not null check(head_sha ~ '^[a-f0-9]{40}$' and head_sha<>input_sha),
  checkpoint_path text not null unique
    check(internal.is_retry_checkpoint_path(checkpoint_path,workspace_id,source_run_id,source_attempt_count)),
  bundle_sha256 text not null check(bundle_sha256 ~ '^[a-f0-9]{64}$')
);
create table public.session_retry_checkpoint_jobs (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_run_id uuid not null references public.session_retry_checkpoints(source_run_id) on delete cascade
);
create index session_retry_checkpoints_workspace_idx on public.session_retry_checkpoints(workspace_id);
create index session_retry_checkpoint_jobs_workspace_idx on public.session_retry_checkpoint_jobs(workspace_id);
create index session_retry_checkpoint_jobs_source_idx on public.session_retry_checkpoint_jobs(source_run_id);
alter table public.session_retry_checkpoints enable row level security;
alter table public.session_retry_checkpoint_jobs enable row level security;
revoke all on public.session_retry_checkpoints,public.session_retry_checkpoint_jobs from public,anon,authenticated,service_role;
grant select on public.session_retry_checkpoints,public.session_retry_checkpoint_jobs to service_role;

create function internal.guard_retry_checkpoint_workspace()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_table_name='session_retry_checkpoints' then
    if not exists(select 1 from public.agent_runs r where r.id=new.source_run_id
      and r.workspace_id=new.workspace_id and r.attempt_count=new.source_attempt_count) then
      raise exception 'Retry checkpoint does not match its source run workspace and attempt.' using errcode='23514';
    end if;
  elsif not exists(select 1 from public.agent_jobs j
    join public.session_retry_checkpoints c on c.source_run_id=new.source_run_id and c.workspace_id=j.workspace_id
    join public.agent_runs r on r.id=c.source_run_id and r.workspace_id=c.workspace_id
      and r.session_id=j.session_id and r.stage_id is not distinct from j.stage_id
    where j.id=new.job_id and j.workspace_id=new.workspace_id) then
    raise exception 'Retry checkpoint binding does not match its job workspace, session, and stage.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_retry_checkpoint_workspace() from public,anon,authenticated,service_role;
create trigger retry_checkpoint_workspace_guard before insert or update on public.session_retry_checkpoints
  for each row execute function internal.guard_retry_checkpoint_workspace();
create trigger retry_checkpoint_job_workspace_guard before insert or update on public.session_retry_checkpoint_jobs
  for each row execute function internal.guard_retry_checkpoint_workspace();

-- One reservation owns a retry path until cleanup or receipt transfer. A
-- replayed acquisition cannot register a durable receipt's file for cleanup.
create unique index workspace_resource_operations_retry_upload_path_idx
  on public.workspace_resource_operations(workspace_id,resource_id)
  where kind='upload' and storage_bucket='session-source-checkpoints'
    and split_part(resource_id,'/',2) like '%-retry-%.bundle';
create function internal.guard_retry_checkpoint_upload_path()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if split_part(new.resource_id,'/',1) is distinct from new.workspace_id::text then
    raise exception 'Retry checkpoint upload path does not match its workspace.' using errcode='23514';
  end if;
  if exists(select 1 from public.session_retry_checkpoints c where c.workspace_id=new.workspace_id
    and c.checkpoint_path=new.resource_id) then
    raise exception 'Retry checkpoint path is already retained.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_retry_checkpoint_upload_path() from public,anon,authenticated,service_role;
create trigger retry_checkpoint_upload_path_guard
  after insert or update of workspace_id,kind,storage_bucket,resource_id on public.workspace_resource_operations
  for each row when(new.kind='upload' and new.storage_bucket='session-source-checkpoints'
    and split_part(new.resource_id,'/',2) like '%-retry-%.bundle')
  execute function internal.guard_retry_checkpoint_upload_path();

create or replace function internal.guard_workspace_storage_admission()
returns trigger language plpgsql security definer set search_path='' as $$
declare owner_id uuid; upload public.workspace_resource_operations;
begin
  if new.bucket_id in ('workspace-avatars','session-attachments','session-source-checkpoints','session-validation-evidence') then
    owner_id:=split_part(new.name,'/',1)::uuid;
    perform internal.assert_workspace_accepts_work(owner_id);
  end if;
  if new.bucket_id='session-source-checkpoints' and split_part(new.name,'/',2) like '%-retry-%.bundle'
    and (tg_op='INSERT' or new.name is distinct from old.name or new.bucket_id is distinct from old.bucket_id
      or new.version is distinct from old.version) then
    -- Share the reservation row lock with transfer and orphan cleanup. An
    -- upload finishing after either owner has won cannot recreate the path.
    select * into upload from public.workspace_resource_operations op
    where op.workspace_id=owner_id and op.kind='upload' and op.storage_bucket=new.bucket_id
      and op.resource_id=new.name for update;
    if not found or upload.settled_at is not null or upload.recovery_after<=clock_timestamp() then
      raise exception 'Retry checkpoint upload reservation is not active.' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;

create function internal.save_session_retry_checkpoint(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_input_sha text,p_head_sha text,p_bundle_sha256 text,
  p_deadline_at timestamptz,p_upload_operation_id uuid,p_checkpoint_path text
) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.sessions; j public.agent_jobs; r public.agent_runs; deadline_at timestamptz;
  upload public.workspace_resource_operations; prior public.session_retry_checkpoints;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into j from public.agent_jobs where id=p_job_id;
  if not found then return false; end if;
  perform internal.assert_workspace_accepts_work(j.workspace_id);
  select * into s from public.sessions where id=j.session_id and workspace_id=j.workspace_id for no key update;
  if not found then return false; end if;
  select * into j from public.agent_jobs where id=p_job_id for update;
  if not found or j.session_id is distinct from s.id or j.workspace_id is distinct from s.workspace_id
    or j.attempt_count is distinct from p_attempt_count or j.status not in ('started','running')
    or s.archived_at is not null or s.phase_status<>'in_progress'
    or j.stage_id is distinct from s.current_stage_id then return false; end if;
  select * into r from public.agent_runs where id=p_run_id for update;
  if not found or r.agent_job_id is distinct from j.id or r.attempt_count is distinct from j.attempt_count
    or r.workspace_id is distinct from s.workspace_id or r.session_id is distinct from s.id
    or r.stage_id is distinct from j.stage_id or r.status<>'running' then return false; end if;
  deadline_at:=least(p_deadline_at,(select d.deadline_at from public.worker_dispatches d
    where d.job_id=j.id and d.attempt_count=j.attempt_count));
  if p_deadline_at is null or deadline_at<=clock_timestamp() then return false; end if;
  if p_input_sha is null or p_head_sha is null or p_bundle_sha256 is null
    or p_head_sha=p_input_sha or not exists(select 1 from public.session_job_git_inputs i
      where i.job_id=j.id and i.workspace_id=s.workspace_id and i.session_id=s.id
        and i.input_sha=p_input_sha and i.pinned_run_id is not null) then
    raise exception 'Retry checkpoint does not match the owned Git input.' using errcode='23514';
  end if;
  if not coalesce(internal.is_retry_checkpoint_path(p_checkpoint_path,s.workspace_id,r.id,j.attempt_count),false) then
    raise exception 'Retry checkpoint path does not match the owned attempt.' using errcode='23514';
  end if;
  select * into prior from public.session_retry_checkpoints where source_run_id=r.id;
  if found then
    return prior.workspace_id=s.workspace_id and prior.source_attempt_count=j.attempt_count
      and prior.rejection_count=s.rejection_count and prior.input_sha=p_input_sha and prior.head_sha=p_head_sha
      and prior.checkpoint_path=p_checkpoint_path and prior.bundle_sha256=p_bundle_sha256
      and exists(select 1 from storage.objects where bucket_id='session-source-checkpoints' and name=p_checkpoint_path);
  end if;
  select * into upload from public.workspace_resource_operations op
  where op.id=p_upload_operation_id and op.workspace_id=s.workspace_id and op.kind='upload'
    and op.storage_bucket='session-source-checkpoints' and op.resource_id=p_checkpoint_path for update;
  if not found or upload.settled_at is not null or upload.recovery_after<=clock_timestamp()
    or deadline_at<=clock_timestamp() then return false; end if;
  if not exists(select 1 from storage.objects where bucket_id='session-source-checkpoints' and name=p_checkpoint_path) then
    raise exception 'Retry checkpoint is not durable.' using errcode='23514';
  end if;
  insert into public.session_retry_checkpoints(source_run_id,workspace_id,source_attempt_count,rejection_count,input_sha,
    head_sha,checkpoint_path,bundle_sha256)
  values(r.id,s.workspace_id,j.attempt_count,s.rejection_count,p_input_sha,p_head_sha,p_checkpoint_path,p_bundle_sha256);
  delete from public.workspace_resource_operations where id=upload.id;
  return true;
end;
$$;

create function public.save_session_retry_checkpoint(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_input_sha text,p_head_sha text,p_bundle_sha256 text,
  p_deadline_at timestamptz,p_upload_operation_id uuid,p_checkpoint_path text
) returns boolean language sql security invoker set search_path='' as $$
  select internal.save_session_retry_checkpoint(p_job_id,p_attempt_count,p_run_id,p_input_sha,p_head_sha,
    p_bundle_sha256,p_deadline_at,p_upload_operation_id,p_checkpoint_path);
$$;

create function internal.enqueue_session_retry_with_checkpoint(
  p_session_id uuid,p_workspace_id uuid,p_expected_stage_id uuid,p_requested_by_member_id uuid,p_retry_run_id uuid,
  p_agent_model_provider text,p_agent_model_name text,p_run_type text
) returns table(job_id uuid,run_id uuid,created boolean) language plpgsql security definer set search_path='' as $$
declare queued record;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_requested_by_member_id is null or not exists(select 1 from public.agent_runs r where r.id=p_retry_run_id
    and r.workspace_id=p_workspace_id and r.session_id=p_session_id and r.status in ('success','error','canceled')) then
    raise exception 'Retry requires a workspace member and a terminal session run.' using errcode='42501';
  end if;
  select * into queued from public.enqueue_session_job_with_run(p_session_id,p_workspace_id,p_expected_stage_id,
    p_requested_by_member_id,'manual_retry',p_agent_model_provider,p_agent_model_name,p_run_type);
  if queued.created then
    -- Canonical enqueue holds the session lock and has selected the accepted
    -- input. A retry checkpoint supplements that input without replacing it.
    insert into public.session_retry_checkpoint_jobs(job_id,workspace_id,source_run_id)
    select target.job_id,target.workspace_id,c.source_run_id
    from public.session_job_git_inputs target
    join public.sessions s on s.id=target.session_id and s.workspace_id=target.workspace_id
    join public.agent_runs failed on failed.id=p_retry_run_id and failed.session_id=s.id and failed.workspace_id=s.workspace_id
    join public.agent_jobs prior on prior.id=failed.agent_job_id and prior.session_id=s.id and prior.workspace_id=s.workspace_id
    left join public.session_retry_checkpoints captured on captured.source_run_id=failed.id
      and captured.workspace_id=s.workspace_id and captured.source_attempt_count=failed.attempt_count
    left join public.session_retry_checkpoint_jobs inherited on inherited.job_id=prior.id and inherited.workspace_id=s.workspace_id
    join public.session_retry_checkpoints c on c.source_run_id=coalesce(captured.source_run_id,inherited.source_run_id)
      and c.workspace_id=s.workspace_id
    join public.agent_runs producer on producer.id=c.source_run_id and producer.session_id=s.id
      and producer.workspace_id=s.workspace_id and producer.stage_id=s.current_stage_id
      and producer.attempt_count=c.source_attempt_count
    join public.session_job_git_inputs source on source.job_id=producer.agent_job_id
      and source.session_id=s.id and source.workspace_id=s.workspace_id
    where target.job_id=queued.job_id and s.phase_status='rejected'
      and failed.stage_id=s.current_stage_id and prior.stage_id=s.current_stage_id
      and failed.status='error' and prior.status='error' and failed.attempt_count=prior.attempt_count
      and prior.last_error ~ '^Worker attempt exceeded its [0-9]+ms deadline\.$'
      and c.rejection_count=s.rejection_count and c.input_sha=source.input_sha and c.input_sha=target.input_sha
      and source.repository_id=target.repository_id and source.repository_full_name=target.repository_full_name
      and source.base_branch=target.base_branch and source.initial_base_sha=target.initial_base_sha
      and source.source_checkpoint_run_id is not distinct from target.source_checkpoint_run_id
      and source.input_ref is not distinct from target.input_ref;
  end if;
  return query select queued.job_id,queued.run_id,queued.created;
end;
$$;

create function public.enqueue_session_retry_with_checkpoint(
  p_session_id uuid,p_workspace_id uuid,p_expected_stage_id uuid,p_requested_by_member_id uuid,p_retry_run_id uuid,
  p_agent_model_provider text,p_agent_model_name text,p_run_type text
) returns table(job_id uuid,run_id uuid,created boolean) language sql security invoker set search_path='' as $$
  select * from internal.enqueue_session_retry_with_checkpoint(p_session_id,p_workspace_id,p_expected_stage_id,
    p_requested_by_member_id,p_retry_run_id,p_agent_model_provider,p_agent_model_name,p_run_type);
$$;

create function public.get_session_retry_checkpoint(p_job_id uuid,p_attempt_count integer,p_run_id uuid)
returns table(source_run_id uuid,source_attempt_count integer,input_sha text,head_sha text,checkpoint_path text,bundle_sha256 text)
language sql stable security invoker set search_path='' as $$
  select c.source_run_id,c.source_attempt_count,c.input_sha,c.head_sha,c.checkpoint_path,c.bundle_sha256
  from public.session_retry_checkpoint_jobs binding
  join public.session_retry_checkpoints c on c.source_run_id=binding.source_run_id and c.workspace_id=binding.workspace_id
  join public.agent_jobs j on j.id=binding.job_id and j.workspace_id=binding.workspace_id
  join public.sessions s on s.id=j.session_id and s.workspace_id=j.workspace_id and s.current_stage_id=j.stage_id
  join public.agent_runs r on r.id=p_run_id and r.agent_job_id=j.id and r.session_id=s.id
    and r.workspace_id=s.workspace_id and r.stage_id=j.stage_id and r.attempt_count=j.attempt_count
  where j.id=p_job_id and j.attempt_count=p_attempt_count and j.status in ('started','running')
    and j.trigger_type='manual_retry' and r.status='running' and s.phase_status='in_progress'
    and s.archived_at is null and s.rejection_count=c.rejection_count;
$$;

revoke all on function internal.save_session_retry_checkpoint(uuid,integer,uuid,text,text,text,timestamptz,uuid,text),
  public.save_session_retry_checkpoint(uuid,integer,uuid,text,text,text,timestamptz,uuid,text),
  internal.enqueue_session_retry_with_checkpoint(uuid,uuid,uuid,uuid,uuid,text,text,text),
  public.enqueue_session_retry_with_checkpoint(uuid,uuid,uuid,uuid,uuid,text,text,text),
  public.get_session_retry_checkpoint(uuid,integer,uuid) from public,anon,authenticated;
grant execute on function internal.save_session_retry_checkpoint(uuid,integer,uuid,text,text,text,timestamptz,uuid,text),
  public.save_session_retry_checkpoint(uuid,integer,uuid,text,text,text,timestamptz,uuid,text),
  internal.enqueue_session_retry_with_checkpoint(uuid,uuid,uuid,uuid,uuid,text,text,text),
  public.enqueue_session_retry_with_checkpoint(uuid,uuid,uuid,uuid,uuid,text,text,text),
  public.get_session_retry_checkpoint(uuid,integer,uuid) to service_role;
