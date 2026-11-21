-- Session and run rows provide worker ownership for benchmark trials. The
-- production surfaces independently limit access and effects by purpose.
alter policy sessions_select_membership on public.sessions
  using (execution_purpose = 'production' and internal.can_access_factory(workspace_id, factory_id));
alter policy sessions_update_title_membership on public.sessions
  using (execution_purpose = 'production' and internal.can_access_factory(workspace_id, factory_id))
  with check (execution_purpose = 'production' and internal.can_access_factory(workspace_id, factory_id));

create or replace function internal.can_access_session(target_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions session
    where session.id = target_session_id and session.execution_purpose = 'production'
      and internal.can_access_factory(session.workspace_id, session.factory_id)
  )
$$;

-- These reads use ordinary workspace tables. Apply the same RLS to result
-- rows, counts, facets, search and lane discovery, before pagination.
alter function public.get_session_list_page(text, text, text, text, integer, timestamptz, uuid, text, integer, uuid)
  security invoker;
alter function public.get_pipeline_dashboard_page(uuid, uuid, uuid, integer, uuid[], uuid)
  security invoker;

-- The private API/MCP projection and webhook event writer share this view.
create or replace view internal.factory_session_read_owners with (security_invoker = true) as
  select session as admitted_session, session.id, session.workspace_id, session.factory_id, session.github_repository_id, session.number
  from public.sessions session
  where session.execution_purpose = 'production' and session.github_repository_id is not null and (
    session.execute_pinned_definition or exists (
      select 1 from public.session_git_roots root
      where (root.session_id, root.workspace_id, root.repository_id) =
        (session.id, session.workspace_id, session.github_repository_id)
    )
  );

create or replace function public.get_session_detail_page(target_workspace_slug text, target_session_number integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare detail jsonb; specification_stage uuid;
begin
  detail := internal.get_session_detail_page(target_workspace_slug, target_session_number);
  if detail#>>'{session,id}' is null then return detail; end if;
  select session.specification_stage_id into specification_stage from public.sessions session
  where session.id = (detail#>>'{session,id}')::uuid and session.execution_purpose = 'production';
  if not found then return null; end if;
  return jsonb_set(detail, '{session,specificationStageId}', coalesce(to_jsonb(specification_stage), 'null'::jsonb));
end;
$$;

create or replace function internal.get_session_git_continuity_state(p_session_id uuid)
returns table(enabled boolean, revision bigint, state text)
language plpgsql security definer set search_path = '' as $$
declare session public.sessions; control internal.git_continuity_release_control;
begin
  select * into session from public.sessions
  where id = p_session_id and execution_purpose = 'production';
  if not found then return; end if;
  if current_setting('role', true) is distinct from 'service_role'
    and not (current_setting('role', true) in ('none','postgres','supabase_admin') and session_user in ('postgres','supabase_admin'))
    and not exists (
      select 1 from public.workspace_members member
      where member.workspace_id = session.workspace_id and member.user_id = auth.uid() and member.is_active
    ) then return; end if;
  select * into strict control from internal.git_continuity_release_control where singleton;
  return query select case when session.pipeline_id is null then true else control.enabled end, control.revision,
    case when session.pipeline_id is null then 'enabled'
      when not exists (
        select 1 from public.session_git_continuity_enrollments enrollment
        where (enrollment.session_id, enrollment.workspace_id) = (session.id, session.workspace_id)
      ) then 'fresh_start_required' when not control.enabled then 'release_paused' else 'enabled' end;
end;
$$;

-- A production outbox/lineage row cannot be created for a replay, even when
-- a caller bypasses the ordinary session API. Trial checkpoint data use the
-- private result store. Cleanup and retention can still access the trial run.
create function internal.require_production_delivery_session()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from public.sessions session
    where session.id = new.session_id and session.execution_purpose = 'benchmark'
  ) then
    raise exception 'A production delivery requires a production session.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.require_production_delivery_session() from public, anon, authenticated, service_role;

create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_git_roots
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_job_git_inputs
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_source_deliveries
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_checkpoint_publications
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_git_checkpoints
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_git_heads
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_pr_sync
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_pr_epochs
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_pr_operations
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_pr_refresh_queue
  for each row execute function internal.require_production_delivery_session();
create trigger require_production_delivery_session before insert or update of session_id, workspace_id on public.session_pull_requests
  for each row execute function internal.require_production_delivery_session();

-- Attachment metadata requires the same production boundary as session details.
create or replace function public.get_session_prompt_attachments(
  target_workspace_slug text,
  target_session_number integer
)
returns table (
  id uuid,
  original_filename text,
  content_type text,
  size_bytes bigint,
  attachment_position smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    attachment.id,
    attachment.original_filename,
    attachment.content_type,
    attachment.size_bytes,
    attachment.position
  from public.workspaces workspace
  join public.sessions session
    on session.workspace_id = workspace.id
   and session.number = target_session_number
  join public.session_attachments attachment
    on attachment.session_id = session.id
   and attachment.workspace_id = workspace.id
   and attachment.status = 'attached'
  where workspace.slug = target_workspace_slug
    and workspace.id in (select internal.current_user_workspace_ids())
    and session.execution_purpose = 'production'
    and internal.can_access_factory(session.workspace_id, session.factory_id)
  order by attachment.position
$$;

-- General session commands own production sessions. The private trial commands own trial transitions.
create or replace function internal.session_mutation_human_actor(
  p_workspace_id uuid, p_factory_id uuid, p_member_id uuid, p_session_id uuid
) returns internal.session_mutation_actor language plpgsql set search_path = '' as $$
declare target public.sessions; admitted public.session_factory_admission_inputs;
begin
  perform internal.assert_session_mutation_human_access(p_workspace_id, p_factory_id, p_member_id);
  select * into target from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_session_id, p_workspace_id, p_factory_id)
    and session.execution_purpose = 'production';
  if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;
  select * into admitted from public.session_factory_admission_inputs receipt
  where (receipt.session_id, receipt.workspace_id, receipt.factory_id, receipt.github_repository_id) =
    (target.id, target.workspace_id, target.factory_id, target.github_repository_id);
  return row(p_workspace_id, p_factory_id, p_member_id, null, null,
    admitted.execution_grant_id, admitted.execution_grant_version, target.github_repository_id, null
  )::internal.session_mutation_actor;
end;
$$;

create or replace function internal.lock_machine_session_mutation_target(
  p_actor internal.session_mutation_actor, p_session_id uuid
) returns public.sessions language plpgsql set search_path = '' as $$
declare target public.sessions;
begin
  select session.* into target from public.sessions session
  join public.session_factory_admission_inputs admitted on
    (admitted.session_id, admitted.workspace_id, admitted.factory_id, admitted.github_repository_id) =
    (session.id, session.workspace_id, session.factory_id, session.github_repository_id)
  where (session.id, session.workspace_id, session.factory_id, session.github_repository_id,
    admitted.execution_grant_id, admitted.execution_grant_version, admitted.credential_owner_service_principal_id) =
    (p_session_id, p_actor.workspace_id, p_actor.factory_id, p_actor.writer_repository_id,
      p_actor.grant_id, p_actor.grant_version, p_actor.service_principal_id)
    and session.execution_purpose = 'production' and session.execute_pinned_definition
  for no key update of session;
  if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;
  return target;
end;
$$;

create or replace function public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid,
  expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text,
  p_agent_model_name text, p_run_type text default 'project', p_expected_review_revision bigint default null)
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,phase_status public.pipeline_phase_status,
  workspace_id uuid,linear_issue_url text,archived_at timestamptz,current_artifact_version integer,rejection_count integer,
  job_id uuid,run_id uuid,job_created boolean)
