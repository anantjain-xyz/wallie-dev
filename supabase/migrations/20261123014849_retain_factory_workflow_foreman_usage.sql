-- A private retry journal for measured usage when native settlement is unavailable.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('factory-workflow-usage-recovery', 'factory-workflow-usage-recovery', false, 8192, array['text/plain']);

create or replace function internal.guard_workspace_storage_admission()
returns trigger language plpgsql security definer set search_path='' as $$
declare owner_id uuid; upload public.workspace_resource_operations;
begin
  if new.bucket_id in ('workspace-avatars','session-attachments','session-source-checkpoints','session-validation-evidence',
    'factory-workflow-usage-recovery') then
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

create or replace function public.finish_workspace_deletion(p_workspace_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare target public.workspaces%rowtype;
begin
  select * into target from public.workspaces where id = p_workspace_id for update;
  if not found then return true; end if;
  if target.deletion_requested_at is null then return false; end if;
  if exists(select 1 from public.workspace_resource_operations where workspace_id = p_workspace_id)
    or exists(select 1 from public.workspace_sandbox_connection_mutations where workspace_id = p_workspace_id
      and expires_at > now())
    or exists(select 1 from public.agent_jobs where workspace_id = p_workspace_id
      and status in ('queued', 'started', 'running'))
    or exists(select 1 from public.agent_runs where workspace_id = p_workspace_id
      and status in ('queued', 'started', 'running'))
    or exists(select 1 from public.session_source_deliveries where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > now())
    or exists(select 1 from public.session_pr_operations where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > clock_timestamp())
    or exists(select 1 from public.session_checkpoint_cleanup where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > clock_timestamp())
    or exists(select 1 from storage.objects where bucket_id in (
      'workspace-avatars', 'session-attachments', 'session-source-checkpoints',
      'session-validation-evidence', 'workspace-run-exports', 'factory-workflow-usage-recovery'
    ) and split_part(name, '/', 1) = p_workspace_id::text) then
    return false;
  end if;
  delete from public.workspaces where id = p_workspace_id;
  return true;
end;
$$;
