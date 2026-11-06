-- Versioned per-session execution budgets and provider-neutral usage accounting.
-- Policies apply to newly created sessions; existing sessions retain their pin (or
-- legacy unlimited behavior). Repair reservations and all budget decisions share
-- the session row lock with the canonical lifecycle.

create function internal.valid_execution_requirements(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(value) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(value))<>5
    or not (value ?& array['version','maxRepairAttempts','maxExecutionMs','maxTotalTokens','maxCostUsd'])
    or value->'version' is distinct from '1'::jsonb
    or jsonb_typeof(value->'maxRepairAttempts') is distinct from 'number'
    or jsonb_typeof(value->'maxExecutionMs') is distinct from 'number'
    or (value->>'maxRepairAttempts')::numeric<>trunc((value->>'maxRepairAttempts')::numeric)
    or (value->>'maxExecutionMs')::numeric<>trunc((value->>'maxExecutionMs')::numeric)
    or (value->>'maxRepairAttempts')::numeric not between 0 and 100
    or (value->>'maxExecutionMs')::numeric not between 1000 and 86400000 then return false; end if;
  if value->'maxTotalTokens' is not null and value->'maxTotalTokens'<>'null'::jsonb
    and (jsonb_typeof(value->'maxTotalTokens') is distinct from 'number'
      or (value->>'maxTotalTokens')::numeric<>trunc((value->>'maxTotalTokens')::numeric)
      or (value->>'maxTotalTokens')::numeric not between 1 and 1000000000000) then return false; end if;
  if value->'maxCostUsd' is not null and value->'maxCostUsd'<>'null'::jsonb
    and (jsonb_typeof(value->'maxCostUsd') is distinct from 'number'
      or (value->>'maxCostUsd')::numeric not between 0.000001 and 1000000) then return false; end if;
  if not (value ? 'maxTotalTokens') or not (value ? 'maxCostUsd') then return false; end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;
revoke all on function internal.valid_execution_requirements(jsonb) from public,anon,authenticated,service_role;

create table public.execution_policy_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  revision bigint not null check(revision>0),
  requirements jsonb not null check(internal.valid_execution_requirements(requirements)),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,revision)
);
create table public.execution_policies (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  current_revision_id uuid not null references public.execution_policy_revisions(id) on delete cascade,
  revision bigint not null check(revision>0)
);
create index execution_policies_revision_idx on public.execution_policies(current_revision_id);

alter table public.execution_policy_revisions enable row level security;
alter table public.execution_policies enable row level security;
revoke all on public.execution_policy_revisions,public.execution_policies from public,anon,authenticated,service_role;
grant select on public.execution_policy_revisions,public.execution_policies to authenticated,service_role;
create policy execution_policy_revisions_read on public.execution_policy_revisions for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));
create policy execution_policies_read on public.execution_policies for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));

create function internal.guard_execution_policy()
returns trigger language plpgsql security invoker set search_path='' as $$
declare revision public.execution_policy_revisions;
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id) then return old; end if;
    raise exception 'Execution policy history is immutable.' using errcode='23514';
  end if;
  if tg_table_name='execution_policy_revisions' then
    if tg_op='UPDATE' then raise exception 'Execution policy history is immutable.' using errcode='23514'; end if;
    return new;
  end if;
  select * into revision from public.execution_policy_revisions where id=new.current_revision_id;
  if revision.workspace_id is distinct from new.workspace_id or revision.revision is distinct from new.revision
    or (tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.revision<>old.revision+1)) then
    raise exception 'Execution policy revision does not match the current policy.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_execution_policy() from public,anon,authenticated,service_role;
create trigger guard_execution_policy_revisions before insert or update or delete on public.execution_policy_revisions
  for each row execute function internal.guard_execution_policy();
create trigger guard_execution_policies before insert or update or delete on public.execution_policies
  for each row execute function internal.guard_execution_policy();

create function public.save_execution_policy(p_workspace_id uuid,p_actor_user_id uuid,
  p_expected_revision bigint,p_requirements jsonb)
returns public.execution_policy_revisions language plpgsql security definer set search_path='' as $$
declare current_policy public.execution_policies; result public.execution_policy_revisions;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found then raise exception 'Execution policy workspace is unavailable.' using errcode='42501'; end if;
  perform 1 from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=p_actor_user_id
    and m.kind='human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then raise exception 'Active workspace manager required.' using errcode='42501'; end if;
  select * into current_policy from public.execution_policies where workspace_id=p_workspace_id;
  if p_expected_revision is null or p_expected_revision<>coalesce(current_policy.revision,0) then
    raise exception 'Execution policy changed. Reload before saving.' using errcode='PT409'; end if;
  if not internal.valid_execution_requirements(p_requirements) then
    raise exception 'Invalid execution requirements.' using errcode='23514'; end if;
  insert into public.execution_policy_revisions(workspace_id,revision,requirements,created_by)
    values(p_workspace_id,coalesce(current_policy.revision,0)+1,p_requirements,p_actor_user_id) returning * into result;
  insert into public.execution_policies(workspace_id,current_revision_id,revision)
    values(p_workspace_id,result.id,result.revision)
    on conflict(workspace_id) do update set current_revision_id=excluded.current_revision_id,revision=excluded.revision;
  return result;
