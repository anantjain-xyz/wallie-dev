-- New checkpoint and fence refs live outside refs/heads so only the canonical
-- PR branch participates in branch-triggered deployments. Existing intents and
-- epochs keep their exact targets for retries and lost-response recovery.
create function internal.is_wallie_checkpoint_ref(value text)
returns boolean language sql immutable strict security invoker set search_path='' as $$
  select value ~ '^refs/wallie/checkpoints/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/[a-f0-9]{40}$';
$$;

create function internal.retained_checkpoint_ref_matches(p_ref text,p_run_id uuid,p_sha text)
returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(p_ref in (
    'refs/wallie/checkpoints/'||p_run_id::text||'/'||p_sha,
    'refs/heads/wallie/checkpoints/'||p_run_id::text||'/'||p_sha
  ),false);
$$;

revoke all on function internal.is_wallie_checkpoint_ref(text),
  internal.retained_checkpoint_ref_matches(text,uuid,text) from public,anon,authenticated;
grant execute on function internal.is_wallie_checkpoint_ref(text),
  internal.retained_checkpoint_ref_matches(text,uuid,text) to service_role;

-- Restore and PR synchronization can read both proven checkpoint refs and
-- historical branch receipts. The legacy delivery receipt stays branch-only.
alter table public.session_job_git_inputs
  drop constraint session_job_git_inputs_input_ref_check,
  add constraint session_job_git_inputs_input_ref_check
    check(internal.is_git_branch_ref(input_ref) or internal.is_wallie_checkpoint_ref(input_ref));

alter table public.session_git_checkpoints
  drop constraint session_git_checkpoints_output_ref_check,
  add constraint session_git_checkpoints_output_ref_check
    check(output_ref like 'refs/heads/%' or internal.is_wallie_checkpoint_ref(output_ref));

alter table public.session_pr_operations
  drop constraint session_pr_operations_source_ref_check,
  add constraint session_pr_operations_source_ref_check
    check(internal.is_git_branch_ref(source_ref) or internal.is_wallie_checkpoint_ref(source_ref));

alter table public.session_checkpoint_publications
  drop constraint session_checkpoint_publications_retained_ref_check,
  add constraint session_checkpoint_publications_retained_ref_check
    check(internal.is_git_branch_ref(retained_ref) or internal.is_wallie_checkpoint_ref(retained_ref));

alter table public.session_checkpoint_cleanup
  drop constraint session_checkpoint_cleanup_retained_ref_check,
  add constraint session_checkpoint_cleanup_retained_ref_check
    check(internal.retained_checkpoint_ref_matches(retained_ref,run_id,expected_sha));

alter table public.session_pr_epochs
  drop constraint session_pr_epochs_fence_branch_check,
  add constraint session_pr_epochs_fence_branch_check
    check(fence_branch in ('wallie/session-fences/'||id::text,'refs/wallie/fences/'||id::text));
comment on column public.session_pr_epochs.fence_branch is
  'Immutable remote fence target. Legacy epochs store the branch name without refs/heads/; newer epochs store the full refs/wallie/fences/ ref.';

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
      and installation.workspace_id=repo.workspace_id and not installation.suspended and installation.installation_id=d.installation_id
    where s.id=p.session_id and w.id=p.workspace_id and w.deletion_requested_at is null
      and s.archived_at is null and s.execution_exhausted_at is null and s.phase_status='in_progress'
      and s.current_stage_id=j.stage_id and s.current_artifact_version=p.expected_artifact_version
      and j.status in ('started','running') and j.attempt_count=p.attempt_count
      and r.status='running' and r.attempt_count=p.attempt_count and r.stage_id=j.stage_id
      and d.attempt_count=p.attempt_count and d.branch_name=r.branch_name
      and i.repository_id=d.repository_id and i.repository_full_name=d.repository_full_name
      and repo.full_name=d.repository_full_name and i.base_branch=d.base_branch and i.input_sha=d.base_sha
      and (s.github_repository_id is null or s.github_repository_id=d.repository_id)
      and (d.base_sha=d.head_sha or (d.bundle_sha256 is not null and (d.checkpoint_path is not null or d.bundle_base64 is not null)))
      and case when d.base_sha<>d.head_sha
        then internal.retained_checkpoint_ref_matches(p.retained_ref,r.id,d.head_sha)
        else p.retained_ref is null end
  );
$$;