language plpgsql security definer set search_path = '' as $$
declare target_factory_id uuid; reviewed public.sessions;
begin
  -- Session factory scope is immutable. Discover its identity without
  -- locking the review so we can take workspace, factory, and human fences
  -- in the same order as the existing mutation commands.
  select session.factory_id into target_factory_id from public.sessions session
  where (session.id, session.workspace_id) = (target_session_id, expected_workspace_id)
    and session.execution_purpose = 'production';
  if not found then return; end if;
  if not exists (
    select 1 from public.workspace_members member
    where (member.workspace_id, member.id) = (expected_workspace_id, approver_member_id)
      and member.kind = 'human' and member.is_active
  ) then return; end if;
  perform internal.assert_session_mutation_human_access(expected_workspace_id, target_factory_id, approver_member_id);

  select session.* into reviewed from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (target_session_id, expected_workspace_id, target_factory_id)
  for no key update;
  if not found then return; end if;

  if reviewed.archived_at is null and reviewed.phase_status = 'awaiting_review'
    and (reviewed.specification_stage_id, reviewed.current_stage_id, reviewed.current_artifact_id,
      reviewed.current_artifact_version, reviewed.artifact_review_revision) =
      (expected_stage_id, expected_stage_id, expected_artifact_id, expected_version, p_expected_review_revision)
    and exists (
      select 1 from public.session_specification_clarifications clarification
      where (clarification.workspace_id, clarification.factory_id, clarification.session_id,
        clarification.stage_id, clarification.artifact_id, clarification.artifact_version) =
        (expected_workspace_id, target_factory_id, target_session_id, expected_stage_id, expected_artifact_id, expected_version)
        and clarification.status = 'pending'
    ) then
    raise exception 'Answer the open specification clarification before approving.' using errcode = 'PT423';
  end if;

  return query select * from internal.approve_session_stage(target_session_id, expected_workspace_id,
    expected_stage_id, expected_artifact_id, expected_version, approver_member_id, p_agent_model_provider,
    p_agent_model_name, p_run_type, p_expected_review_revision);
end;
$$;

-- Keep both direct repository lookup and production publication claims behind the purpose fence.
create or replace function internal.session_writable_repository_id(p_session public.sessions)
returns uuid language sql stable set search_path = '' as $$
  select case
    when p_session.execution_purpose <> 'production' then null
    when p_session.execute_pinned_definition then (
    select case when admission.session_id is null then p_session.github_repository_id
      else admission.github_repository_id end
    from (values (p_session.id)) as session(id)
    left join public.session_factory_admission_inputs admission on
      (admission.session_id, admission.workspace_id, admission.factory_id, admission.definition_revision_id) =
      (session.id, p_session.workspace_id, p_session.factory_id, p_session.factory_definition_revision_id)
  ) else p_session.github_repository_id end