end;
$$;
revoke all on function public.save_execution_policy(uuid,uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_execution_policy(uuid,uuid,bigint,jsonb) to service_role;

alter table public.sessions
  add column execution_policy_revision_id uuid references public.execution_policy_revisions(id) on delete set null,
  add column execution_repair_attempts integer not null default 0 check(execution_repair_attempts>=0),
  add column execution_exhausted_at timestamptz,
  add column execution_exhaustion_code text check(execution_exhaustion_code in(
    'repair_attempts','elapsed_execution','tokens','tokens_unavailable','spend','spend_unavailable')),
  add column execution_exhaustion_detail jsonb check(execution_exhaustion_detail is null or jsonb_typeof(execution_exhaustion_detail)='object');
create index sessions_execution_policy_idx on public.sessions(execution_policy_revision_id);
create index sessions_execution_exhaustion_idx on public.sessions(workspace_id,execution_exhausted_at) where execution_exhausted_at is not null;

alter table public.agent_jobs add column is_repair boolean not null default false;
alter table public.agent_runs
  add column execution_policy_revision_id uuid references public.execution_policy_revisions(id) on delete set null,
  add column token_provenance text not null default 'unavailable' check(token_provenance in('measured','estimated','unavailable')),
  add column cost_provenance text not null default 'unavailable' check(cost_provenance in('measured','estimated','unavailable')),
  add column usage_estimation_revision text,
  add column usage_recorded_at timestamptz,
  add column usage_finalized_at timestamptz,
  add column usage_unavailable_reason text check(usage_unavailable_reason is null or usage_unavailable_reason in(
    'provider_did_not_report','provider_unsupported','partial_provider_usage','subscription_not_metered'));
-- Historical rows could contain partial or negative telemetry. Preserve them as
-- unavailable rather than failing deployment or presenting invalid totals.
update public.agent_runs set input_tokens=null,output_tokens=null
  where (input_tokens is null)<>(output_tokens is null) or input_tokens<0 or output_tokens<0;
update public.agent_runs set total_cost_usd=null where total_cost_usd<0;
update public.agent_runs set token_provenance='measured',usage_recorded_at=coalesce(finished_at,updated_at)
  where input_tokens is not null and output_tokens is not null;
update public.agent_runs set cost_provenance='measured',usage_recorded_at=coalesce(finished_at,updated_at)
  where total_cost_usd is not null;
update public.agent_runs set usage_finalized_at=coalesce(finished_at,updated_at),
  usage_unavailable_reason=case when token_provenance='unavailable' or cost_provenance='unavailable'
    then 'provider_did_not_report' else null end
  where status in('success','error','canceled');
alter table public.agent_runs
  add constraint agent_runs_token_usage_provenance check(
    (token_provenance='unavailable' and input_tokens is null and output_tokens is null)
    or (token_provenance in('measured','estimated') and input_tokens>=0 and output_tokens>=0)),
  add constraint agent_runs_cost_provenance check(
    (cost_provenance='unavailable' and total_cost_usd is null)
    or (cost_provenance in('measured','estimated') and total_cost_usd>=0));
create index agent_runs_session_usage_idx on public.agent_runs(session_id,started_at)
  include(input_tokens,output_tokens,total_cost_usd,token_provenance,cost_provenance,usage_finalized_at,finished_at,status);

create function internal.pin_session_execution_policy()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='INSERT' then
    if new.execution_policy_revision_id is null then
      select current_revision_id into new.execution_policy_revision_id from public.execution_policies
        where workspace_id=new.workspace_id;
    end if;
  elsif new.execution_policy_revision_id is distinct from old.execution_policy_revision_id
    or new.execution_repair_attempts<old.execution_repair_attempts
    or (old.execution_exhausted_at is not null and (new.execution_exhausted_at is distinct from old.execution_exhausted_at
      or new.execution_exhaustion_code is distinct from old.execution_exhaustion_code
      or new.execution_exhaustion_detail is distinct from old.execution_exhaustion_detail)) then
    raise exception 'Session execution policy and exhaustion history are immutable.' using errcode='23514';
  end if;
  if new.execution_policy_revision_id is not null and not exists(
    select 1 from public.execution_policy_revisions where id=new.execution_policy_revision_id and workspace_id=new.workspace_id) then
    raise exception 'Execution policy does not belong to the session workspace.' using errcode='23514';
  end if;
  if (new.execution_exhausted_at is null)<>(new.execution_exhaustion_code is null)
    or (new.execution_exhausted_at is null and new.execution_exhaustion_detail is not null) then
    raise exception 'Execution exhaustion requires a coherent reason.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.pin_session_execution_policy() from public,anon,authenticated,service_role;
create trigger pin_session_execution_policy before insert or update on public.sessions
  for each row execute function internal.pin_session_execution_policy();

create function internal.finalize_agent_run_usage()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.status in('success','error','canceled') and old.status not in('success','error','canceled') then
    new.usage_finalized_at:=coalesce(new.usage_finalized_at,clock_timestamp());
    if new.token_provenance='unavailable' or new.cost_provenance='unavailable' then
      new.usage_unavailable_reason:=coalesce(new.usage_unavailable_reason,'provider_did_not_report');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.finalize_agent_run_usage() from public,anon,authenticated,service_role;
create trigger finalize_agent_run_usage before update of status on public.agent_runs
  for each row execute function internal.finalize_agent_run_usage();

create function internal.pin_agent_run_execution_policy()
returns trigger language plpgsql security invoker set search_path='' as $$
declare owner_workspace uuid;
begin
  select workspace_id,execution_policy_revision_id into owner_workspace,new.execution_policy_revision_id
    from public.sessions where id=new.session_id;
  if not found or owner_workspace is distinct from new.workspace_id then
    raise exception 'Agent run session is outside its workspace.' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.pin_agent_run_execution_policy() from public,anon,authenticated,service_role;
create trigger pin_agent_run_execution_policy before insert or update of session_id,workspace_id on public.agent_runs
  for each row execute function internal.pin_agent_run_execution_policy();

-- Legacy publication writers supplied numeric usage before provenance columns
-- existed. Classify those explicit provider values as measured, never absent zeroes.
create function internal.normalize_agent_run_legacy_usage()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if (new.input_tokens is null)<>(new.output_tokens is null) or new.input_tokens<0 or new.output_tokens<0 then
    new.input_tokens:=null; new.output_tokens:=null; new.token_provenance:='unavailable';
  end if;
  if new.total_cost_usd<0 then new.total_cost_usd:=null; new.cost_provenance:='unavailable'; end if;
  if new.input_tokens is not null and new.output_tokens is not null and new.token_provenance='unavailable'
    and (tg_op='INSERT' or old.input_tokens is null or old.output_tokens is null) then
    new.token_provenance:='measured';
    new.usage_recorded_at:=coalesce(new.usage_recorded_at,clock_timestamp());
  end if;
  if new.total_cost_usd is not null and new.cost_provenance='unavailable'
    and (tg_op='INSERT' or old.total_cost_usd is null) then
    new.cost_provenance:='measured';
    new.usage_recorded_at:=coalesce(new.usage_recorded_at,clock_timestamp());
  end if;
  return new;
end;
$$;
revoke all on function internal.normalize_agent_run_legacy_usage() from public,anon,authenticated,service_role;
create trigger normalize_agent_run_legacy_usage before insert or update of input_tokens,output_tokens,total_cost_usd on public.agent_runs
  for each row execute function internal.normalize_agent_run_legacy_usage();

create type internal.session_execution_usage as (
  elapsed_ms bigint,total_tokens numeric,total_cost_usd numeric,
  tokens_unavailable boolean,cost_unavailable boolean,started_runs bigint
);

create function internal.load_session_execution_usage(p_session_id uuid)
returns internal.session_execution_usage language sql volatile security invoker set search_path='' as $$
  select (coalesce(sum(greatest(0,extract(epoch from(coalesce(r.finished_at,clock_timestamp())-r.started_at))*1000))
    filter(where r.started_at is not null),0))::bigint,
    coalesce(sum(r.input_tokens+r.output_tokens) filter(where r.started_at is not null and r.token_provenance in('measured','estimated')),0),
    coalesce(sum(r.total_cost_usd) filter(where r.started_at is not null and r.cost_provenance in('measured','estimated')),0),
    coalesce(bool_or(r.usage_finalized_at is not null and r.token_provenance='unavailable') filter(where r.started_at is not null),false),
    coalesce(bool_or(r.usage_finalized_at is not null and r.cost_provenance='unavailable') filter(where r.started_at is not null),false),
    count(*) filter(where r.started_at is not null)
  from public.agent_runs r where r.session_id=p_session_id;
$$;
revoke all on function internal.load_session_execution_usage(uuid) from public,anon,authenticated,service_role;
grant execute on function internal.load_session_execution_usage(uuid) to service_role;

create function internal.exhaust_session_execution(p_session_id uuid,p_code text,p_observed numeric,p_limit numeric,
  p_detail jsonb default '{}'::jsonb)
returns text language plpgsql security definer set search_path='' as $$
begin
  update public.sessions s set execution_exhausted_at=coalesce(s.execution_exhausted_at,clock_timestamp()),
    execution_exhaustion_code=coalesce(s.execution_exhaustion_code,p_code),
    execution_exhaustion_detail=coalesce(s.execution_exhaustion_detail,jsonb_build_object(
      'observed',p_observed,'limit',p_limit,'policyRevisionId',s.execution_policy_revision_id)||p_detail)
  where s.id=p_session_id;
  return p_code;
end;
$$;
revoke all on function internal.exhaust_session_execution(uuid,text,numeric,numeric,jsonb) from public,anon,authenticated,service_role;
grant execute on function internal.exhaust_session_execution(uuid,text,numeric,numeric,jsonb) to service_role;

create function internal.refresh_session_execution_exhaustion(p_session_id uuid,p_workspace_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare s public.sessions; policy public.execution_policy_revisions; usage internal.session_execution_usage;
  max_tokens bigint; max_cost numeric; max_elapsed bigint;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into s from public.sessions where id=p_session_id and workspace_id=p_workspace_id for no key update;
  if not found then return null; end if;
  if s.execution_exhaustion_code is not null then return s.execution_exhaustion_code; end if;
  if s.execution_policy_revision_id is null then return null; end if;
  select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id and workspace_id=s.workspace_id;
  if not found then return null; end if;
  usage:=internal.load_session_execution_usage(s.id);
  max_elapsed:=(policy.requirements->>'maxExecutionMs')::bigint;
  max_tokens:=case when jsonb_typeof(policy.requirements->'maxTotalTokens')='number'
    then (policy.requirements->>'maxTotalTokens')::bigint else null end;
  max_cost:=case when jsonb_typeof(policy.requirements->'maxCostUsd')='number'
    then (policy.requirements->>'maxCostUsd')::numeric else null end;
  if usage.elapsed_ms>=max_elapsed then
    return internal.exhaust_session_execution(s.id,'elapsed_execution',usage.elapsed_ms,max_elapsed);
  elsif max_tokens is not null and usage.tokens_unavailable then
    return internal.exhaust_session_execution(s.id,'tokens_unavailable',null,max_tokens,
      jsonb_build_object('reason','Finalized run token usage is unavailable.'));
  elsif max_tokens is not null and usage.total_tokens>=max_tokens then
    return internal.exhaust_session_execution(s.id,'tokens',usage.total_tokens,max_tokens);
  elsif max_cost is not null and usage.cost_unavailable then
    return internal.exhaust_session_execution(s.id,'spend_unavailable',null,max_cost,
      jsonb_build_object('reason','Finalized run cost is unavailable.'));
  elsif max_cost is not null and usage.total_cost_usd>=max_cost then
    return internal.exhaust_session_execution(s.id,'spend',usage.total_cost_usd,max_cost);
  end if;
  return null;
end;
$$;
revoke all on function internal.refresh_session_execution_exhaustion(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function internal.refresh_session_execution_exhaustion(uuid,uuid) to service_role;

create function internal.session_execution_admissible(p_session_id uuid,p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  return internal.refresh_session_execution_exhaustion(p_session_id,p_workspace_id) is null;
end;
$$;
revoke all on function internal.session_execution_admissible(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function internal.session_execution_admissible(uuid,uuid) to service_role;

create function internal.reserve_session_repair_attempt(p_session_id uuid,p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare s public.sessions; policy public.execution_policy_revisions; max_repairs integer;
begin
  perform internal.assert_checkpoint_publication_service();
  if internal.refresh_session_execution_exhaustion(p_session_id,p_workspace_id) is not null then return false; end if;
  select * into s from public.sessions where id=p_session_id and workspace_id=p_workspace_id for no key update;
  if not found then return false; end if;
  if s.execution_policy_revision_id is not null then
    select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
    max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
    if s.execution_repair_attempts>=max_repairs then
      perform internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
      return false;
    end if;
  end if;
  update public.sessions set execution_repair_attempts=execution_repair_attempts+1 where id=s.id;
  return true;
end;
$$;
revoke all on function internal.reserve_session_repair_attempt(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function internal.reserve_session_repair_attempt(uuid,uuid) to service_role;

create function internal.admit_agent_job_execution()
returns trigger language plpgsql security invoker set search_path='' as $$
declare pinned_policy uuid; existing_job_id uuid;
begin
  new.is_repair:=new.is_repair or new.trigger_type in('manual_retry','comment_retry');
  -- Legacy unlimited sessions need no new session lock. This preserves the
  -- canonical mixed-producer race contract while policy-pinned sessions serialize.
  select execution_policy_revision_id into pinned_policy from public.sessions where id=new.session_id;
  if new.status='queued' and pinned_policy is not null then
    if new.is_repair then
      -- Let the canonical rejection INSERT hit its active-job uniqueness
      -- violation and adopt the queued repair without another reservation.
      -- Lock session -> job before deciding: a legacy contender cannot finish
      -- the queued job between this check and its own uniqueness check.
      perform 1 from public.sessions where id=new.session_id for no key update;
      select existing.id into existing_job_id from public.agent_jobs existing
        where existing.session_id=new.session_id and existing.workspace_id=new.workspace_id
          and existing.status='queued' for update;
      if existing_job_id is null then
        if not internal.reserve_session_repair_attempt(new.session_id,new.workspace_id) then return null; end if;
      end if;
    elsif not internal.session_execution_admissible(new.session_id,new.workspace_id) then return null; end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.admit_agent_job_execution() from public,anon,authenticated,service_role;
create trigger admit_agent_job_execution before insert on public.agent_jobs
  for each row execute function internal.admit_agent_job_execution();

create function public.get_session_execution_budget(p_session_id uuid)
returns table(policy_revision bigint,max_repair_attempts integer,max_execution_ms bigint,max_total_tokens bigint,
  max_cost_usd numeric,repair_attempts_used integer,elapsed_ms bigint,total_tokens numeric,total_cost_usd numeric,
  tokens_unavailable boolean,cost_unavailable boolean,remaining_execution_ms bigint,exhaustion_code text)
language plpgsql security definer set search_path='' as $$
declare s public.sessions; policy public.execution_policy_revisions; usage internal.session_execution_usage; code text;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into s from public.sessions where id=p_session_id;
  if not found then return; end if;
  code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
  usage:=internal.load_session_execution_usage(s.id);
  if s.execution_policy_revision_id is not null then
    select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
  end if;
  return query select policy.revision,
    coalesce((policy.requirements->>'maxRepairAttempts')::integer,0),
    (policy.requirements->>'maxExecutionMs')::bigint,
    case when jsonb_typeof(policy.requirements->'maxTotalTokens')='number' then (policy.requirements->>'maxTotalTokens')::bigint else null end,
    case when jsonb_typeof(policy.requirements->'maxCostUsd')='number' then (policy.requirements->>'maxCostUsd')::numeric else null end,
    s.execution_repair_attempts,usage.elapsed_ms,usage.total_tokens,usage.total_cost_usd,
    usage.tokens_unavailable,usage.cost_unavailable,
    case when policy.id is null then null else greatest(0,(policy.requirements->>'maxExecutionMs')::bigint-usage.elapsed_ms) end,
    code;
end;
$$;
revoke all on function public.get_session_execution_budget(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_session_execution_budget(uuid) to service_role;

create function public.record_session_run_usage(p_job_id uuid,p_attempt_count integer,p_run_id uuid,
  p_input_tokens bigint default null,p_output_tokens bigint default null,p_token_provenance text default 'unavailable',
  p_cost_usd numeric default null,p_cost_provenance text default 'unavailable',p_estimation_revision text default null,
  p_finalize boolean default false)
returns table(accepted boolean,exhaustion_code text) language plpgsql security definer set search_path='' as $$
declare s public.sessions; j public.agent_jobs; r public.agent_runs;
  next_input bigint; next_output bigint; next_cost numeric; next_token_provenance text; next_cost_provenance text;
  next_estimation text; recorded_at timestamptz; finalized_at timestamptz; unavailable_reason text; code text;
begin
  perform internal.assert_checkpoint_publication_service();
  if (p_input_tokens is null)<>(p_output_tokens is null) or p_input_tokens<0 or p_output_tokens<0 or p_cost_usd<0
    or p_token_provenance not in('measured','estimated','unavailable')
    or p_cost_provenance not in('measured','estimated','unavailable')
    or (p_input_tokens is not null and p_token_provenance='unavailable')
    or (p_input_tokens is null and p_token_provenance<>'unavailable')
    or (p_cost_usd is not null and p_cost_provenance='unavailable')
    or (p_cost_usd is null and p_cost_provenance<>'unavailable')
    or ((p_token_provenance='estimated' or p_cost_provenance='estimated') and nullif(btrim(coalesce(p_estimation_revision,'')),'') is null) then
    raise exception 'Usage values and provenance are invalid.' using errcode='23514';
  end if;
  select owner.* into s from public.sessions owner join public.agent_jobs candidate on candidate.session_id=owner.id
    where candidate.id=p_job_id for no key update of owner;
  if not found then return query select false,null::text; return; end if;
  select * into j from public.agent_jobs where id=p_job_id and session_id=s.id and workspace_id=s.workspace_id for update;
  if not found or j.attempt_count is distinct from p_attempt_count then return query select false,null::text; return; end if;
  select * into r from public.agent_runs where id=p_run_id and agent_job_id=j.id and session_id=s.id and workspace_id=s.workspace_id for update;
  if not found or r.attempt_count is distinct from p_attempt_count or r.status<>'running' then
    return query select false,null::text; return;
  end if;
  next_input:=coalesce(p_input_tokens,r.input_tokens); next_output:=coalesce(p_output_tokens,r.output_tokens);
  next_cost:=coalesce(p_cost_usd,r.total_cost_usd);
  next_token_provenance:=case when p_input_tokens is null then r.token_provenance
    when r.token_provenance='measured' and p_token_provenance='estimated' then 'measured' else p_token_provenance end;
  next_cost_provenance:=case when p_cost_usd is null then r.cost_provenance
    when r.cost_provenance='measured' and p_cost_provenance='estimated' then 'measured' else p_cost_provenance end;
  if next_token_provenance='measured' and p_token_provenance='estimated' and r.token_provenance='measured' then
    next_input:=r.input_tokens; next_output:=r.output_tokens;
  end if;
  if next_cost_provenance='measured' and p_cost_provenance='estimated' and r.cost_provenance='measured' then next_cost:=r.total_cost_usd; end if;
  next_estimation:=coalesce(p_estimation_revision,r.usage_estimation_revision);
  recorded_at:=case when p_input_tokens is not null or p_cost_usd is not null then clock_timestamp() else r.usage_recorded_at end;
  finalized_at:=case when p_finalize then coalesce(r.usage_finalized_at,clock_timestamp()) else r.usage_finalized_at end;
  unavailable_reason:=case when next_token_provenance='unavailable' or next_cost_provenance='unavailable'
    then coalesce(r.usage_unavailable_reason,'provider_did_not_report') else null end;
  update public.agent_runs set input_tokens=next_input,output_tokens=next_output,total_cost_usd=next_cost,
    token_provenance=next_token_provenance,cost_provenance=next_cost_provenance,usage_estimation_revision=next_estimation,
    usage_recorded_at=recorded_at,usage_finalized_at=finalized_at,usage_unavailable_reason=unavailable_reason
  where id=r.id;
  code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
  return query select true,code;
end;
$$;
revoke all on function public.record_session_run_usage(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.record_session_run_usage(uuid,integer,uuid,bigint,bigint,text,numeric,text,text,boolean)
  to service_role;

-- Recovery never publishes into an exhausted session, independently of its
-- budget-adjusted intent deadline.
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
      and p.retained_ref is not distinct from case when d.base_sha<>d.head_sha
        then 'refs/heads/wallie/checkpoints/'||r.id::text||'/'||d.head_sha end
  );
$$;

-- Settings aggregates include every started execution, not only successful runs.
-- NULL and explicit coverage flags prevent unavailable values becoming zero.
drop function public.get_workspace_usage(uuid);
create function public.get_workspace_usage(target_workspace_id uuid)
returns table(total_input_tokens bigint,total_output_tokens bigint,total_cost_usd numeric,total_runs bigint,
  tokens_unavailable boolean,cost_unavailable boolean,has_estimated_tokens boolean,has_estimated_cost boolean)
language sql stable security invoker set search_path='' as $$
  with permitted as(select target_workspace_id workspace_id where target_workspace_id in(select internal.current_user_workspace_ids())),
  runs as(select r.* from public.agent_runs r join permitted p on p.workspace_id=r.workspace_id where r.started_at is not null)
  select case when count(*)=0 then 0 when bool_and(token_provenance='unavailable') then null
      else coalesce(sum(input_tokens) filter(where token_provenance in('measured','estimated')),0) end::bigint,
    case when count(*)=0 then 0 when bool_and(token_provenance='unavailable') then null
      else coalesce(sum(output_tokens) filter(where token_provenance in('measured','estimated')),0) end::bigint,
    case when count(*)=0 then 0 when bool_and(cost_provenance='unavailable') then null
      else coalesce(sum(total_cost_usd) filter(where cost_provenance in('measured','estimated')),0) end,
    count(*)::bigint,
    coalesce(bool_or(token_provenance='unavailable'),false),
    coalesce(bool_or(cost_provenance='unavailable'),false),
    coalesce(bool_or(token_provenance='estimated'),false),coalesce(bool_or(cost_provenance='estimated'),false)
  from runs;
$$;
revoke all on function public.get_workspace_usage(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_workspace_usage(uuid) to authenticated,service_role;

-- A skipped insert is a durable, non-throwing admission receipt. Callers must
-- not manufacture a queued run when the trigger refused the job.
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
  if current_session.archived_at is not null then raise exception 'Session is archived.' using errcode = '55000'; end if;
  if current_session.current_stage_id is distinct from p_expected_stage_id then
    raise exception 'Session stage changed.' using errcode = '55000'; end if;
  if current_session.phase_status = 'approved' then raise exception 'Session is already complete.' using errcode = '55000'; end if;
  if p_requested_by_member_id is not null and not exists (
    select 1 from public.workspace_members member
    where member.id = p_requested_by_member_id and member.workspace_id = p_workspace_id
      and member.is_active and member.kind = 'human') then
    raise exception 'Requester is not an active workspace member.' using errcode = '42501';
  end if;
  select * into current_stage from public.pipeline_stages
  where id = current_session.current_stage_id and pipeline_id = current_session.pipeline_id and workspace_id = p_workspace_id;
  if not found then raise exception 'Session references a missing stage.' using errcode = 'P0002'; end if;
  select * into active_job from public.agent_jobs
  where session_id = p_session_id and workspace_id = p_workspace_id and status in ('queued', 'started', 'running') for update;
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
      select * into active_job from public.agent_jobs
      where session_id = p_session_id and workspace_id = p_workspace_id
        and status in ('queued', 'started', 'running') for update;
      if not found then raise; end if;
    end;
  end if;
  if active_job.id is null and queued_job_id is null then
    return query select null::uuid,null::uuid,false;
    return;
  end if;
  if active_job.id is not null then
    if active_job.stage_id is not null and active_job.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000'; end if;
    select * into existing_run from public.agent_runs where agent_job_id = active_job.id
      order by created_at desc, id desc limit 1;
    if existing_run.stage_id is not null and existing_run.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000'; end if;
    select * into existing_run from public.agent_runs
    where agent_job_id = active_job.id and status in ('queued', 'started', 'running')
    order by created_at desc, id desc limit 1;
    if existing_run.stage_id is not null and existing_run.stage_id <> current_stage.id then
      raise exception 'Session has an active job for a different stage.' using errcode = '55000'; end if;
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
$function$;
revoke all on function public.enqueue_session_job_with_run(uuid,uuid,uuid,uuid,public.agent_trigger_type,text,text,text)
  from public,anon,authenticated;
grant execute on function public.enqueue_session_job_with_run(uuid,uuid,uuid,uuid,public.agent_trigger_type,text,text,text)
  to service_role;

-- Revalidate after release admission and before binding any execution. The
-- original function retains the session -> job -> run locking chain.
create or replace function internal.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control; job public.agent_jobs; session public.sessions; execution_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  select * into job from public.agent_jobs where id=p_job_id;
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
  perform 1 from public.sessions where id=session.id and workspace_id=session.workspace_id for no key update;
  if not internal.session_execution_admissible(session.id,session.workspace_id) then return null; end if;
  execution_id:=internal.start_session_job_attempt_before_release(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
    p_model_provider,p_model_name,p_run_type,p_branch_name);
  if execution_id is not null then perform internal.bind_manual_retry_feedback(p_job_id); end if;
  return execution_id;
end;
$$;
revoke all on function internal.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text) from public,anon,authenticated;
grant execute on function internal.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text) to service_role;

CREATE OR REPLACE FUNCTION public.fail_session_job_attempt(p_job_id uuid, p_attempt_count integer, p_error text, p_retry boolean, p_max_retries integer, p_run_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  s public.sessions%rowtype;
  j public.agent_jobs%rowtype;
  r public.agent_runs%rowtype;
  current_stage_owner boolean;
  stage_matches boolean;
  retrying boolean;
  effective_attempt_count integer;
  failure_error text:=p_error;
begin
  select owner.* into s from public.sessions owner join public.agent_jobs candidate on candidate.session_id = owner.id
  where candidate.id = p_job_id for no key update of owner;
  if not found then return 'stale'; end if;
  select * into j from public.agent_jobs where id = p_job_id for update;
  if not found or p_attempt_count is null or p_attempt_count <= 0
     or j.attempt_count <> p_attempt_count or j.status not in ('started', 'running', 'success')
     or j.session_id <> s.id or j.workspace_id <> s.workspace_id then return 'stale'; end if;
  if p_run_id is not null then
    select * into r from public.agent_runs where id = p_run_id for update;
    if not found or r.agent_job_id is distinct from j.id or r.attempt_count is distinct from p_attempt_count
       or r.workspace_id <> s.workspace_id or r.session_id <> s.id then return 'stale'; end if;
    if r.status = 'success' then
      perform public.complete_session_job_attempt(j.id, p_attempt_count, r.id);
      return 'success';
    end if;
    if r.status not in ('queued', 'started', 'running') then return 'stale'; end if;
  else
    perform 1 from public.agent_runs where agent_job_id = j.id order by id for update;
    if exists (select 1 from public.agent_runs where agent_job_id = j.id and attempt_count = p_attempt_count)
      then return 'stale'; end if;
  end if;
  if j.status = 'success' then return 'stale'; end if;
  stage_matches := (j.stage_id is null or j.stage_id = s.current_stage_id)
    and not exists (select 1 from public.agent_runs history where history.agent_job_id = j.id
      and history.stage_id is not null and history.stage_id <> s.current_stage_id);
  current_stage_owner := s.archived_at is null and stage_matches and j.stage_id = s.current_stage_id
    and s.phase_status in ('in_progress', 'rejected');
  effective_attempt_count:=internal.git_continuity_effective_attempt_count(j.id,s.workspace_id,s.id,j.attempt_count);
  retrying := coalesce(p_retry, false) and effective_attempt_count < greatest(coalesce(p_max_retries, 0), 0)
    and s.archived_at is null and stage_matches and s.execution_exhausted_at is null
    and (s.phase_status in ('in_progress', 'rejected')
      or (p_run_id is null and s.phase_status = 'awaiting_review'
          and not exists(select 1 from public.agent_runs where agent_job_id = j.id and status = 'success')));
  -- Finalize the failed run before deciding whether its unknown usage can be
  -- followed by another repair. Otherwise a missing-usage run could slip a
  -- queued retry through before the subsequent exhaustion refresh.
  if p_run_id is not null then
    update public.agent_runs set status = 'error', finished_at = now() where id = r.id;
  else
    update public.agent_runs set status = 'error', finished_at = now()
    where agent_job_id = j.id and attempt_count is null and status in ('queued', 'started', 'running');
  end if;
  if internal.refresh_session_execution_exhaustion(s.id,s.workspace_id) is not null then
    if retrying then failure_error:=coalesce(nullif(btrim(p_error),'')||E'\n','')||'Execution budget exhausted; no automatic repair was queued.'; end if;
    retrying:=false;
  end if;
  if retrying then
    retrying:=internal.reserve_session_repair_attempt(s.id,s.workspace_id);
    if not retrying then failure_error:=coalesce(nullif(btrim(p_error),'')||E'\n','')||'Execution budget exhausted; no automatic repair was queued.'; end if;
  end if;
  update public.agent_jobs set
    status = case when retrying then 'queued'::public.agent_job_status else 'error'::public.agent_job_status end,
    finished_at = case when retrying then null else now() end,
    scheduled_at = case when retrying then now() + make_interval(secs => least(300, 5 * power(2, least(effective_attempt_count, 10)))::double precision) else null end,
    last_error = failure_error
  where id = j.id;
  if current_stage_owner then update public.sessions set phase_status = 'rejected' where id = s.id; end if;
  return case when retrying then 'queued' else 'error' end;
end;
$function$;
revoke all on function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid) from public,anon,authenticated;
grant execute on function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid) to service_role;

-- Preserve final artifact approval, but never advance an exhausted session into
-- another execution stage. The wrapper and original share the same session lock.
alter function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint) set schema internal;
alter function internal.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)
  rename to approve_session_stage_before_execution_budget;
revoke all on function internal.approve_session_stage_before_execution_budget(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function internal.approve_session_stage_before_execution_budget(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint)
  to service_role;
create function public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid,
  expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text,
  p_agent_model_name text, p_run_type text default 'project',p_expected_review_revision bigint default null)
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,phase_status public.pipeline_phase_status,
  workspace_id uuid,linear_issue_url text,archived_at timestamptz,current_artifact_version integer,rejection_count integer,
  job_id uuid,run_id uuid,job_created boolean)
language plpgsql security invoker set search_path='' as $$
declare s public.sessions; code text; has_later_stage boolean;
begin
  select * into s from public.sessions owner where owner.id=target_session_id and owner.workspace_id=expected_workspace_id for no key update;
  if not found then return; end if;
  select exists(select 1 from public.pipeline_stages later
    join public.session_selected_stages selected on selected.stage_id=later.id and selected.session_id=s.id
    join public.pipeline_stages current on current.id=s.current_stage_id
    where later.pipeline_id=s.pipeline_id and later.workspace_id=s.workspace_id and later.position>current.position)
    into has_later_stage;
  code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
  if code is not null and has_later_stage then return; end if;
  if not has_later_stage then
    return query select * from internal.approve_session_stage_before_execution_budget(target_session_id,expected_workspace_id,
      expected_stage_id,expected_artifact_id,expected_version,approver_member_id,p_agent_model_provider,p_agent_model_name,
      p_run_type,p_expected_review_revision);
    return;
  end if;
  begin
    return query select * from internal.approve_session_stage_before_execution_budget(target_session_id,expected_workspace_id,
      expected_stage_id,expected_artifact_id,expected_version,approver_member_id,p_agent_model_provider,p_agent_model_name,
      p_run_type,p_expected_review_revision);
  exception when others then
    -- A refusal in the nested enqueue rolls back only the approval attempt.
    -- Recompute after that rollback so a same-transaction deadline crossing is
    -- still durable without advancing the stage or losing the prior review.
    code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
    if code is null then raise; end if;
    return;
  end;
end;
$$;
revoke all on function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.approve_session_stage(uuid,uuid,uuid,uuid,integer,uuid,text,text,text,bigint) to service_role;

-- Exhausted review feedback remains durable even though no job/run exists.
alter table public.artifact_feedback_batches alter column job_id drop not null;
alter table public.artifact_feedback_batches alter column run_id drop not null;
create or replace function internal.guard_artifact_feedback_batch()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare owner_session public.sessions; job public.agent_jobs; run public.agent_runs;
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.workspaces where id = old.workspace_id)
    or not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.session_artifacts where id = old.artifact_id)
    or not exists (select 1 from public.agent_jobs where id = old.job_id)
    or not exists (select 1 from public.agent_runs where id = old.run_id)
  ) then return old; end if;
  if tg_op <> 'INSERT' then raise exception 'Submitted artifact feedback is immutable.' using errcode = '23514'; end if;
  select * into owner_session from public.sessions
    where id = new.session_id and workspace_id = new.workspace_id;
  if not found or owner_session.current_artifact_id is distinct from new.artifact_id
    or owner_session.current_stage_id is distinct from new.stage_id
    or owner_session.current_artifact_version is distinct from new.artifact_version
    or owner_session.artifact_review_revision is distinct from new.review_revision
    or owner_session.rejection_count is distinct from new.rejection_count
    or owner_session.phase_status <> 'rejected' then
    raise exception 'Feedback batch does not match its reviewed transition.' using errcode = '23514';
  end if;
  if new.job_id is null or new.run_id is null then
    if new.job_id is not null or new.run_id is not null or new.job_created
      or owner_session.execution_exhausted_at is null
      or not exists (select 1 from public.session_artifacts a
        where a.id = new.artifact_id and a.session_id = new.session_id
          and a.workspace_id = new.workspace_id and a.stage_id = new.stage_id and a.version = new.artifact_version)
      or not exists (select 1 from public.workspace_members m
        where m.id = new.requested_by_member_id and m.workspace_id = new.workspace_id
          and m.kind = 'human' and m.is_active and internal.artifact_review_author_label(m) = new.actor_label)
      or (new.checkpoint_run_id is not null and not exists(select 1 from public.session_git_checkpoints c
        where c.run_id = new.checkpoint_run_id and c.artifact_id = new.artifact_id
          and c.session_id = new.session_id and c.workspace_id = new.workspace_id)) then
      raise exception 'Exhausted feedback must retain its review without a fabricated execution.' using errcode = '23514';
    end if;
    return new;
  end if;
  select * into job from public.agent_jobs where id = new.job_id;
  select * into run from public.agent_runs where id = new.run_id;
  if job.id is null or run.id is null or job.session_id <> new.session_id
    or job.workspace_id <> new.workspace_id or job.stage_id is distinct from new.stage_id
    or (new.job_created and job.requested_by_member_id is distinct from new.requested_by_member_id)
    or job.status <> 'queued' or run.agent_job_id is distinct from job.id
    or run.session_id <> new.session_id or run.workspace_id <> new.workspace_id
    or run.stage_id is distinct from new.stage_id or run.status <> 'queued'
    or not exists (select 1 from public.session_artifacts a
      where a.id = new.artifact_id and a.session_id = new.session_id
        and a.workspace_id = new.workspace_id and a.stage_id = new.stage_id
        and a.version = new.artifact_version)
    or not exists (select 1 from public.workspace_members m
      where m.id = new.requested_by_member_id and m.workspace_id = new.workspace_id
        and m.kind = 'human' and m.is_active
        and internal.artifact_review_author_label(m) = new.actor_label) then
    raise exception 'Feedback batch does not match its revision generation.' using errcode = '23514';
  end if;
  if new.checkpoint_run_id is not null and not exists (
    select 1 from public.session_git_checkpoints c
    join public.session_job_git_inputs i on i.job_id = new.job_id
    where c.run_id = new.checkpoint_run_id and c.artifact_id = new.artifact_id
      and c.session_id = new.session_id and c.workspace_id = new.workspace_id
      and i.source_checkpoint_run_id = c.run_id and i.input_sha = c.output_sha
      and i.session_id = c.session_id and i.workspace_id = c.workspace_id
  ) then
    raise exception 'Feedback batch does not match its reviewed checkpoint.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create or replace function internal.link_original_artifact_feedback_job()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.job_id is not null then
    insert into public.artifact_feedback_batch_jobs(job_id,batch_id,workspace_id,session_id)
      values(new.job_id,new.id,new.workspace_id,new.session_id);
  end if;
  return new;
