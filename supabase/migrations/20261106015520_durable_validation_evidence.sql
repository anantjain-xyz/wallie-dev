-- Execution receipts come only from the trusted harness, never agent Markdown.
-- An immutable run manifest survives sandbox teardown; its validation status is
-- still independent from the OP-508 current-readiness decision.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('session-validation-evidence','session-validation-evidence',false,1048576,array['text/plain','application/json'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create table public.session_validation_evidence (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check(attempt_count>0),
  repository_id uuid not null,
  repository_full_name text not null,
  commit_sha text not null check(commit_sha ~ '^[a-f0-9]{40}$'),
  validation_tree_sha text not null check(validation_tree_sha ~ '^[a-f0-9]{40}$'),
  records jsonb not null check(jsonb_typeof(records)='array' and jsonb_array_length(records)<=20 and pg_column_size(records)<=262144),
  assets jsonb not null check(jsonb_typeof(assets)='array' and jsonb_array_length(assets)<=100 and pg_column_size(assets)<=131072),
  created_at timestamptz not null default clock_timestamp()
);
create index session_validation_evidence_workspace_idx on public.session_validation_evidence(workspace_id);
create index session_validation_evidence_session_idx on public.session_validation_evidence(session_id,created_at desc);
create index session_validation_evidence_job_idx on public.session_validation_evidence(job_id);

create table public.session_validation_assets (
  id uuid primary key,
  run_id uuid not null references public.session_validation_evidence(run_id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  evidence_key text not null check(length(btrim(evidence_key)) between 1 and 200),
  kind text not null check(kind in ('report','screenshot','preview','log')),
  required boolean not null,
  storage_path text not null unique,
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  content_type text not null check(content_type in ('text/plain','application/json')),
  size_bytes integer not null check(size_bytes between 0 and 1048576),
  check(storage_path=workspace_id::text||'/'||run_id::text||'/'||id::text)
);
create index session_validation_assets_workspace_idx on public.session_validation_assets(workspace_id);
create index session_validation_assets_session_idx on public.session_validation_assets(session_id);
create index session_validation_assets_run_idx on public.session_validation_assets(run_id);
alter table public.session_validation_evidence enable row level security;
alter table public.session_validation_assets enable row level security;
revoke all on public.session_validation_evidence,public.session_validation_assets from public,anon,authenticated,service_role;
grant select on public.session_validation_evidence,public.session_validation_assets to authenticated,service_role;
create policy session_validation_evidence_read on public.session_validation_evidence for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));
create policy session_validation_assets_read on public.session_validation_assets for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));
create policy session_validation_storage_read on storage.objects for select to authenticated
  using(bucket_id='session-validation-evidence' and exists(select 1 from public.session_validation_assets a
    where a.storage_path=name and a.workspace_id in(select internal.current_user_workspace_ids())));

create function internal.guard_validation_evidence_history()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' and (not exists(select 1 from public.sessions where id=old.session_id)
    or not exists(select 1 from public.workspaces where id=old.workspace_id)
    or tg_table_name='session_validation_assets' and not exists(select 1 from public.session_validation_evidence where run_id=old.run_id)) then
    return old;
  end if;
  raise exception 'Validation evidence history is immutable.' using errcode='23514';
end;
$$;
revoke all on function internal.guard_validation_evidence_history() from public,anon,authenticated,service_role;
create trigger validation_evidence_immutable before update or delete on public.session_validation_evidence
  for each row execute function internal.guard_validation_evidence_history();
create trigger validation_assets_immutable before update or delete on public.session_validation_assets
  for each row execute function internal.guard_validation_evidence_history();

create function internal.record_session_validation_evidence(p_run_id uuid,p_commit_sha text,p_validation_tree_sha text,
  p_records jsonb,p_assets jsonb default '[]'::jsonb)
