-- Keep the initial and repeated Git input pins inside the session factory.
create or replace function internal.pin_session_job_git_input(
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
    where id=p_repository_id and workspace_id=s.workspace_id
      and factory_id=s.factory_id and not is_archived;
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
