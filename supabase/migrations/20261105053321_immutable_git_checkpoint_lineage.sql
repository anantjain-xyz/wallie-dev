-- No historical SHA backfill: unknown code provenance stays unknown.
-- A job ID is the durable execution intent; claim retries advance attempt_count.
create table public.session_git_roots (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Immutable identity snapshot, deliberately retained after repo disconnection.
  repository_id uuid not null,
  repository_full_name text not null,
  base_branch text not null check (length(btrim(base_branch)) > 0),
  initial_base_sha text not null check (initial_base_sha ~ '^[a-f0-9]{40}$'),
  created_at timestamptz not null default now()
);

create table public.session_job_git_inputs (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  repository_id uuid not null,
  repository_full_name text not null,
  base_branch text not null check (length(btrim(base_branch)) > 0),
  initial_base_sha text not null check (initial_base_sha ~ '^[a-f0-9]{40}$'),
  input_sha text not null check (input_sha ~ '^[a-f0-9]{40}$'),
  pinned_run_id uuid not null references public.agent_runs(id) on delete cascade,
  pinned_attempt_count integer not null check (pinned_attempt_count > 0),
  created_at timestamptz not null default now()
);

create table public.session_git_checkpoints (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check (attempt_count > 0),
  repository_id uuid not null,
  repository_full_name text not null,
  initial_base_sha text not null check (initial_base_sha ~ '^[a-f0-9]{40}$'),
  input_sha text not null check (input_sha ~ '^[a-f0-9]{40}$'),
  output_sha text not null check (output_sha ~ '^[a-f0-9]{40}$'),
  output_kind text not null check (output_kind in ('code', 'no-code')),
  artifact_id uuid not null unique references public.session_artifacts(id) on delete cascade,
  -- Intended remote target, NOT evidence that the push has completed. Durable
  -- bundle/fallback and confirmed delivery status live in session_source_deliveries.
  output_ref text not null check (output_ref like 'refs/heads/%'),
  checkpoint_path text,
  bundle_sha256 text check (bundle_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  constraint session_git_checkpoints_source_delivery_fkey foreign key (run_id)
    references public.session_source_deliveries(run_id) on delete cascade,
  check ((output_kind = 'no-code') = (input_sha = output_sha))
);
comment on column public.session_git_checkpoints.output_ref is
  'Attempt-owned intended target, not a confirmed remote location. The associated source delivery delivered_ref records the actual remote ref when known; older successful receipts may leave it NULL. Pending source is durable in private Storage or DB fallback.';
comment on table public.session_job_git_inputs is
  'Immutable pre-execution input per durable job intent, shared by every claim retry. OP-495 adds restoration from prior accepted outputs.';

create index session_git_roots_workspace_idx on public.session_git_roots(workspace_id);
create index session_job_git_inputs_workspace_idx on public.session_job_git_inputs(workspace_id);
create index session_job_git_inputs_session_idx on public.session_job_git_inputs(session_id);
create index session_git_checkpoints_workspace_idx on public.session_git_checkpoints(workspace_id);
create index session_git_checkpoints_session_idx on public.session_git_checkpoints(session_id, created_at);
create index session_git_checkpoints_job_idx on public.session_git_checkpoints(job_id);

alter table public.session_git_roots enable row level security;
alter table public.session_job_git_inputs enable row level security;
alter table public.session_git_checkpoints enable row level security;
revoke all on public.session_git_roots, public.session_job_git_inputs, public.session_git_checkpoints from public, anon, authenticated;
grant select on public.session_git_roots, public.session_job_git_inputs, public.session_git_checkpoints to authenticated;
grant all on public.session_git_roots, public.session_job_git_inputs, public.session_git_checkpoints to service_role;
create policy session_git_roots_select_membership on public.session_git_roots for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));
create policy session_job_git_inputs_select_membership on public.session_job_git_inputs for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));
create policy session_git_checkpoints_select_membership on public.session_git_checkpoints for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));