returns public.session_validation_evidence language plpgsql security definer set search_path='' as $$
declare s public.sessions; j public.agent_jobs; r public.agent_runs; pinned public.session_job_git_inputs;
  prior public.session_validation_evidence; result public.session_validation_evidence;
  item jsonb; asset jsonb; field text; stamp_start timestamptz; stamp_end timestamptz;
  total_bytes bigint:=0;
begin
  -- Callers cannot supply a tenant, job, attempt, or repository independently.
  perform internal.assert_checkpoint_publication_service();
  select owner.* into s from public.sessions owner join public.agent_runs candidate on candidate.session_id=owner.id
    where candidate.id=p_run_id for no key update of owner;
  if s.id is null then raise exception 'Validation execution is unavailable.' using errcode='42501'; end if;
  perform internal.assert_workspace_accepts_work(s.workspace_id);
  select * into prior from public.session_validation_evidence where run_id=p_run_id;
  if found then
    if prior.commit_sha=p_commit_sha and prior.validation_tree_sha=p_validation_tree_sha and prior.records=p_records and prior.assets=p_assets then return prior; end if;
    raise exception 'Validation evidence has already been recorded.' using errcode='PT409';
  end if;
  select job.* into j from public.agent_jobs job join public.agent_runs candidate on candidate.agent_job_id=job.id
    where candidate.id=p_run_id for update of job;
  select * into r from public.agent_runs where id=p_run_id for update;
  select * into pinned from public.session_job_git_inputs where job_id=j.id;
  if s.archived_at is not null or s.phase_status is distinct from 'in_progress'
    or j.workspace_id is distinct from s.workspace_id or j.session_id is distinct from s.id
    or j.stage_id is distinct from s.current_stage_id or j.status not in ('started','running')
    or r.workspace_id is distinct from s.workspace_id or r.session_id is distinct from s.id
    or r.status is distinct from 'running' or r.stage_id is distinct from j.stage_id
    or r.attempt_count is distinct from j.attempt_count or r.agent_job_id is distinct from j.id
    or pinned.session_id is distinct from s.id or pinned.workspace_id is distinct from s.workspace_id
    or pinned.repository_id is null then
    raise exception 'Validation execution is no longer current.' using errcode='PT409';
  end if;
  if exists(select 1 from public.session_source_deliveries d where d.run_id=p_run_id
    and (d.head_sha is distinct from p_commit_sha or d.repository_id is distinct from pinned.repository_id)) then
    raise exception 'Validation commit does not match the prepared source.' using errcode='23514';
  end if;
  if p_commit_sha !~ '^[a-f0-9]{40}$' or p_validation_tree_sha !~ '^[a-f0-9]{40}$'
    or jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records)>20 or pg_column_size(p_records)>262144
    or jsonb_typeof(p_assets) is distinct from 'array' or jsonb_array_length(p_assets)>100 or pg_column_size(p_assets)>131072 then
    raise exception 'Invalid validation evidence manifest.' using errcode='23514';
  end if;
  for item in select * from jsonb_array_elements(p_records) loop
    if jsonb_typeof(item) is distinct from 'object' or not item ?& array['key','command','provenance','status','exitCode',
      'startedAt','completedAt','commitSha','treeSha','finalCommitSha','finalTreeSha','reportKeys','missingRequiredReports']
      or (select count(*) from jsonb_object_keys(item))<>13 or item->>'provenance' is distinct from 'harness'
      or item->>'status' is null or item->>'status' not in ('passed','failed','stale','error')
      or jsonb_typeof(item->'key') is distinct from 'string' or length(btrim(item->>'key')) not between 1 and 200
      or jsonb_typeof(item->'command') is distinct from 'string' or length(item->>'command') not between 1 and 4096 then
      raise exception 'Invalid observed validation command.' using errcode='23514';
    end if;
    if item->'exitCode'<>'null'::jsonb and (jsonb_typeof(item->'exitCode') is distinct from 'number'
      or (item->>'exitCode')::numeric<>trunc((item->>'exitCode')::numeric) or (item->>'exitCode')::numeric not between -2147483648 and 2147483647) then
      raise exception 'Invalid observed validation exit status.' using errcode='23514';
    end if;
    foreach field in array array['commitSha','treeSha','finalCommitSha','finalTreeSha'] loop
      if item->field<>'null'::jsonb and (jsonb_typeof(item->field) is distinct from 'string' or item->>field !~ '^[a-f0-9]{40}$') then
        raise exception 'Invalid validation commit identity.' using errcode='23514';
      end if;
    end loop;
    foreach field in array array['reportKeys','missingRequiredReports'] loop
      if jsonb_typeof(item->field) is distinct from 'array' or jsonb_array_length(item->field)>100
        or exists(select 1 from jsonb_array_elements(item->field) value where jsonb_typeof(value) is distinct from 'string'
          or length(btrim(value #>> '{}')) not between 1 and 200)
        or (select count(*) from jsonb_array_elements(item->field)) <>
          (select count(distinct value) from jsonb_array_elements(item->field)) then
        raise exception 'Invalid validation report requirements.' using errcode='23514';
      end if;
    end loop;
    if jsonb_typeof(item->'startedAt') is distinct from 'string' or jsonb_typeof(item->'completedAt') is distinct from 'string' then
      raise exception 'Invalid validation execution time.' using errcode='23514';
    end if;
    stamp_start:=(item->>'startedAt')::timestamptz; stamp_end:=(item->>'completedAt')::timestamptz;
    if not isfinite(stamp_start) or not isfinite(stamp_end) or stamp_start>stamp_end or stamp_end>clock_timestamp()+interval '5 seconds'
      or stamp_start<r.started_at-interval '5 seconds' then
      raise exception 'Invalid validation execution time.' using errcode='23514';
    end if;
    if item->>'status'='passed' and (item->'exitCode' is distinct from '0'::jsonb
      or item->>'commitSha' is distinct from p_commit_sha or item->>'finalCommitSha' is distinct from p_commit_sha
      or item->>'treeSha' is distinct from p_validation_tree_sha or item->>'finalTreeSha' is distinct from p_validation_tree_sha
      or jsonb_array_length(item->'missingRequiredReports')<>0) then
      raise exception 'Passed validation must prove the exact unchanged code.' using errcode='23514';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_records)) <>
    (select count(distinct value->>'key') from jsonb_array_elements(p_records)) then
    raise exception 'Validation command identities must be unique.' using errcode='23514';
  end if;
  for asset in select * from jsonb_array_elements(p_assets) loop
    if jsonb_typeof(asset) is distinct from 'object' or not asset ?& array['id','key','kind','required','storagePath','sha256','contentType','sizeBytes']
      or (select count(*) from jsonb_object_keys(asset))<>8
      or jsonb_typeof(asset->'id') is distinct from 'string' or asset->>'id' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      or jsonb_typeof(asset->'key') is distinct from 'string' or length(btrim(asset->>'key')) not between 1 and 200
      or asset->>'kind' is null or asset->>'kind' not in ('report','screenshot','preview','log')
      or jsonb_typeof(asset->'required') is distinct from 'boolean'
      or asset->>'storagePath' is distinct from s.workspace_id::text||'/'||r.id::text||'/'||(asset->>'id')
      or jsonb_typeof(asset->'sha256') is distinct from 'string' or asset->>'sha256' !~ '^[a-f0-9]{64}$'
      or asset->>'contentType' is null or asset->>'contentType' not in ('text/plain','application/json')
      or jsonb_typeof(asset->'sizeBytes') is distinct from 'number'
      or (asset->>'sizeBytes')::numeric<>trunc((asset->>'sizeBytes')::numeric)
      or (asset->>'sizeBytes')::numeric not between 0 and 1048576 then
      raise exception 'Invalid durable validation asset.' using errcode='23514';
    end if;
    total_bytes:=total_bytes+(asset->>'sizeBytes')::bigint;
    if total_bytes>10485760 or not exists(select 1 from storage.objects o where o.bucket_id='session-validation-evidence'
      and o.name=asset->>'storagePath' and o.metadata->>'size'=(asset->>'sizeBytes')
      and o.metadata->>'mimetype'=asset->>'contentType') then
      raise exception 'Validation asset is unavailable or exceeds the size limit.' using errcode='23514';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_assets)) <>
    (select count(distinct value->>'id') from jsonb_array_elements(p_assets))
    or (select count(*) from jsonb_array_elements(p_assets)) <>
    (select count(distinct value->>'key') from jsonb_array_elements(p_assets)) then
    raise exception 'Validation asset identities must be unique.' using errcode='23514';
  end if;
  -- A receipt claiming success must include every required report it names.
  if exists(select 1 from jsonb_array_elements(p_records) command
    cross join lateral jsonb_array_elements_text(command->'reportKeys') report
    where command->>'status'='passed' and not exists(select 1 from jsonb_array_elements(p_assets) a
      where a->>'key'=report and a->'required'='true'::jsonb)) then
    raise exception 'Passed validation is missing a required report.' using errcode='23514';
  end if;
  insert into public.session_validation_evidence(run_id,workspace_id,session_id,job_id,attempt_count,repository_id,
    repository_full_name,commit_sha,validation_tree_sha,records,assets)
  values(r.id,s.workspace_id,s.id,j.id,r.attempt_count,pinned.repository_id,pinned.repository_full_name,
    p_commit_sha,p_validation_tree_sha,p_records,p_assets) returning * into result;
  insert into public.session_validation_assets(id,run_id,workspace_id,session_id,evidence_key,kind,required,storage_path,sha256,content_type,size_bytes)
  select (a->>'id')::uuid,r.id,s.workspace_id,s.id,a->>'key',a->>'kind',(a->>'required')::boolean,
    a->>'storagePath',a->>'sha256',a->>'contentType',(a->>'sizeBytes')::integer from jsonb_array_elements(p_assets) a;
  return result;