$$;

create or replace function internal.session_pr_is_eligible(p_session_id uuid,p_workspace_id uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.sessions s join public.workspaces w on w.id=s.workspace_id
    where s.id=p_session_id and s.workspace_id=p_workspace_id and w.deletion_requested_at is null
      and s.execution_purpose = 'production'
      and (s.archived_at is null or s.phase_status='approved'));
$$;

create or replace function internal.source_delivery_is_eligible(delivery public.session_source_deliveries)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(select 1 from public.agent_runs r
    join public.agent_jobs j on j.id=delivery.job_id
    join public.sessions s on s.id=delivery.session_id
    join public.workspaces w on w.id=delivery.workspace_id
    where r.id=delivery.run_id and r.status='success' and r.agent_job_id=j.id
      and r.attempt_count=delivery.attempt_count and j.attempt_count=delivery.attempt_count
      and r.workspace_id=w.id and j.workspace_id=w.id and s.workspace_id=w.id
      and r.session_id=s.id and j.session_id=s.id and j.status in ('started','running','success')
      and s.execution_purpose = 'production'
      and (s.archived_at is null or (s.phase_status='approved' and j.status='success'))
      and w.deletion_requested_at is null and delivery.repository_id is not null
      and not exists(select 1 from public.session_pr_sync managed where managed.session_id=s.id and managed.workspace_id=w.id));
$$;

-- Life-cycle facts also feed the production scorer queues. Retain operational trial data only in its trial scope.
create or replace function internal.record_factory_outcome_observation(
  p_workspace_id uuid, p_factory_id uuid, p_event_type text, p_source_kind text,
  p_source_key text, p_occurred_at timestamptz,
  p_session_id uuid default null, p_job_id uuid default null, p_run_id uuid default null,
  p_attempt_count integer default null, p_stage_id uuid default null, p_artifact_id uuid default null,
  p_actor_member_id uuid default null, p_actor_service_principal_id uuid default null,
  p_definition_revision_id uuid default null, p_repository_id uuid default null,
  p_status text default null, p_trigger_type text default null, p_capture_mode text default 'live'
) returns void language sql set search_path = '' as $$
  insert into internal.factory_outcome_observations (
    workspace_id, factory_id, event_type, source_kind, source_key, occurred_at,
    session_id, job_id, run_id, attempt_count, stage_id, artifact_id,
    actor_member_id, actor_service_principal_id, definition_revision_id, repository_id,
    status, trigger_type, capture_mode
  )
  select p_workspace_id, p_factory_id, p_event_type, p_source_kind, p_source_key, p_occurred_at,
    p_session_id, p_job_id, p_run_id, p_attempt_count, p_stage_id, p_artifact_id,
    p_actor_member_id, p_actor_service_principal_id, p_definition_revision_id, p_repository_id,
    p_status, p_trigger_type, p_capture_mode
  where p_session_id is null or exists (
    select 1 from public.sessions session
    where (session.workspace_id, session.factory_id, session.id) = (p_workspace_id, p_factory_id, p_session_id)
      and session.execution_purpose = 'production'
  )
  on conflict (workspace_id, factory_id, event_type, source_kind, source_key) do nothing;
$$;

create or replace function internal.record_factory_scorer_sample(
  p_policy public.factory_scorer_sampling_policies, p_run_id uuid
) returns public.factory_scorer_sample_receipts language plpgsql set search_path = '' as $$
declare
  target record;
  checkpoint public.session_git_checkpoints;
  required_kinds text[];
  missing_kinds text[] := '{}';
  retained_evidence jsonb := '[]';
  includes_withheld boolean;
  decision text := 'excluded';
  decision_reason text;
  receipt public.factory_scorer_sample_receipts;