-- Cross-table checks are enforced for privileged SQL too. Updates are never
-- allowed; deletes are allowed only as a consequence of parent cleanup.
create function internal.guard_git_lineage()
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
      or d.branch_name is distinct from r.branch_name or new.output_ref is distinct from 'refs/heads/'||d.branch_name
      or d.checkpoint_path is distinct from new.checkpoint_path or d.bundle_sha256 is distinct from new.bundle_sha256 then
      raise exception 'Git checkpoint does not match the accepted execution and artifact.' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_git_lineage() from public,anon,authenticated;
grant execute on function internal.guard_git_lineage() to service_role;
create trigger guard_session_git_roots before insert or update or delete on public.session_git_roots
  for each row execute function internal.guard_git_lineage();
create trigger guard_session_job_git_inputs before insert or update or delete on public.session_job_git_inputs
  for each row execute function internal.guard_git_lineage();
create trigger guard_session_git_checkpoints before insert or update or delete on public.session_git_checkpoints
  for each row execute function internal.guard_git_lineage();

create function public.pin_session_job_git_input(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_repository_id uuid,p_base_branch text,p_observed_sha text
) returns setof public.session_job_git_inputs language plpgsql security invoker set search_path='' as $$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype;
  root public.session_git_roots%rowtype; pinned public.session_job_git_inputs%rowtype;
  repository public.github_repositories%rowtype;
begin
  select owner.* into s from public.sessions owner
    join public.agent_jobs candidate on candidate.session_id=owner.id
    where candidate.id=p_job_id for no key update of owner;
  if not found then return; end if;
  select * into j from public.agent_jobs where id=p_job_id for update;
  if not found or p_attempt_count is null or p_attempt_count<=0 or j.attempt_count<>p_attempt_count
    or j.status not in ('started','running') or j.workspace_id<>s.workspace_id
    or s.archived_at is not null or s.phase_status<>'in_progress'
    or j.stage_id is distinct from s.current_stage_id then return; end if;
  select * into r from public.agent_runs where id=p_run_id for update;
  if not found or r.agent_job_id is distinct from j.id or r.attempt_count is distinct from p_attempt_count
    or r.workspace_id<>s.workspace_id or r.session_id<>s.id or r.stage_id is distinct from j.stage_id
    or r.status<>'running' then return; end if;
  perform internal.assert_workspace_accepts_work(s.workspace_id);
  select * into repository from public.github_repositories
    where id=p_repository_id and workspace_id=s.workspace_id and not is_archived;
  if not found or (s.github_repository_id is not null and s.github_repository_id<>p_repository_id) then
    raise exception 'Git lineage repository does not match the session.' using errcode='23514';
  end if;
  if p_observed_sha is null or p_observed_sha !~ '^[a-f0-9]{40}$' or nullif(btrim(p_base_branch),'') is null then
    raise exception 'Invalid Git execution input.' using errcode='23514';
  end if;
  select * into root from public.session_git_roots where session_id=s.id;
  if not found then
    insert into public.session_git_roots(session_id,workspace_id,repository_id,repository_full_name,base_branch,initial_base_sha)
    values(s.id,s.workspace_id,repository.id,repository.full_name,p_base_branch,p_observed_sha) returning * into root;
  elsif root.repository_id<>repository.id or root.repository_full_name<>repository.full_name then
    raise exception 'Git execution repository is already pinned.' using errcode='23514';
  end if;
  select * into pinned from public.session_job_git_inputs where job_id=j.id;
  if found then
    if pinned.repository_id<>repository.id or pinned.base_branch<>p_base_branch then
      raise exception 'Git execution input is already pinned.' using errcode='23514';
    end if;
    return next pinned;
    return;
  end if;
  insert into public.session_job_git_inputs(job_id,workspace_id,session_id,repository_id,repository_full_name,
    base_branch,initial_base_sha,input_sha,pinned_run_id,pinned_attempt_count)
  values(j.id,s.workspace_id,s.id,root.repository_id,root.repository_full_name,root.base_branch,
    root.initial_base_sha,root.initial_base_sha,r.id,p_attempt_count) returning * into pinned;
  return next pinned;
end;
$$;
revoke all on function public.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text) to service_role;