end;
$$;

-- Return a durable rejected receipt when a new repair cannot be admitted. Exact
-- queued-job adoption remains idempotent and consumes no additional attempt.
alter function public.reject_session_stage(uuid,uuid,integer,text,text,text,uuid,uuid,text,uuid) set schema internal;
alter function internal.reject_session_stage(uuid,uuid,integer,text,text,text,uuid,uuid,text,uuid)
  rename to reject_session_stage_before_execution_budget;
revoke all on function internal.reject_session_stage_before_execution_budget(uuid,uuid,integer,text,text,text,uuid,uuid,text,uuid)
  from public,anon,authenticated,service_role;
create function public.reject_session_stage(p_session_id uuid,p_workspace_id uuid,p_artifact_version integer,
  p_feedback_text text,p_agent_model_provider text,p_agent_model_name text,p_expected_stage_id uuid,
  p_expected_artifact_id uuid,p_run_type text default 'project',p_requested_by_member_id uuid default null)
returns table(session_id uuid,workspace_id uuid,current_stage_id uuid,current_artifact_version integer,
  phase_status public.pipeline_phase_status,rejection_count integer,archived_at timestamptz,job_id uuid,run_id uuid,job_created boolean)
language plpgsql security definer set search_path='' as $$
declare s public.sessions; active public.agent_jobs; policy public.execution_policy_revisions; code text; max_repairs integer;
begin
  select * into s from public.sessions owner where owner.id=p_session_id and owner.workspace_id=p_workspace_id for no key update;
  if not found then raise exception 'Session not found.' using errcode='P0002'; end if;
  select * into active from public.agent_jobs active_job where active_job.session_id=s.id and active_job.workspace_id=s.workspace_id
    and active_job.status in('queued','started','running') for update;
  if (active.id is null or active.status<>'queued') and s.archived_at is null
    and s.phase_status='awaiting_review' and s.current_stage_id is not distinct from p_expected_stage_id
    and s.current_artifact_id is not distinct from p_expected_artifact_id
    and s.current_artifact_version=p_artifact_version then
    code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
    if code is null and s.execution_policy_revision_id is not null then
      select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
      max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
      if s.execution_repair_attempts>=max_repairs then
        code:=internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
      end if;
    end if;
    if code is not null then
      insert into public.session_artifact_feedback(workspace_id,session_id,stage_id,stage_slug,target_version,feedback_text)
      select s.workspace_id,s.id,stage.id,stage.slug,p_artifact_version,p_feedback_text
        from public.pipeline_stages stage where stage.id=s.current_stage_id
      on conflict on constraint session_artifact_feedback_unique_target
      do update set feedback_text=excluded.feedback_text;
      update public.sessions owner set phase_status='rejected',rejection_count=owner.rejection_count+1
        where owner.id=s.id and owner.phase_status='awaiting_review';
      return query select s.id,s.workspace_id,s.current_stage_id,s.current_artifact_version,
        'rejected'::public.pipeline_phase_status,s.rejection_count+1,s.archived_at,null::uuid,null::uuid,false;
      return;
    end if;
  end if;
  return query select * from internal.reject_session_stage_before_execution_budget(p_session_id,p_workspace_id,
    p_artifact_version,p_feedback_text,p_agent_model_provider,p_agent_model_name,p_expected_stage_id,
    p_expected_artifact_id,p_run_type,p_requested_by_member_id);
