-- Delivery verification is independent of phase_status and artifact approval.
-- Deliberately no legacy backfill: missing policy or observations means unknown.
create type public.pr_readiness_state as enum ('unknown','checking','blocked','ready','merged','closed','not_applicable');

create function internal.valid_delivery_requirements(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare field text; item jsonb;
begin
  if jsonb_typeof(value) is distinct from 'object' or
    (select count(*) from jsonb_object_keys(value)) <> 9 or
    value->'version' is distinct from '1'::jsonb or
    value->>'deliveryMode' not in ('code','analysis') or value->>'deliveryMode' is null then return false; end if;
  foreach field in array array['requireCodeOwnerReview','requireResolvedThreads','requireArtifactApprovalForDelivery'] loop
    if jsonb_typeof(value->field) is distinct from 'boolean' then return false; end if;
  end loop;
  foreach field in array array['minimumApprovals','freshnessSeconds'] loop
    if jsonb_typeof(value->field) is distinct from 'number' or (value->>field)::numeric<>trunc((value->>field)::numeric) then return false; end if;
  end loop;
  if (value->>'minimumApprovals')::numeric not between 0 and 20 or
    (value->>'freshnessSeconds')::numeric not between 60 and 604800 then return false; end if;
  foreach field in array array['requiredChecks','requiredEvidence'] loop
    if jsonb_typeof(value->field) is distinct from 'array' or jsonb_array_length(value->field)>100 then return false; end if;
    for item in select * from jsonb_array_elements(value->field) loop
      if jsonb_typeof(item) is distinct from 'string' or char_length(btrim(item #>> '{}')) not between 1 and 200
        or (item #>> '{}')<>btrim(item #>> '{}') then return false; end if;
    end loop;
    if (select count(*) from jsonb_array_elements(value->field)) <>
       (select count(distinct x) from jsonb_array_elements(value->field) x) then return false; end if;
  end loop;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end;
$$;
revoke all on function internal.valid_delivery_requirements(jsonb) from public,anon,authenticated,service_role;

create table public.delivery_policy_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  pipeline_id uuid not null references public.pipelines(id) on delete cascade,
  revision bigint not null check(revision>0),
  requirements jsonb not null check(internal.valid_delivery_requirements(requirements)),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(pipeline_id,revision)
);
create index delivery_policy_revisions_workspace_idx on public.delivery_policy_revisions(workspace_id);
create table public.delivery_policies (
  pipeline_id uuid primary key references public.pipelines(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  current_revision_id uuid not null references public.delivery_policy_revisions(id) on delete cascade,
  revision bigint not null check(revision>0)
);
create index delivery_policies_workspace_idx on public.delivery_policies(workspace_id);
create index delivery_policies_revision_idx on public.delivery_policies(current_revision_id);

create table public.session_pr_verification_observations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  policy_revision_id uuid not null references public.delivery_policy_revisions(id) on delete cascade,
  repository_id uuid,
  repository_full_name text,
  pr_epoch_id uuid references public.session_pr_epochs(id) on delete cascade,
  pr_number integer check(pr_number>0),
  head_sha text check(head_sha ~ '^[a-f0-9]{40}$'),
  base_sha text check(base_sha ~ '^[a-f0-9]{40}$'),
  checkpoint_run_id uuid references public.session_git_checkpoints(run_id) on delete cascade,
  artifact_review_revision bigint not null check(artifact_review_revision>=0),
  source text not null check(source in ('github','evidence','readiness')),
  payload jsonb not null check(jsonb_typeof(payload)='object' and pg_column_size(payload)<=262144),
  observed_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index session_pr_verification_observations_workspace_idx on public.session_pr_verification_observations(workspace_id);
create index session_pr_verification_observations_session_idx on public.session_pr_verification_observations(session_id,created_at desc,id);
create index session_pr_verification_observations_policy_idx on public.session_pr_verification_observations(policy_revision_id);
create index session_pr_verification_observations_epoch_idx on public.session_pr_verification_observations(pr_epoch_id);
create index session_pr_verification_observations_checkpoint_idx on public.session_pr_verification_observations(checkpoint_run_id);

create table public.session_pr_verification_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  observation_id uuid not null references public.session_pr_verification_observations(id) on delete cascade,
  state public.pr_readiness_state not null,
  blockers jsonb not null check(jsonb_typeof(blockers)='array' and pg_column_size(blockers)<=65536),
  created_at timestamptz not null default clock_timestamp()
);
create index session_pr_verification_results_workspace_idx on public.session_pr_verification_results(workspace_id);
create index session_pr_verification_results_session_idx on public.session_pr_verification_results(session_id,created_at desc,id);
create index session_pr_verification_results_observation_idx on public.session_pr_verification_results(observation_id);

alter table public.delivery_policy_revisions enable row level security;
alter table public.delivery_policies enable row level security;
alter table public.session_pr_verification_observations enable row level security;
alter table public.session_pr_verification_results enable row level security;
revoke all on public.delivery_policy_revisions,public.delivery_policies,public.session_pr_verification_observations,
  public.session_pr_verification_results from public,anon,authenticated,service_role;
grant select on public.delivery_policy_revisions,public.delivery_policies,public.session_pr_verification_observations,
  public.session_pr_verification_results to authenticated,service_role;
create policy delivery_policy_revisions_read on public.delivery_policy_revisions for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));
create policy delivery_policies_read on public.delivery_policies for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));
create policy session_pr_verification_observations_read on public.session_pr_verification_observations for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));
create policy session_pr_verification_results_read on public.session_pr_verification_results for select to authenticated
  using(workspace_id in(select internal.current_user_workspace_ids()));