-- Source preparation must serialize with cancellation/retry/publication in the
-- same session -> job -> run order as the rest of the ownership contract.
create or replace function public.prepare_session_source_delivery(
  p_run_id uuid,p_repository_id uuid,p_base_branch text,p_base_sha text,p_head_sha text,
  p_title text,p_body text,p_checkpoint_path text,p_bundle_sha256 text,p_bundle_base64 text
) returns boolean language plpgsql security invoker set search_path='' as $$
declare s public.sessions%rowtype; r public.agent_runs%rowtype; j public.agent_jobs%rowtype;
  repository public.github_repositories%rowtype; pinned public.session_job_git_inputs%rowtype;
  installation bigint; prior public.session_source_deliveries%rowtype; decoded bytea;
begin
  select owner.* into s from public.sessions owner join public.agent_runs candidate on candidate.session_id=owner.id
    where candidate.id=p_run_id for no key update of owner;
  if not found then return false; end if;
  select job.* into j from public.agent_jobs job join public.agent_runs candidate on candidate.agent_job_id=job.id
    where candidate.id=p_run_id for update of job;
  if not found or j.status not in ('started','running') or j.workspace_id<>s.workspace_id
    or s.archived_at is not null or s.phase_status<>'in_progress' or j.stage_id is distinct from s.current_stage_id then return false; end if;
  select * into r from public.agent_runs where id=p_run_id for update;
  if not found or r.status<>'running' or r.agent_job_id is distinct from j.id
    or j.attempt_count is distinct from r.attempt_count or r.session_id<>s.id or r.workspace_id<>s.workspace_id
    or r.stage_id is distinct from j.stage_id or r.branch_name is null then return false; end if;
  perform internal.assert_workspace_accepts_work(r.workspace_id);
  select * into pinned from public.session_job_git_inputs where job_id=j.id;
  if not found or pinned.repository_id is distinct from p_repository_id or pinned.base_branch is distinct from p_base_branch
    or pinned.input_sha is distinct from p_base_sha then
    raise exception 'Source does not match the pinned Git input.' using errcode='23514';
  end if;
  select * into repository from public.github_repositories where id=p_repository_id and workspace_id=r.workspace_id;
  if not found or repository.full_name<>pinned.repository_full_name
    or (s.github_repository_id is not null and s.github_repository_id<>p_repository_id) then
    raise exception 'Source repository is not in the workspace.' using errcode='23514';
  end if;
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
  if prior.head_sha=p_head_sha and prior.base_sha=p_base_sha and prior.repository_id=p_repository_id
    and prior.base_branch=p_base_branch and prior.branch_name=r.branch_name
    and prior.bundle_sha256 is not distinct from nullif(p_bundle_sha256,'') then
    update public.agent_runs set source_recovery_required=false where id=r.id;
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.publish_session_job_with_source(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_expected_artifact_version integer,p_artifact_json text,
  p_deadline_at timestamptz default null
) returns boolean language plpgsql security invoker set search_path='' as $$
declare pinned public.session_job_git_inputs%rowtype; d public.session_source_deliveries%rowtype;
  accepted_artifact uuid;
begin
  -- The primitive takes session -> job -> run locks, checks the exact claim,
  -- inserts the artifact and marks its run successful. A later exception rolls
  -- all of those writes back, including deadline failures during adoption.
  if not exists(select 1 from public.session_source_deliveries where run_id=p_run_id
    and job_id=p_job_id and attempt_count=p_attempt_count) then
    raise exception 'Source checkpoint is required before publication.' using errcode='23514';
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
    'refs/heads/'||d.branch_name,d.checkpoint_path,d.bundle_sha256);
  if p_deadline_at is not null and clock_timestamp()>=p_deadline_at then
    raise exception 'Worker attempt exceeded its publication deadline.' using errcode='57014';
  end if;
  return true;
end;
$$;

-- Delivery leases remain mutable. Accepted source identity does not: otherwise
-- changing a fallback's pointer or digest could invalidate immutable provenance.
create function internal.guard_accepted_git_delivery()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if exists(select 1 from public.session_git_checkpoints where run_id=old.run_id)
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
revoke all on function internal.guard_accepted_git_delivery() from public,anon,authenticated;
grant execute on function internal.guard_accepted_git_delivery() to service_role;
create trigger guard_accepted_git_delivery before update on public.session_source_deliveries
  for each row execute function internal.guard_accepted_git_delivery();

