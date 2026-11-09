-- Run-specific execution instructions never enter the source branch.
create table public.session_validation_plans (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check(attempt_count>0),
  repository_id uuid not null,
  commit_sha text not null check(commit_sha ~ '^[a-f0-9]{40}$'),
  validation_tree_sha text not null check(validation_tree_sha ~ '^[a-f0-9]{40}$'),
  plan jsonb not null check(jsonb_typeof(plan)='object' and octet_length(plan::text)<=65536),
  created_at timestamptz not null default clock_timestamp()
);
create index session_validation_plans_workspace_idx on public.session_validation_plans(workspace_id);
create index session_validation_plans_session_idx on public.session_validation_plans(session_id);
create index session_validation_plans_job_idx on public.session_validation_plans(job_id);
alter table public.session_validation_plans enable row level security;
revoke all on public.session_validation_plans from public,anon,authenticated,service_role;
grant select on public.session_validation_plans to authenticated,service_role;
create policy session_validation_plans_read on public.session_validation_plans for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));
create trigger validation_plans_immutable before update or delete on public.session_validation_plans
  for each row execute function internal.guard_validation_evidence_history();

create function internal.pin_session_validation_plan(p_run_id uuid,p_commit_sha text,p_validation_tree_sha text,p_plan jsonb)
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
    or p_plan->'version' is distinct from '1'::jsonb
    or (select count(*) from jsonb_object_keys(p_plan))<>2
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
create function public.pin_session_validation_plan(p_run_id uuid,p_commit_sha text,p_validation_tree_sha text,p_plan jsonb)
returns public.session_validation_plans language sql security invoker set search_path='' as $$
  select internal.pin_session_validation_plan(p_run_id,p_commit_sha,p_validation_tree_sha,p_plan);
$$;
revoke all on function internal.pin_session_validation_plan(uuid,text,text,jsonb),
  public.pin_session_validation_plan(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function internal.pin_session_validation_plan(uuid,text,text,jsonb),
  public.pin_session_validation_plan(uuid,text,text,jsonb) to service_role;

-- Receipts from workers predating this migration remain valid. When a run has
-- a frozen plan, its receipts must describe that plan and its original code.
create function internal.guard_validation_plan_receipt()
returns trigger language plpgsql security invoker set search_path='' as $$
declare pinned public.session_validation_plans; receipt jsonb; command jsonb; report_keys jsonb;
begin
  select * into pinned from public.session_validation_plans where run_id=new.run_id;
  if not found then return new; end if;
  for receipt in select * from jsonb_array_elements(new.records) loop
    select value into command from jsonb_array_elements(pinned.plan->'commands') where value->>'key'=receipt->>'key';
    select coalesce(jsonb_agg((command->>'key')||'/'||(value->>'key')),'[]'::jsonb) into report_keys
      from jsonb_array_elements(command->'reports') where value->'required'='true'::jsonb;
    if command is null or receipt->>'command' is distinct from command->>'command'
      or receipt->'reportKeys' is distinct from report_keys
      or receipt->>'status'='passed' and (new.commit_sha<>pinned.commit_sha or new.validation_tree_sha<>pinned.validation_tree_sha) then
      raise exception 'Validation receipt does not match its pinned plan.' using errcode='23514';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function internal.guard_validation_plan_receipt() from public,anon,authenticated,service_role;
create trigger validation_evidence_plan before insert on public.session_validation_evidence
  for each row execute function internal.guard_validation_plan_receipt();
