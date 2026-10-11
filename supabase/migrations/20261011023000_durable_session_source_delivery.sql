-- Source publication has a durable checkpoint; GitHub delivery is retryable.
alter table public.agent_runs add column source_recovery_required boolean not null default false;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('session-source-checkpoints','session-source-checkpoints',false,4194304,array['application/octet-stream'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create table public.session_source_deliveries (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null,
  repository_id uuid references public.github_repositories(id) on delete set null,
  installation_id bigint not null,
  repository_full_name text not null,
  branch_name text not null,
  base_branch text not null,
  base_sha text not null check(base_sha ~ '^[a-f0-9]{40}$'),
  head_sha text not null check(head_sha ~ '^[a-f0-9]{40}$'),
  checkpoint_path text,
  bundle_sha256 text check(bundle_sha256 ~ '^[a-f0-9]{64}$'),
  -- A small private fallback keeps a Storage outage from losing source. It is
  -- never returned by browser APIs and is cleared after successful delivery.
  bundle_base64 text check(octet_length(bundle_base64) <= 5592408),
  title text not null check(length(title) <= 256),
  body text not null check(length(body) <= 60000),
  status text not null default 'pending' check(status in ('pending','claimed','delivered')),
  delivery_attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claim_id uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  check(base_sha=head_sha or (bundle_sha256 is not null and
    (checkpoint_path is not null or bundle_base64 is not null or status='delivered'))),
  check(checkpoint_path is null or checkpoint_path=workspace_id::text||'/'||run_id::text||'.bundle')
);
create index session_source_deliveries_ready_idx on public.session_source_deliveries(next_attempt_at,run_id)
  where status in ('pending','claimed');
create index session_source_deliveries_workspace_idx on public.session_source_deliveries(workspace_id);
create unique index session_source_deliveries_claim_idx on public.session_source_deliveries(claim_id) where claim_id is not null;
alter table public.session_source_deliveries enable row level security;
revoke all on public.session_source_deliveries from public,anon,authenticated;
grant all on public.session_source_deliveries to service_role;
create trigger source_delivery_workspace_admission before insert or update of status on public.session_source_deliveries
  for each row when(new.status in ('pending','claimed')) execute function internal.guard_workspace_work_admission();

alter table public.workspace_resource_operations drop constraint workspace_resource_operations_storage_bucket_check;
alter table public.workspace_resource_operations add constraint workspace_resource_operations_storage_bucket_check
  check(storage_bucket in ('workspace-avatars','session-attachments','session-source-checkpoints'));
create or replace function internal.guard_workspace_storage_admission()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.bucket_id in ('workspace-avatars','session-attachments','session-source-checkpoints') then
    perform internal.assert_workspace_accepts_work(split_part(new.name,'/',1)::uuid);
  end if;
  return new;
end;
$$;

create function public.prepare_session_source_delivery(
  p_run_id uuid,p_repository_id uuid,p_base_branch text,p_base_sha text,p_head_sha text,
  p_title text,p_body text,p_checkpoint_path text,p_bundle_sha256 text,p_bundle_base64 text
) returns boolean language plpgsql security invoker set search_path='' as $$
declare r public.agent_runs%rowtype; j public.agent_jobs%rowtype; repository public.github_repositories%rowtype;
  installation bigint; prior public.session_source_deliveries%rowtype; decoded bytea;
begin
  select * into r from public.agent_runs where id=p_run_id;
  if not found then return false; end if;
  perform internal.assert_workspace_accepts_work(r.workspace_id);
  select * into j from public.agent_jobs where id=r.agent_job_id;
  if j.status not in ('started','running') or r.status<>'running'
    or j.attempt_count is distinct from r.attempt_count or j.session_id<>r.session_id or j.workspace_id<>r.workspace_id
    or r.branch_name is null then return false; end if;
  select * into repository from public.github_repositories where id=p_repository_id and workspace_id=r.workspace_id;
  if not found then raise exception 'Source repository is not in the workspace.' using errcode='23514'; end if;
  select installation_id into installation from public.github_installations
    where id=repository.github_installation_id and workspace_id=r.workspace_id and not suspended;
  if installation is null then raise exception 'Source installation is unavailable.' using errcode='23514'; end if;
  if p_base_sha<>p_head_sha then
    if nullif(p_bundle_base64,'') is not null then
      decoded:=decode(p_bundle_base64,'base64');
      if octet_length(decoded)>4194304 or encode(extensions.digest(decoded,'sha256'),'hex') is distinct from p_bundle_sha256 then
        raise exception 'Invalid source checkpoint.' using errcode='23514';
      end if;
    elsif not exists(select 1 from storage.objects where bucket_id='session-source-checkpoints' and name=p_checkpoint_path) then
      raise exception 'Source checkpoint is not durable.' using errcode='23514';
    end if;
  end if;
  insert into public.session_source_deliveries(run_id,workspace_id,session_id,job_id,attempt_count,repository_id,
    installation_id,repository_full_name,branch_name,base_branch,base_sha,head_sha,title,body,checkpoint_path,bundle_sha256,bundle_base64)
  values(r.id,r.workspace_id,r.session_id,j.id,r.attempt_count,repository.id,installation,repository.full_name,
    r.branch_name,p_base_branch,p_base_sha,p_head_sha,p_title,p_body,nullif(p_checkpoint_path,''),nullif(p_bundle_sha256,''),nullif(p_bundle_base64,''))
  on conflict(run_id) do nothing;
  select * into prior from public.session_source_deliveries where run_id=r.id;
  if prior.head_sha=p_head_sha and prior.base_sha=p_base_sha and prior.repository_id=p_repository_id then
    update public.agent_runs set source_recovery_required=false where id=r.id;
    return true;
  end if;
  return false;
end;
$$;

-- Keep the existing publication primitive for old callers during rollout. New
-- execution must pass this stronger boundary before marking a run successful.
create function public.publish_session_job_with_source(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_expected_artifact_version integer,p_artifact_json text,
  p_deadline_at timestamptz default null
) returns boolean language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.session_source_deliveries where run_id=p_run_id
    and job_id=p_job_id and attempt_count=p_attempt_count) then
    raise exception 'Source checkpoint is required before publication.' using errcode='23514';
  end if;
  return public.publish_session_job_attempt(p_job_id,p_attempt_count,p_run_id,p_expected_artifact_version,p_artifact_json,p_deadline_at);
end;
$$;

create function internal.source_delivery_is_eligible(delivery public.session_source_deliveries)
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
      and w.deletion_requested_at is null and delivery.repository_id is not null);
