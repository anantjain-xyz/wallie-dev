-- The workspace and its credentials are the durable cleanup obligation. They
-- remain present until external cleanup has succeeded and this fence is final.
alter table public.workspaces add column deletion_requested_at timestamptz;
create index workspaces_pending_deletion_idx on public.workspaces(deletion_requested_at, id)
  where deletion_requested_at is not null;

create table public.workspace_resource_operations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('sandbox', 'upload')),
  provider text check (provider in ('vercel', 'e2b', 'daytona', 'fake')),
  connection_revision uuid,
  resource_id text,
  storage_bucket text check (storage_bucket in ('workspace-avatars', 'session-attachments')),
  recovery_after timestamptz not null,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'sandbox' and provider is not null and storage_bucket is null)
    or (kind = 'upload' and provider is null and storage_bucket is not null and resource_id is not null))
);
create index workspace_resource_operations_workspace_idx on public.workspace_resource_operations(workspace_id);
alter table public.workspace_resource_operations enable row level security;
revoke all on public.workspace_resource_operations from public, anon, authenticated;
grant all on public.workspace_resource_operations to service_role;

create function internal.assert_workspace_accepts_work(target_workspace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare deleting_at timestamptz;
begin
  if target_workspace_id is null then return; end if;
  -- SHARE conflicts with the deletion update. Admission and fencing cannot
  -- both commit based on an earlier unlocked read of the workspace.
  select deletion_requested_at into deleting_at from public.workspaces
  where id = target_workspace_id for share;
  if not found then raise exception 'Workspace not found.' using errcode = '23503'; end if;
  if deleting_at is not null then
    raise exception 'Workspace deletion is in progress.' using errcode = 'P0010';
  end if;
end;
$$;
revoke all on function internal.assert_workspace_accepts_work(uuid) from public, anon, authenticated;

create function internal.guard_workspace_work_admission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_workspace_accepts_work(new.workspace_id);
  return new;
end;
$$;
revoke all on function internal.guard_workspace_work_admission() from public, anon, authenticated;

create trigger sessions_workspace_admission before insert on public.sessions
  for each row execute function internal.guard_workspace_work_admission();
create trigger sessions_workspace_generation_admission before update of phase_status on public.sessions
  for each row when (new.phase_status = 'in_progress') execute function internal.guard_workspace_work_admission();
create trigger agent_jobs_workspace_admission before insert or update of status on public.agent_jobs
  for each row when (new.status in ('queued', 'started', 'running')) execute function internal.guard_workspace_work_admission();
create trigger agent_runs_workspace_admission before insert or update of status on public.agent_runs
  for each row when (new.status in ('queued', 'started', 'running')) execute function internal.guard_workspace_work_admission();
create trigger capability_checks_workspace_admission before insert or update of status on public.sandbox_capability_checks
  for each row when (new.status = 'running') execute function internal.guard_workspace_work_admission();
create trigger codex_auth_workspace_admission before insert or update of status on public.codex_device_auth_flows
  for each row when (new.status in ('starting', 'prompted')) execute function internal.guard_workspace_work_admission();
create trigger session_attachments_workspace_admission before insert on public.session_attachments
  for each row execute function internal.guard_workspace_work_admission();
create trigger sandbox_mutations_workspace_admission before insert on public.workspace_sandbox_connection_mutations
  for each row execute function internal.guard_workspace_work_admission();

-- A request admitted just before fencing may still be trying to rotate or
-- delete provider credentials. Preserve them for deletion cleanup. Cascades
-- after removal of the parent workspace are allowed.
create function internal.preserve_deleting_workspace_credentials()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  target := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  if tg_op = 'DELETE' and not exists(select 1 from public.workspaces where id = target) then return old; end if;
  -- The same workspace mutex serializes credential changes and acquisition
  -- reservations. No provider row lock is taken by reservation admission.
  perform 1 from public.workspaces where id=target for update;
  perform internal.assert_workspace_accepts_work(target);
  if exists(select 1 from public.workspace_resource_operations
    where workspace_id=target and kind='sandbox') then
    raise exception 'Sandbox acquisition cleanup is still pending.' using errcode='P0010';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function internal.preserve_deleting_workspace_credentials() from public, anon, authenticated;
create trigger vercel_workspace_credential_fence before insert or update or delete on public.workspace_vercel_sandbox_connections
  for each row execute function internal.preserve_deleting_workspace_credentials();
create trigger e2b_workspace_credential_fence before insert or update or delete on public.workspace_e2b_sandbox_connections
  for each row execute function internal.preserve_deleting_workspace_credentials();
create trigger daytona_workspace_credential_fence before insert or update or delete on public.workspace_daytona_sandbox_connections
  for each row execute function internal.preserve_deleting_workspace_credentials();

-- Storage can finish a request after the web process has died. Its final
-- metadata write must honor the same fence even when it uses service_role.
create function internal.guard_workspace_storage_admission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.bucket_id in ('workspace-avatars', 'session-attachments') then
    perform internal.assert_workspace_accepts_work(split_part(new.name, '/', 1)::uuid);
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_workspace_storage_admission() from public, anon, authenticated;
create trigger workspace_storage_admission before insert or update on storage.objects
  for each row execute function internal.guard_workspace_storage_admission();

create function public.begin_workspace_resource_operation(
  p_workspace_id uuid, p_kind text, p_provider text, p_resource_id text,
  p_storage_bucket text, p_recovery_after timestamptz, p_connection_revision uuid default null
) returns uuid language plpgsql security invoker set search_path = '' as $$
declare operation_id uuid; current_revision uuid;
begin
  perform 1 from public.workspaces where id=p_workspace_id for update;
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  if p_recovery_after <= now() or p_recovery_after > now() + interval '3 hours' then
    raise exception 'Invalid resource recovery deadline.' using errcode = '22023';
  end if;
  if p_kind='sandbox' and p_provider<>'fake' then
    case p_provider
      when 'vercel' then select connection_revision into current_revision from public.workspace_vercel_sandbox_connections where workspace_id=p_workspace_id;
      when 'e2b' then select connection_revision into current_revision from public.workspace_e2b_sandbox_connections where workspace_id=p_workspace_id;
      when 'daytona' then select connection_revision into current_revision from public.workspace_daytona_sandbox_connections where workspace_id=p_workspace_id;
      else raise exception 'Invalid sandbox provider.' using errcode='22023';
    end case;
    if current_revision is null or current_revision is distinct from p_connection_revision then
      raise exception 'Sandbox connection changed. Refresh and try again.' using errcode='P0011';
    end if;
  end if;
  insert into public.workspace_resource_operations(workspace_id,kind,provider,connection_revision,resource_id,storage_bucket,recovery_after)
  values(p_workspace_id,p_kind,nullif(p_provider,''),p_connection_revision,nullif(p_resource_id,''),nullif(p_storage_bucket,''),p_recovery_after)
  returning id into operation_id;
  return operation_id;
end;
$$;

create function public.record_workspace_resource_operation(p_operation_id uuid, p_resource_id text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare target uuid; deleting_at timestamptz;
begin
  select workspace_id into target from public.workspace_resource_operations where id = p_operation_id;
  select deletion_requested_at into deleting_at from public.workspaces where id = target for share;
  if not found then return false; end if;
  update public.workspace_resource_operations set resource_id=p_resource_id
  where id=p_operation_id and (resource_id is null or resource_id=p_resource_id);
  return found and deleting_at is null;
end;
$$;

create function public.settle_workspace_resource_operation(p_operation_id uuid, p_transferred boolean)
returns void language plpgsql security invoker set search_path = '' as $$
declare target uuid; deleting_at timestamptz;
begin
  select workspace_id into target from public.workspace_resource_operations where id=p_operation_id;
  select deletion_requested_at into deleting_at from public.workspaces where id=target for share;
  if not found then return; end if;
  if p_transferred and deleting_at is null then
    delete from public.workspace_resource_operations where id=p_operation_id;
  else
    update public.workspace_resource_operations set settled_at=now() where id=p_operation_id;
  end if;
end;
$$;

create function public.begin_workspace_deletion(p_workspace_id uuid, p_owner_member_id uuid, p_confirmation text)
returns timestamptz language plpgsql security invoker set search_path = '' as $$
declare target public.workspaces%rowtype;
begin
  select * into target from public.workspaces where id=p_workspace_id for update;
  if not found then return null; end if;
  if not exists(select 1 from public.workspace_members where id=p_owner_member_id and workspace_id=p_workspace_id
    and kind='human' and role='owner' and is_active) then
    raise exception 'Only the workspace owner can delete this workspace.' using errcode='42501';
  end if;
  if btrim(p_confirmation) <> target.name then
    raise exception 'Type the workspace name exactly to confirm deletion.' using errcode='22023';
  end if;
  update public.workspaces set deletion_requested_at=coalesce(deletion_requested_at,now())
  where id=p_workspace_id returning deletion_requested_at into target.deletion_requested_at;
  return target.deletion_requested_at;
end;
$$;

create function public.finish_workspace_deletion(p_workspace_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare target public.workspaces%rowtype;
begin
  select * into target from public.workspaces where id=p_workspace_id for update;
  if not found then return true; end if;
  if target.deletion_requested_at is null then return false; end if;
  if exists(select 1 from public.workspace_resource_operations where workspace_id=p_workspace_id)
    or exists(select 1 from public.workspace_sandbox_connection_mutations where workspace_id=p_workspace_id and expires_at>now())
    or exists(select 1 from public.agent_jobs where workspace_id=p_workspace_id and status in ('queued','started','running'))
    or exists(select 1 from public.agent_runs where workspace_id=p_workspace_id and status in ('queued','started','running'))
    or exists(select 1 from storage.objects where bucket_id in ('workspace-avatars','session-attachments')
      and split_part(name,'/',1)=p_workspace_id::text) then return false; end if;
  delete from public.workspaces where id=p_workspace_id;
  return true;
end;
$$;

revoke all on function public.begin_workspace_resource_operation(uuid,text,text,text,text,timestamptz,uuid) from public,anon,authenticated;
revoke all on function public.record_workspace_resource_operation(uuid,text) from public,anon,authenticated;
revoke all on function public.settle_workspace_resource_operation(uuid,boolean) from public,anon,authenticated;
revoke all on function public.begin_workspace_deletion(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.finish_workspace_deletion(uuid) from public,anon,authenticated;
grant execute on function public.begin_workspace_resource_operation(uuid,text,text,text,text,timestamptz,uuid) to service_role;
grant execute on function public.record_workspace_resource_operation(uuid,text) to service_role;
grant execute on function public.settle_workspace_resource_operation(uuid,boolean) to service_role;
grant execute on function public.begin_workspace_deletion(uuid,uuid,text) to service_role;
grant execute on function public.finish_workspace_deletion(uuid) to service_role;
grant execute on function internal.assert_workspace_accepts_work(uuid) to service_role;
