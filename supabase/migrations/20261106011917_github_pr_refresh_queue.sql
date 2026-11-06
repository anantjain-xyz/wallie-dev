-- GitHub events are wake-ups, never authoritative verification receipts.
create table public.session_pr_refresh_queue (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_generation bigint not null default 1 check(requested_generation>0),
  status text not null default 'pending' check(status in ('pending','claimed','current','error')),
  claim_token uuid,
  claim_generation bigint,
  lease_expires_at timestamptz,
  context jsonb,
  last_observation_id uuid references public.session_pr_verification_observations(id) on delete set null,
  last_error_code text check(last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check((claim_token is null)=(lease_expires_at is null)),
  check((claim_token is null)=(claim_generation is null)),
  check(status<>'claimed' or claim_token is not null)
);
create index session_pr_refresh_queue_workspace_idx on public.session_pr_refresh_queue(workspace_id);
create index session_pr_refresh_queue_observation_idx on public.session_pr_refresh_queue(last_observation_id);
create index session_pr_refresh_queue_due_idx on public.session_pr_refresh_queue(next_attempt_at,session_id);
create unique index session_pr_refresh_queue_claim_idx on public.session_pr_refresh_queue(claim_token) where claim_token is not null;
alter table public.session_pr_refresh_queue enable row level security;
revoke all on public.session_pr_refresh_queue from public,anon,authenticated,service_role;
grant select on public.session_pr_refresh_queue to authenticated,service_role;
create policy session_pr_refresh_queue_read on public.session_pr_refresh_queue for select to authenticated
  using(workspace_id in (select internal.current_user_workspace_ids()));

-- A fanout event may match more than one bounded enqueue batch. The durable
-- repository revision makes every prior collection stale immediately; periodic
-- reconciliation continues the remaining rows without another webhook delivery.
-- Ordinary <=100-target events retain their narrow per-session generation fence.
create table public.github_pr_refresh_watermarks (
  repository_id uuid primary key references public.github_repositories(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  revision bigint not null check(revision>0),
  updated_at timestamptz not null default clock_timestamp()
);
create index github_pr_refresh_watermarks_workspace_idx on public.github_pr_refresh_watermarks(workspace_id);
alter table public.github_pr_refresh_watermarks enable row level security;
revoke all on public.github_pr_refresh_watermarks from public,anon,authenticated,service_role;
grant select on public.github_pr_refresh_watermarks to authenticated,service_role;
create policy github_pr_refresh_watermarks_read on public.github_pr_refresh_watermarks for select to authenticated
  using(workspace_id in (select internal.current_user_workspace_ids()));

create table internal.github_pr_refresh_deliveries (
  installation_id bigint not null,
  github_repository_id bigint not null,
  delivery_id text not null check(length(delivery_id) between 1 and 200),
  received_at timestamptz not null default clock_timestamp(),
  primary key(installation_id,github_repository_id,delivery_id)
);
create index github_pr_refresh_deliveries_age_idx on internal.github_pr_refresh_deliveries(received_at);
alter table internal.github_pr_refresh_deliveries enable row level security;
revoke all on internal.github_pr_refresh_deliveries from public,anon,authenticated,service_role;

-- This exact context is captured before network I/O and compared again under
-- the session lock before publication. Names are snapshots, IDs are authority.
create function internal.github_pr_refresh_context(p_session_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'session_id',s.id,'workspace_id',s.workspace_id,'policy_revision_id',p.current_revision_id,
    'requirements',revision.requirements,'artifact_review_revision',s.artifact_review_revision,
    'checkpoint_run_id',h.checkpoint_run_id,'repository_id',e.repository_id,
    'repository_full_name',e.repository_full_name,'github_repository_id',e.github_repository_id,
    'installation_id',installation.installation_id,'installation_suspended',installation.suspended,
    'repository_archived',repo.is_archived,'pr_epoch_id',e.id,'pr_number',e.pr_number,
    'branch_name',e.branch_name,'base_branch',e.base_branch,
    'sync_generation',sync.target_generation,'github_event_revision',coalesce(watermark.revision,0))
  from public.sessions s
  join public.workspaces workspace on workspace.id=s.workspace_id and workspace.deletion_requested_at is null
  join public.delivery_policies p on p.pipeline_id=s.pipeline_id and p.workspace_id=s.workspace_id
  join public.delivery_policy_revisions revision on revision.id=p.current_revision_id
  join public.session_pr_sync sync on sync.session_id=s.id and sync.workspace_id=s.workspace_id
  join public.session_pr_epochs e on e.id=sync.current_epoch_id and e.session_id=s.id and e.workspace_id=s.workspace_id
  join public.session_git_heads h on h.session_id=s.id and h.workspace_id=s.workspace_id
  join public.session_git_checkpoints c on c.run_id=h.checkpoint_run_id and c.workspace_id=s.workspace_id
    and c.session_id=s.id and c.repository_id=e.repository_id and c.repository_full_name=e.repository_full_name
  join public.github_repositories repo on repo.id=e.repository_id and repo.workspace_id=s.workspace_id
    and repo.repo_id=e.github_repository_id and lower(repo.full_name)=lower(e.repository_full_name)
  join public.github_installations installation on installation.id=repo.github_installation_id
    and installation.workspace_id=s.workspace_id
  left join public.github_pr_refresh_watermarks watermark on watermark.repository_id=repo.id and watermark.workspace_id=s.workspace_id
  where s.id=p_session_id and s.archived_at is null and e.pr_number is not null
    and revision.requirements->>'deliveryMode'='code';
$$;
revoke all on function internal.github_pr_refresh_context(uuid) from public,anon,authenticated,service_role;

create function public.enqueue_session_pr_refresh(p_workspace_id uuid,p_session_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.sessions where id=p_session_id and workspace_id=p_workspace_id and archived_at is null for no key update;
  if not found then return false; end if;
  if not exists(select 1 from public.session_pr_sync sync
    join public.session_pr_epochs e on e.id=sync.current_epoch_id and e.session_id=p_session_id
    join public.sessions s on s.id=sync.session_id
    join public.delivery_policies p on p.pipeline_id=s.pipeline_id and p.workspace_id=p_workspace_id
    join public.delivery_policy_revisions revision on revision.id=p.current_revision_id
    where sync.session_id=p_session_id and sync.workspace_id=p_workspace_id and e.pr_number is not null
      and revision.requirements->>'deliveryMode'='code') then return false; end if;
  insert into public.session_pr_refresh_queue as q(session_id,workspace_id)
    values(p_session_id,p_workspace_id)
    on conflict(session_id) do update set requested_generation=q.requested_generation+1,
      status='pending',last_error_code=null,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp();
  return true;
end;
$$;
revoke all on function public.enqueue_session_pr_refresh(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_session_pr_refresh(uuid,uuid) to service_role;

create function public.enqueue_github_pr_refresh_event(p_installation_id bigint,p_github_repository_id bigint,
  p_delivery_id text,p_pr_numbers integer[] default null,p_head_sha text default null,p_base_branch text default null)
returns integer language plpgsql security definer set search_path='' as $$
declare target_session_id uuid; targets uuid[]; repository public.github_repositories; queued integer:=0;
begin
  if p_installation_id is null or p_installation_id<=0 or p_github_repository_id is null or p_github_repository_id<=0
    or p_delivery_id is null or length(p_delivery_id) not between 1 and 200
    or coalesce(cardinality(p_pr_numbers),0)>100
    or (p_pr_numbers is not null and exists(select 1 from unnest(p_pr_numbers) n where n is null or n<=0))
    or (p_head_sha is not null and p_head_sha !~ '^[a-f0-9]{40}$')
    or (p_base_branch is not null and not internal.is_git_branch_ref('refs/heads/'||p_base_branch))
    or (coalesce(cardinality(p_pr_numbers),0)=0 and p_head_sha is null and p_base_branch is null)
    then raise exception 'Invalid GitHub refresh event.' using errcode='22023'; end if;
  -- Resolve one installed repository before deduplication or tenant work.
  select r.* into repository from public.github_installations i join public.github_repositories r
    on r.github_installation_id=i.id and r.workspace_id=i.workspace_id
    where i.installation_id=p_installation_id and r.repo_id=p_github_repository_id;
  if not found then return 0; end if;
  perform 1 from public.workspaces where id=repository.workspace_id and deletion_requested_at is null for share;
  if not found then return 0; end if;
  insert into internal.github_pr_refresh_deliveries(installation_id,github_repository_id,delivery_id)
    values(p_installation_id,p_github_repository_id,p_delivery_id) on conflict do nothing;
  if not found then return 0; end if;
  -- Filter archives and code-policy/canonical prerequisites BEFORE the bounded
  -- discovery. One extra eligible ID proves continuation is needed.
  select array_agg(m.session_id order by m.session_id) into targets from (
    select e.session_id from public.session_pr_epochs e
    join public.session_pr_sync sync on sync.session_id=e.session_id and sync.current_epoch_id=e.id
      and sync.workspace_id=repository.workspace_id
    join public.sessions s on s.id=e.session_id and s.workspace_id=repository.workspace_id and s.archived_at is null
    join public.delivery_policies policy on policy.pipeline_id=s.pipeline_id and policy.workspace_id=s.workspace_id
    join public.delivery_policy_revisions revision on revision.id=policy.current_revision_id
      and revision.requirements->>'deliveryMode'='code'
    left join public.session_pr_refresh_queue refresh on refresh.session_id=e.session_id
    left join public.session_pr_verification_observations observation on observation.id=refresh.last_observation_id
    where e.repository_id=repository.id and e.workspace_id=repository.workspace_id
      and e.github_repository_id=p_github_repository_id and e.pr_number is not null
      and (e.pr_number=any(p_pr_numbers) or e.pr_head_sha=p_head_sha or e.base_branch=p_base_branch or e.branch_name=p_base_branch
        or observation.payload->'checkEvidence'->>'selectedSha'=p_head_sha
        or observation.payload->'checkEvidence'->'merge'->>'sha'=p_head_sha)
      and internal.github_pr_refresh_context(e.session_id) is not null
    order by e.session_id limit 101
  ) m;
  if coalesce(cardinality(targets),0)>100 then
    -- Atomic with delivery dedupe and the initial batch. An unqueued current
    -- row fails currentness immediately and remains a periodic mismatch until
    -- enqueued. An in-flight receipt is fenced by its pinned context revision.
    insert into public.github_pr_refresh_watermarks as watermark(repository_id,workspace_id,revision)
      values(repository.id,repository.workspace_id,1)
      on conflict(repository_id) do update set revision=watermark.revision+1,updated_at=clock_timestamp();
  end if;
  foreach target_session_id in array coalesce(targets,'{}'::uuid[]) loop
    exit when queued>=100;
    if public.enqueue_session_pr_refresh(repository.workspace_id,target_session_id) then queued:=queued+1; end if;
  end loop;
  return queued;
end;
$$;
revoke all on function public.enqueue_github_pr_refresh_event(bigint,bigint,text,integer[],text,text) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_github_pr_refresh_event(bigint,bigint,text,integer[],text,text) to service_role;

create function public.enqueue_due_github_pr_refreshes(p_limit integer default 20,p_workspace_id uuid default null)
returns integer language plpgsql security definer set search_path='' as $$
declare target record; queued integer:=0;
begin
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid refresh limit.' using errcode='22023'; end if;
  -- Retain delivery IDs for seven days; deleting a bounded old batch is safe:
  -- a very late redelivery merely schedules another authoritative GET.
  delete from internal.github_pr_refresh_deliveries where (installation_id,github_repository_id,delivery_id) in
    (select installation_id,github_repository_id,delivery_id from internal.github_pr_refresh_deliveries
      where received_at<clock_timestamp()-interval '7 days' order by received_at limit 1000);
  for target in select s.id,s.workspace_id from public.sessions s
    join public.workspaces workspace on workspace.id=s.workspace_id and workspace.deletion_requested_at is null
    join public.delivery_policies p on p.pipeline_id=s.pipeline_id and p.workspace_id=s.workspace_id
    join public.delivery_policy_revisions revision on revision.id=p.current_revision_id
    join public.session_pr_sync sync on sync.session_id=s.id and sync.workspace_id=s.workspace_id
    join public.session_pr_epochs e on e.id=sync.current_epoch_id and e.session_id=s.id
    left join public.session_pr_refresh_queue q on q.session_id=s.id
    where s.archived_at is null and e.pr_number is not null and revision.requirements->>'deliveryMode'='code'
      and (p_workspace_id is null or s.workspace_id=p_workspace_id)
      and (q.session_id is null or (q.status='current' and (q.next_attempt_at<=clock_timestamp()
        or q.context is distinct from internal.github_pr_refresh_context(s.id))))
    order by q.next_attempt_at nulls first,s.id limit p_limit
  loop
    perform 1 from public.workspaces where id=target.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    if public.enqueue_session_pr_refresh(target.workspace_id,target.id) then queued:=queued+1; end if;
  end loop;
  return queued;
end;
$$;
revoke all on function public.enqueue_due_github_pr_refreshes(integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_due_github_pr_refreshes(integer,uuid) to service_role;

create function public.claim_github_pr_refresh(p_workspace_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record; q public.session_pr_refresh_queue; snapshot jsonb; token uuid;
begin
  for candidate in select refresh.session_id,refresh.workspace_id from public.session_pr_refresh_queue refresh
    join public.sessions active on active.id=refresh.session_id and active.archived_at is null
    join public.workspaces workspace on workspace.id=refresh.workspace_id and workspace.deletion_requested_at is null
    where (p_workspace_id is null or refresh.workspace_id=p_workspace_id)
      and ((status in ('pending','error') and next_attempt_at<=clock_timestamp())
        or (claim_token is not null and lease_expires_at<=clock_timestamp()))
    order by next_attempt_at,refresh.session_id limit 100
  loop
    -- Admission is workspace first, then session and queue; SKIP LOCKED bounds contention.
    perform 1 from public.workspaces where id=candidate.workspace_id and deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions where id=candidate.session_id and archived_at is null for no key update skip locked;
    if not found then continue; end if;
    select * into q from public.session_pr_refresh_queue where session_id=candidate.session_id for update skip locked;
    if not found or (q.claim_token is not null and q.lease_expires_at>clock_timestamp())
      or q.next_attempt_at>clock_timestamp() then continue; end if;
    snapshot:=internal.github_pr_refresh_context(candidate.session_id);
    if snapshot is null then
      update public.session_pr_refresh_queue set status='error',last_error_code='github_identity_unavailable',
        claim_token=null,claim_generation=null,lease_expires_at=null,
        next_attempt_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() where session_id=q.session_id;
      continue;
    end if;
    token:=gen_random_uuid();
    update public.session_pr_refresh_queue set status='claimed',claim_token=token,claim_generation=requested_generation,
      lease_expires_at=clock_timestamp()+interval '2 minutes',context=snapshot,attempt_count=attempt_count+1,
      updated_at=clock_timestamp() where session_id=q.session_id;
    return snapshot||jsonb_build_object('claim_token',token);
  end loop;
  return null;
end;
$$;
revoke all on function public.claim_github_pr_refresh(uuid) from public,anon,authenticated,service_role;
grant execute on function public.claim_github_pr_refresh(uuid) to service_role;

create function public.finish_github_pr_refresh(p_session_id uuid,p_claim_token uuid,p_head_sha text default null,
  p_base_sha text default null,p_payload jsonb default null,p_error_code text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare q public.session_pr_refresh_queue; snapshot jsonb; observation public.session_pr_verification_observations; workspace uuid;
begin
  select workspace_id into workspace from public.sessions where id=p_session_id;
  perform 1 from public.workspaces where id=workspace and deletion_requested_at is null for share;
  if not found then return false; end if;
  perform 1 from public.sessions where id=p_session_id and archived_at is null for no key update;
  if not found then return false; end if;
  select * into q from public.session_pr_refresh_queue where session_id=p_session_id for update;
  if not found or q.claim_token is distinct from p_claim_token or p_claim_token is null
    or q.lease_expires_at<=clock_timestamp() then return false; end if;
  snapshot:=internal.github_pr_refresh_context(p_session_id);
  if q.claim_generation is distinct from q.requested_generation or snapshot is distinct from q.context then
    update public.session_pr_refresh_queue set status='pending',claim_token=null,claim_generation=null,
      lease_expires_at=null,last_error_code=null,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
      where session_id=p_session_id;
    return false;
  end if;
  if p_error_code is not null then
    if p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then raise exception 'Invalid GitHub refresh error.' using errcode='22023'; end if;
    update public.session_pr_refresh_queue set status='error',claim_token=null,claim_generation=null,lease_expires_at=null,
      last_error_code=p_error_code,next_attempt_at=clock_timestamp()+make_interval(secs=>least(900,30*power(2,least(greatest(attempt_count-1,0),5)))::integer),
      updated_at=clock_timestamp() where session_id=p_session_id;
    return true;
  end if;
  if p_head_sha is null or p_head_sha !~ '^[a-f0-9]{40}$' or p_base_sha is null or p_base_sha !~ '^[a-f0-9]{40}$'
    or p_payload is null or jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>262144
    or (snapshot->>'installation_suspended')::boolean or (snapshot->>'repository_archived')::boolean then
    raise exception 'Invalid GitHub refresh receipt.' using errcode='22023'; end if;
  observation:=public.record_pr_verification_observation(q.workspace_id,p_session_id,
    (snapshot->>'policy_revision_id')::uuid,(snapshot->>'repository_id')::uuid,snapshot->>'repository_full_name',
    (snapshot->>'pr_epoch_id')::uuid,(snapshot->>'pr_number')::integer,p_head_sha,p_base_sha,
    (snapshot->>'checkpoint_run_id')::uuid,(snapshot->>'artifact_review_revision')::bigint,'github',p_payload,clock_timestamp());
  update public.session_pr_refresh_queue set status='current',claim_token=null,claim_generation=null,lease_expires_at=null,
    last_error_code=null,last_observation_id=observation.id,attempt_count=0,
    next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,greatest(30,(snapshot->'requirements'->>'freshnessSeconds')::integer/2))),
    updated_at=clock_timestamp() where session_id=p_session_id;
  return true;
end;
$$;
revoke all on function public.finish_github_pr_refresh(uuid,uuid,text,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_github_pr_refresh(uuid,uuid,text,text,jsonb,text) to service_role;

-- A dirty or failed refresh invalidates previously green decisions immediately.
-- The later readiness evaluator must consume the latest GitHub observation.
create or replace view public.session_pr_verification_currentness with (security_invoker=true) as
select r.*, coalesce(
  s.archived_at is null and workspace.deletion_requested_at is null
  and p.current_revision_id=o.policy_revision_id and s.artifact_review_revision=o.artifact_review_revision
  and o.observed_at<=statement_timestamp()+interval '5 seconds'
  and o.observed_at>statement_timestamp()-make_interval(secs=>(revision.requirements->>'freshnessSeconds')::integer)
  and case when revision.requirements->>'deliveryMode'='analysis' then o.pr_epoch_id is null
    else repo.id=o.repository_id and repo.workspace_id=o.workspace_id and repo.full_name=o.repository_full_name
      and not repo.is_archived and installation.id=repo.github_installation_id
      and installation.workspace_id=o.workspace_id and not installation.suspended
      and sync.current_epoch_id=o.pr_epoch_id and sync.status='synced' and sync.desired_checkpoint_run_id=o.checkpoint_run_id
      and h.checkpoint_run_id=o.checkpoint_run_id and e.pr_number=o.pr_number and e.pr_head_sha=o.head_sha
      and e.repository_id=o.repository_id and e.repository_full_name=o.repository_full_name
      and c.repository_id=o.repository_id and c.repository_full_name=o.repository_full_name and c.output_sha=o.head_sha
      and q.status='current' and github.head_sha=o.head_sha and github.base_sha=o.base_sha
      and github.observed_at<=statement_timestamp()+interval '5 seconds'
      and github.observed_at>statement_timestamp()-make_interval(secs=>(revision.requirements->>'freshnessSeconds')::integer)
      and github.policy_revision_id=o.policy_revision_id and github.pr_epoch_id=o.pr_epoch_id
      and github.checkpoint_run_id=o.checkpoint_run_id and github.artifact_review_revision=o.artifact_review_revision
      and github.created_at<=o.created_at
      and (q.context->>'sync_generation')::bigint=sync.target_generation
      and coalesce((q.context->>'github_event_revision')::bigint,0)=coalesce(watermark.revision,0) end,false) as is_current
from public.session_pr_verification_results r
join public.session_pr_verification_observations o on o.id=r.observation_id
join public.sessions s on s.id=r.session_id
join public.workspaces workspace on workspace.id=s.workspace_id
join public.delivery_policy_revisions revision on revision.id=o.policy_revision_id
left join public.delivery_policies p on p.pipeline_id=s.pipeline_id
left join public.session_pr_sync sync on sync.session_id=s.id
left join public.session_pr_epochs e on e.id=sync.current_epoch_id
left join public.session_git_heads h on h.session_id=s.id
left join public.session_git_checkpoints c on c.run_id=o.checkpoint_run_id
left join public.github_repositories repo on repo.id=o.repository_id
left join public.github_installations installation on installation.id=repo.github_installation_id
left join public.session_pr_refresh_queue q on q.session_id=s.id
left join public.github_pr_refresh_watermarks watermark on watermark.repository_id=repo.id and watermark.workspace_id=s.workspace_id
left join public.session_pr_verification_observations github on github.id=q.last_observation_id;
