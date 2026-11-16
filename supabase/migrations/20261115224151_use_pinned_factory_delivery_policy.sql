-- Every refresh, evaluator currentness check, and final approval uses the
-- session's admitted policy revision. A legacy session resolves the current
-- pipeline policy as before. Explicit null remains unconfigured.

create or replace function internal.github_pr_refresh_context(p_session_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'session_id',s.id,'workspace_id',s.workspace_id,'policy_revision_id',revision.id,
    'requirements',revision.requirements,'artifact_review_revision',s.artifact_review_revision,
    'checkpoint_run_id',h.checkpoint_run_id,'repository_id',e.repository_id,
    'repository_full_name',e.repository_full_name,'github_repository_id',e.github_repository_id,
    'installation_id',installation.installation_id,'installation_suspended',installation.suspended,
    'repository_archived',repo.is_archived,'pr_epoch_id',e.id,'pr_number',e.pr_number,
    'branch_name',e.branch_name,'base_branch',e.base_branch,
    'sync_generation',sync.target_generation,'github_event_revision',coalesce(watermark.revision,0))
  from public.sessions s
  join public.workspaces workspace on workspace.id=s.workspace_id and workspace.deletion_requested_at is null
  left join public.delivery_policies p on p.pipeline_id=s.pipeline_id and p.workspace_id=s.workspace_id
    and not s.execute_pinned_definition
  join public.delivery_policy_revisions revision on revision.id=case when s.execute_pinned_definition then s.pinned_delivery_policy_revision_id else p.current_revision_id end
    and revision.workspace_id=s.workspace_id and revision.pipeline_id=s.pipeline_id
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

