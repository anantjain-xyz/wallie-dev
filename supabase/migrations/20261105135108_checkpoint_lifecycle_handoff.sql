-- A queued job selects code before a worker assigns its producing run. Binding
-- the producer later must not change that immutable execution input.
alter table public.session_job_git_inputs
  add column input_ref text check(internal.is_git_branch_ref(input_ref)),
  add column source_checkpoint_run_id uuid references public.session_git_checkpoints(run_id) on delete cascade,
  alter column pinned_run_id drop not null,
  alter column pinned_attempt_count drop not null;
alter table public.session_job_git_inputs add constraint session_job_git_inputs_binding_pair
  check((pinned_run_id is null)=(pinned_attempt_count is null));
create index session_job_git_inputs_source_checkpoint_idx on public.session_job_git_inputs(source_checkpoint_run_id);
comment on table public.session_job_git_inputs is
  'Immutable Git input per durable job intent. Queued selection has no producing run; the first owned execution binds the run/attempt once. Retries reuse the original SHA, ref and source checkpoint.';
comment on column public.session_job_git_inputs.input_ref is
  'Exact remote fetch ref for input_sha, inherited through no-code outputs. NULL for the initial root or older unknown refs; never a moving-branch fallback.';

-- Keep the accepted code cursor separate from mutable review/stage fields.
create table public.session_git_heads (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  checkpoint_run_id uuid not null references public.session_git_checkpoints(run_id) on delete cascade,
  updated_at timestamptz not null default clock_timestamp()
);
create index session_git_heads_workspace_idx on public.session_git_heads(workspace_id);
create index session_git_heads_checkpoint_idx on public.session_git_heads(checkpoint_run_id);
alter table public.session_git_heads enable row level security;
revoke all on public.session_git_heads from public,anon,authenticated,service_role;
grant select on public.session_git_heads to authenticated,service_role;
create policy session_git_heads_select_membership on public.session_git_heads for select to authenticated
  using(workspace_id in (select internal.current_user_workspace_ids()));
comment on table public.session_git_heads is
  'Last atomically accepted checkpoint per session, independent of human approval and current_artifact_id clearing. Only checkpoint insertion advances it; no timestamp-based historical reconstruction.';

create function internal.guard_session_git_head()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.sessions where id=old.session_id)
      or not exists(select 1 from public.workspaces where id=old.workspace_id) then return old; end if;
    raise exception 'Git head is maintained by checkpoint adoption.' using errcode='23514';
  end if;
  if (tg_op='UPDATE' and (new.session_id is distinct from old.session_id or new.workspace_id is distinct from old.workspace_id))
    or not exists(select 1 from public.session_git_checkpoints c join public.sessions s on s.id=c.session_id
      join public.session_git_roots root on root.session_id=s.id
      where c.run_id=new.checkpoint_run_id and c.session_id=new.session_id and c.workspace_id=new.workspace_id
        and s.workspace_id=new.workspace_id and s.current_artifact_id=c.artifact_id
        and root.workspace_id=c.workspace_id and root.repository_id=c.repository_id
        and root.repository_full_name=c.repository_full_name and root.initial_base_sha=c.initial_base_sha) then
    raise exception 'Git head does not match the accepted session checkpoint.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_session_git_head() from public,anon,authenticated,service_role;
create trigger guard_session_git_head before insert or update or delete on public.session_git_heads
  for each row execute function internal.guard_session_git_head();

create function internal.advance_session_git_head()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- The checkpoint guard already holds session -> job -> run locks and proves
  -- the artifact association. Reentrant session locking also protects legacy
  -- source-aware publication paths using the same checkpoint insert boundary.
  perform 1 from public.sessions where id=new.session_id and workspace_id=new.workspace_id
    and current_artifact_id=new.artifact_id for no key update;
  if not found then raise exception 'Git head does not match the accepted session checkpoint.' using errcode='23514'; end if;
  insert into public.session_git_heads(session_id,workspace_id,checkpoint_run_id)
  values(new.session_id,new.workspace_id,new.run_id)
  on conflict(session_id) do update set checkpoint_run_id=excluded.checkpoint_run_id,updated_at=clock_timestamp();
  return new;
end;
$$;
revoke all on function internal.advance_session_git_head() from public,anon,authenticated,service_role;
create trigger advance_session_git_head after insert on public.session_git_checkpoints
  for each row execute function internal.advance_session_git_head();

-- Recover only an exact current artifact link. Never guess the newest result
-- by creation timestamps, stage position or a moving repository branch.
insert into public.session_git_heads(session_id,workspace_id,checkpoint_run_id)
select s.id,s.workspace_id,c.run_id from public.sessions s
join public.session_git_checkpoints c on c.artifact_id=s.current_artifact_id
  and c.session_id=s.id and c.workspace_id=s.workspace_id
join public.session_git_roots root on root.session_id=s.id and root.workspace_id=s.workspace_id
  and root.repository_id=c.repository_id and root.repository_full_name=c.repository_full_name
  and root.initial_base_sha=c.initial_base_sha;