begin
  select * into receipt from public.factory_scorer_sample_receipts prior
  where (prior.policy_id, prior.run_id) = (p_policy.id, p_run_id);
  if found then return receipt; end if;

  select run.id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id, run.status, run.finished_at,
    owner.factory_definition_revision_id as definition_revision_id,
    array(select jsonb_array_elements_text(scorer.definition->'requiredEvidence')) as required_kinds
  into target
  from public.agent_runs run
  join public.sessions owner on (owner.workspace_id, owner.id) = (run.workspace_id, run.session_id)
  join public.workspaces workspace on workspace.id = owner.workspace_id and workspace.deletion_requested_at is null
  join public.factory_definition_revisions definition
    on (definition.workspace_id, definition.factory_id, definition.id) =
      (owner.workspace_id, owner.factory_id, owner.factory_definition_revision_id)
  join public.factory_scorer_revisions scorer
    on (scorer.workspace_id, scorer.factory_id, scorer.id) =
      (p_policy.workspace_id, p_policy.factory_id, p_policy.scorer_revision_id)
  where run.id = p_run_id
    and owner.execution_purpose = 'production'
    and (owner.workspace_id, owner.factory_id) = (p_policy.workspace_id, p_policy.factory_id)
    and run.finished_at is not null and run.status in ('success', 'error', 'canceled')
    and definition.schema_version = 2
    and (definition.definition_json::jsonb->'scorerRevisionIds') ? scorer.id::text;
  if not found then raise exception 'Terminal run is unavailable for this scorer policy.' using errcode = 'P0002'; end if;

  required_kinds := target.required_kinds;
  select * into checkpoint from public.session_git_checkpoints exact
  where (exact.run_id, exact.workspace_id, exact.session_id, exact.job_id, exact.attempt_count) =
    (target.id, p_policy.workspace_id, target.session_id, target.agent_job_id, target.attempt_count);

  if not (target.status::text = any(p_policy.terminal_statuses)) then
    decision_reason := 'status_excluded';
  elsif cardinality(p_policy.stage_ids) > 0 and (target.stage_id = any(p_policy.stage_ids)) is not true then
    decision_reason := 'stage_excluded';
  elsif exists (
    select 1 from public.session_retained_content_erasures erasure
    where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
      (p_policy.workspace_id, p_policy.factory_id, target.session_id)
  ) then
    decision_reason := 'withheld_evidence';
    missing_kinds := required_kinds;
  elsif checkpoint.run_id is null then
    decision_reason := 'unsupported_run';
  else
    select selected.evidence, selected.missing_kinds, selected.includes_withheld
      into retained_evidence, missing_kinds, includes_withheld
      from internal.select_factory_scorer_checkpoint_evidence(checkpoint, p_policy.factory_id, required_kinds, false) selected;

    if cardinality(missing_kinds) > 0 then
      decision_reason := case when includes_withheld then 'withheld_evidence' else 'missing_evidence' end;
    elsif internal.factory_scorer_sample_draw(p_policy.seed, target.id) * 10000
      < p_policy.rate_bps::bigint * 4294967296 then
      decision := 'sampled';
    else
      decision := 'not_sampled';
    end if;
  end if;

  insert into public.factory_scorer_sample_receipts (
    workspace_id, factory_id, policy_id, scorer_revision_id, definition_revision_id, session_id,
    run_id, attempt_count, run_finished_at, target_commit_sha, outcome, reason, missing_evidence, evidence
  ) values (
    p_policy.workspace_id, p_policy.factory_id, p_policy.id, p_policy.scorer_revision_id, target.definition_revision_id,
    target.session_id, target.id, target.attempt_count, target.finished_at, checkpoint.output_sha,
    decision, decision_reason, missing_kinds, retained_evidence
  ) on conflict (policy_id, run_id) do nothing returning * into receipt;
  if found then return receipt; end if;

  -- A concurrent insert can win after this call's first snapshot. A new
  -- statement sees the committed winner and returns its exact receipt.
  select * into strict receipt from public.factory_scorer_sample_receipts prior
    where (prior.policy_id, prior.run_id) = (p_policy.id, p_run_id);
  return receipt;
end;
$$;

-- The rebuild sweep and operating cost projection also read session and run rows directly.
create or replace function public.enqueue_factory_flow_rebuild(
  p_workspace_id uuid, p_factory_id uuid, p_after_session_id uuid default null, p_limit integer default 100
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare enqueued integer; next_session_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 250 then
    raise exception 'Invalid factory flow rebuild batch size.' using errcode = '22023';
  end if;
  if not internal.can_manage_factory(p_workspace_id, p_factory_id) or not exists (
    select 1 from public.factories factory
    join public.workspaces workspace on workspace.id = factory.workspace_id
    where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id) and workspace.deletion_requested_at is null
  ) then raise exception 'Factory flow projection is unavailable.' using errcode = 'PT404'; end if;
  with batch as materialized (
    select session.id from public.sessions session
    where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
      and session.execution_purpose = 'production'
      and (p_after_session_id is null or session.id > p_after_session_id)
    order by session.id limit p_limit
  ), queued as (
    insert into internal.factory_flow_projection_dirty_sessions as dirty(session_id, workspace_id, factory_id, queued_at)
    select id, p_workspace_id, p_factory_id, clock_timestamp() from batch
    on conflict (session_id) do update set queued_at = least(dirty.queued_at, excluded.queued_at)
    returning session_id
  )
  select count(*)::integer, (array_agg(session_id order by session_id desc))[1]
    into enqueued, next_session_id from queued;
  return jsonb_build_object('enqueued', enqueued, 'nextSessionId',
    case when enqueued = p_limit then next_session_id end);
end;
$$;