end;
$$;
revoke all on function public.reject_session_stage(uuid,uuid,integer,text,text,text,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.reject_session_stage(uuid,uuid,integer,text,text,text,uuid,uuid,text,uuid) to service_role;

-- Linear rework/continuation is repair work; landing is normal stage execution.
CREATE OR REPLACE FUNCTION public.apply_linear_session_transition(p_session_id uuid, p_workspace_id uuid, p_linear_issue_id text, p_expected_session_updated_at timestamp with time zone, p_expected_routing_updated_at timestamp with time zone, p_source_span_id text, p_source_started_at timestamp with time zone, p_source_state_id text, p_source_issue_updated_at timestamp with time zone, p_status_name text, p_agent_model_provider text DEFAULT NULL::text, p_agent_model_name text DEFAULT NULL::text, p_run_type text DEFAULT 'project'::text)
 RETURNS TABLE(outcome text, job_ids uuid[], run_ids uuid[], job_id uuid, run_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  s public.sessions%rowtype;
  config public.workspace_linear_routing%rowtype;
  receipt internal.session_linear_transition_receipts%rowtype;
  target public.pipeline_stages%rowtype;
  pipeline_id uuid;
  config_key jsonb;
  route_key text;
  candidate text;
  target_slug text;
  normalized_name text := lower(regexp_replace(btrim(p_status_name), '\s+', ' ', 'g'));
  canceled_jobs uuid[] := '{}';
  canceled_runs uuid[] := '{}';
  queued_job uuid;
  queued_run uuid;
  result text := 'observed';
  initial_baseline boolean;
  code text;
  policy public.execution_policy_revisions;
  max_repairs integer;
begin
  if nullif(btrim(p_source_span_id), '') is null or nullif(btrim(p_source_state_id), '') is null
     or nullif(normalized_name, '') is null or p_source_started_at is null or p_source_issue_updated_at is null
     or p_source_started_at > p_source_issue_updated_at then
    raise exception 'A coherent Linear state span is required' using errcode = '22023';
  end if;
  select session.pipeline_id into pipeline_id from public.sessions session
  where session.id = p_session_id and session.workspace_id = p_workspace_id;
  if not found then return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return; end if;
  perform 1 from public.pipelines pipeline where pipeline.id = pipeline_id and pipeline.workspace_id = p_workspace_id for share;
  select * into config from public.workspace_linear_routing where workspace_id = p_workspace_id for share;
  if not found then raise exception 'Linear routing configuration is missing' using errcode = '55000'; end if;
  if config.updated_at is distinct from p_expected_routing_updated_at then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  foreach candidate in array array['backlog','todo','in_progress','in_review','rework','merging','done','canceled'] loop
    if jsonb_typeof(config.status_mappings -> candidate) is distinct from 'array'
       or jsonb_array_length(config.status_mappings -> candidate) = 0 then
      raise exception 'Linear routing configuration is invalid' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(config.status_mappings -> candidate) value
      where jsonb_typeof(value) <> 'string' or btrim(value #>> '{}') = '') then
      raise exception 'Linear routing configuration is invalid' using errcode = '22023';
    end if;
    if route_key is null and exists (
      select 1 from jsonb_array_elements_text(config.status_mappings -> candidate) name
      where lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = normalized_name
    ) then route_key := candidate; end if;
  end loop;
  config_key := jsonb_build_object('route', route_key, 'target', case
    when route_key = 'rework' then config.rework_stage_slug
    when route_key in ('merging','done') then config.land_stage_slug else null end);
  select * into s from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if s.pipeline_id is distinct from pipeline_id or s.linear_issue_id is distinct from p_linear_issue_id
     or ((s.updated_at is distinct from p_expected_session_updated_at or s.archived_at is not null)
         and not (s.archived_at is not null and route_key = 'done')) then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  insert into internal.session_linear_transition_receipts(session_id, baseline_at)
  values(s.id, s.created_at) on conflict do nothing;
  select * into receipt from internal.session_linear_transition_receipts where session_id = s.id;
  if receipt.source_started_at is not null and (
      p_source_started_at < receipt.source_started_at
      or p_source_issue_updated_at < receipt.issue_updated_at
      or (p_source_started_at = receipt.source_started_at and p_source_span_id <> receipt.source_span_id
          and p_source_issue_updated_at <= receipt.issue_updated_at)
    ) then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  if receipt.source_span_id = p_source_span_id and (receipt.source_state_id is distinct from p_source_state_id
      or receipt.source_started_at is distinct from p_source_started_at) then
    raise exception 'Linear state span identity changed' using errcode = '22023';
  end if;
  if receipt.source_span_id = p_source_span_id and receipt.routing_config = config_key then
    update internal.session_linear_transition_receipts set issue_updated_at = p_source_issue_updated_at,
      observed_at = now() where session_id = s.id;
    return query select 'duplicate', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  initial_baseline := receipt.source_span_id is null and p_source_started_at <= receipt.baseline_at;
  if route_key = 'rework' then target_slug := config.rework_stage_slug;
  elsif route_key in ('merging','done') then target_slug := config.land_stage_slug; end if;
  if target_slug is not null then
    select stage.* into target from public.pipeline_stages stage
    join public.session_selected_stages selected on selected.stage_id = stage.id and selected.session_id = s.id
    where stage.workspace_id = s.workspace_id and stage.pipeline_id = s.pipeline_id
      and stage.slug = target_slug for share of stage;
    if not found and route_key <> 'done' then
      return query select 'missing_stage', canceled_jobs, canceled_runs, queued_job, queued_run; return;
    end if;
  end if;
  if s.archived_at is not null and target.id is not null then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  -- Refuse exhausted work before canceling jobs or deleting review history.
  if not initial_baseline and (target.id is not null or (route_key in('todo','in_progress') and s.phase_status in('in_progress','rejected'))) then
    code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
    if code is null and route_key='rework' and s.execution_policy_revision_id is not null then
      select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
      max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
      if s.execution_repair_attempts>=max_repairs then
        code:=internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
      end if;
    end if;
    if code is not null then
      update internal.session_linear_transition_receipts set source_span_id=p_source_span_id,
        source_started_at=p_source_started_at,source_state_id=p_source_state_id,
        issue_updated_at=p_source_issue_updated_at,routing_config=config_key,observed_at=now()
      where session_id=s.id;
      return query select 'exhausted',canceled_jobs,canceled_runs,queued_job,queued_run;
      return;
    end if;
  end if;
  if route_key = 'canceled' or (route_key = 'done' and target.id is null) then
    select archived.job_ids, archived.run_ids into canceled_jobs, canceled_runs
    from public.archive_session_job_attempts(s.id, s.workspace_id,
      'Linear issue moved to "' || p_status_name || '".', route_key = 'done') archived;
    result := case when route_key = 'done' then 'completed' else 'archived' end;
  elsif not initial_baseline and target.id is not null then
    begin
      select canceled.job_ids, canceled.run_ids into canceled_jobs, canceled_runs
      from public.cancel_session_job_attempts(s.id, s.workspace_id,
        'Linear issue moved to "' || p_status_name || '".', null, false) canceled;
      delete from public.session_artifact_feedback feedback using public.pipeline_stages stage
      where feedback.session_id = s.id and feedback.stage_id = stage.id
        and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
      delete from public.session_phase_completions completion using public.pipeline_stages stage
      where completion.session_id = s.id and completion.stage_id = stage.id
        and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
      update public.sessions set current_stage_id = target.id, current_artifact_id = null,
        current_artifact_version = coalesce((select max(version) from public.session_artifacts
          where session_id = s.id and stage_id = target.id), 0),
        phase_status = 'rejected', rejection_count = 0 where id = s.id;
      select queued.job_id, queued.run_id into queued_job, queued_run
      from public.enqueue_session_job_with_run(s.id,s.workspace_id,target.id,null,
        case when route_key='rework' then 'manual_retry'::public.agent_trigger_type else 'assignment'::public.agent_trigger_type end,
        p_agent_model_provider,p_agent_model_name,p_run_type) queued;
      if queued_job is null then raise exception 'Linear execution budget admission refused' using errcode='P429B'; end if;
      if queued_run is null then raise exception 'Linear replacement needs an atomic queued run' using errcode = '55000'; end if;
      result := 'routed';
    exception when sqlstate 'P429B' then
      -- The inner subtransaction restores the original stage, feedback,
      -- completions and active work. Recompute and persist the reason outside it.
      canceled_jobs:='{}'; canceled_runs:='{}'; queued_job:=null; queued_run:=null;
      code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
      if code is null and route_key='rework' and s.execution_policy_revision_id is not null then
        select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
        max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
        if s.execution_repair_attempts>=max_repairs then
          code:=internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
        end if;
      end if;
      if code is null then raise; end if;
      result := 'exhausted';
    end;
  elsif not initial_baseline and route_key in ('todo','in_progress')
      and s.phase_status in ('in_progress','rejected') then
    select queued.job_id, queued.run_id into queued_job, queued_run
    from public.enqueue_session_job_with_run(s.id,s.workspace_id,s.current_stage_id,null,'manual_retry',
      p_agent_model_provider,p_agent_model_name,p_run_type) queued;
    result := case when queued_job is null then 'exhausted' else 'queued' end;
  end if;
  update internal.session_linear_transition_receipts set source_span_id = p_source_span_id,
    source_started_at = p_source_started_at, source_state_id = p_source_state_id,
    issue_updated_at = p_source_issue_updated_at, routing_config = config_key, observed_at = now()
  where session_id = s.id;
  return query select result, canceled_jobs, canceled_runs, queued_job, queued_run;
end;
$function$;
revoke all on function public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text)
  to service_role;