create function internal.checkpoint_execution_input(p_run_id uuid,p_session_id uuid,p_workspace_id uuid)
returns table(repository_id uuid,repository_full_name text,base_branch text,initial_base_sha text,
  input_sha text,input_ref text,source_checkpoint_run_id uuid)
language plpgsql security invoker set search_path='' as $$
declare c public.session_git_checkpoints%rowtype; producer public.session_job_git_inputs%rowtype; fetch_ref text;
begin
  select checkpoint.* into c from public.session_git_checkpoints checkpoint
    where checkpoint.run_id=p_run_id and checkpoint.session_id=p_session_id and checkpoint.workspace_id=p_workspace_id;
  if not found then raise exception 'Accepted Git checkpoint is unavailable. Start a new session with the intended source.' using errcode='55000'; end if;
  select * into producer from public.session_job_git_inputs where job_id=c.job_id;
  if not found or producer.pinned_run_id is null or producer.pinned_attempt_count is null
    or producer.workspace_id<>c.workspace_id or producer.session_id<>c.session_id
    or producer.repository_id<>c.repository_id or producer.repository_full_name<>c.repository_full_name
    or producer.initial_base_sha<>c.initial_base_sha or producer.input_sha<>c.input_sha then
    raise exception 'Accepted Git checkpoint does not match its producing input.' using errcode='23514';
  end if;
  if c.output_kind='code' then
    select publication.remote_verified_ref into fetch_ref from public.session_checkpoint_publications publication
      where publication.run_id=c.run_id and publication.status='adopted'
        and publication.remote_verified_ref=c.output_ref and publication.remote_verified_sha=c.output_sha
        and publication.remote_verified_at is not null;
    if fetch_ref is null then
      -- Older checkpoints recorded an intended output_ref, so only an actual
      -- delivery receipt can supply a fetch ref. Providers still verify SHA.
      select delivery.delivered_ref into fetch_ref from public.session_source_deliveries delivery
        where delivery.run_id=c.run_id and delivery.workspace_id=c.workspace_id and delivery.session_id=c.session_id
          and delivery.repository_full_name=c.repository_full_name and delivery.head_sha=c.output_sha
          and delivery.delivered_ref is not null;
    end if;
    if fetch_ref is null then raise exception 'Accepted Git checkpoint has no verified remote ref.' using errcode='55000'; end if;
  else
    if c.input_sha<>c.output_sha then raise exception 'No-code checkpoint changed its input.' using errcode='23514'; end if;
    fetch_ref:=producer.input_ref;
    if fetch_ref is null and c.output_sha<>c.initial_base_sha then
      raise exception 'Accepted Git checkpoint has no verified remote ref.' using errcode='55000';
    end if;
  end if;
  return query select c.repository_id,c.repository_full_name,producer.base_branch,c.initial_base_sha,
    c.output_sha,fetch_ref,c.run_id;