create or replace function internal.factory_cost_contributions(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_basis text
) returns table (
  run_id uuid, session_id uuid, attempt_count integer, run_status text,
  started_at timestamptz, finished_at timestamptz,
  merge_id uuid, merge_observation_id uuid, candidate_merge_id uuid, attribution text,
  cost_state text, cost_usd numeric,
  usage_recorded_at timestamptz, usage_finalized_at timestamptz, usage_estimation_revision text
) language sql stable set search_path = '' as $$
  with verified_merges as materialized (
    select fact.id, fact.observation_id, fact.session_id, fact.epoch_id, fact.merged_at,
      epoch.epoch_number, epoch.created_at as epoch_created_at
    from internal.current_factory_canonical_pull_request_merges fact
    join public.session_pr_epochs epoch on epoch.id = fact.epoch_id
    where (fact.workspace_id, fact.factory_id) = (p_workspace_id, p_factory_id) and fact.status = 'observed'
  ), period_merges as materialized (
    select id, session_id from verified_merges where merged_at >= p_from and merged_at < p_to
  ), attempts as materialized (
    select run.id, run.session_id, run.attempt_count, run.status, run.started_at, run.finished_at,
      run.cost_provenance, run.total_cost_usd, run.usage_recorded_at, run.usage_finalized_at, run.usage_estimation_revision
    from public.agent_runs run join public.sessions session
      on (session.workspace_id, session.id) = (run.workspace_id, run.session_id)
    where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
      and session.execution_purpose = 'production'
      and run.started_at is not null and (
        (p_basis = 'operating' and run.started_at >= p_from and run.started_at < p_to)
        or (p_basis = 'delivery' and exists (
          select 1 from period_merges merge where merge.session_id = run.session_id
        ))
      )
  ), assignment as (
    select attempt.*, exact.id as exact_merge_id, exact.observation_id as exact_observation_id,
      candidate.id as window_merge_id, candidate.observation_id as window_observation_id,
      candidate.id is not null and attempt.status in ('success', 'error', 'canceled')
        and attempt.finished_at between attempt.started_at and candidate.merged_at
        and not exists (
          select 1 from public.session_pr_epochs successor
          where (successor.workspace_id, successor.session_id) = (p_workspace_id, attempt.session_id)
            and successor.epoch_number > candidate.epoch_number and successor.created_at <= attempt.finished_at
        )
        and not exists (
          select 1 from public.session_pr_epochs previous
          left join verified_merges evidence on evidence.epoch_id = previous.id
          where (previous.workspace_id, previous.session_id) = (p_workspace_id, attempt.session_id)
            and previous.epoch_number < candidate.epoch_number and previous.pr_state = 'merged'
            and (
              (evidence.id is not null and evidence.merged_at >= attempt.started_at)
              or (evidence.id is null and candidate.epoch_created_at > attempt.started_at
                and (previous.pr_updated_at is null or previous.pr_updated_at >= attempt.started_at))
            )
        ) as window_proven
    from attempts attempt
    left join lateral (
      -- If a checkpoint really reached multiple successive PRs, its charge
      -- belongs to the first verified exact publication, once.
      select merge.id, merge.observation_id
      from internal.factory_canonical_pull_request_merge_runs source
      join verified_merges merge on merge.observation_id = source.observation_id
      where (source.run_id, source.attempt_count, merge.session_id) =
        (attempt.id, attempt.attempt_count, attempt.session_id)
      order by merge.epoch_number
      limit 1
    ) exact on true
    left join lateral (
      -- A failed or detached attempt may still belong to the next delivery.
      -- Choose its candidate before filtering the requested period.
      select merge.* from verified_merges merge
      where exact.id is null and merge.session_id = attempt.session_id and merge.merged_at >= attempt.started_at
        and not exists (
          select 1 from public.session_pr_epochs successor
          where (successor.workspace_id, successor.session_id) = (p_workspace_id, attempt.session_id)
            and successor.epoch_number > merge.epoch_number and successor.created_at <= attempt.started_at
        )
      order by merge.epoch_number
      limit 1
    ) candidate on true
  ), membership as (
    select assignment.*,
      coalesce(exact_merge_id, case when window_proven then window_merge_id end) as assigned_merge_id,
      coalesce(exact_observation_id, case when window_proven then window_observation_id end) as assigned_observation_id,
      case when exact_merge_id is not null then 'exact_publication_receipt'
        when window_proven then 'settled_session_window'
        when window_merge_id is not null then 'unresolved'
        else 'unlinked' end as assigned_by,
      case when status not in ('success', 'error', 'canceled') then 'pending'
        when usage_finalized_at is not null and total_cost_usd is not null and total_cost_usd >= 0
          and total_cost_usd not in ('NaN'::numeric, 'Infinity'::numeric)
          and cost_provenance in ('measured', 'estimated') then cost_provenance
        else 'unavailable' end as usage_state
    from assignment
  )
  select id, membership.session_id, membership.attempt_count, status::text, membership.started_at, membership.finished_at,
    assigned_merge_id, assigned_observation_id,
    case when assigned_by = 'unresolved' then window_merge_id end, assigned_by, usage_state,
    case when usage_state in ('measured', 'estimated') then total_cost_usd end,
    membership.usage_recorded_at, membership.usage_finalized_at, membership.usage_estimation_revision
  from membership
  where p_basis = 'operating' or exists (
    select 1 from period_merges merge where merge.id = coalesce(assigned_merge_id, window_merge_id)
  )
$$;