end;
$$;
create function public.record_session_validation_evidence(p_run_id uuid,p_commit_sha text,p_validation_tree_sha text,
  p_records jsonb,p_assets jsonb default '[]'::jsonb)
returns public.session_validation_evidence language sql security invoker set search_path='' as $$
  select internal.record_session_validation_evidence(p_run_id,p_commit_sha,p_validation_tree_sha,p_records,p_assets);
$$;
revoke all on function internal.record_session_validation_evidence(uuid,text,text,jsonb,jsonb),
  public.record_session_validation_evidence(uuid,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function internal.record_session_validation_evidence(uuid,text,text,jsonb,jsonb),
  public.record_session_validation_evidence(uuid,text,text,jsonb,jsonb) to service_role;

-- The storage deletion fence includes in-flight and retained evidence uploads.
alter table public.workspace_resource_operations drop constraint workspace_resource_operations_storage_bucket_check;
alter table public.workspace_resource_operations add constraint workspace_resource_operations_storage_bucket_check
  check(storage_bucket in ('workspace-avatars','session-attachments','session-source-checkpoints','session-validation-evidence'));
create or replace function internal.guard_workspace_storage_admission()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.bucket_id in ('workspace-avatars','session-attachments','session-source-checkpoints','session-validation-evidence') then
    perform internal.assert_workspace_accepts_work(split_part(new.name,'/',1)::uuid);
  end if;
  return new;
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
    or exists(select 1 from public.session_pr_operations where workspace_id=p_workspace_id and status='claimed' and lease_expires_at>clock_timestamp())
    or exists(select 1 from public.session_checkpoint_cleanup where workspace_id=p_workspace_id and status='claimed' and lease_expires_at>clock_timestamp())
    or exists(select 1 from storage.objects where bucket_id in ('workspace-avatars','session-attachments','session-source-checkpoints','session-validation-evidence')
      and split_part(name,'/',1)=p_workspace_id::text) then return false; end if;
  delete from public.workspaces where id=p_workspace_id;
  return true;
end;
$$;