create or replace function public.enqueue_session_pr_refresh(p_workspace_id uuid,p_session_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.sessions where id=p_session_id and workspace_id=p_workspace_id and archived_at is null for no key update;
  if not found then return false; end if;
  if not exists(select 1 from public.session_pr_sync sync
    join public.session_pr_epochs e on e.id=sync.current_epoch_id and e.session_id=p_session_id
    join public.sessions s on s.id=sync.session_id
    left join public.delivery_policies p on p.pipeline_id=s.pipeline_id and p.workspace_id=p_workspace_id
      and not s.execute_pinned_definition
    join public.delivery_policy_revisions revision on revision.id=case when s.execute_pinned_definition then s.pinned_delivery_policy_revision_id else p.current_revision_id end
      and revision.workspace_id=p_workspace_id and revision.pipeline_id=s.pipeline_id
    where sync.session_id=p_session_id and sync.workspace_id=p_workspace_id and e.pr_number is not null
      and revision.requirements->>'deliveryMode'='code') then return false; end if;
  insert into public.session_pr_refresh_queue as q(session_id,workspace_id)
    values(p_session_id,p_workspace_id)
    on conflict(session_id) do update set requested_generation=q.requested_generation+1,
      status='pending',last_error_code=null,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp();
  return true;
end;
$$;

create or replace function public.enqueue_github_pr_refresh_event(p_installation_id bigint,p_github_repository_id bigint,
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
    left join public.delivery_policies policy on policy.pipeline_id=s.pipeline_id and policy.workspace_id=s.workspace_id
      and not s.execute_pinned_definition
    join public.delivery_policy_revisions revision on revision.id=case when s.execute_pinned_definition then s.pinned_delivery_policy_revision_id else policy.current_revision_id end
      and revision.workspace_id=s.workspace_id and revision.pipeline_id=s.pipeline_id
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

create or replace function public.enqueue_due_github_pr_refreshes(p_limit integer default 20,p_workspace_id uuid default null)
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
    left join public.delivery_policies p on p.pipeline_id=s.pipeline_id and p.workspace_id=s.workspace_id
      and not s.execute_pinned_definition
    join public.delivery_policy_revisions revision on revision.id=case when s.execute_pinned_definition then s.pinned_delivery_policy_revision_id else p.current_revision_id end
      and revision.workspace_id=s.workspace_id and revision.pipeline_id=s.pipeline_id
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

create or replace view public.session_pr_verification_currentness with (security_invoker=true) as
select r.*, coalesce(
  s.archived_at is null and workspace.deletion_requested_at is null
  and (case when s.execute_pinned_definition then s.pinned_delivery_policy_revision_id else p.current_revision_id end)=o.policy_revision_id and s.artifact_review_revision=o.artifact_review_revision
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
left join public.delivery_policies p on p.pipeline_id=s.pipeline_id and p.workspace_id=s.workspace_id
  and not s.execute_pinned_definition
left join public.session_pr_sync sync on sync.session_id=s.id
left join public.session_pr_epochs e on e.id=sync.current_epoch_id
left join public.session_git_heads h on h.session_id=s.id
left join public.session_git_checkpoints c on c.run_id=o.checkpoint_run_id
left join public.github_repositories repo on repo.id=o.repository_id
left join public.github_installations installation on installation.id=repo.github_installation_id
left join public.session_pr_refresh_queue q on q.session_id=s.id
left join public.github_pr_refresh_watermarks watermark on watermark.repository_id=repo.id and watermark.workspace_id=s.workspace_id
left join public.session_pr_verification_observations github on github.id=q.last_observation_id;

create or replace function internal.assert_delivery_readiness_gate(p_session_id uuid, p_workspace_id uuid)
returns void language plpgsql stable security invoker set search_path='' as $$
declare reviewed public.sessions%rowtype;
  selected_policy_revision_id uuid;
  requirements jsonb;
  decision record;
begin
  select s.* into reviewed from public.sessions s
    where s.id=p_session_id and s.workspace_id=p_workspace_id;
  if reviewed.id is null then
    raise exception 'Delivery gate session is unavailable.' using errcode='42501';
  end if;
  if reviewed.execute_pinned_definition then
    selected_policy_revision_id := reviewed.pinned_delivery_policy_revision_id;
  else
    select p.current_revision_id into selected_policy_revision_id from public.delivery_policies p
      where p.pipeline_id=reviewed.pipeline_id and p.workspace_id=p_workspace_id;
  end if;
  -- An explicitly unconfigured definition has no delivery readiness gate.
  if selected_policy_revision_id is null then return; end if;
  select r.requirements into requirements from public.delivery_policy_revisions r
    where r.id=selected_policy_revision_id and r.workspace_id=p_workspace_id and r.pipeline_id=reviewed.pipeline_id;
  if not found then
    raise exception 'Delivery policy revision is unavailable.' using errcode='55000';
  end if;
  -- Analysis delivery is explicitly not applicable: no synthetic PR or merge.
  if requirements is null or requirements->>'deliveryMode' is distinct from 'code' then return; end if;
  -- Delivery without required artifact approval does not gate on readiness.
  if (requirements->>'requireArtifactApprovalForDelivery')::boolean is distinct from true then return; end if;

  -- Inspect the newest current decision before checking whether it is Ready.
  -- A failed verification of a previously available report must supersede
  -- the prior Ready decision for the same GitHub observation.
  -- The decision must remain current for the exact repository,
  -- canonical PR epoch/number, head/base SHA, accepted checkpoint, policy
  -- revision and artifact-review revision it was bound to, within configured
  -- freshness. It must also consume the queue's latest completed GitHub
  -- observation: the evaluator records the observation id it actually read,
  -- so a decision evaluated from a superseded collection — a refresh that
  -- landed between the evaluator's read and its recording, with unchanged
  -- head/base SHAs — cannot pass here even though the currentness view's
  -- created_at ordering is satisfied.
  select c.id, c.state, o.payload as readiness_payload,
      q.last_observation_id as consumed_observation_id
    into decision
    from public.session_pr_verification_currentness c
    join public.session_pr_verification_observations o on o.id=c.observation_id
    join public.session_pr_refresh_queue q on q.session_id=c.session_id
    where c.session_id=p_session_id and c.workspace_id=p_workspace_id
      and c.is_current and o.source='readiness'
      and o.policy_revision_id=selected_policy_revision_id
    order by c.created_at desc, c.id desc limit 1;
  if decision.id is null then
    if exists (
      select 1 from public.session_pr_verification_results r
      join public.session_pr_verification_observations o on o.id=r.observation_id
      where r.session_id=p_session_id and r.workspace_id=p_workspace_id
        and r.state='ready' and o.source='readiness') then
      raise exception 'PR readiness decision is stale. Refresh PR verification and approve again.'
        using errcode='PT428';
    end if;
    raise exception 'PR readiness is not Ready. Resolve the reported delivery blockers before approving.'
      using errcode='PT428';
  end if;
  -- Bind the accepted decision to the exact observation it consumed. A null
  -- or absent sourceObservationId fails closed here.
  if (decision.readiness_payload->>'sourceObservationId')::uuid
      is distinct from decision.consumed_observation_id then
    raise exception 'PR readiness decision is stale. Refresh PR verification and approve again.'
      using errcode='PT428';
  end if;
  if decision.state is distinct from 'ready' then
    raise exception 'PR readiness is not Ready. Resolve the reported delivery blockers before approving.'
      using errcode='PT428';
  end if;
end;
$$;
