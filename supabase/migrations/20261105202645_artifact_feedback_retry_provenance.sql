-- A batch is an immutable feedback generation. Manual retry jobs bind to that
-- generation only when their owned attempt starts, after session -> job -> run
-- locking. A queued manual job can still be adopted by a newer explicit review.
create table public.artifact_feedback_batch_jobs (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  batch_id uuid not null references public.artifact_feedback_batches(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
create index artifact_feedback_batch_jobs_batch_idx on public.artifact_feedback_batch_jobs(batch_id);
create index artifact_feedback_batch_jobs_workspace_idx on public.artifact_feedback_batch_jobs(workspace_id);
create index artifact_feedback_batch_jobs_session_idx on public.artifact_feedback_batch_jobs(session_id);
alter table public.artifact_feedback_batch_jobs enable row level security;
revoke all on public.artifact_feedback_batch_jobs from public, anon, authenticated, service_role;
grant select on public.artifact_feedback_batch_jobs to authenticated, service_role;
create policy artifact_feedback_batch_jobs_read on public.artifact_feedback_batch_jobs
  for select to authenticated using (workspace_id in (select internal.current_user_workspace_ids()));

-- Only original batch/job provenance is knowable before this migration. Never
-- infer historical manual retry inputs from timestamps or mutable feedback.
insert into public.artifact_feedback_batch_jobs(job_id,batch_id,workspace_id,session_id)
select job_id,id,workspace_id,session_id from public.artifact_feedback_batches;

create function internal.guard_artifact_feedback_batch_job()
returns trigger language plpgsql security invoker set search_path='' as $$
declare batch public.artifact_feedback_batches; job public.agent_jobs; owner public.sessions;
begin
  if tg_op='DELETE' and (
    not exists(select 1 from public.agent_jobs where id=old.job_id)
    or not exists(select 1 from public.artifact_feedback_batches where id=old.batch_id)
    or not exists(select 1 from public.sessions where id=old.session_id)
    or not exists(select 1 from public.workspaces where id=old.workspace_id)
  ) then return old; end if;
  if tg_op<>'INSERT' then
    raise exception 'A consumed feedback generation cannot be rewritten.' using errcode='23514';
  end if;
  select * into batch from public.artifact_feedback_batches where id=new.batch_id;
  select * into job from public.agent_jobs where id=new.job_id;
  select * into owner from public.sessions where id=new.session_id;
  if batch.id is null or job.id is null or owner.id is null
    or new.workspace_id<>batch.workspace_id or new.session_id<>batch.session_id
    or job.workspace_id<>new.workspace_id or job.session_id<>new.session_id
    or job.stage_id is distinct from batch.stage_id then
    raise exception 'Feedback provenance must belong to the exact session and stage.' using errcode='23514';
  end if;
  if job.id<>batch.job_id and (
    job.trigger_type<>'manual_retry' or job.status not in ('started','running')
    or owner.archived_at is not null or owner.phase_status<>'in_progress'
    or owner.current_stage_id is distinct from batch.stage_id
    or owner.rejection_count<>batch.rejection_count
    or owner.current_artifact_version<batch.artifact_version
    or not exists(select 1 from public.agent_runs r where r.agent_job_id=job.id
      and r.workspace_id=job.workspace_id and r.session_id=job.session_id
      and r.stage_id=batch.stage_id and r.attempt_count=job.attempt_count and r.status='running')
  ) then
    raise exception 'Only an owned manual retry can inherit this feedback generation.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_artifact_feedback_batch_job() from public,anon,authenticated,service_role;
create trigger guard_artifact_feedback_batch_job before insert or update or delete
  on public.artifact_feedback_batch_jobs for each row execute function internal.guard_artifact_feedback_batch_job();

create function internal.link_original_artifact_feedback_job()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  insert into public.artifact_feedback_batch_jobs(job_id,batch_id,workspace_id,session_id)
    values(new.job_id,new.id,new.workspace_id,new.session_id);
  return new;
end;
$$;
revoke all on function internal.link_original_artifact_feedback_job() from public,anon,authenticated,service_role;
create trigger link_original_artifact_feedback_job after insert on public.artifact_feedback_batches
  for each row execute function internal.link_original_artifact_feedback_job();

create function internal.bind_manual_retry_feedback(p_job_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare job public.agent_jobs; owner public.sessions; candidates uuid[];
begin
  -- Called only after the owned start has locked session, job and executions.
  if exists(select 1 from public.artifact_feedback_batch_jobs where job_id=p_job_id) then return; end if;
  select * into strict job from public.agent_jobs where id=p_job_id;
  if job.trigger_type<>'manual_retry' then return; end if;
  select * into strict owner from public.sessions where id=job.session_id and workspace_id=job.workspace_id;
  select array_agg(b.id) into candidates from public.artifact_feedback_batches b
    where b.workspace_id=job.workspace_id and b.session_id=job.session_id and b.stage_id=job.stage_id
      and b.rejection_count=owner.rejection_count and b.artifact_version<=owner.current_artifact_version;
  if cardinality(candidates)>1 then
    raise exception 'Feedback generation is ambiguous.' using errcode='23514';
  end if;
  if cardinality(candidates)=1 then
    insert into public.artifact_feedback_batch_jobs(job_id,batch_id,workspace_id,session_id)
      values(job.id,candidates[1],job.workspace_id,job.session_id);
  end if;
end;
$$;
revoke all on function internal.bind_manual_retry_feedback(uuid) from public,anon,authenticated,service_role;

-- Underlying reads retain RLS and never join the private agent_jobs table.
create view public.artifact_feedback_outputs with (security_invoker=true) as
select link.workspace_id,link.session_id,link.batch_id,link.job_id,
  checkpoint.run_id,checkpoint.artifact_id,artifact.version as artifact_version,
  artifact.created_at
from public.artifact_feedback_batch_jobs link
join public.session_git_checkpoints checkpoint on checkpoint.job_id=link.job_id
  and checkpoint.session_id=link.session_id and checkpoint.workspace_id=link.workspace_id
join public.session_artifacts artifact on artifact.id=checkpoint.artifact_id
  and artifact.session_id=link.session_id and artifact.workspace_id=link.workspace_id;
revoke all on public.artifact_feedback_outputs from public,anon,authenticated,service_role;
grant select on public.artifact_feedback_outputs to authenticated,service_role;
comment on table public.artifact_feedback_batch_jobs is
  'Immutable consumed feedback generation per job. Original submissions link atomically; manual retry jobs bind only at owned attempt start. Later review edits cannot change their prompt input.';
comment on view public.artifact_feedback_outputs is
  'All accepted outputs of a feedback generation, including manual retry jobs. Security invoker preserves active-member tenant RLS without exposing private jobs.';

create or replace function internal.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control; job public.agent_jobs; session public.sessions; execution_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  select * into job from public.agent_jobs where id=p_job_id;
  -- A refused/unclaimed identity never reaches release admission. Preserve
  -- the original NULL receipt rather than labeling unrelated stale work paused.
  if not found or p_attempt_count is null or p_attempt_count<=0 or job.attempt_count<>p_attempt_count
    or job.status not in('started','running') then return null; end if;
  select * into session from public.sessions where id=job.session_id and workspace_id=job.workspace_id;
  if not found then return null; end if;
  if session.pipeline_id is not null and (not control.enabled or job.git_continuity_release_revision is distinct from control.revision
    or not exists(select 1 from public.session_git_continuity_enrollments e where e.session_id=session.id and e.workspace_id=session.workspace_id)) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode='P499P';
  end if;
  perform 1 from public.workspaces where id=job.workspace_id for share;
  if not found then return null; end if;
  perform internal.assert_workspace_accepts_work(job.workspace_id);
  execution_id := internal.start_session_job_attempt_before_release(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
    p_model_provider,p_model_name,p_run_type,p_branch_name);
  if execution_id is not null then perform internal.bind_manual_retry_feedback(p_job_id); end if;
  return execution_id;
end;
$$;