create function internal.guard_delivery_verification()
returns trigger language plpgsql security invoker set search_path='' as $$
declare policy public.delivery_policy_revisions; observation public.session_pr_verification_observations;
  session public.sessions; epoch public.session_pr_epochs;
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id)
      or not exists(select 1 from public.pipelines where id=(to_jsonb(old)->>'pipeline_id')::uuid)
        and tg_table_name in ('delivery_policy_revisions','delivery_policies')
      or tg_table_name in ('session_pr_verification_observations','session_pr_verification_results')
        and not exists(select 1 from public.sessions where id=(to_jsonb(old)->>'session_id')::uuid) then return old; end if;
    raise exception 'Delivery verification history is immutable.' using errcode='23514';
  end if;
  if tg_op='UPDATE' and tg_table_name<>'delivery_policies' then
    raise exception 'Delivery verification history is immutable.' using errcode='23514';
  end if;
  if tg_table_name='delivery_policy_revisions' then
    if not exists(select 1 from public.pipelines p where p.id=new.pipeline_id and p.workspace_id=new.workspace_id) then
      raise exception 'Delivery policy pipeline is outside the workspace.' using errcode='23514'; end if;
  elsif tg_table_name='delivery_policies' then
    select * into policy from public.delivery_policy_revisions where id=new.current_revision_id;
    if policy.pipeline_id is distinct from new.pipeline_id or policy.workspace_id is distinct from new.workspace_id
      or policy.revision is distinct from new.revision
      or (tg_op='UPDATE' and (new.pipeline_id is distinct from old.pipeline_id or new.workspace_id is distinct from old.workspace_id
        or new.revision<>old.revision+1)) then
      raise exception 'Delivery policy revision does not match the current policy.' using errcode='23514'; end if;
  elsif tg_table_name='session_pr_verification_observations' then
    select * into session from public.sessions s where s.id=new.session_id and s.workspace_id=new.workspace_id;
    select * into policy from public.delivery_policy_revisions p where p.id=new.policy_revision_id;
    if session.id is null or policy.workspace_id is distinct from new.workspace_id or policy.pipeline_id is distinct from session.pipeline_id then
      raise exception 'Verification policy does not match the session.' using errcode='23514'; end if;
    if new.observed_at>clock_timestamp()+interval '5 seconds' then
      raise exception 'Verification observation time is in the future.' using errcode='23514'; end if;
    if policy.requirements->>'deliveryMode'='code' then
      if new.repository_id is null or new.repository_full_name is null or new.pr_epoch_id is null or new.pr_number is null
        or new.head_sha is null or new.base_sha is null or new.checkpoint_run_id is null then
        raise exception 'Code verification requires a complete canonical PR identity.' using errcode='23514'; end if;
    end if;
    if new.pr_epoch_id is not null then
      select * into epoch from public.session_pr_epochs e where e.id=new.pr_epoch_id;
      if epoch.workspace_id is distinct from new.workspace_id or epoch.session_id is distinct from new.session_id
        or epoch.repository_id is distinct from new.repository_id or epoch.repository_full_name is distinct from new.repository_full_name
        or epoch.pr_number is distinct from new.pr_number then
        raise exception 'Verification canonical PR identity does not match the session.' using errcode='23514'; end if;
    elsif new.pr_number is not null or new.repository_id is not null or new.repository_full_name is not null
      or new.head_sha is not null or new.base_sha is not null or new.checkpoint_run_id is not null then
      raise exception 'Verification identity must be complete or absent for analysis.' using errcode='23514';
    end if;
    if new.checkpoint_run_id is not null and not exists(select 1 from public.session_git_checkpoints c
      where c.run_id=new.checkpoint_run_id and c.session_id=new.session_id and c.workspace_id=new.workspace_id
        and c.repository_id=new.repository_id and c.repository_full_name=new.repository_full_name) then
      raise exception 'Verification checkpoint does not match the session repository.' using errcode='23514'; end if;
  else
    select * into observation from public.session_pr_verification_observations o where o.id=new.observation_id;
    select * into policy from public.delivery_policy_revisions p where p.id=observation.policy_revision_id;
    if observation.workspace_id is distinct from new.workspace_id or observation.session_id is distinct from new.session_id then
      raise exception 'Verification result does not match its observation.' using errcode='23514'; end if;
    if (policy.requirements->>'deliveryMode'='analysis' and new.state not in ('unknown','not_applicable'))
      or (policy.requirements->>'deliveryMode'='code' and new.state='not_applicable') then
      raise exception 'Verification state does not match the delivery mode.' using errcode='23514'; end if;
    -- A privileged evaluator must explicitly attest each verification dimension.
    -- This storage guard is not the OP-508 evaluator: missing access/requirements
    -- cannot accidentally turn an empty JSON observation into Ready.
    if new.state='ready' and (observation.source is distinct from 'readiness'
      or observation.payload->>'githubAccess' is distinct from 'available'
      or observation.payload->>'checks' is distinct from 'passed'
      or observation.payload->>'reviews' is distinct from 'passed'
      or observation.payload->>'evidence' is distinct from 'passed'
      or observation.payload->>'threads' is distinct from 'passed') then
      raise exception 'Ready requires explicit successful verification dimensions.' using errcode='23514';
    end if;
    if new.state in ('ready','not_applicable') and jsonb_array_length(new.blockers)>0 then
      raise exception 'Successful verification cannot contain blockers.' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_delivery_verification() from public,anon,authenticated,service_role;