-- Freeze the referenced historical objects too: an immutable checkpoint must
-- never resolve to rewritten artifact content or a different producing run.
create function internal.guard_git_producer_identity()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  -- Owning-session/workspace cleanup may null related FKs before the remaining
  -- cascade triggers run. Normal history edits never use this exception.
  if not exists(select 1 from public.workspaces where id=old.workspace_id)
    or not exists(select 1 from public.sessions where id=old.session_id) then return new; end if;
  if tg_table_name='session_artifacts' then
    if exists(select 1 from public.session_git_checkpoints where artifact_id=old.id)
      and (new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
        or new.session_id is distinct from old.session_id or new.stage_slug is distinct from old.stage_slug
        or new.version is distinct from old.version or new.artifact_json is distinct from old.artifact_json
        or new.created_at is distinct from old.created_at
        or (new.stage_id is distinct from old.stage_id and not (
          new.stage_id is null and old.stage_id is not null
          and not exists(select 1 from public.pipeline_stages where id=old.stage_id)))) then
      raise exception 'Accepted Git artifact identity and content are immutable.' using errcode='23514';
    end if;
  elsif tg_table_name='agent_runs' then
    if (exists(select 1 from public.session_job_git_inputs where pinned_run_id=old.id)
      or exists(select 1 from public.session_git_checkpoints where run_id=old.id))
      and (new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
        or new.session_id is distinct from old.session_id or new.agent_job_id is distinct from old.agent_job_id
        or new.attempt_count is distinct from old.attempt_count or new.branch_name is distinct from old.branch_name
        or (new.stage_id is distinct from old.stage_id and not (
          new.stage_id is null and old.stage_id is not null
          and not exists(select 1 from public.pipeline_stages where id=old.stage_id)))) then
      raise exception 'Pinned Git run producer identity is immutable.' using errcode='23514';
    end if;
  elsif exists(select 1 from public.session_job_git_inputs where job_id=old.id)
    and (new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id) then
    raise exception 'Pinned Git job identity is immutable.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_git_producer_identity() from public,anon,authenticated;
grant execute on function internal.guard_git_producer_identity() to service_role;
create trigger guard_accepted_git_artifact before update on public.session_artifacts
  for each row execute function internal.guard_git_producer_identity();
create trigger guard_pinned_git_run before update on public.agent_runs
  for each row execute function internal.guard_git_producer_identity();
create trigger guard_pinned_git_job before update on public.agent_jobs
  for each row execute function internal.guard_git_producer_identity();

-- The checkpoint's output_ref remains the intended attempt target. This
-- separate receipt records the actual branch, including recovery branches.
-- Existing delivery receipts stay unknown (NULL), never fabricated.
create function internal.is_git_branch_ref(value text)
returns boolean language sql immutable security invoker set search_path='' as $$
  select value is null or (
    starts_with(value,'refs/heads/') and length(value)>11 and length(value)<=1024
    and value !~ '[[:cntrl:][:space:]]'
    and translate(value,'~^:?*[','')=value and position(chr(92) in value)=0
    and position('..' in value)=0 and position('@{' in value)=0
    and right(value,1)<>'.'
    and not exists(select 1 from regexp_split_to_table(value,'/') segment
      where segment='' or left(segment,1)='.' or right(segment,5)='.lock')
  );
$$;
revoke all on function internal.is_git_branch_ref(text) from public,anon,authenticated;
grant execute on function internal.is_git_branch_ref(text) to service_role;
alter table public.session_source_deliveries add column delivered_ref text
  check(internal.is_git_branch_ref(delivered_ref));
comment on column public.session_source_deliveries.delivered_ref is
  'Actual durable Git ref recorded under the delivery lease; NULL means no-code output or an older receipt with unknown ref. Once known it is immutable.';

create function internal.guard_delivered_git_ref()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.delivered_ref is not null and new.delivered_ref is distinct from old.delivered_ref then
    raise exception 'Delivered Git ref is immutable.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_delivered_git_ref() from public,anon,authenticated;