-- A workspace export snapshots only production runs and artifacts before traversing retained evidence.
create or replace function internal.snapshot_run_export(p_job public.run_exports)
returns table(item_count bigint, source_expires_at timestamptz, snapshot_visibility pg_snapshot)
language plpgsql security invoker set search_path = '' as $$
begin
  with runs as materialized (
    select r.id, r.session_id, s.number as session_number, left(s.title, 200) as session_title,
      r.agent_job_id, r.attempt_count, r.stage_id, left(r.stage_slug, 128) as stage_slug,
      left(r.stage_name, 128) as stage_name, left(r.model_provider, 64) as model_provider,
      left(r.model_name, 128) as model_name, r.status, r.created_at, r.started_at,
      r.finished_at, r.last_activity_at, r.input_tokens, r.output_tokens, r.total_cost_usd,
      r.token_provenance, r.cost_provenance, r.usage_finalized_at,
      coalesce(expiry.expired_at, transcript_deadline.expired_at) as expired_at,
      s.archived_at as session_archived_at, policy.evidence_days,
      case when r.status in ('success', 'error', 'canceled') then coalesce(r.finished_at, r.updated_at)
        else p_job.snapshot_at end as terminal_at,
      case when r.status in ('success', 'error', 'canceled') then coalesce(r.finished_at, r.updated_at)
        else p_job.snapshot_at end + internal.run_retention_duration(policy.transcript_days) as transcript_cutoff
    from public.agent_runs r
    join public.sessions s on (s.id, s.workspace_id) = (r.session_id, r.workspace_id)
    left join public.agent_run_transcript_expirations expiry
      on (expiry.run_id, expiry.workspace_id) = (r.id, r.workspace_id)
    left join public.workspace_run_retention policy on policy.workspace_id = r.workspace_id
    left join lateral (
      select coalesce(r.finished_at, r.updated_at) + internal.run_retention_duration(policy.transcript_days) as expired_at
      where expiry.run_id is null and policy.transcript_days is not null
        and r.status in ('success', 'error', 'canceled')
        and coalesce(r.finished_at, r.updated_at) <= p_job.snapshot_at - internal.run_retention_duration(policy.transcript_days)
        and exists (
          select 1 from public.agent_run_events o
          where (o.agent_run_id, o.workspace_id, o.attempt_count) = (r.id, r.workspace_id, r.attempt_count)
        )
    ) transcript_deadline on true
    where r.workspace_id = p_job.workspace_id
      and s.execution_purpose = 'production'
      and not exists (select 1 from public.session_retained_content_erasures erasure
        where (erasure.workspace_id, erasure.session_id) = (r.workspace_id, r.session_id))
  ),
  events as materialized (
    select e.agent_run_id, e.attempt_count, e.sequence, e.causation_sequence, e.kind,
      e.schema_version, e.truncated, e.created_at,
      case when e.kind = 'capture_end' then e.payload->>'status' end as capture_status,
      lag(e.sequence, 1, 0) over (partition by e.agent_run_id order by e.sequence) as previous_sequence
    from runs r join public.agent_run_events e
      on (e.agent_run_id, e.attempt_count) = (r.id, r.attempt_count)
    where e.workspace_id = p_job.workspace_id and r.expired_at is null
  ),
  capture_ends as (
    select distinct on (agent_run_id) agent_run_id, capture_status
    from events where kind = 'capture_end' order by agent_run_id, sequence desc
  ),
  diagnostics as materialized (
    select m.id, m.agent_run_id, r.attempt_count, m.kind, m.created_at,
      case when octet_length(m.message_md) > 1048576 then 'inaccessible' else 'available' end as state
    from runs r join public.agent_run_messages m on m.agent_run_id = r.id
    where m.workspace_id = p_job.workspace_id
      and m.kind in ('run_failure', 'worker_error', 'worker_progress', 'worker_completion')
  ),
  checkpoints as materialized (
    select c.run_id, c.session_id, c.artifact_id, c.attempt_count, c.repository_id,
      c.initial_base_sha, c.input_sha, c.output_sha, c.output_kind, c.bundle_sha256, c.created_at
    from runs r join public.session_git_checkpoints c
      on (c.run_id, c.session_id, c.job_id, c.attempt_count) =
         (r.id, r.session_id, r.agent_job_id, r.attempt_count)
    where c.workspace_id = p_job.workspace_id
  ),
  receipts as materialized (
    select e.run_id, e.session_id, e.job_id, e.attempt_count, e.repository_id, e.commit_sha,
      e.validation_tree_sha, e.created_at, r.session_archived_at, r.evidence_days, r.terminal_at, r.status
    from runs r join public.session_validation_evidence e
      on (e.run_id, e.session_id, e.job_id, e.attempt_count) =
         (r.id, r.session_id, r.agent_job_id, r.attempt_count)
    where e.workspace_id = p_job.workspace_id
  ),
  stage_artifacts as (
    select a.id, a.session_id, c.run_id, c.attempt_count, a.stage_id, a.stage_slug, a.version,
      a.created_at, markdown.body
    from public.session_artifacts a
    join public.sessions s on (s.id, s.workspace_id) = (a.session_id, a.workspace_id)
    left join checkpoints c on (c.artifact_id, c.session_id) = (a.id, a.session_id)
    cross join lateral (
      select case when jsonb_typeof(a.artifact_json) = 'string' then a.artifact_json #>> '{}' end as body
    ) markdown
    where a.workspace_id = p_job.workspace_id
      and s.execution_purpose = 'production'
      and not exists (select 1 from public.session_retained_content_erasures erasure
        where (erasure.workspace_id, erasure.session_id) = (a.workspace_id, a.session_id))
  ),
  validation_assets as materialized (
    select a.id, a.run_id, a.session_id, a.kind, a.evidence_key, a.required, a.sha256,
      a.size_bytes, a.content_type, e.attempt_count, e.commit_sha, e.validation_tree_sha,
      a.required and e.session_archived_at is null as requires_archive,
      greatest(e.created_at, e.terminal_at) + internal.run_retention_duration(e.evidence_days) as age_deadline,
      coalesce(w.state, case when e.evidence_days is not null and (not a.required or e.session_archived_at is not null)
        and e.status in ('success', 'error', 'canceled')
        and greatest(e.created_at, e.terminal_at) <= p_job.snapshot_at - internal.run_retention_duration(e.evidence_days)
        then 'expired' else 'recorded' end) as state
    from receipts e join public.session_validation_assets a
      on (a.run_id, a.session_id) = (e.run_id, e.session_id)
    left join public.session_validation_asset_withholdings w on w.asset_id = a.id
    where a.workspace_id = p_job.workspace_id
  ),
  entries as (
    select 1 as rank, 'run' as kind, r.id as source_id, r.id as run_id, r.attempt_count,
      null::integer as event_sequence, 'available' as state,
      to_jsonb(r) - '{id,expired_at,session_archived_at,evidence_days,terminal_at,transcript_cutoff}'::text[] as metadata
    from runs r

    union all
    select 2, 'event', md5('agent_run_event:' || e.agent_run_id::text || ':' ||
      e.attempt_count::text || ':' || e.sequence::text)::uuid,
      e.agent_run_id, e.attempt_count, e.sequence,
      case when e.kind = 'capture_gap' then 'gap' else 'available' end,
      to_jsonb(e) - 'agent_run_id' - 'previous_sequence' - 'capture_status'
    from events e

    union all
    select 3, 'run_diagnostic', d.id, d.agent_run_id, d.attempt_count, null, d.state,
      jsonb_strip_nulls(jsonb_build_object('kind', d.kind, 'created_at', d.created_at,
        'reason', case when d.state = 'inaccessible' then 'diagnostic_exceeds_limit' end))
    from diagnostics d

    union all
    select 4, 'capture_gap', r.id, r.id, r.attempt_count, null,
      case when r.expired_at is not null then 'expired' else 'gap' end,
      jsonb_strip_nulls(jsonb_build_object('expired_at', r.expired_at, 'reason', case
        when r.expired_at is not null then 'retention_expired'
        when ce.capture_status = 'interrupted' then 'capture_interrupted'
        when exists(select 1 from events e where e.agent_run_id = r.id) then 'capture_end_missing'
        else 'no_retained_transcript' end))
    from runs r left join capture_ends ce on ce.agent_run_id = r.id
    where r.expired_at is not null or ce.capture_status is distinct from 'complete'

    union all
    select 4, 'capture_gap',
      md5('agent_run_export_gap:' || e.agent_run_id::text || ':' || e.attempt_count::text ||
        ':' || e.sequence::text)::uuid,
      e.agent_run_id, e.attempt_count, e.sequence, 'gap',
      jsonb_build_object('reason', 'missing_event_sequences', 'first_sequence', e.previous_sequence + 1,
        'last_sequence', e.sequence - 1)
    from events e where e.sequence > e.previous_sequence + 1

    union all
    select 5, 'stage_markdown', a.id, a.run_id, a.attempt_count, null,
      case when octet_length(a.body) <= 1048576 then 'available' else 'inaccessible' end,
      jsonb_strip_nulls(jsonb_build_object('session_id', a.session_id, 'stage_id', a.stage_id,
        'stage_slug', left(a.stage_slug, 128), 'version', a.version, 'created_at', a.created_at,
        'content_type', 'text/markdown', 'size_bytes', octet_length(a.body),
        'sha256', case when octet_length(a.body) <= 1048576
          then encode(sha256(convert_to(a.body, 'UTF8')), 'hex') end,
        'provenance', case when a.run_id is null then 'legacy_unlinked' else 'accepted_checkpoint' end,
        'reason', case when a.body is null then 'unsupported_markdown_encoding'
          when octet_length(a.body) > 1048576 then 'markdown_exceeds_limit' end))
    from stage_artifacts a

    union all
    select 6, 'checkpoint', c.run_id, c.run_id, c.attempt_count, null, 'metadata_only',
      to_jsonb(c) - 'run_id' || jsonb_build_object('reason', 'private_source_checkpoint')
    from checkpoints c

    union all
    select 7, 'validation_receipt', e.run_id, e.run_id, e.attempt_count, null, 'available',
      to_jsonb(e) - '{run_id,session_archived_at,evidence_days,terminal_at,status}'::text[]
    from receipts e

    union all
    select 8, 'validation_asset', a.id, a.run_id, a.attempt_count, null, a.state,
      jsonb_build_object('session_id', a.session_id, 'kind', a.kind, 'key', a.evidence_key,
        'required', a.required, 'sha256', a.sha256, 'size_bytes', a.size_bytes,
        'content_type', a.content_type, 'validation_commit_sha', a.commit_sha,
        'validation_tree_sha', a.validation_tree_sha)
    from validation_assets a
  ),
  roster as (
    insert into internal.run_export_entries(
      export_id, ordinal, record_kind, record_id, run_id, attempt_count, event_sequence, availability, metadata
    )
    select p_job.id, row_number() over (order by x.rank, x.run_id, x.event_sequence, x.source_id),
      x.kind, x.source_id, x.run_id, x.attempt_count, x.event_sequence, x.state, x.metadata
    from entries x
    returning 1
  ),
  archive_deadlines as (
    insert into internal.run_export_archive_deadlines(export_id, session_id, age_deadline)
    select p_job.id, a.session_id, min(a.age_deadline) from validation_assets a
    where a.state = 'recorded' and a.requires_archive and a.age_deadline is not null
    group by a.session_id
  )
  select (select count(*) from roster), least(
    (select min(a.age_deadline) from validation_assets a where a.state = 'recorded' and not a.requires_archive),
    (select min(r.transcript_cutoff) from runs r
      where exists(select 1 from events e where e.agent_run_id = r.id))
  ), pg_current_snapshot() into item_count, source_expires_at, snapshot_visibility;
  return next;
