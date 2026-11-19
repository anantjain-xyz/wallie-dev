-- The visual portion of a version-2 plan is instructions only. Command
-- instructions and receipts keep their existing validation and ownership.
create function internal.is_browser_verification_plan(value jsonb)
returns boolean language plpgsql immutable security invoker set search_path='' as $$
declare check_spec jsonb; step jsonb; capture jsonb; exclude_id jsonb;
  keys text[]:='{}'; kinds text[]; exclusions text[];
begin
  if jsonb_typeof(value) is distinct from 'array' then return false; end if;
  if jsonb_array_length(value) not between 1 and 5 then return false; end if;

  for check_spec in select * from jsonb_array_elements(value) loop
    if jsonb_typeof(check_spec) is distinct from 'object' then return false; end if;
    if not check_spec ?& array['key','path','timeoutSeconds','interactions','regionTestId','excludedTestIds','evidence']
      or (select count(*) from jsonb_object_keys(check_spec))<>7
      or jsonb_typeof(check_spec->'key') is distinct from 'string'
      or check_spec->>'key' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
      or check_spec->>'key'=any(keys)
      or jsonb_typeof(check_spec->'path') is distinct from 'string'
      or length(check_spec->>'path')>256
      or check_spec->>'path' !~ '^/([A-Za-z0-9_-][A-Za-z0-9._~-]*(/[A-Za-z0-9_-][A-Za-z0-9._~-]*)*/?)?$'
      or jsonb_typeof(check_spec->'regionTestId') is distinct from 'string'
      or check_spec->>'regionTestId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
      or jsonb_typeof(check_spec->'timeoutSeconds') is distinct from 'number'
      or jsonb_typeof(check_spec->'interactions') is distinct from 'array'
      or jsonb_typeof(check_spec->'excludedTestIds') is distinct from 'array'
      or jsonb_typeof(check_spec->'evidence') is distinct from 'array' then
      return false;
    end if;
    if (check_spec->>'timeoutSeconds')::numeric not between 1 and 30
      or (check_spec->>'timeoutSeconds')::numeric<>trunc((check_spec->>'timeoutSeconds')::numeric)
      or jsonb_array_length(check_spec->'interactions')>12
      or jsonb_array_length(check_spec->'excludedTestIds')>12
      or jsonb_array_length(check_spec->'evidence') not between 1 and 2 then
      return false;
    end if;

    keys:=array_append(keys,check_spec->>'key');
    for step in select * from jsonb_array_elements(check_spec->'interactions') loop
      if jsonb_typeof(step) is distinct from 'object' then return false; end if;
      if (select count(*) from jsonb_object_keys(step))<>2
        or coalesce(step->>'action','') not in ('click','expectVisible')
        or jsonb_typeof(step->'testId') is distinct from 'string'
        or step->>'testId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' then
        return false;
      end if;
    end loop;

    exclusions:='{}';
    for exclude_id in select * from jsonb_array_elements(check_spec->'excludedTestIds') loop
      if jsonb_typeof(exclude_id) is distinct from 'string'
        or (exclude_id#>>'{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'
        or (exclude_id#>>'{}')=any(exclusions)
        or (exclude_id#>>'{}')=check_spec->>'regionTestId' then
        return false;
      end if;
      exclusions:=array_append(exclusions,exclude_id#>>'{}');
    end loop;

    kinds:='{}';
    for capture in select * from jsonb_array_elements(check_spec->'evidence') loop
      if jsonb_typeof(capture) is distinct from 'object' then return false; end if;
      if (select count(*) from jsonb_object_keys(capture))<>2
        or coalesce(capture->>'kind','') not in ('screenshot','video')
        or capture->>'kind'=any(kinds)
        or jsonb_typeof(capture->'required') is distinct from 'boolean' then
        return false;
      end if;
      kinds:=array_append(kinds,capture->>'kind');
    end loop;
  end loop;
  return true;
end;
$$;

revoke all on function internal.is_browser_verification_plan(jsonb)
  from public,anon,authenticated,service_role;

create or replace function internal.pin_session_validation_plan(p_run_id uuid,p_commit_sha text,p_validation_tree_sha text,p_plan jsonb)
returns public.session_validation_plans language plpgsql security definer set search_path='' as $$
declare s public.sessions; j public.agent_jobs; r public.agent_runs; pinned public.session_job_git_inputs;
  prior public.session_validation_plans; result public.session_validation_plans;
  command jsonb; report jsonb; keys text[]:='{}'; asset_keys text[]:='{}'; asset_key text;
begin
  perform internal.assert_checkpoint_publication_service();
  select owner.* into s from public.sessions owner join public.agent_runs candidate on candidate.session_id=owner.id
    where candidate.id=p_run_id for no key update of owner;
  if s.id is null then raise exception 'Validation execution is unavailable.' using errcode='42501'; end if;
  perform internal.assert_workspace_accepts_work(s.workspace_id);
  select * into prior from public.session_validation_plans where run_id=p_run_id;
  if found then
    if prior.commit_sha=p_commit_sha and prior.validation_tree_sha=p_validation_tree_sha and prior.plan=p_plan then return prior; end if;
    raise exception 'Validation plan has already been pinned.' using errcode='PT409';
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
  if exists(select 1 from public.session_validation_evidence where run_id=p_run_id)
    or exists(select 1 from public.session_source_deliveries where run_id=p_run_id) then
    raise exception 'Validation plan must precede execution evidence and publication.' using errcode='PT409';
  end if;
  if p_commit_sha is null or p_commit_sha !~ '^[a-f0-9]{40}$'
    or p_validation_tree_sha is null or p_validation_tree_sha !~ '^[a-f0-9]{40}$'
    or jsonb_typeof(p_plan) is distinct from 'object' or octet_length(p_plan::text)>65536
    or not (
      (p_plan->'version'='1'::jsonb and (select count(*) from jsonb_object_keys(p_plan))=2)
      or (p_plan->'version'='2'::jsonb and (select count(*) from jsonb_object_keys(p_plan))=3
        and internal.is_browser_verification_plan(p_plan->'browser'))
    ) is true
    or jsonb_typeof(p_plan->'commands') is distinct from 'array' or jsonb_array_length(p_plan->'commands')>20 then
    raise exception 'Invalid validation plan.' using errcode='23514';
  end if;
  for command in select * from jsonb_array_elements(p_plan->'commands') loop
    if jsonb_typeof(command) is distinct from 'object'
      or not command ?& array['key','command','timeoutSeconds','reports']
      or (select count(*) from jsonb_object_keys(command))<>4
      or jsonb_typeof(command->'key') is distinct from 'string'
      or command->>'key' !~ '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$' or length(command->>'key')>200
      or command->>'key'=any(keys)
      or jsonb_typeof(command->'command') is distinct from 'string' or length(command->>'command') not between 1 and 4096
      or jsonb_typeof(command->'timeoutSeconds') is distinct from 'number'
      or (command->>'timeoutSeconds')::numeric<>trunc((command->>'timeoutSeconds')::numeric)
      or (command->>'timeoutSeconds')::numeric not between 1 and 300
      or jsonb_typeof(command->'reports') is distinct from 'array' or jsonb_array_length(command->'reports')>10 then
      raise exception 'Invalid validation command.' using errcode='23514';
    end if;
    keys:=array_append(keys,command->>'key');
    asset_keys:=array_append(asset_keys,(command->>'key')||'/log');
    for report in select * from jsonb_array_elements(command->'reports') loop
      asset_key:=(command->>'key')||'/'||(report->>'key');
      if jsonb_typeof(report) is distinct from 'object' or not report ?& array['key','path','kind','required']
        or (select count(*) from jsonb_object_keys(report))<>4
        or jsonb_typeof(report->'key') is distinct from 'string'
        or report->>'key' !~ '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$' or length(asset_key)>200 or asset_key=any(asset_keys)
        or jsonb_typeof(report->'path') is distinct from 'string' or length(report->>'path') not between 1 and 500
        or report->>'path' ~ '(^/|/$|//|(^|/)\.{1,2}(/|$)|[[:cntrl:]])' or position(chr(92) in report->>'path')>0
        or report->>'kind' is null or report->>'kind' not in ('report','screenshot','preview')
        or jsonb_typeof(report->'required') is distinct from 'boolean' then
        raise exception 'Invalid validation report.' using errcode='23514';
      end if;
      asset_keys:=array_append(asset_keys,asset_key);
    end loop;
  end loop;
  if cardinality(asset_keys)>100 or exists(select 1 from unnest(asset_keys) key where length(key)>200)
    or cardinality(asset_keys)<>(select count(distinct key) from unnest(asset_keys) key) then
    raise exception 'Invalid validation asset identities.' using errcode='23514';
  end if;
  insert into public.session_validation_plans(run_id,workspace_id,session_id,job_id,attempt_count,repository_id,commit_sha,validation_tree_sha,plan)
  values(r.id,s.workspace_id,s.id,j.id,r.attempt_count,pinned.repository_id,p_commit_sha,p_validation_tree_sha,p_plan)
  returning * into result;
  return result;
end;
$$;

-- A receipt belongs to the immutable plan, so its run, job attempt, repository
-- and source identity cannot be retargeted. Browser status has no authority
-- over command receipts. This increment only writes nonpassing outcomes.
create table public.session_browser_verification_receipts (
  run_id uuid primary key references public.session_validation_plans(run_id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  records jsonb not null check(jsonb_typeof(records)='array' and octet_length(records::text)<=16384),
  created_at timestamptz not null default clock_timestamp()
);

create index session_browser_verification_receipts_session_idx
  on public.session_browser_verification_receipts(session_id);
alter table public.session_browser_verification_receipts enable row level security;
revoke all on public.session_browser_verification_receipts from public,anon,authenticated,service_role;
grant select on public.session_browser_verification_receipts to authenticated,service_role;
create policy session_browser_verification_receipts_read
  on public.session_browser_verification_receipts for select to authenticated
  using(internal.can_access_session(session_id));
create trigger browser_verification_receipts_immutable before update or delete
  on public.session_browser_verification_receipts for each row
  execute function internal.guard_validation_evidence_history();

create function internal.record_session_browser_verification(
  p_run_id uuid,p_attempt_count integer,p_commit_sha text,p_validation_tree_sha text,p_records jsonb
) returns public.session_browser_verification_receipts language plpgsql security definer set search_path='' as $$
declare pinned public.session_validation_plans; owner public.sessions; j public.agent_jobs; r public.agent_runs;
  prior public.session_browser_verification_receipts; result public.session_browser_verification_receipts;
  receipt jsonb; planned jsonb; identity text; keys text[]:='{}'; expected_count integer;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into pinned from public.session_validation_plans where run_id=p_run_id;
  if not found or pinned.plan->'version' is distinct from '2'::jsonb
    or pinned.attempt_count is distinct from p_attempt_count
    or pinned.commit_sha is distinct from p_commit_sha
    or pinned.validation_tree_sha is distinct from p_validation_tree_sha then
    raise exception 'Browser verification does not match the frozen run plan.' using errcode='23514';
  end if;

  select * into owner from public.sessions where id=pinned.session_id for no key update;
  if not found then raise exception 'Browser verification is unavailable.' using errcode='42501'; end if;
  perform internal.assert_workspace_accepts_work(owner.workspace_id);

  select * into prior from public.session_browser_verification_receipts where run_id=p_run_id;
  if found then
    if prior.records=p_records then return prior; end if;
    raise exception 'Browser verification has already been recorded.' using errcode='PT409';
  end if;

  select * into j from public.agent_jobs where id=pinned.job_id for update;
  select * into r from public.agent_runs where id=p_run_id for update;
  if owner.archived_at is not null or owner.phase_status is distinct from 'in_progress'
    or j.workspace_id is distinct from owner.workspace_id or j.session_id is distinct from owner.id
    or j.stage_id is distinct from owner.current_stage_id or j.status not in ('started','running')
    or r.workspace_id is distinct from owner.workspace_id or r.session_id is distinct from owner.id
    or r.status is distinct from 'running' or r.stage_id is distinct from j.stage_id
    or r.agent_job_id is distinct from j.id
    or j.attempt_count is distinct from pinned.attempt_count
    or r.attempt_count is distinct from pinned.attempt_count
    or exists(select 1 from public.session_source_deliveries where run_id=p_run_id) then
    raise exception 'Browser verification is no longer current.' using errcode='PT409';
  end if;

  if jsonb_typeof(p_records) is distinct from 'array' or octet_length(p_records::text)>16384 then
    raise exception 'Invalid browser verification receipts.' using errcode='23514';
  end if;
  select sum(jsonb_array_length(value->'evidence')) into expected_count
    from jsonb_array_elements(pinned.plan->'browser');
  if jsonb_array_length(p_records)<>expected_count then
    raise exception 'Browser verification receipts must match every planned capture.' using errcode='23514';
  end if;

  for receipt in select * from jsonb_array_elements(p_records) loop
    if jsonb_typeof(receipt) is distinct from 'object' then
      raise exception 'Invalid browser verification receipt.' using errcode='23514';
    end if;
    select value into planned from jsonb_array_elements(pinned.plan->'browser')
      where value->>'key'=receipt->>'key';
    identity:=(receipt->>'key')||':'||(receipt->>'kind');
    if planned is null or (select count(*) from jsonb_object_keys(receipt))<>6
      or not receipt ?& array['key','kind','path','policy','status','reason']
      or identity is null or identity=any(keys)
      or receipt->>'path' is distinct from planned->>'path'
      or receipt->>'policy' is distinct from 'isolated-fixture-v1'
      or not exists (
        select 1 from jsonb_array_elements(planned->'evidence') item where item->>'kind'=receipt->>'kind'
      )
      or not (
        (receipt->>'status'='unavailable'
          and receipt->>'reason' in ('runtime_unavailable','tool_not_approved','isolated_target_unavailable'))
        or (receipt->>'status'='failed'
          and receipt->>'reason' in ('capture_failed','policy_excluded','source_changed'))
      ) is true then
      raise exception 'Browser verification receipt does not match its planned capture.' using errcode='23514';
    end if;
    keys:=array_append(keys,identity);
  end loop;

  insert into public.session_browser_verification_receipts(run_id,session_id,workspace_id,records)
    values(p_run_id,pinned.session_id,pinned.workspace_id,p_records) returning * into result;
  return result;
end;
$$;

create function public.record_session_browser_verification(
  p_run_id uuid,p_attempt_count integer,p_commit_sha text,p_validation_tree_sha text,p_records jsonb
) returns public.session_browser_verification_receipts language sql security invoker set search_path='' as $$
  select internal.record_session_browser_verification(
    p_run_id,p_attempt_count,p_commit_sha,p_validation_tree_sha,p_records
  );
$$;

revoke all on function internal.record_session_browser_verification(uuid,integer,text,text,jsonb),
  public.record_session_browser_verification(uuid,integer,text,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function internal.record_session_browser_verification(uuid,integer,text,text,jsonb),
  public.record_session_browser_verification(uuid,integer,text,text,jsonb) to service_role;