$$;
revoke all on function internal.source_delivery_is_eligible(public.session_source_deliveries) from public,anon,authenticated;
grant execute on function internal.source_delivery_is_eligible(public.session_source_deliveries) to service_role;

create function public.claim_session_source_delivery()
returns uuid language plpgsql security invoker set search_path='' as $$
declare target uuid;
begin
  select d.run_id into target from public.session_source_deliveries d
  where internal.source_delivery_is_eligible(d)
    and ((d.status='pending' and d.next_attempt_at<=now()) or (d.status='claimed' and d.lease_expires_at<=now()))
  order by d.next_attempt_at,d.run_id limit 1 for update of d skip locked;
  if target is null then return null; end if;
  update public.session_source_deliveries set status='claimed',claim_id=gen_random_uuid(),
    lease_expires_at=now()+interval '2 minutes',delivery_attempt_count=delivery_attempt_count+1 where run_id=target;
  return (select claim_id from public.session_source_deliveries where run_id=target);
end;
$$;

create function public.assert_session_source_delivery_claim(p_run_id uuid,p_claim_id uuid)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  return exists(select 1 from public.session_source_deliveries d
    where d.run_id=p_run_id and d.claim_id=p_claim_id and d.status='claimed' and d.lease_expires_at>now()
      and internal.source_delivery_is_eligible(d));
end;
$$;

create function public.finish_session_source_delivery(p_run_id uuid,p_claim_id uuid,p_delivered boolean)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
  update public.session_source_deliveries set
    status=case when p_delivered then 'delivered' else 'pending' end,
    next_attempt_at=now()+make_interval(secs=>least(3600,15*power(2,least(delivery_attempt_count,8)))::integer),
    delivered_at=case when p_delivered then now() else null end,
    bundle_base64=case when p_delivered then null else bundle_base64 end,
    last_error_code=case when p_delivered then null else 'delivery_failed' end,claim_id=null,lease_expires_at=null
  where run_id=p_run_id and claim_id=p_claim_id and status='claimed' and lease_expires_at>now();
  return found;
end;
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
    or exists(select 1 from storage.objects where bucket_id in ('workspace-avatars','session-attachments','session-source-checkpoints')
      and split_part(name,'/',1)=p_workspace_id::text) then return false; end if;
  delete from public.workspaces where id=p_workspace_id;
  return true;
end;
$$;

revoke all on function public.prepare_session_source_delivery(uuid,uuid,text,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.publish_session_job_with_source(uuid,integer,uuid,integer,text,timestamptz) from public,anon,authenticated;
revoke all on function public.claim_session_source_delivery() from public,anon,authenticated;
revoke all on function public.assert_session_source_delivery_claim(uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_session_source_delivery(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.prepare_session_source_delivery(uuid,uuid,text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.publish_session_job_with_source(uuid,integer,uuid,integer,text,timestamptz) to service_role;
grant execute on function public.claim_session_source_delivery() to service_role;
grant execute on function public.assert_session_source_delivery_claim(uuid,uuid) to service_role;
grant execute on function public.finish_session_source_delivery(uuid,uuid,boolean) to service_role;