end;
$$;

-- Capture and restoration are anchored to production source runs.
create or replace function public.create_factory_benchmark_task(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_source_run_id uuid, p_name text, p_acceptance_criteria text, p_tags text[],
  p_replay_eligibility text default 'unverified', p_eligibility_reason text default null
) returns public.factory_benchmark_task_revisions
language plpgsql security definer set search_path = '' as $$
declare task_id uuid; result public.factory_benchmark_task_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  insert into public.factory_benchmark_tasks(
    workspace_id, factory_id, source_run_id, source_session_id, source_provenance, created_by
  )
  select p_workspace_id, p_factory_id, run.id, run.session_id, jsonb_build_object(
    'runId', run.id, 'sessionId', run.session_id, 'stageSlug', run.stage_slug, 'attempt', run.attempt_count,
    'modelProvider', run.model_provider, 'modelName', run.model_name,
    'runType', run.run_type, 'definitionRevisionId', manifest.definition_revision_id,
    'definitionDigest', manifest.definition_digest, 'inputSha', manifest.input_sha,
    'promptSha256', manifest.prompt_sha256
  ), p_actor_user_id
  from public.agent_runs run
  join public.sessions session on (session.workspace_id, session.id) = (run.workspace_id, run.session_id)
  -- A deleted stage clears run.stage_id while its attempt manifest remains retained.
  left join public.session_attempt_manifests manifest
    on (manifest.workspace_id, manifest.session_id, manifest.run_id, manifest.job_id, manifest.attempt_count)
      = (run.workspace_id, run.session_id, run.id, run.agent_job_id, run.attempt_count)
  where run.id = p_source_run_id and (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
    and session.execution_purpose = 'production'
  returning id into task_id;
  if not found then
    raise exception 'Source run is unavailable in this factory.' using errcode = 'P0002';
  end if;

  insert into public.factory_benchmark_task_revisions(
    workspace_id, factory_id, task_id, revision_number, name, acceptance_criteria, tags,
    replay_eligibility, eligibility_reason, created_by
  ) values (
    p_workspace_id, p_factory_id, task_id, 1, btrim(p_name), p_acceptance_criteria,
    internal.normalize_factory_benchmark_tags(p_tags), p_replay_eligibility, p_eligibility_reason, p_actor_user_id
  ) returning * into result;
  return result;
end;
$$;

create or replace function public.assert_factory_benchmark_replay_access(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_task_revision_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare source public.sessions;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select session.* into source
  from public.factory_benchmark_task_revisions revision
  join public.factory_benchmark_task_inputs input
    on (input.workspace_id, input.factory_id, input.task_id) =
       (revision.workspace_id, revision.factory_id, revision.task_id)
  join public.sessions session
    on (session.workspace_id, session.factory_id, session.id, session.factory_definition_revision_id) =
       (input.workspace_id, input.factory_id, input.source_session_id, input.definition_revision_id)
  join public.agent_runs run
    on (run.workspace_id, run.session_id, run.id, run.agent_job_id, run.attempt_count) =
       (input.workspace_id, input.source_session_id, input.source_run_id, input.source_job_id, input.source_attempt_count)
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (p_workspace_id, p_factory_id, p_task_revision_id)
    and revision.replay_eligibility = 'eligible' and session.execution_purpose = 'production'
    and run.status in ('success', 'error', 'canceled') and run.finished_at is not null
    and not exists (
      select 1 from public.session_retained_content_erasures erasure
      where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
        (session.workspace_id, session.factory_id, session.id)
    )
  for key share of session, run nowait;
  if not found then
    raise exception 'The benchmark source or task revision is unavailable.' using errcode = 'P0002';
  end if;

  if not source.execute_pinned_definition and exists (
    select 1 from public.session_factory_admission_inputs admission
    where (admission.workspace_id, admission.factory_id, admission.session_id) =
      (source.workspace_id, source.factory_id, source.id)
      and admission.execution_grant_id is not null
  ) then
    raise exception 'The benchmark source execution authority is unavailable.' using errcode = '42501';
  end if;
  perform internal.recheck_session_execution_grant(source);
  return true;
exception when lock_not_available then
  raise exception 'The benchmark source is changing. Retry after the change finishes.' using errcode = 'PT409';
end;
$$;