create or replace function internal.guard_checkpoint_publication()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id)
      or not exists(select 1 from public.sessions where id=old.session_id) then return old; end if;
    raise exception 'Checkpoint publication intent is immutable.' using errcode='23514';
  end if;
  if tg_op='UPDATE' then
    if new.run_id is distinct from old.run_id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id or new.job_id is distinct from old.job_id
      or new.attempt_count is distinct from old.attempt_count
      or new.expected_artifact_version is distinct from old.expected_artifact_version
      or new.artifact_md is distinct from old.artifact_md or new.deadline_at is distinct from old.deadline_at
      or new.retained_ref is distinct from old.retained_ref or new.created_at is distinct from old.created_at
      or (old.remote_verified_at is not null and (new.remote_verified_at is distinct from old.remote_verified_at
        or new.remote_verified_ref is distinct from old.remote_verified_ref or new.remote_verified_sha is distinct from old.remote_verified_sha))
      or (old.status='adopted' and new is distinct from old) then
      raise exception 'Checkpoint publication intent is immutable.' using errcode='23514';
    end if;
  elsif (new.retained_ref is not null and not internal.is_wallie_checkpoint_ref(new.retained_ref))
    or not internal.checkpoint_publication_is_current(new) then
    raise exception 'Checkpoint publication does not match the current execution.' using errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function internal.prepare_session_checkpoint_publication(
  p_run_id uuid,p_expected_artifact_version integer,p_artifact_md text,p_deadline_at timestamptz default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; j public.agent_jobs%rowtype; r public.agent_runs%rowtype;
  d public.session_source_deliveries%rowtype; prior public.session_checkpoint_publications%rowtype;
  new_intent public.session_checkpoint_publications%rowtype;
begin
  perform internal.assert_checkpoint_publication_service();
  select owner.* into s from public.sessions owner join public.agent_runs observed_run on observed_run.session_id=owner.id
    where observed_run.id=p_run_id for no key update of owner;
  if not found then return false; end if;
  select job.* into j from public.agent_jobs job join public.agent_runs observed_run on observed_run.agent_job_id=job.id
    where observed_run.id=p_run_id for update of job;
  if not found then return false; end if;
  select * into r from public.agent_runs where id=p_run_id for update;
  if not found then return false; end if;
  select * into d from public.session_source_deliveries where run_id=p_run_id for update;
  if not found then return false; end if;
  select * into prior from public.session_checkpoint_publications where run_id=p_run_id for update;
  if found then
    if prior.expected_artifact_version is distinct from p_expected_artifact_version
      or prior.artifact_md is distinct from p_artifact_md
      or (p_deadline_at is not null and prior.deadline_at is distinct from p_deadline_at) then
      raise exception 'Checkpoint publication intent is immutable.' using errcode='23514';
    end if;
    return true;
  end if;
  new_intent.run_id:=p_run_id; new_intent.workspace_id:=s.workspace_id; new_intent.session_id:=s.id;
  new_intent.job_id:=j.id; new_intent.attempt_count:=r.attempt_count;
  new_intent.expected_artifact_version:=p_expected_artifact_version; new_intent.artifact_md:=p_artifact_md;
  new_intent.deadline_at:=coalesce(p_deadline_at,r.started_at+interval '30 minutes');
  new_intent.retained_ref:=case when d.base_sha<>d.head_sha then 'refs/wallie/checkpoints/'||r.id::text||'/'||d.head_sha end;
  if not internal.checkpoint_publication_is_current(new_intent) then return false; end if;
  perform internal.assert_workspace_accepts_work(s.workspace_id);
  insert into public.session_checkpoint_publications(run_id,workspace_id,session_id,job_id,attempt_count,
    expected_artifact_version,artifact_md,deadline_at,retained_ref)
  values(new_intent.run_id,new_intent.workspace_id,new_intent.session_id,new_intent.job_id,new_intent.attempt_count,
    new_intent.expected_artifact_version,new_intent.artifact_md,new_intent.deadline_at,new_intent.retained_ref);
  return true;
end;
$$;

create or replace function internal.guard_session_pr_protocol()
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
      or (tg_op='INSERT' and new.fence_branch<>'refs/wallie/fences/'||new.id::text) then
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

create or replace function internal.claim_session_pr_sync_before_release(p_session_id uuid default null)
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
        'refs/wallie/fences/'||new_epoch_id::text) returning * into epoch;
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

create or replace function internal.authorize_session_pr_successor(p_actor_user_id uuid,p_session_id uuid,p_expected_epoch_id uuid,p_request_id uuid)
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
    'refs/wallie/fences/'||next_epoch::text) returning id into next_epoch;
  insert into internal.session_pr_successor_requests(workspace_id,actor_user_id,request_id,session_id,expected_epoch_id,successor_epoch_id)
  values(session.workspace_id,p_actor_user_id,p_request_id,session.id,p_expected_epoch_id,next_epoch);
  update public.session_pr_sync set current_epoch_id=next_epoch,status='pending',observed_head_sha=null,observed_fence_sha=null,
    observed_pr_head_sha=null,last_error_code=null,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where session_id=session.id;
  return next_epoch;