create trigger guard_delivery_policy_revisions before insert or update or delete on public.delivery_policy_revisions
  for each row execute function internal.guard_delivery_verification();
create trigger guard_delivery_policies before insert or update or delete on public.delivery_policies
  for each row execute function internal.guard_delivery_verification();
create trigger guard_pr_verification_observations before insert or update or delete on public.session_pr_verification_observations
  for each row execute function internal.guard_delivery_verification();
create trigger guard_pr_verification_results before insert or update or delete on public.session_pr_verification_results
  for each row execute function internal.guard_delivery_verification();

create function public.save_delivery_policy(p_workspace_id uuid,p_pipeline_id uuid,p_actor_user_id uuid,
  p_expected_revision bigint,p_requirements jsonb)
returns public.delivery_policy_revisions language plpgsql security definer set search_path='' as $$
declare current_policy public.delivery_policies; result public.delivery_policy_revisions;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.pipelines p where p.id=p_pipeline_id and p.workspace_id=p_workspace_id for update;
  if not found then raise exception 'Delivery policy pipeline is unavailable.' using errcode='42501'; end if;
  perform 1 from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=p_actor_user_id
    and m.kind='human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then raise exception 'Active workspace manager required.' using errcode='42501'; end if;
  select * into current_policy from public.delivery_policies where pipeline_id=p_pipeline_id;
  if p_expected_revision is null or p_expected_revision<>coalesce(current_policy.revision,0) then
    -- Semantic optimistic-concurrency conflict, not a retryable serialization failure.
    raise exception 'Delivery policy changed. Reload before saving.' using errcode='PT409'; end if;
  if not internal.valid_delivery_requirements(p_requirements) then
    raise exception 'Invalid delivery requirements.' using errcode='23514'; end if;
  insert into public.delivery_policy_revisions(workspace_id,pipeline_id,revision,requirements,created_by)
    values(p_workspace_id,p_pipeline_id,coalesce(current_policy.revision,0)+1,p_requirements,p_actor_user_id) returning * into result;
  insert into public.delivery_policies(pipeline_id,workspace_id,current_revision_id,revision)
    values(p_pipeline_id,p_workspace_id,result.id,result.revision)
    on conflict(pipeline_id) do update set current_revision_id=excluded.current_revision_id,revision=excluded.revision;
  return result;