grant execute on function internal.guard_delivered_git_ref() to service_role;
create trigger guard_delivered_git_ref before update on public.session_source_deliveries
  for each row execute function internal.guard_delivered_git_ref();

-- Existing invoker APIs retain access to the existing delivery fields. Only
-- the private, fenced receipt helper below may set the new delivered_ref.
revoke insert, update on public.session_source_deliveries from service_role;
grant insert (run_id,workspace_id,session_id,job_id,attempt_count,repository_id,
  installation_id,repository_full_name,branch_name,base_branch,base_sha,head_sha,
  checkpoint_path,bundle_sha256,bundle_base64,title,body,status,delivery_attempt_count,
  next_attempt_at,claim_id,lease_expires_at,last_error_code,created_at,delivered_at)
  on public.session_source_deliveries to service_role;
grant update (run_id,workspace_id,session_id,job_id,attempt_count,repository_id,
  installation_id,repository_full_name,branch_name,base_branch,base_sha,head_sha,
  checkpoint_path,bundle_sha256,bundle_base64,title,body,status,delivery_attempt_count,
  next_attempt_at,claim_id,lease_expires_at,last_error_code,created_at,delivered_at)
  on public.session_source_deliveries to service_role;

create function internal.finish_session_source_delivery_with_ref(
  p_run_id uuid,p_claim_id uuid,p_delivered_ref text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare d public.session_source_deliveries%rowtype;
begin
  -- EXECUTE is service-only; keep a role boundary in the privileged helper too.
  if current_setting('role',true) is distinct from 'service_role'
    and session_user not in ('postgres','supabase_admin') then
    raise exception 'Service role is required for Git delivery receipts.' using errcode='42501';
  end if;
  -- Take lifecycle locks before the outbox lock, never reverse the execution
  -- publication order. Eligibility is checked again after all waits.
  perform 1 from public.sessions s join public.session_source_deliveries candidate on candidate.session_id=s.id
    where candidate.run_id=p_run_id for no key update of s;
  if not found then return false; end if;
  perform 1 from public.agent_jobs j join public.session_source_deliveries candidate on candidate.job_id=j.id
    where candidate.run_id=p_run_id for update of j;
  if not found then return false; end if;
  perform 1 from public.agent_runs where id=p_run_id for update;
  if not found then return false; end if;
  select * into d from public.session_source_deliveries where run_id=p_run_id for update;
  if not found or d.claim_id is distinct from p_claim_id or d.status<>'claimed'
    or d.lease_expires_at is null or d.lease_expires_at<=clock_timestamp()
    or not internal.source_delivery_is_eligible(d) then return false; end if;
  if not internal.is_git_branch_ref(p_delivered_ref)
    or (p_delivered_ref is null and d.base_sha<>d.head_sha) then
    raise exception 'A valid delivered Git branch ref is required for changed code.' using errcode='23514';
  end if;
  if d.delivered_ref is not null and d.delivered_ref is distinct from p_delivered_ref then return false; end if;
  if not public.finish_session_source_delivery(p_run_id,p_claim_id,true) then return false; end if;
  update public.session_source_deliveries set delivered_ref=coalesce(delivered_ref,p_delivered_ref) where run_id=p_run_id;
  if clock_timestamp()>=d.lease_expires_at then
    raise exception 'Git delivery lease expired before receipt.' using errcode='57014';
  end if;
  return true;
end;
$$;
revoke all on function internal.finish_session_source_delivery_with_ref(uuid,uuid,text) from public,anon,authenticated;
grant execute on function internal.finish_session_source_delivery_with_ref(uuid,uuid,text) to service_role;
create function public.finish_session_source_delivery_with_ref(
  p_run_id uuid,p_claim_id uuid,p_delivered_ref text default null
) returns boolean language sql security invoker set search_path='' as $$
  select internal.finish_session_source_delivery_with_ref(p_run_id,p_claim_id,p_delivered_ref);
$$;
revoke all on function public.finish_session_source_delivery_with_ref(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.finish_session_source_delivery_with_ref(uuid,uuid,text) to service_role;