end;
$$;

create or replace function internal.checkpoint_cleanup_has_safe_ref(p_repository_id uuid,p_sha text,p_ref text,p_excluded_ref text)
returns boolean language sql stable security invoker set search_path='' as $$
  select p_ref is not null and p_ref is distinct from p_excluded_ref and exists(
    select 1 from public.session_git_checkpoints c join public.session_checkpoint_publications p on p.run_id=c.run_id
    where c.repository_id=p_repository_id and c.output_sha=p_sha and c.output_kind='code'
      and c.output_ref=p_ref and p.status='adopted' and p.remote_verified_ref=p_ref
      and p.remote_verified_sha=p_sha and p.remote_verified_at is not null
      and internal.retained_checkpoint_ref_matches(p_ref,c.run_id,p_sha)
  );
$$;

create or replace function internal.guard_checkpoint_cleanup()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.sessions where id=old.session_id)
      or not exists(select 1 from public.workspaces where id=old.workspace_id) then return old; end if;
    raise exception 'Checkpoint cleanup history is retained until session cleanup.' using errcode='23514';
  end if;
  if tg_op='UPDATE' then
    if not exists(select 1 from public.sessions where id=old.session_id)
      or not exists(select 1 from public.workspaces where id=old.workspace_id) then return new; end if;
    if new.run_id is distinct from old.run_id or new.workspace_id is distinct from old.workspace_id
      or new.session_id is distinct from old.session_id or new.job_id is distinct from old.job_id
      or new.attempt_count is distinct from old.attempt_count or new.repository_id is distinct from old.repository_id
      or new.repository_full_name is distinct from old.repository_full_name or new.github_repository_id is distinct from old.github_repository_id
      or new.retained_ref is distinct from old.retained_ref or new.expected_sha is distinct from old.expected_sha
      or new.eligible_after is distinct from old.eligible_after or new.created_at is distinct from old.created_at
      or new.cleanup_attempt_count<old.cleanup_attempt_count
      or (old.remote_absent_at is not null and (new.remote_absent_at is distinct from old.remote_absent_at or new.status is distinct from old.status)) then
      raise exception 'Checkpoint cleanup identity and accepted receipt are immutable.' using errcode='23514';
    end if;
  end if;
  if not exists(select 1 from public.session_checkpoint_publications p
    join public.session_source_deliveries d on d.run_id=p.run_id join public.session_job_git_inputs i on i.job_id=p.job_id
    where p.run_id=new.run_id and p.workspace_id=new.workspace_id and p.session_id=new.session_id
      and p.job_id=new.job_id and p.attempt_count=new.attempt_count and p.retained_ref=new.retained_ref
      and i.repository_id=new.repository_id and i.repository_full_name=new.repository_full_name
      and d.head_sha=new.expected_sha and d.base_sha<>d.head_sha and new.eligible_after=p.deadline_at+interval '7 days'
      and internal.retained_checkpoint_ref_matches(new.retained_ref,new.run_id,new.expected_sha)) then
    raise exception 'Checkpoint cleanup does not match its publication candidate.' using errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function internal.claim_session_checkpoint_cleanup(p_run_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare candidate record; p public.session_checkpoint_publications; j public.agent_jobs; r public.agent_runs;
  d public.session_source_deliveries; pinned public.session_job_git_inputs; cleanup public.session_checkpoint_cleanup;
  repository public.github_repositories; claim uuid; blocked text;
begin
  perform internal.assert_checkpoint_publication_service();
  for candidate in select publication.run_id,publication.workspace_id,publication.session_id,publication.job_id
    from public.session_checkpoint_publications publication left join public.session_checkpoint_cleanup prior on prior.run_id=publication.run_id
    where (p_run_id is null or publication.run_id=p_run_id) and publication.status<>'adopted' and publication.retained_ref is not null
      and publication.deadline_at+interval '7 days'<=clock_timestamp()
      and (prior.run_id is null or (prior.status<>'deleted' and prior.next_attempt_at<=clock_timestamp()
        and (prior.status<>'claimed' or prior.lease_expires_at<=clock_timestamp())))
    order by publication.deadline_at,publication.run_id limit 100
  loop
    perform 1 from public.workspaces where id=candidate.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions where id=candidate.session_id for no key update skip locked;
    if not found then continue; end if;
    select * into j from public.agent_jobs where id=candidate.job_id for update skip locked;
    if not found then continue; end if;
    select * into r from public.agent_runs where id=candidate.run_id for update skip locked;
    if not found then continue; end if;
    select * into p from public.session_checkpoint_publications where run_id=candidate.run_id for update skip locked;
    if not found or p.status='adopted' or p.artifact_id is not null or p.deadline_at+interval '7 days'>clock_timestamp()
      or r.status='success' or exists(select 1 from public.session_git_checkpoints where run_id=p.run_id) then continue; end if;
    select * into d from public.session_source_deliveries where run_id=p.run_id;
    select * into pinned from public.session_job_git_inputs where job_id=p.job_id;
    if not found or p.workspace_id<>j.workspace_id or p.session_id<>j.session_id or r.agent_job_id is distinct from j.id
      or r.workspace_id<>p.workspace_id or r.session_id<>p.session_id or r.attempt_count is distinct from p.attempt_count
      or d.workspace_id<>p.workspace_id or d.session_id<>p.session_id or d.job_id<>p.job_id
      or d.attempt_count<>p.attempt_count or d.base_sha=d.head_sha
      or not internal.retained_checkpoint_ref_matches(p.retained_ref,p.run_id,d.head_sha) then continue; end if;
    perform pg_catalog.pg_advisory_xact_lock(internal.checkpoint_cleanup_lock_key(pinned.repository_id,d.head_sha));
    select * into cleanup from public.session_checkpoint_cleanup where run_id=p.run_id for update;
    if found and (cleanup.status='deleted' or cleanup.next_attempt_at>clock_timestamp()
      or (cleanup.status='claimed' and cleanup.lease_expires_at>clock_timestamp())) then continue; end if;
    blocked:=null;
    if p.lease_expires_at>clock_timestamp() then blocked:='live_publication_lease'; end if;
    if blocked is null and j.attempt_count=p.attempt_count and j.status in ('started','running') and r.status in ('queued','started','running') then
      perform public.fail_session_job_attempt(j.id,p.attempt_count,'Checkpoint candidate expired before adoption.',false,0,p.run_id);
      select * into j from public.agent_jobs where id=j.id;
      select * into r from public.agent_runs where id=p.run_id;
    end if;
    if blocked is null and j.attempt_count=p.attempt_count and r.status in ('queued','started','running') then blocked:='live_execution'; end if;
    if blocked is null then
      update public.session_checkpoint_publications set status='stale',claim_id=null,lease_expires_at=null,last_error_code='publication_deadline_exceeded'
        where run_id=p.run_id;
      p.status:='stale';
    end if;
    select repo.* into repository from public.github_repositories repo
      join public.github_installations installation on installation.id=repo.github_installation_id
      where repo.id=pinned.repository_id and repo.workspace_id=p.workspace_id and not repo.is_archived
        and repo.full_name=pinned.repository_full_name and installation.workspace_id=p.workspace_id and not installation.suspended
        and repo.repo_id between 1 and 9007199254740991;
    if not found and blocked is null then blocked:='repository_unavailable'; end if;
    if cleanup.run_id is null then
      insert into public.session_checkpoint_cleanup(run_id,workspace_id,session_id,job_id,attempt_count,repository_id,
        repository_full_name,github_repository_id,retained_ref,expected_sha,eligible_after)
      values(p.run_id,p.workspace_id,p.session_id,p.job_id,p.attempt_count,pinned.repository_id,pinned.repository_full_name,
        repository.repo_id,p.retained_ref,d.head_sha,p.deadline_at+interval '7 days') returning * into cleanup;
    end if;
    if cleanup.github_repository_id is null or (repository.id is not null and cleanup.github_repository_id<>repository.repo_id) then
      blocked:=coalesce(blocked,'repository_identity_unknown');
    end if;
    if blocked is null and internal.checkpoint_cleanup_ref_is_protected(cleanup.repository_id,cleanup.expected_sha,cleanup.retained_ref,cleanup.run_id) then
      blocked:='referenced';
    end if;
    if blocked is not null then
      update public.session_checkpoint_cleanup set status='blocked',claim_id=null,lease_expires_at=null,last_error_code=blocked,
        next_attempt_at=clock_timestamp()+interval '1 hour' where run_id=p.run_id;
      continue;
    end if;
    claim:=pg_catalog.gen_random_uuid();
    update public.session_checkpoint_cleanup set status='claimed',claim_id=claim,lease_expires_at=clock_timestamp()+interval '2 minutes',
      cleanup_attempt_count=cleanup_attempt_count+1,last_error_code=null where run_id=p.run_id;
    return claim;
  end loop;
  return null;
end;
$$;