end;
$$;
revoke all on function internal.checkpoint_execution_input(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function internal.checkpoint_execution_input(uuid,uuid,uuid) to service_role;

create function internal.session_execution_input(p_session_id uuid,p_workspace_id uuid)
returns table(repository_id uuid,repository_full_name text,base_branch text,initial_base_sha text,
  input_sha text,input_ref text,source_checkpoint_run_id uuid)
language plpgsql security invoker set search_path='' as $$
declare s public.sessions%rowtype; root public.session_git_roots%rowtype; head public.session_git_heads%rowtype;
begin
  select * into s from public.sessions where id=p_session_id and workspace_id=p_workspace_id;
  if not found then raise exception 'Session not found.' using errcode='P0002'; end if;
  select * into root from public.session_git_roots where session_id=s.id and workspace_id=s.workspace_id;
  if not found then return; end if;
  if s.current_artifact_id is not null and not exists(select 1 from public.session_git_checkpoints checkpoint
    where checkpoint.artifact_id=s.current_artifact_id and checkpoint.session_id=s.id and checkpoint.workspace_id=s.workspace_id) then
    raise exception 'Reviewed artifact has no restorable Git checkpoint. Start a new session with the intended source.' using errcode='55000';
  end if;
  select * into head from public.session_git_heads where session_id=s.id and workspace_id=s.workspace_id;
  if found then
    return query select * from internal.checkpoint_execution_input(head.checkpoint_run_id,s.id,s.workspace_id);
    return;
  end if;
  if exists(select 1 from public.session_artifacts artifact where artifact.session_id=s.id)
    or exists(select 1 from public.session_git_checkpoints checkpoint where checkpoint.session_id=s.id) then
    raise exception 'Accepted Git checkpoint is unavailable. Start a new session with the intended source.' using errcode='55000';
  end if;
  return query select root.repository_id,root.repository_full_name,root.base_branch,root.initial_base_sha,
    root.initial_base_sha,null::text,null::uuid;
end;
$$;
revoke all on function internal.session_execution_input(uuid,uuid) from public,anon,authenticated;
grant execute on function internal.session_execution_input(uuid,uuid) to service_role;

create function internal.prepare_session_job_git_input(p_job_id uuid,p_checkpoint_run_id uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; prior public.session_job_git_inputs%rowtype; selected record; stage public.pipeline_stages%rowtype;
begin
  perform internal.assert_checkpoint_publication_service();
  select owner.* into s from public.sessions owner join public.agent_jobs candidate on candidate.session_id=owner.id
    where candidate.id=p_job_id for no key update of owner;
  if not found then raise exception 'Session not found.' using errcode='P0002'; end if;
  select * into j from public.agent_jobs where id=p_job_id for update;
  if j.workspace_id<>s.workspace_id or j.session_id<>s.id or (j.stage_id is not null and j.stage_id<>s.current_stage_id)
    or s.archived_at is not null then raise exception 'Git input does not match the current execution.' using errcode='23514'; end if;
  select * into prior from public.session_job_git_inputs where job_id=j.id;
  if found then
    if p_checkpoint_run_id is not null and prior.source_checkpoint_run_id is distinct from p_checkpoint_run_id then
      raise exception 'Git execution input is already selected for this job.' using errcode='23514';
    end if;
    return;
  end if;
  if j.status<>'queued' then raise exception 'Active execution has no pinned Git input.' using errcode='55000'; end if;
  select * into selected from internal.session_execution_input(s.id,s.workspace_id);
  if not found then return; end if; -- First execution resolves the initial root.
  if p_checkpoint_run_id is not null and selected.source_checkpoint_run_id is distinct from p_checkpoint_run_id then
    raise exception 'Reviewed Git checkpoint is not the current session head.' using errcode='55000';
  end if;
  -- A legacy producer may have a live run despite its queued job status.
  -- Known Git selection must precede execution; never retarget such work.
  perform 1 from public.agent_runs where agent_job_id=j.id order by id for update;
  if exists(select 1 from public.agent_runs where agent_job_id=j.id and status in ('started','running')) then
    raise exception 'Active execution has no pinned Git input.' using errcode='55000';
  end if;
  if j.stage_id is null then
    -- Canonical enqueue also adopts bare legacy queued jobs without making a
    -- synthetic run. Bind their missing stage only when Git selection exists;
    -- no-lineage legacy adoption remains completely unchanged.
    select * into stage from public.pipeline_stages where id=s.current_stage_id
      and workspace_id=s.workspace_id and pipeline_id=s.pipeline_id;
    if not found then raise exception 'Session references a missing stage.' using errcode='P0002'; end if;
    update public.agent_jobs set stage_id=stage.id,stage_slug=stage.slug,stage_name=stage.name
      where id=j.id and status='queued' and stage_id is null returning * into j;
    if not found then raise exception 'Git input does not match the current execution.' using errcode='23514'; end if;
  end if;
  insert into public.session_job_git_inputs(job_id,workspace_id,session_id,repository_id,repository_full_name,
    base_branch,initial_base_sha,input_sha,input_ref,source_checkpoint_run_id,pinned_run_id,pinned_attempt_count)
  values(j.id,s.workspace_id,s.id,selected.repository_id,selected.repository_full_name,selected.base_branch,
    selected.initial_base_sha,selected.input_sha,selected.input_ref,selected.source_checkpoint_run_id,null,null);
end;
$$;
revoke all on function internal.prepare_session_job_git_input(uuid,uuid) from public,anon,authenticated;
grant execute on function internal.prepare_session_job_git_input(uuid,uuid) to service_role;

create function internal.assert_reviewed_git_checkpoint(p_session_id uuid,p_workspace_id uuid,p_artifact_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare checkpoint_run uuid;
begin
  if not exists(select 1 from public.session_git_roots where session_id=p_session_id and workspace_id=p_workspace_id) then return null; end if;
  select run_id into checkpoint_run from public.session_git_checkpoints
    where artifact_id=p_artifact_id and session_id=p_session_id and workspace_id=p_workspace_id;
  if not found then
    raise exception 'Reviewed artifact has no restorable Git checkpoint. Start a new session with the intended source.' using errcode='55000';
  end if;
  if not exists(select 1 from public.session_git_heads where session_id=p_session_id and workspace_id=p_workspace_id
    and checkpoint_run_id=checkpoint_run) then
    raise exception 'Reviewed Git checkpoint is not the current session head.' using errcode='55000';
  end if;
  perform 1 from internal.checkpoint_execution_input(checkpoint_run,p_session_id,p_workspace_id);
  return checkpoint_run;
end;
$$;
revoke all on function internal.assert_reviewed_git_checkpoint(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function internal.assert_reviewed_git_checkpoint(uuid,uuid,uuid) to service_role;

-- Preserve existing root/checkpoint admission; only queued selection binding is mutable.
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
  selected record;
begin
  if tg_op = 'UPDATE' then
    if tg_table_name<>'session_job_git_inputs' then
      raise exception 'Git lineage is immutable.' using errcode='23514';
    end if;
    if old.pinned_run_id is not null or old.pinned_attempt_count is not null
      or new.pinned_run_id is null or new.pinned_attempt_count is null
      or new.job_id is distinct from old.job_id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id or new.repository_id is distinct from old.repository_id
      or new.repository_full_name is distinct from old.repository_full_name or new.base_branch is distinct from old.base_branch
      or new.initial_base_sha is distinct from old.initial_base_sha or new.input_sha is distinct from old.input_sha
      or new.input_ref is distinct from old.input_ref or new.source_checkpoint_run_id is distinct from old.source_checkpoint_run_id
      or new.created_at is distinct from old.created_at then
      raise exception 'Git lineage is immutable.' using errcode='23514';
    end if;
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
    if root.workspace_id is distinct from new.workspace_id or root.repository_id is distinct from new.repository_id
      or root.repository_full_name is distinct from new.repository_full_name
      or root.initial_base_sha is distinct from new.initial_base_sha or root.base_branch is distinct from new.base_branch
      or (s.github_repository_id is not null and s.github_repository_id<>new.repository_id)
      or j.session_id is distinct from s.id or j.workspace_id is distinct from s.workspace_id
      or j.stage_id is distinct from s.current_stage_id or s.archived_at is not null then
      raise exception 'Git input does not match the current execution.' using errcode='23514';
    end if;
    if new.source_checkpoint_run_id is null then
      if new.input_sha is distinct from root.initial_base_sha or new.input_ref is not null
        or (tg_op='INSERT' and exists(select 1 from public.session_git_heads where session_id=s.id)) then
        raise exception 'Git input does not match the current execution.' using errcode='23514';
      end if;
    else
      select * into selected from internal.checkpoint_execution_input(new.source_checkpoint_run_id,s.id,s.workspace_id);
      if selected.repository_id is distinct from new.repository_id
        or selected.repository_full_name is distinct from new.repository_full_name
        or selected.base_branch is distinct from new.base_branch or selected.initial_base_sha is distinct from new.initial_base_sha
        or selected.input_sha is distinct from new.input_sha or selected.input_ref is distinct from new.input_ref
        or (tg_op='INSERT' and not exists(select 1 from public.session_git_heads
          where session_id=s.id and workspace_id=s.workspace_id and checkpoint_run_id=new.source_checkpoint_run_id)) then
        raise exception 'Git input does not match the current execution.' using errcode='23514';
      end if;
    end if;
    if new.pinned_run_id is null and new.pinned_attempt_count is null then
      if tg_op<>'INSERT' or j.status<>'queued' or s.phase_status not in ('in_progress','rejected','awaiting_review') then
        raise exception 'Git input does not match the current execution.' using errcode='23514';
      end if;
    else
      select * into r from public.agent_runs where id=new.pinned_run_id for update;
      if j.status not in ('started','running') or j.attempt_count is distinct from new.pinned_attempt_count
        or r.agent_job_id is distinct from j.id or r.workspace_id is distinct from s.workspace_id
        or r.session_id is distinct from s.id or r.stage_id is distinct from j.stage_id
        or r.attempt_count is distinct from j.attempt_count or r.status is distinct from 'running'
        or s.phase_status is distinct from 'in_progress' then
        raise exception 'Git input does not match the current execution.' using errcode='23514';
      end if;
    end if;
  else
    select * into pinned from public.session_job_git_inputs where job_id=new.job_id;
    select * into j from public.agent_jobs where id=new.job_id for update;
    select * into r from public.agent_runs where id=new.run_id for update;
    select * into d from public.session_source_deliveries where run_id=new.run_id;
    if pinned.pinned_run_id is null or pinned.pinned_attempt_count is null
      or pinned.session_id is distinct from s.id or pinned.workspace_id is distinct from s.workspace_id
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


create function internal.pin_session_job_git_input(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_repository_id uuid,p_base_branch text,p_observed_sha text
) returns setof public.session_job_git_inputs language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype;
  root public.session_git_roots%rowtype; pinned public.session_job_git_inputs%rowtype;
  repository public.github_repositories%rowtype; selected record;
begin
  perform internal.assert_checkpoint_publication_service();
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
    if pinned.repository_id<>repository.id or pinned.repository_full_name<>repository.full_name or pinned.base_branch<>p_base_branch then
      raise exception 'Git execution input is already pinned.' using errcode='23514';
    end if;
    if pinned.input_sha is distinct from p_observed_sha then
      raise exception 'Observed Git input does not match the selected checkpoint.' using errcode='23514';
    end if;
    if pinned.pinned_run_id is null then
      update public.session_job_git_inputs set pinned_run_id=r.id,pinned_attempt_count=p_attempt_count
        where job_id=j.id returning * into pinned;
    end if;
    return next pinned;
    return;
  end if;
  select * into selected from internal.session_execution_input(s.id,s.workspace_id);
  if not found then raise exception 'Git execution input is unavailable.' using errcode='55000'; end if;
  if selected.input_sha is distinct from p_observed_sha then
    raise exception 'Observed Git input does not match the selected checkpoint.' using errcode='23514';
  end if;
  insert into public.session_job_git_inputs(job_id,workspace_id,session_id,repository_id,repository_full_name,
    base_branch,initial_base_sha,input_sha,input_ref,source_checkpoint_run_id,pinned_run_id,pinned_attempt_count)
  values(j.id,s.workspace_id,s.id,selected.repository_id,selected.repository_full_name,selected.base_branch,
    selected.initial_base_sha,selected.input_sha,selected.input_ref,selected.source_checkpoint_run_id,r.id,p_attempt_count) returning * into pinned;
  return next pinned;
end;
$$;


-- Only the fenced RPC can acquire the input row for its one-time binding.
-- A direct UPDATE would hold that row before its trigger takes session locks.
revoke update on public.session_job_git_inputs from service_role;
revoke all on function internal.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function internal.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text) to service_role;
create or replace function public.pin_session_job_git_input(
  p_job_id uuid,p_attempt_count integer,p_run_id uuid,p_repository_id uuid,p_base_branch text,p_observed_sha text
) returns setof public.session_job_git_inputs language sql security invoker set search_path='' as $$
  select * from internal.pin_session_job_git_input(p_job_id,p_attempt_count,p_run_id,p_repository_id,p_base_branch,p_observed_sha);
$$;
revoke all on function public.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.pin_session_job_git_input(uuid,integer,uuid,uuid,text,text) to service_role;

CREATE OR REPLACE FUNCTION public.enqueue_session_job_with_run(p_session_id uuid, p_workspace_id uuid, p_expected_stage_id uuid, p_requested_by_member_id uuid DEFAULT NULL::uuid, p_trigger_type public.agent_trigger_type DEFAULT 'assignment'::public.agent_trigger_type, p_agent_model_provider text DEFAULT NULL::text, p_agent_model_name text DEFAULT NULL::text, p_run_type text DEFAULT 'project'::text)
 RETURNS TABLE(job_id uuid, run_id uuid, created boolean)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  current_session public.sessions%rowtype;
  current_stage public.pipeline_stages%rowtype;
  active_job public.agent_jobs%rowtype;
  existing_run public.agent_runs%rowtype;
  queued_job_id uuid;
  queued_run_id uuid;
begin
  if nullif(btrim(p_agent_model_provider), '') is null
     or nullif(btrim(p_agent_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
  end if;
  if p_run_type is null or p_run_type not in ('project', 'code') then
    raise exception 'Run type must be project or code' using errcode = '22023';
  end if;

  select * into current_session from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
  if current_session.archived_at is not null then
    raise exception 'Session is archived.' using errcode = '55000';
  end if;
  if current_session.current_stage_id is distinct from p_expected_stage_id then
    raise exception 'Session stage changed.' using errcode = '55000';
  end if;
  if current_session.phase_status = 'approved' then
    raise exception 'Session is already complete.' using errcode = '55000';
  end if;
  if p_requested_by_member_id is not null and not exists (
    select 1 from public.workspace_members member
    where member.id = p_requested_by_member_id
      and member.workspace_id = p_workspace_id and member.is_active and member.kind = 'human'
  ) then
    raise exception 'Requester is not an active workspace member.' using errcode = '42501';
  end if;
  select * into current_stage from public.pipeline_stages
  where id = current_session.current_stage_id
    and pipeline_id = current_session.pipeline_id and workspace_id = p_workspace_id;
  if not found then raise exception 'Session references a missing stage.' using errcode = 'P0002'; end if;

  select * into active_job from public.agent_jobs
  where session_id = p_session_id and workspace_id = p_workspace_id
    and status in ('queued', 'started', 'running') for update;
  if not found then
    begin
      insert into public.agent_jobs(
        workspace_id, session_id, requested_by_member_id, stage_id, stage_slug, stage_name,
        trigger_type, status, dedupe_key
      ) values (
        p_workspace_id, p_session_id, p_requested_by_member_id,
        current_stage.id, current_stage.slug, current_stage.name, p_trigger_type, 'queued',
        'session:' || p_session_id::text || ':active'
      ) returning id into queued_job_id;
    exception when unique_violation then
      -- Direct legacy producers may insert after our initial lookup. The
      -- session's NO KEY UPDATE lock permits their FK KEY SHARE lock, so they
      -- can commit and we can adopt instead of deadlocking on the unique key.
      select * into active_job from public.agent_jobs
      where session_id = p_session_id and workspace_id = p_workspace_id
        and status in ('queued', 'started', 'running') for update;
      if not found then raise; end if;
    end;
  end if;
  if active_job.id is not null then
    if active_job.stage_id is not null and active_job.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000';
    end if;
    select * into existing_run from public.agent_runs
    where agent_job_id = active_job.id
    order by created_at desc, id desc limit 1;
    if existing_run.stage_id is not null and existing_run.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000';
    end if;
    -- Historical stage evidence above still matters when a previous attempt
    -- finished. Only an active execution can represent the adopted work.
    select * into existing_run from public.agent_runs
    where agent_job_id = active_job.id and status in ('queued', 'started', 'running')
    order by created_at desc, id desc limit 1;
    if existing_run.stage_id is not null and existing_run.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000';
    end if;
    if active_job.status='queued' then perform internal.prepare_session_job_git_input(active_job.id); end if;
    return query select active_job.id, existing_run.id, false;
    return;
  end if;

  insert into public.agent_runs(
    workspace_id, session_id, agent_job_id, triggered_by_member_id,
    stage_id, stage_slug, stage_name, run_type, model_provider, model_name, status
  ) values (
    p_workspace_id, p_session_id, queued_job_id, p_requested_by_member_id,
    current_stage.id, current_stage.slug, current_stage.name, p_run_type,
    btrim(p_agent_model_provider), btrim(p_agent_model_name), 'queued'
  ) returning id into queued_run_id;
  perform internal.prepare_session_job_git_input(queued_job_id);
  return query select queued_job_id, queued_run_id, true;
end;
$function$
;


CREATE OR REPLACE FUNCTION public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid, expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text, p_agent_model_name text, p_run_type text DEFAULT 'project'::text)
 RETURNS TABLE(id uuid, pipeline_id uuid, current_stage_id uuid, current_stage_slug text, phase_status public.pipeline_phase_status, workspace_id uuid, linear_issue_url text, archived_at timestamp with time zone, current_artifact_version integer, rejection_count integer, job_id uuid, run_id uuid, job_created boolean)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  reviewed_session public.sessions%rowtype;
  reviewed_stage public.pipeline_stages%rowtype;
  reviewer public.workspace_members%rowtype;
  next_stage public.pipeline_stages%rowtype;
  active_job public.agent_jobs%rowtype;
  published_run public.agent_runs%rowtype;
  queued_job_id uuid;
  queued_run_id uuid;
  queued_job_created boolean := false;
  approved_at_now timestamptz := now();
  reviewed_checkpoint uuid;
begin
  -- This lock serializes review, publication, rejection, and canonical enqueue.
  -- NO KEY UPDATE also permits a legacy producer's session FK KEY SHARE lock.
  select s.* into reviewed_session from public.sessions s
  where s.id = target_session_id and s.workspace_id = expected_workspace_id
  for no key update;
  if not found or reviewed_session.archived_at is not null
     or reviewed_session.phase_status <> 'awaiting_review'
     or reviewed_session.current_stage_id is distinct from expected_stage_id
     or reviewed_session.current_artifact_version is distinct from expected_version then
    return;
  end if;

  if reviewed_session.current_artifact_id is null then
    raise exception 'Review artifact identity is unavailable. Run this stage again before reviewing.' using errcode = '55000';
  end if;
  if reviewed_session.current_artifact_id is distinct from expected_artifact_id then return; end if;

  select stage.* into reviewed_stage from public.pipeline_stages stage
  where stage.id = expected_stage_id and stage.workspace_id = expected_workspace_id
    and stage.pipeline_id = reviewed_session.pipeline_id;
  if not found or not exists (
    select 1 from public.session_selected_stages selection
    where selection.session_id = reviewed_session.id
      and selection.workspace_id = reviewed_session.workspace_id
      and selection.stage_id = reviewed_stage.id
  ) then return; end if;
  -- Stage/version values can recur after an external reroute. The immutable
  -- artifact identity binds the decision to the markdown the reviewer saw.
  -- Slugs are editable labels; stored artifact slugs remain publication history.
  if not exists (
    select 1 from public.session_artifacts artifact
    where artifact.id = expected_artifact_id
      and artifact.session_id = reviewed_session.id
      and artifact.workspace_id = reviewed_session.workspace_id
      and artifact.stage_id = reviewed_stage.id
      and artifact.version = expected_version
  ) then return; end if;

  select member.* into reviewer from public.workspace_members member
  where member.id = approver_member_id and member.workspace_id = expected_workspace_id
    and member.is_active and member.kind = 'human';
  if not found then return; end if;
  if coalesce(reviewed_stage.anyone_can_approve, false) then
    null;
  elsif coalesce(array_length(reviewed_stage.approver_member_ids, 1), 0) > 0 then
    if not (reviewer.id = any(reviewed_stage.approver_member_ids)) then return; end if;
  elsif reviewer.role not in ('owner', 'admin') then
    return;
  end if;

  reviewed_checkpoint:=internal.assert_reviewed_git_checkpoint(reviewed_session.id,expected_workspace_id,expected_artifact_id);

  -- A publishing worker may still own the session's active queue key during
  -- PR delivery. Only its exact successful attempt is safe to complete here;
  -- queued/unpublished work is a competing intent, never silently canceled.
  select job.* into active_job from public.agent_jobs job
  where job.session_id = reviewed_session.id and job.workspace_id = expected_workspace_id
    and job.status in ('queued', 'started', 'running')
  for update;
  if found then
    select run.* into published_run from public.agent_runs run
    where run.agent_job_id = active_job.id
      and run.attempt_count = active_job.attempt_count
      and run.session_id = reviewed_session.id and run.workspace_id = expected_workspace_id
      and run.stage_id = reviewed_stage.id and run.status = 'success'
    for update;
    if not found or active_job.stage_id is distinct from reviewed_stage.id
       or not public.complete_session_job_attempt(active_job.id, active_job.attempt_count, published_run.id) then
      raise exception 'Session has active work that has not published the reviewed artifact.' using errcode = '55000';
    end if;
  end if;

  -- The session lock above also serializes this existence check with approval
  -- and Linear invalidation. Retain the first valid fact for the stable stage,
  -- including its original label, without discarding legacy decision history.
  insert into public.session_phase_completions (
    session_id, workspace_id, stage_id, stage_slug, completed_at, completed_by_member_id
  )
  select reviewed_session.id, expected_workspace_id, reviewed_stage.id, reviewed_stage.slug,
    approved_at_now, reviewer.id
  where not exists (
    select 1 from public.session_phase_completions completion
    where completion.session_id = reviewed_session.id and completion.stage_id = reviewed_stage.id
  );

  select stage.* into next_stage from public.pipeline_stages stage
  join public.session_selected_stages selection
    on selection.stage_id = stage.id and selection.session_id = reviewed_session.id
      and selection.workspace_id = expected_workspace_id
  where stage.pipeline_id = reviewed_session.pipeline_id
    and stage.workspace_id = expected_workspace_id and stage.position > reviewed_stage.position
  order by stage.position asc limit 1;

  if next_stage.id is null then
    update public.sessions s set phase_status = 'approved',
      archived_at = case when s.linear_issue_id is null or not exists (
        select 1 from public.workspace_linear_routing routing
        where routing.workspace_id = expected_workspace_id and routing.land_stage_slug is null
      ) then approved_at_now else s.archived_at end
    where s.id = reviewed_session.id;
  else
    update public.sessions s set current_stage_id = next_stage.id, current_artifact_id = null, phase_status = 'in_progress',
      current_artifact_version = coalesce((
        select max(artifact.version) from public.session_artifacts artifact
        where artifact.session_id = reviewed_session.id and artifact.stage_id = next_stage.id
      ), 0), rejection_count = 0
    where s.id = reviewed_session.id;

    select queued.job_id, queued.run_id, queued.created
    into queued_job_id, queued_run_id, queued_job_created
    from public.enqueue_session_job_with_run(
      reviewed_session.id, expected_workspace_id, next_stage.id, reviewer.id, 'assignment',
      p_agent_model_provider, p_agent_model_name, p_run_type
    ) queued;
    if reviewed_checkpoint is not null then
      perform internal.prepare_session_job_git_input(queued_job_id,reviewed_checkpoint);
    end if;
    if queued_run_id is null then
      -- A concurrent legacy producer can win the queue-key INSERT without a
      -- run. The canonical helper holds its job lock; only queued work can be
      -- given a placeholder safely, before any worker claim/bootstrap.
      select job.* into active_job from public.agent_jobs job
      where job.id = queued_job_id and job.session_id = reviewed_session.id
        and job.workspace_id = expected_workspace_id for update;
      if not found or active_job.status <> 'queued' then
        raise exception 'Next stage job has no queued execution.' using errcode = '55000';
      end if;
      insert into public.agent_runs(
        workspace_id, session_id, agent_job_id, triggered_by_member_id,
        stage_id, stage_slug, stage_name, run_type, model_provider, model_name, status
      ) values (
        expected_workspace_id, reviewed_session.id, queued_job_id, reviewer.id,
        next_stage.id, next_stage.slug, next_stage.name, p_run_type,
        btrim(p_agent_model_provider), btrim(p_agent_model_name), 'queued'
      ) returning agent_runs.id into queued_run_id;
    end if;
  end if;

  return query select s.id, s.pipeline_id, s.current_stage_id, stage.slug, s.phase_status,
    s.workspace_id, s.linear_issue_url, s.archived_at, s.current_artifact_version, s.rejection_count,
    queued_job_id, queued_run_id, queued_job_created
  from public.sessions s join public.pipeline_stages stage on stage.id = s.current_stage_id
  where s.id = reviewed_session.id;
end;
$function$
;


CREATE OR REPLACE FUNCTION public.reject_session_stage(p_session_id uuid, p_workspace_id uuid, p_artifact_version integer, p_feedback_text text, p_agent_model_provider text, p_agent_model_name text, p_expected_stage_id uuid, p_expected_artifact_id uuid, p_run_type text DEFAULT 'project'::text, p_requested_by_member_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(session_id uuid, workspace_id uuid, current_stage_id uuid, current_artifact_version integer, phase_status public.pipeline_phase_status, rejection_count integer, archived_at timestamp with time zone, job_id uuid, run_id uuid, job_created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare reviewed_session public.sessions%rowtype; reviewed_checkpoint uuid; successor record;
begin
  select s.* into reviewed_session from public.sessions s
  where s.id = p_session_id and s.workspace_id = p_workspace_id for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
  if reviewed_session.archived_at is not null then
    raise exception 'Session is archived.' using errcode = '55000';
  end if;
  if reviewed_session.phase_status <> 'awaiting_review' then
    raise exception 'Session is not awaiting review.' using errcode = '55000';
  end if;
  if reviewed_session.current_artifact_version is distinct from p_artifact_version then
    raise exception 'Version mismatch: a newer version exists.' using errcode = '55000';
  end if;
  if reviewed_session.current_artifact_id is null then
    raise exception 'Review artifact identity is unavailable. Run this stage again before reviewing.' using errcode = '55000';
  end if;
  if reviewed_session.current_artifact_id is distinct from p_expected_artifact_id
     or reviewed_session.current_stage_id is distinct from p_expected_stage_id
     or not exists (
       select 1 from public.session_artifacts artifact
       where artifact.id = p_expected_artifact_id and artifact.session_id = p_session_id
         and artifact.workspace_id = p_workspace_id and artifact.stage_id = p_expected_stage_id
         and artifact.version = p_artifact_version
     ) then
    raise exception 'Review artifact changed. Refresh and try again.' using errcode = '55000';
  end if;
  reviewed_checkpoint:=internal.assert_reviewed_git_checkpoint(p_session_id,p_workspace_id,p_expected_artifact_id);
  -- The legacy rejection body may retire an active attempt. Lock jobs before
  -- runs here so its internal updates cannot invert lifecycle lock order.
  perform 1 from public.agent_jobs where agent_jobs.session_id=p_session_id order by id for update;
  perform 1 from public.agent_runs where agent_runs.session_id=p_session_id order by id for update;
  for successor in select * from internal.reject_session_stage(
    p_session_id,p_workspace_id,p_artifact_version,p_feedback_text,
    p_agent_model_provider,p_agent_model_name,p_run_type,p_requested_by_member_id
  ) loop
    if reviewed_checkpoint is not null then
      perform internal.prepare_session_job_git_input(successor.job_id,reviewed_checkpoint);
    end if;
    return query select successor.session_id,successor.workspace_id,successor.current_stage_id,
      successor.current_artifact_version,successor.phase_status,successor.rejection_count,
      successor.archived_at,successor.job_id,successor.run_id,successor.job_created;
  end loop;
end;
$function$
;


-- Preselected queued input is not evidence of an observed execution checkout.
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
  if not found or pinned.pinned_run_id is null or pinned.pinned_attempt_count is null
    or pinned.repository_id is distinct from p_repository_id or pinned.base_branch is distinct from p_base_branch
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


create or replace function internal.checkpoint_publication_is_current(p public.session_checkpoint_publications)
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
      and i.pinned_run_id is not null and i.pinned_attempt_count is not null
      and i.repository_id=d.repository_id and i.repository_full_name=d.repository_full_name
      and repo.full_name=d.repository_full_name and i.base_branch=d.base_branch and i.input_sha=d.base_sha
      and (s.github_repository_id is null or s.github_repository_id=d.repository_id)
      and (d.base_sha=d.head_sha or (d.bundle_sha256 is not null and (d.checkpoint_path is not null or d.bundle_base64 is not null)))
      and p.retained_ref is not distinct from case when d.base_sha<>d.head_sha
        then 'refs/heads/wallie/checkpoints/'||r.id::text||'/'||d.head_sha end
  );
$$;


-- Rerouting also clears current_artifact_id before canonical enqueue. Known
-- untracked output must be diagnosed before that review identity disappears.
create function internal.guard_git_review_handoff()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.current_artifact_id is not null
    and (new.current_artifact_id is null or new.current_stage_id is distinct from old.current_stage_id)
    and exists(select 1 from public.session_git_roots root where root.session_id=old.id and root.workspace_id=old.workspace_id)
    and exists(select 1 from public.sessions owner where owner.id=old.id)
    and exists(select 1 from public.workspaces owner where owner.id=old.workspace_id)
    and not exists(select 1 from public.session_git_checkpoints checkpoint
      where checkpoint.artifact_id=old.current_artifact_id and checkpoint.session_id=old.id and checkpoint.workspace_id=old.workspace_id) then
    raise exception 'Reviewed artifact has no restorable Git checkpoint. Start a new session with the intended source.' using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_git_review_handoff() from public,anon,authenticated;
grant execute on function internal.guard_git_review_handoff() to service_role;
create trigger guard_git_review_handoff before update of current_artifact_id,current_stage_id on public.sessions
  for each row execute function internal.guard_git_review_handoff();