end;
$$;
revoke all on function public.save_delivery_policy(uuid,uuid,uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_delivery_policy(uuid,uuid,uuid,bigint,jsonb) to service_role;

create function public.record_pr_verification_observation(p_workspace_id uuid,p_session_id uuid,p_policy_revision_id uuid,
  p_repository_id uuid,p_repository_full_name text,p_pr_epoch_id uuid,p_pr_number integer,p_head_sha text,p_base_sha text,
  p_checkpoint_run_id uuid,p_artifact_review_revision bigint,p_source text,p_payload jsonb,p_observed_at timestamptz)
returns public.session_pr_verification_observations language plpgsql security definer set search_path='' as $$
declare result public.session_pr_verification_observations;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.sessions s where s.id=p_session_id and s.workspace_id=p_workspace_id and s.archived_at is null for no key update;
  if not found then raise exception 'Verification session is unavailable.' using errcode='42501'; end if;
  insert into public.session_pr_verification_observations(workspace_id,session_id,policy_revision_id,repository_id,repository_full_name,
    pr_epoch_id,pr_number,head_sha,base_sha,checkpoint_run_id,artifact_review_revision,source,payload,observed_at)
    values(p_workspace_id,p_session_id,p_policy_revision_id,p_repository_id,p_repository_full_name,p_pr_epoch_id,p_pr_number,
      p_head_sha,p_base_sha,p_checkpoint_run_id,p_artifact_review_revision,p_source,p_payload,p_observed_at) returning * into result;
  return result;
end;
$$;
revoke all on function public.record_pr_verification_observation(uuid,uuid,uuid,uuid,text,uuid,integer,text,text,uuid,bigint,text,jsonb,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.record_pr_verification_observation(uuid,uuid,uuid,uuid,text,uuid,integer,text,text,uuid,bigint,text,jsonb,timestamptz) to service_role;

create function public.record_pr_verification_result(p_observation_id uuid,p_state public.pr_readiness_state,p_blockers jsonb)
returns public.session_pr_verification_results language plpgsql security definer set search_path='' as $$
declare observation public.session_pr_verification_observations; result public.session_pr_verification_results;
begin
  select * into observation from public.session_pr_verification_observations where id=p_observation_id;
  perform internal.assert_workspace_accepts_work(observation.workspace_id);
  perform 1 from public.sessions s where s.id=observation.session_id and s.workspace_id=observation.workspace_id and s.archived_at is null for no key update;
  if not found then raise exception 'Verification session is unavailable.' using errcode='42501'; end if;
  insert into public.session_pr_verification_results(workspace_id,session_id,observation_id,state,blockers)
    values(observation.workspace_id,observation.session_id,observation.id,p_state,p_blockers) returning * into result;
  return result;
end;
$$;
revoke all on function public.record_pr_verification_result(uuid,public.pr_readiness_state,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_pr_verification_result(uuid,public.pr_readiness_state,jsonb) to service_role;

-- This is identity/freshness metadata, not a readiness evaluator. OP-506 owns
-- authoritative GitHub/base observations; OP-508 owns the decision algorithm.
create view public.session_pr_verification_currentness with (security_invoker=true) as
select r.*, coalesce(
  p.current_revision_id=o.policy_revision_id and s.artifact_review_revision=o.artifact_review_revision
  and o.observed_at<=statement_timestamp()+interval '5 seconds'
  and o.observed_at>statement_timestamp()-make_interval(secs=>(revision.requirements->>'freshnessSeconds')::integer)
  and case when revision.requirements->>'deliveryMode'='analysis' then o.pr_epoch_id is null
    else repo.id=o.repository_id and repo.workspace_id=o.workspace_id and repo.full_name=o.repository_full_name
      and not repo.is_archived and installation.id=repo.github_installation_id
      and installation.workspace_id=o.workspace_id and not installation.suspended
      and sync.current_epoch_id=o.pr_epoch_id and sync.status='synced' and sync.desired_checkpoint_run_id=o.checkpoint_run_id
      and h.checkpoint_run_id=o.checkpoint_run_id and e.pr_number=o.pr_number and e.pr_head_sha=o.head_sha
      and e.repository_id=o.repository_id and e.repository_full_name=o.repository_full_name
      and c.repository_id=o.repository_id and c.repository_full_name=o.repository_full_name
      and c.output_sha=o.head_sha end,false) as is_current
from public.session_pr_verification_results r
join public.session_pr_verification_observations o on o.id=r.observation_id
join public.sessions s on s.id=r.session_id
join public.delivery_policy_revisions revision on revision.id=o.policy_revision_id
left join public.delivery_policies p on p.pipeline_id=s.pipeline_id
left join public.session_pr_sync sync on sync.session_id=s.id
left join public.session_pr_epochs e on e.id=sync.current_epoch_id
left join public.session_git_heads h on h.session_id=s.id
left join public.session_git_checkpoints c on c.run_id=o.checkpoint_run_id
left join public.github_repositories repo on repo.id=o.repository_id
left join public.github_installations installation on installation.id=repo.github_installation_id;
revoke all on public.session_pr_verification_currentness from public,anon,authenticated,service_role;
grant select on public.session_pr_verification_currentness to authenticated,service_role;
