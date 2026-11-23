-- Seal selected branch outputs and integrate them through the exact parent attempt.

create table internal.factory_workflow_joins (
  root_session_id uuid not null,
  join_id uuid not null default gen_random_uuid(),
  request_id uuid not null,
  branch_group_id uuid not null,
  join_occurrence_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  parent_session_id uuid not null,
  expected_head_run_id uuid not null,
  expected_generation bigint not null check (expected_generation between 1 and 9007199254740991),
  workflow_digest text not null,
  repository_id uuid not null,
  base_sha text not null check (base_sha collate "C" ~ '^[0-9a-f]{40}$'),
  delivery_policy_revision_id uuid not null references public.delivery_policy_revisions(id) deferrable initially deferred,
  required_evidence jsonb not null check (jsonb_typeof(required_evidence) = 'array' and jsonb_array_length(required_evidence) > 0),
  admitted_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, join_id),
  unique (root_session_id, request_id),
  unique (root_session_id, join_occurrence_id),
  foreign key (root_session_id, branch_group_id)
    references internal.factory_workflow_branch_groups(root_session_id, group_id) on delete cascade,
  foreign key (root_session_id, join_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) deferrable initially deferred,
  foreign key (parent_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) deferrable initially deferred,
  foreign key (expected_head_run_id)
    references public.session_git_checkpoints(run_id) deferrable initially deferred
);

create table internal.factory_workflow_join_inputs (
  root_session_id uuid not null,
  join_id uuid not null,
  slot_id uuid not null,
  branch_edge_id text not null,
  outcome_id uuid,
  admission_blocker text check (admission_blocker in (
    'workflow_child_limit', 'workflow_visit_limit_exhausted', 'workflow_child_attempt_limit'
  )),
  selected boolean not null,
  check ((outcome_id is not null and admission_blocker is null) or
    (outcome_id is null and admission_blocker is not null and not selected)),
  primary key (root_session_id, join_id, slot_id),
  unique (root_session_id, join_id, branch_edge_id),
  foreign key (root_session_id, join_id)
    references internal.factory_workflow_joins(root_session_id, join_id) on delete cascade,
  foreign key (root_session_id, slot_id)
    references internal.factory_workflow_branch_slots(root_session_id, slot_id) deferrable initially deferred,
  foreign key (root_session_id, outcome_id)
    references internal.factory_workflow_branch_outcomes(root_session_id, outcome_id) deferrable initially deferred
);

create table internal.factory_workflow_join_attempts (
  root_session_id uuid not null,
  join_id uuid not null,
  job_id uuid not null,
  run_id uuid not null unique,
  attempt_count integer not null check (attempt_count > 0),
  bound_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null check (isfinite(deadline_at) and deadline_at > bound_at),
  primary key (root_session_id, join_id),
  foreign key (root_session_id, join_id)
    references internal.factory_workflow_joins(root_session_id, join_id) on delete cascade
);

create table internal.factory_workflow_join_candidates (
  root_session_id uuid not null,
  join_id uuid not null,
  commit_sha text not null check (commit_sha collate "C" ~ '^[0-9a-f]{40}$'),
  tree_sha text not null check (tree_sha collate "C" ~ '^[0-9a-f]{40}$'),
  bundle_sha256 text check (bundle_sha256 collate "C" ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, join_id),
  foreign key (root_session_id, join_id)
    references internal.factory_workflow_join_attempts(root_session_id, join_id) on delete cascade
);

create table internal.factory_workflow_join_outcomes (
  root_session_id uuid not null,
  join_id uuid not null,
  outcome text not null check (outcome in ('conflict', 'validation_failed', 'adopted')),
  detail jsonb not null check (jsonb_typeof(detail) = 'object'),
  checkpoint_run_id uuid,
  artifact_id uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, join_id),
  foreign key (root_session_id, join_id)
    references internal.factory_workflow_join_attempts(root_session_id, join_id) on delete cascade,
  foreign key (checkpoint_run_id) references public.session_git_checkpoints(run_id) deferrable initially deferred,
  check ((outcome = 'adopted' and checkpoint_run_id is not null and artifact_id is not null)
    or (outcome <> 'adopted' and checkpoint_run_id is null and artifact_id is null))
);

alter table internal.factory_workflow_joins enable row level security;
alter table internal.factory_workflow_join_inputs enable row level security;
alter table internal.factory_workflow_join_attempts enable row level security;
alter table internal.factory_workflow_join_candidates enable row level security;
alter table internal.factory_workflow_join_outcomes enable row level security;
revoke all on table internal.factory_workflow_joins, internal.factory_workflow_join_inputs,
  internal.factory_workflow_join_attempts, internal.factory_workflow_join_candidates,
  internal.factory_workflow_join_outcomes from public, anon, authenticated, service_role;

create function internal.reject_factory_workflow_join_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'The workflow join receipt is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.reject_factory_workflow_join_update() from public, anon, authenticated, service_role;
create trigger freeze_factory_workflow_join before update on internal.factory_workflow_joins
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_join_input before update on internal.factory_workflow_join_inputs
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_join_attempt before update on internal.factory_workflow_join_attempts
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_join_candidate before update on internal.factory_workflow_join_candidates
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_join_outcome before update on internal.factory_workflow_join_outcomes
  for each row execute function internal.reject_factory_workflow_join_update();

create function internal.factory_workflow_join_head_is_current(p_join internal.factory_workflow_joins)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from internal.factory_workflow_executions execution
    join public.sessions parent on (parent.id, parent.workspace_id, parent.factory_id, parent.pinned_delivery_policy_revision_id) =
      (p_join.parent_session_id, p_join.workspace_id, p_join.factory_id, p_join.delivery_policy_revision_id)
    join public.session_git_heads head on (head.session_id, head.workspace_id) = (parent.id, parent.workspace_id)
    where (execution.root_session_id, execution.workspace_id, execution.factory_id,
      execution.workflow_digest, execution.generation, execution.lifecycle_status) =
      (p_join.root_session_id, p_join.workspace_id, p_join.factory_id, p_join.workflow_digest, p_join.expected_generation, 'running')
      and head.checkpoint_run_id = p_join.expected_head_run_id
  )
$$;
revoke all on function internal.factory_workflow_join_head_is_current(internal.factory_workflow_joins)
  from public, anon, authenticated, service_role;

create function public.open_factory_workflow_join(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_request_id uuid, p_branch_group_id uuid, p_expected_head_run_id uuid,
  p_selected_outcome_ids uuid[]
) returns table(join_id uuid, join_occurrence_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_branch_groups;
  receipt internal.factory_workflow_joins;
  parent public.sessions;
  required_keys jsonb;
  selected_ids uuid[];
  occurrence_id uuid;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if p_request_id is null or p_expected_head_run_id is null or coalesce(cardinality(p_selected_outcome_ids), 0) not between 1 and 128
    or (select count(distinct input_id) from unnest(p_selected_outcome_ids) input_id) <> cardinality(p_selected_outcome_ids) then
    raise exception 'An exact join request and unique selected output receipts are required.' using errcode = '22023';
  end if;
  select array_agg(input_id order by input_id) into selected_ids from unnest(p_selected_outcome_ids) input_id;
  select existing.* into receipt from internal.factory_workflow_joins existing
  where (existing.root_session_id, existing.workspace_id, existing.factory_id, existing.request_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_request_id);
  if found then
    if (receipt.branch_group_id, receipt.expected_head_run_id, receipt.expected_generation)
      is distinct from (p_branch_group_id, p_expected_head_run_id, p_expected_generation)
      or (select array_agg(input.outcome_id order by input.outcome_id)
        from internal.factory_workflow_join_inputs input
        where (input.root_session_id, input.join_id) = (p_root_session_id, receipt.join_id) and input.selected) is distinct from selected_ids then
      raise exception 'The join request already names a different checkpoint set.' using errcode = 'PT409';
    end if;
    return query select receipt.join_id, receipt.join_occurrence_id, false;
    return;
  end if;

  select groups.* into manifest from internal.factory_workflow_branch_groups groups
  where (groups.root_session_id, groups.workspace_id, groups.factory_id, groups.group_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_branch_group_id);
  if not found then raise exception 'The workflow branch group is unavailable.' using errcode = 'PT404'; end if;
  if manifest.source_checkpoint_run_id is distinct from p_expected_head_run_id
    or not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, manifest.parent_session_id) then
    raise exception 'The join no longer owns its exact parent checkpoint.' using errcode = 'PT409';
  end if;
  perform 1 from public.session_git_heads head
  where (head.session_id, head.workspace_id, head.checkpoint_run_id) =
    (manifest.parent_session_id, p_workspace_id, p_expected_head_run_id) for share;
  if not found then raise exception 'The join no longer owns its exact parent checkpoint.' using errcode = 'PT409'; end if;

  if exists (
    select 1 from internal.factory_workflow_joins prior
    left join internal.factory_workflow_join_outcomes terminal
      on (prior.root_session_id, prior.join_id) = (terminal.root_session_id, terminal.join_id)
    left join internal.factory_workflow_join_jobs marker
      on (marker.root_session_id,marker.join_id)=(prior.root_session_id,prior.join_id)
    left join public.agent_jobs job on job.id=marker.job_id
    where (prior.root_session_id, prior.branch_group_id) = (p_root_session_id, p_branch_group_id)
      and (terminal.outcome = 'adopted' or (
        terminal.outcome is null and prior.expected_generation = execution.generation
        and (job.id is null or job.status not in ('error','canceled'))
      ))
  ) then raise exception 'The branch group already owns an active or adopted join.' using errcode = 'PT409'; end if;

  if (select count(*) from internal.factory_workflow_branch_slots slot
      join internal.factory_workflow_branch_outcomes output
        on (output.root_session_id, output.slot_id) = (slot.root_session_id, slot.slot_id)
      where (slot.root_session_id, slot.group_id) = (p_root_session_id, p_branch_group_id)
        and output.outcome = 'succeeded' and output.outcome_id = any(selected_ids)) <> cardinality(selected_ids)
    or exists (
      select 1 from internal.factory_workflow_branch_slots slot
      left join internal.factory_workflow_branch_outcomes output
        on (output.root_session_id, output.slot_id) = (slot.root_session_id, slot.slot_id)
      left join internal.factory_workflow_branch_slot_dispatches dispatch
        on (dispatch.root_session_id, dispatch.slot_id) = (slot.root_session_id, slot.slot_id)
      where (slot.root_session_id, slot.group_id) = (p_root_session_id, p_branch_group_id)
        and (
          (slot.required and (output.outcome_id is null or not (output.outcome_id = any(selected_ids))))
          or (not slot.required and output.outcome_id is null and dispatch.terminal_blocker is null)
        )
    ) then
    raise exception 'The join requires the terminal branch set and every required successful output.' using errcode = 'PT409';
  end if;

  select session.* into strict parent from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (manifest.parent_session_id, p_workspace_id, p_factory_id);
  select policy.requirements->'requiredEvidence' into required_keys from public.delivery_policy_revisions policy
  where (policy.id, policy.workspace_id, policy.pipeline_id) = (parent.pinned_delivery_policy_revision_id, p_workspace_id, parent.pipeline_id);
  if jsonb_typeof(required_keys) is distinct from 'array' or jsonb_array_length(required_keys) = 0 then
    raise exception 'The join requires pinned validation evidence.' using errcode = 'PT422';
  end if;

  perform internal.assert_factory_workflow_route_capacity(execution, jsonb_build_object('kind', 'branch-result'));
  if (select count(*) from internal.factory_workflow_node_occurrences occurrence where occurrence.root_session_id = p_root_session_id) >= 1024 then
    raise exception 'The workflow visit limit is exhausted.' using errcode = 'PT409', detail = 'workflow_visit_limit_exhausted';
  end if;
  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  values (p_root_session_id, manifest.join_node_id, 'join', execution.generation)
  returning factory_workflow_node_occurrences.occurrence_id into occurrence_id;
  insert into internal.factory_workflow_joins(
    root_session_id, request_id, branch_group_id, join_occurrence_id, workspace_id, factory_id, parent_session_id,
    expected_head_run_id, expected_generation, workflow_digest, repository_id, base_sha, delivery_policy_revision_id, required_evidence
  ) values (
    p_root_session_id, p_request_id, p_branch_group_id, occurrence_id, p_workspace_id, p_factory_id, manifest.parent_session_id,
    p_expected_head_run_id, execution.generation, execution.workflow_digest, manifest.repository_id, manifest.input_sha,
    parent.pinned_delivery_policy_revision_id, required_keys
  ) returning * into receipt;
  insert into internal.factory_workflow_join_inputs(root_session_id, join_id, slot_id, branch_edge_id,
    outcome_id, admission_blocker, selected)
  select p_root_session_id, receipt.join_id, slot.slot_id, slot.branch_edge_id, output.outcome_id,
    case when output.outcome_id is null then dispatch.terminal_blocker end,
    coalesce(output.outcome_id = any(selected_ids), false)
  from internal.factory_workflow_branch_slots slot
  left join internal.factory_workflow_branch_outcomes output
    on (output.root_session_id, output.slot_id) = (slot.root_session_id, slot.slot_id)
  left join internal.factory_workflow_branch_slot_dispatches dispatch
    on (dispatch.root_session_id, dispatch.slot_id) = (slot.root_session_id, slot.slot_id)
  where (slot.root_session_id, slot.group_id) = (p_root_session_id, p_branch_group_id);
  return query select receipt.join_id, receipt.join_occurrence_id, true;
end;
$$;
revoke all on function public.open_factory_workflow_join(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.open_factory_workflow_join(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, uuid[])
  to service_role;
create function public.bind_factory_workflow_join_attempt(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_join_id uuid, p_job_id uuid, p_attempt_count integer, p_run_id uuid,
  p_deadline_at timestamptz default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  manifest internal.factory_workflow_joins;
  bound internal.factory_workflow_join_attempts;
  claimed_at timestamptz;
  run_started_at timestamptz;
  checked_at timestamptz;
  effective_deadline timestamptz;
  budget record;
begin
  if p_deadline_at is not null and not isfinite(p_deadline_at) then return false; end if;
  perform internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select recorded.* into manifest from internal.factory_workflow_joins recorded
  where (recorded.root_session_id, recorded.workspace_id, recorded.factory_id, recorded.join_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_join_id);
  if not found then return false; end if;
  select attempt.* into bound from internal.factory_workflow_join_attempts attempt
  where (attempt.root_session_id, attempt.join_id) = (p_root_session_id, p_join_id);
  if found then
    if (bound.job_id, bound.attempt_count, bound.run_id) is distinct from (p_job_id, p_attempt_count, p_run_id) then
      raise exception 'The join already owns a different integration attempt.' using errcode = 'PT409';
    end if;
    return true;
  end if;
  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, manifest.parent_session_id)
    or not internal.factory_workflow_join_head_is_current(manifest) then return false; end if;

  select job.started_at, run.started_at into claimed_at, run_started_at
  from public.agent_jobs job join public.agent_runs run
    on (run.agent_job_id, run.session_id, run.workspace_id, run.stage_id, run.attempt_count) =
      (job.id, job.session_id, job.workspace_id, job.stage_id, job.attempt_count)
  join public.session_job_git_inputs input
    on (input.job_id, input.session_id, input.workspace_id, input.pinned_run_id, input.pinned_attempt_count) =
      (job.id, job.session_id, job.workspace_id, run.id, job.attempt_count)
  join internal.factory_workflow_attempt_reservations reservation
    on (reservation.root_session_id, reservation.session_id, reservation.workspace_id, reservation.factory_id,
        reservation.job_id, reservation.attempt_count, reservation.run_id) =
      (manifest.root_session_id, job.session_id, job.workspace_id, manifest.factory_id, job.id, job.attempt_count, run.id)
  join public.sessions parent on (parent.id, parent.workspace_id, parent.current_stage_id) =
    (job.session_id, job.workspace_id, job.stage_id)
  where (job.id, run.id, run.attempt_count, job.session_id, job.workspace_id) =
    (p_job_id, p_run_id, p_attempt_count, manifest.parent_session_id, p_workspace_id)
    and (input.source_checkpoint_run_id, input.repository_id, input.input_sha) =
      (manifest.expected_head_run_id, manifest.repository_id, manifest.base_sha)
    and job.status in ('started', 'running') and run.status = 'running' and parent.phase_status = 'in_progress'
    and not exists (select 1 from public.session_checkpoint_publications existing where existing.run_id = run.id)
  for update of job, run;
  if not found or run_started_at is null then return false; end if;

  -- The live budget subtracts the time already spent in this run.
  -- Anchor before its read so database latency cannot extend the cutoff.
  checked_at := clock_timestamp();
  select * into budget from public.get_session_execution_budget(manifest.parent_session_id);
  if not found or budget.exhaustion_code is not null then return false; end if;
  effective_deadline := least(
    p_deadline_at,
    coalesce(claimed_at, run_started_at) + interval '30 minutes',
    (select dispatch.deadline_at from public.worker_dispatches dispatch
      where (dispatch.job_id, dispatch.attempt_count, dispatch.workspace_id) = (p_job_id, p_attempt_count, p_workspace_id)),
    checked_at + budget.remaining_execution_ms * interval '1 millisecond'
  );
  checked_at := clock_timestamp();
  if effective_deadline <= checked_at then return false; end if;
  insert into internal.factory_workflow_join_attempts(root_session_id, join_id, job_id, run_id, attempt_count, bound_at, deadline_at)
  values (p_root_session_id, p_join_id, p_job_id, p_run_id, p_attempt_count, checked_at, effective_deadline);
  return true;
end;
$$;

create function public.record_factory_workflow_join_candidate(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_join_id uuid, p_run_id uuid, p_commit_sha text, p_tree_sha text, p_bundle_sha256 text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  manifest internal.factory_workflow_joins;
  candidate internal.factory_workflow_join_candidates;
begin
  perform internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select recorded.* into manifest from internal.factory_workflow_joins recorded
  join internal.factory_workflow_join_attempts attempt using (root_session_id, join_id)
  where (recorded.root_session_id, recorded.workspace_id, recorded.factory_id, recorded.join_id, attempt.run_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_join_id, p_run_id);
  if not found then return false; end if;
  select existing.* into candidate from internal.factory_workflow_join_candidates existing
  where (existing.root_session_id, existing.join_id) = (p_root_session_id, p_join_id);
  if found then
    if (candidate.commit_sha, candidate.tree_sha, candidate.bundle_sha256) is distinct from (p_commit_sha, p_tree_sha, p_bundle_sha256) then
      raise exception 'The join already pins different integrated bytes.' using errcode = 'PT409';
    end if;
    return true;
  end if;
  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, manifest.parent_session_id)
    or not internal.factory_workflow_join_head_is_current(manifest)
    or exists (select 1 from internal.factory_workflow_join_outcomes terminal
      where (terminal.root_session_id, terminal.join_id) = (p_root_session_id, p_join_id)) then return false; end if;
  if (p_commit_sha = manifest.base_sha) <> (p_bundle_sha256 is null) then
    raise exception 'The join candidate bundle must match whether the source changed.' using errcode = '22023';
  end if;
  insert into internal.factory_workflow_join_candidates(root_session_id, join_id, commit_sha, tree_sha, bundle_sha256)
  values (p_root_session_id, p_join_id, p_commit_sha, p_tree_sha, p_bundle_sha256);
  return true;
end;
$$;

create function internal.factory_workflow_join_validation_passes(
  p_manifest internal.factory_workflow_joins, p_attempt internal.factory_workflow_join_attempts,
  p_candidate internal.factory_workflow_join_candidates
) returns boolean language plpgsql stable set search_path = '' as $$
declare
  plan public.session_validation_plans;
  required_key text;
begin
  select candidate_plan.* into plan from public.session_validation_plans candidate_plan
  where (candidate_plan.run_id, candidate_plan.workspace_id, candidate_plan.session_id, candidate_plan.job_id,
    candidate_plan.attempt_count, candidate_plan.repository_id, candidate_plan.commit_sha, candidate_plan.validation_tree_sha) =
    (p_attempt.run_id, p_manifest.workspace_id, p_manifest.parent_session_id, p_attempt.job_id,
      p_attempt.attempt_count, p_manifest.repository_id, p_candidate.commit_sha, p_candidate.tree_sha);
  if not found then return false; end if;
  for required_key in select jsonb_array_elements_text(p_manifest.required_evidence) loop
    if required_key collate "C" ~ '^browser:(screenshot|video):[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then
      if not internal.factory_workflow_browser_evidence_passes(plan, required_key) then return false; end if;
    elsif not internal.factory_workflow_command_evidence_passes(plan, required_key) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function internal.factory_workflow_join_validation_passes(internal.factory_workflow_joins,
  internal.factory_workflow_join_attempts, internal.factory_workflow_join_candidates) from public, anon, authenticated, service_role;

create function public.record_factory_workflow_join_blocker(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_join_id uuid, p_run_id uuid, p_outcome text, p_detail jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  manifest internal.factory_workflow_joins;
  attempt internal.factory_workflow_join_attempts;
  candidate internal.factory_workflow_join_candidates;
  prior internal.factory_workflow_join_outcomes;
begin
  perform internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if p_outcome is null or p_outcome not in ('conflict', 'validation_failed')
    or jsonb_typeof(p_detail) is distinct from 'object' or octet_length(p_detail::text) > 8192 then
    raise exception 'An exact bounded join blocker is required.' using errcode = '22023';
  end if;
  select recorded.* into manifest from internal.factory_workflow_joins recorded
  where (recorded.root_session_id, recorded.workspace_id, recorded.factory_id, recorded.join_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_join_id);
  if not found then return false; end if;
  select owned.* into attempt from internal.factory_workflow_join_attempts owned
  where (owned.root_session_id, owned.join_id, owned.run_id) = (p_root_session_id, p_join_id, p_run_id);
  if not found then return false; end if;
  select terminal.* into prior from internal.factory_workflow_join_outcomes terminal
  where (terminal.root_session_id, terminal.join_id) = (p_root_session_id, p_join_id);
  if found then
    if (prior.outcome, prior.detail) is distinct from (p_outcome, p_detail) then
      raise exception 'The join already has a different terminal result.' using errcode = 'PT409';
    end if;
    return true;
  end if;
  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, manifest.parent_session_id)
    or not internal.factory_workflow_join_head_is_current(manifest) then return false; end if;
  select sealed.* into candidate from internal.factory_workflow_join_candidates sealed
  where (sealed.root_session_id, sealed.join_id) = (p_root_session_id, p_join_id);

  if p_outcome = 'conflict' then
    if candidate.join_id is not null or p_detail - array['reportSha256', 'paths'] <> '{}'::jsonb
      or jsonb_typeof(p_detail->'reportSha256') is distinct from 'string'
      or p_detail->>'reportSha256' collate "C" !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(p_detail->'paths') is distinct from 'array'
      or jsonb_array_length(p_detail->'paths') not between 1 and 128
      or exists (select 1 from jsonb_array_elements(p_detail->'paths') path
        where jsonb_typeof(path) is distinct from 'string'
          or length(path#>>'{}') not between 1 and 512
          or path#>>'{}' collate "C" !~ '^[^/[:cntrl:]][^[:cntrl:]]*$'
          or path#>>'{}' collate "C" ~ '(^|/)\.\.(/|$)') then
      raise exception 'A conflict requires the retained integration report.' using errcode = '22023';
    end if;
  elsif p_detail <> '{}'::jsonb or candidate.join_id is null
    or not exists (
      select 1 from public.session_validation_evidence evidence
      where (evidence.run_id, evidence.workspace_id, evidence.session_id, evidence.job_id, evidence.attempt_count,
        evidence.repository_id, evidence.commit_sha, evidence.validation_tree_sha) =
        (attempt.run_id, manifest.workspace_id, manifest.parent_session_id, attempt.job_id, attempt.attempt_count,
          manifest.repository_id, candidate.commit_sha, candidate.tree_sha)
    ) or internal.factory_workflow_join_validation_passes(manifest, attempt, candidate) then
    return false;
  end if;

  insert into internal.factory_workflow_join_outcomes(root_session_id, join_id, outcome, detail)
  values (p_root_session_id, p_join_id, p_outcome, p_detail);
  return true;
end;
$$;

create function public.read_factory_workflow_join(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_join_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('manifest', to_jsonb(manifest), 'attempt', to_jsonb(attempt),
    'candidate', to_jsonb(candidate), 'outcome', to_jsonb(terminal),
    'inputs', (select jsonb_agg(to_jsonb(input) || jsonb_build_object('branchOutput', to_jsonb(output))
      order by input.branch_edge_id)
      from internal.factory_workflow_join_inputs input left join internal.factory_workflow_branch_outcomes output
        on (output.root_session_id, output.outcome_id) = (input.root_session_id, input.outcome_id)
      where (input.root_session_id, input.join_id) = (manifest.root_session_id, manifest.join_id)))
  from internal.factory_workflow_joins manifest
  left join internal.factory_workflow_join_attempts attempt using (root_session_id, join_id)
  left join internal.factory_workflow_join_candidates candidate using (root_session_id, join_id)
  left join internal.factory_workflow_join_outcomes terminal using (root_session_id, join_id)
  where (manifest.root_session_id, manifest.workspace_id, manifest.factory_id, manifest.join_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_join_id)
$$;

revoke all on function public.bind_factory_workflow_join_attempt(uuid, uuid, uuid, bigint, uuid, uuid, uuid, integer, uuid, timestamptz),
  public.record_factory_workflow_join_candidate(uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, text, text),
  public.record_factory_workflow_join_blocker(uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, jsonb),
  public.read_factory_workflow_join(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.bind_factory_workflow_join_attempt(uuid, uuid, uuid, bigint, uuid, uuid, uuid, integer, uuid, timestamptz),
  public.record_factory_workflow_join_candidate(uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, text, text),
  public.record_factory_workflow_join_blocker(uuid, uuid, uuid, bigint, uuid, uuid, uuid, text, jsonb),
  public.read_factory_workflow_join(uuid, uuid, uuid, uuid) to service_role;
-- The native adopter opens this fence inside its transaction. The artifact
-- primitive cannot be used directly to finish a join, even for no-code output.
create table internal.factory_workflow_join_adoption_fences (
  run_id uuid primary key,
  transaction_id xid8 not null
);
alter table internal.factory_workflow_join_adoption_fences enable row level security;
revoke all on table internal.factory_workflow_join_adoption_fences from public, anon, authenticated, service_role;

create function internal.factory_workflow_join_publication_is_current(p_publication public.session_checkpoint_publications)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  manifest internal.factory_workflow_joins;
  attempt internal.factory_workflow_join_attempts;
  candidate internal.factory_workflow_join_candidates;
begin
  select owned.* into attempt from internal.factory_workflow_join_attempts owned
  where owned.run_id = p_publication.run_id;
  if not found then return true; end if;

  select recorded.* into strict manifest from internal.factory_workflow_joins recorded
  where (recorded.root_session_id, recorded.join_id) = (attempt.root_session_id, attempt.join_id);
  select sealed.* into candidate from internal.factory_workflow_join_candidates sealed
  where (sealed.root_session_id, sealed.join_id) = (attempt.root_session_id, attempt.join_id);
  if candidate.join_id is null or p_publication.deadline_at > attempt.deadline_at
    or (p_publication.workspace_id, p_publication.session_id, p_publication.job_id, p_publication.attempt_count) is distinct from
      (manifest.workspace_id, manifest.parent_session_id, attempt.job_id, attempt.attempt_count)
    or not internal.factory_workflow_join_head_is_current(manifest)
    or exists (select 1 from internal.factory_workflow_join_outcomes terminal
      where (terminal.root_session_id, terminal.join_id) = (manifest.root_session_id, manifest.join_id))
    or not exists (
      select 1 from public.session_source_deliveries delivery
      join public.session_job_git_inputs input
        on (input.job_id, input.workspace_id, input.session_id, input.pinned_run_id, input.pinned_attempt_count) =
          (delivery.job_id, delivery.workspace_id, delivery.session_id, delivery.run_id, delivery.attempt_count)
      where (delivery.run_id, delivery.job_id, delivery.attempt_count, delivery.repository_id, delivery.base_sha, delivery.head_sha) =
        (attempt.run_id, attempt.job_id, attempt.attempt_count, manifest.repository_id, manifest.base_sha, candidate.commit_sha)
        and delivery.bundle_sha256 is not distinct from candidate.bundle_sha256
        and input.source_checkpoint_run_id = manifest.expected_head_run_id
    ) then return false; end if;
  return internal.factory_workflow_join_validation_passes(manifest, attempt, candidate);
end;
$$;
revoke all on function internal.factory_workflow_join_publication_is_current(public.session_checkpoint_publications)
  from public, anon, authenticated, service_role;
grant execute on function internal.factory_workflow_join_publication_is_current(public.session_checkpoint_publications)
  to service_role;
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
      and internal.factory_workflow_join_publication_is_current(p)
  );
$$;

-- A typed join on a completed specification is a new integration artifact.
-- A normal specification run still cannot deliver changed source.
create or replace function internal.guard_specification_source_delivery()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.base_sha <> new.head_sha and exists (
    select 1 from public.agent_runs run join public.sessions session
      on (session.id, session.workspace_id, session.specification_stage_id) =
        (run.session_id, run.workspace_id, run.stage_id)
    where (run.id, run.agent_job_id, run.attempt_count, run.session_id, run.workspace_id) =
      (new.run_id, new.job_id, new.attempt_count, new.session_id, new.workspace_id)
  ) and not exists (
    select 1 from internal.factory_workflow_join_attempts attempt
    join internal.factory_workflow_joins manifest using (root_session_id,join_id)
    join internal.factory_workflow_join_candidates candidate using (root_session_id,join_id)
    where (attempt.run_id,attempt.job_id,attempt.attempt_count,manifest.workspace_id,manifest.parent_session_id,
      manifest.repository_id,manifest.base_sha,candidate.commit_sha)=(new.run_id,new.job_id,new.attempt_count,
      new.workspace_id,new.session_id,new.repository_id,new.base_sha,new.head_sha)
      and internal.factory_workflow_join_validation_passes(manifest,attempt,candidate)
  ) then
    raise exception 'Specification publication requires unchanged source from the exact execution attempt.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function internal.publish_session_job_attempt_with_conversation(
  p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_expected_artifact_version integer,
  p_artifact_json text, p_deadline_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  session public.sessions;
  run public.agent_runs;
  message public.session_conversation_messages;
  question text;
  question_ordinal integer;
begin
  if exists (select 1 from internal.factory_workflow_join_attempts attempt where attempt.run_id = p_run_id)
    and not exists (
      select 1 from internal.factory_workflow_join_adoption_fences fence
      where fence.run_id = p_run_id and fence.transaction_id = pg_current_xact_id_if_assigned()
    ) then
    raise exception 'A joined artifact requires atomic checkpoint adoption.' using errcode = '42501';
  end if;
  if not internal.publish_session_job_attempt_without_conversation(
    p_job_id, p_attempt_count, p_run_id, p_expected_artifact_version, p_artifact_json, p_deadline_at) then
    return false;
  end if;
  select * into strict run from public.agent_runs where id = p_run_id;
  select * into strict session from public.sessions where id = run.session_id;
  message.body_md := 'An artifact is ready for review.';
  if exists (select 1 from internal.factory_workflow_join_attempts attempt where attempt.run_id = p_run_id) then
    message.body_md := 'A workflow join is ready for review.';
  elsif run.stage_id = session.specification_stage_id then
    -- Inspect the exact captured input and unchanged source before the original
    -- publication, checkpoint, artifact and job transition can commit.
    if not exists (
      select 1 from public.session_source_deliveries delivery
      join public.session_job_git_inputs input on (input.job_id, input.workspace_id, input.session_id,
        input.pinned_run_id, input.pinned_attempt_count, input.repository_id, input.input_sha) =
        (delivery.job_id, delivery.workspace_id, delivery.session_id, delivery.run_id,
          delivery.attempt_count, delivery.repository_id, delivery.base_sha)
      where (delivery.run_id, delivery.job_id, delivery.attempt_count, delivery.session_id, delivery.workspace_id) =
        (run.id, p_job_id, p_attempt_count, session.id, session.workspace_id)
        and delivery.base_sha = delivery.head_sha
    ) then
      raise exception 'Specification publication requires unchanged source from the exact execution attempt.' using errcode = '23514';
    end if;
    message.body_md := 'A specification is ready for review.';
    question := internal.checked_session_specification_question(session.id, p_artifact_json);
    if question is not null then
      select coalesce(max(clarification.ordinal), 0) + 1 into question_ordinal
      from public.session_specification_clarifications clarification where clarification.session_id = session.id;
      insert into public.session_specification_clarifications (
        workspace_id, factory_id, session_id, stage_id, artifact_id, artifact_version, run_id, attempt_count, ordinal, question
      ) values (
        session.workspace_id, session.factory_id, session.id, run.stage_id, session.current_artifact_id,
        session.current_artifact_version, run.id, run.attempt_count, question_ordinal, question
      );
      message.body_md := 'Clarification needed: ' || question;
    end if;
  end if;
  message.kind := 'review_ready';
  message.author_kind := 'agent';
  message.author_label := coalesce((select agent.name from public.factory_agents agent
    where (agent.workspace_id, agent.factory_id, agent.id) = (session.workspace_id, session.factory_id, run.agent_id)), 'Wallie');
  message.originating_member_id := run.triggered_by_member_id;
  message.run_id := run.id;
  message.attempt_count := run.attempt_count;
  message.artifact_id := session.current_artifact_id;
  message.body_truncated := false;
  perform internal.append_session_conversation_message(session, message, 'review_ready:' || session.current_artifact_id::text);
  if p_deadline_at is not null and clock_timestamp() >= p_deadline_at then
    raise exception 'Worker attempt exceeded its publication deadline.' using errcode = '57014';
  end if;
  return true;
end;
$$;

create or replace function internal.adopt_session_checkpoint_publication(
  p_run_id uuid,p_claim_id uuid,p_remote_ref text default null,p_remote_sha text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare p public.session_checkpoint_publications%rowtype; d public.session_source_deliveries%rowtype; accepted uuid;
  join_manifest internal.factory_workflow_joins;
  join_execution internal.factory_workflow_executions;
  join_candidate internal.factory_workflow_join_candidates;
begin
  perform internal.assert_checkpoint_publication_service();
  select recorded.* into join_manifest from internal.factory_workflow_joins recorded
  join internal.factory_workflow_join_attempts attempt using (root_session_id, join_id)
  where attempt.run_id = p_run_id;
  if found and not exists (
    select 1 from internal.factory_workflow_join_outcomes outcome
    where (outcome.root_session_id, outcome.join_id, outcome.outcome) =
      (join_manifest.root_session_id, join_manifest.join_id, 'adopted')
  ) then
    perform internal.lock_factory_workflow_root(join_manifest.root_session_id, join_manifest.workspace_id, join_manifest.factory_id);
    select execution.* into strict join_execution from internal.factory_workflow_executions execution
    where execution.root_session_id = join_manifest.root_session_id for no key update;
    -- A concurrent caller can adopt while this replay waits for the root.
    -- The locked publication below still requires the original claim and proof.
    if not exists (
      select 1 from internal.factory_workflow_join_outcomes outcome
      where (outcome.root_session_id, outcome.join_id, outcome.outcome) =
        (join_manifest.root_session_id, join_manifest.join_id, 'adopted')
    ) and (
      not internal.recheck_factory_workflow_delegation_lineage(join_manifest.root_session_id, join_manifest.workspace_id,
        join_manifest.factory_id, join_manifest.parent_session_id)
      or not internal.factory_workflow_join_head_is_current(join_manifest)
    ) then return false; end if;
  end if;
  perform 1 from public.sessions s join public.session_checkpoint_publications candidate on candidate.session_id=s.id
    where candidate.run_id=p_run_id for no key update of s;
  if not found then return false; end if;
  perform 1 from public.agent_jobs j join public.session_checkpoint_publications candidate on candidate.job_id=j.id
    where candidate.run_id=p_run_id for update of j;
  if not found then return false; end if;
  perform 1 from public.agent_runs where id=p_run_id for update;
  if not found then return false; end if;
  select * into p from public.session_checkpoint_publications where run_id=p_run_id for update;
  if not found then return false; end if;
  if p.status='adopted' then
    return p_claim_id is not null and p.claim_id=p_claim_id and p.remote_verified_ref is not distinct from p_remote_ref
      and p.remote_verified_sha is not distinct from p_remote_sha;
  end if;
  if p.status<>'claimed' or p.claim_id is distinct from p_claim_id
    or p.lease_expires_at<=clock_timestamp() or p.deadline_at<=clock_timestamp()
    or not internal.checkpoint_publication_is_current(p) then return false; end if;
  perform internal.assert_workspace_accepts_work(p.workspace_id);
  select * into d from public.session_source_deliveries where run_id=p_run_id for update;
  if d.base_sha<>d.head_sha then
    if p_remote_ref is distinct from p.retained_ref or p_remote_sha is distinct from d.head_sha then
      raise exception 'Exact retained remote checkpoint proof is required.' using errcode='23514';
    end if;
    update public.session_checkpoint_publications set remote_verified_ref=p_remote_ref,remote_verified_sha=p_remote_sha,
      remote_verified_at=clock_timestamp() where run_id=p_run_id;
  elsif p_remote_ref is not null or p_remote_sha is not null then
    raise exception 'No-code checkpoint must not fabricate a remote ref or SHA.' using errcode='23514';
  end if;
  if join_manifest.join_id is not null then
    insert into internal.factory_workflow_join_adoption_fences(run_id, transaction_id)
    values (p_run_id, pg_current_xact_id());
  end if;
  if not public.publish_session_job_with_source(p.job_id,p.attempt_count,p.run_id,p.expected_artifact_version,p.artifact_md,p.deadline_at) then
    raise exception 'Checkpoint adoption lost execution ownership.' using errcode='23514';
  end if;
  -- Separate statements guarantee the checkpoint insert precedes completion;
  -- do not rely on expression evaluation order for lifecycle mutations.
  if not public.complete_session_job_attempt(p.job_id,p.attempt_count,p.run_id) then
    raise exception 'Checkpoint adoption lost execution ownership.' using errcode='23514';
  end if;
  select current_artifact_id into accepted from public.sessions where id=p.session_id;
  update public.session_checkpoint_publications set status='adopted',artifact_id=accepted,adopted_at=clock_timestamp()
    where run_id=p.run_id;
  if join_manifest.join_id is not null then
    select candidate.* into strict join_candidate from internal.factory_workflow_join_candidates candidate
    where (candidate.root_session_id, candidate.join_id) = (join_manifest.root_session_id, join_manifest.join_id);
    insert into internal.factory_workflow_join_outcomes(root_session_id, join_id, outcome, detail, checkpoint_run_id, artifact_id)
    values (join_manifest.root_session_id, join_manifest.join_id, 'adopted',
      jsonb_build_object('commitSha', join_candidate.commit_sha, 'treeSha', join_candidate.tree_sha), p_run_id, accepted);
    perform internal.insert_factory_workflow_node_result(join_execution, join_manifest.join_occurrence_id,
      'succeeded', 'join-checkpoint:' || p_run_id);
    delete from internal.factory_workflow_join_adoption_fences where run_id = p_run_id;
  end if;
  if clock_timestamp()>=p.deadline_at or clock_timestamp()>=p.lease_expires_at then
    raise exception 'Checkpoint publication lease or deadline expired before adoption.' using errcode='57014';
  end if;
  return true;
end;
$$;

-- The queue marker exists before the claim can be visible to either worker.
create table internal.factory_workflow_join_jobs (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  queued_run_id uuid not null unique references public.agent_runs(id) on delete cascade,
  root_session_id uuid not null,
  join_id uuid not null,
  expected_generation bigint not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  parent_session_id uuid not null,
  stage_id uuid not null,
  artifact_id uuid not null,
  artifact_version integer not null check (artifact_version>=0),
  previous_phase public.pipeline_phase_status not null,
  previous_archived_at timestamptz,
  unique (root_session_id,join_id),
  foreign key (root_session_id,join_id) references internal.factory_workflow_joins(root_session_id,join_id) on delete cascade
);
alter table internal.factory_workflow_join_jobs enable row level security;
revoke all on table internal.factory_workflow_join_jobs from public,anon,authenticated,service_role;
create trigger freeze_factory_workflow_join_job before update on internal.factory_workflow_join_jobs
  for each row execute function internal.reject_factory_workflow_join_update();

create function internal.is_factory_workflow_join_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from internal.factory_workflow_join_jobs marker where marker.job_id=p_job_id)
$$;
revoke all on function internal.is_factory_workflow_join_job(uuid) from public,anon,authenticated,service_role;
grant execute on function internal.is_factory_workflow_join_job(uuid) to service_role;

create function public.enqueue_factory_workflow_join(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_expected_generation bigint,p_ownership_token uuid,
  p_request_id uuid,p_branch_group_id uuid,p_expected_head_run_id uuid,p_selected_outcome_ids uuid[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  prior internal.factory_workflow_join_jobs;
  parent public.sessions;
  head public.session_git_checkpoints;
  opened record;
  queued record;
begin
  perform internal.assert_checkpoint_publication_service();
  execution:=internal.lock_factory_workflow_owner(p_root_session_id,p_workspace_id,p_factory_id,p_expected_generation,p_ownership_token);
  select * into strict opened from public.open_factory_workflow_join(p_root_session_id,p_workspace_id,p_factory_id,p_expected_generation,
    p_ownership_token,p_request_id,p_branch_group_id,p_expected_head_run_id,p_selected_outcome_ids);
  select * into strict manifest from internal.factory_workflow_joins
  where (root_session_id,join_id)=(p_root_session_id,opened.join_id);
  select * into prior from internal.factory_workflow_join_jobs
  where (root_session_id,join_id)=(p_root_session_id,opened.join_id);
  if found then
    return jsonb_build_object('joinId',manifest.join_id,'occurrenceId',manifest.join_occurrence_id,'jobId',prior.job_id,
      'runId',prior.queued_run_id,'created',false);
  end if;
  if not internal.factory_workflow_join_head_is_current(manifest)
    or not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id,p_workspace_id,p_factory_id,manifest.parent_session_id)
    then raise exception 'The join no longer owns its exact parent checkpoint.' using errcode='PT409'; end if;
  select * into strict parent from public.sessions where (id,workspace_id,factory_id)=(manifest.parent_session_id,p_workspace_id,p_factory_id)
    for no key update;
  head:=internal.factory_workflow_adopted_checkpoint(parent.id,p_workspace_id,p_factory_id,parent.factory_definition_revision_id,
    (select admission.definition_digest from public.session_factory_admission_inputs admission where admission.session_id=parent.id),
    p_expected_head_run_id);
  if parent.phase_status not in ('in_progress','awaiting_review','approved')
    or parent.current_artifact_id is null or head.artifact_id is distinct from parent.current_artifact_id
    or head.repository_id is distinct from manifest.repository_id or head.output_sha is distinct from manifest.base_sha
    or (parent.archived_at is not null and parent.phase_status<>'approved')
    then raise exception 'The exact parent artifact is no longer available for integration.' using errcode='PT409'; end if;

  if parent.phase_status='approved' then
    -- Reopen the exact approved artifact for an explicitly admitted integration.
    -- A subsequent manual archive does not carry that approval's archive time.
    if not exists (
      select 1 from public.session_stage_approval_receipts approval
      where (approval.session_id,approval.workspace_id,approval.stage_id,approval.artifact_id,approval.artifact_version)=
        (parent.id,p_workspace_id,parent.current_stage_id,parent.current_artifact_id,parent.current_artifact_version)
        and (parent.archived_at is null or parent.archived_at<=approval.approved_at)
    ) then raise exception 'The exact approved parent artifact cannot be reopened.' using errcode='PT409'; end if;
    update public.sessions set archived_at=null, phase_status='in_progress' where id=parent.id;
  end if;

  select * into strict queued from public.enqueue_session_job_with_run(parent.id,p_workspace_id,parent.current_stage_id,p_run_type=>'code');
  if not queued.created or queued.job_id is null or queued.run_id is null then
    raise exception 'The parent already owns an active attempt.' using errcode='PT409'; end if;
  perform internal.prepare_session_job_git_input(queued.job_id,p_expected_head_run_id);
  insert into internal.factory_workflow_join_jobs(job_id,queued_run_id,root_session_id,join_id,expected_generation,workspace_id,
    factory_id,parent_session_id,stage_id,artifact_id,artifact_version,previous_phase,previous_archived_at)
  values(queued.job_id,queued.run_id,p_root_session_id,manifest.join_id,execution.generation,p_workspace_id,p_factory_id,parent.id,
    parent.current_stage_id,parent.current_artifact_id,parent.current_artifact_version,parent.phase_status,parent.archived_at);
  return jsonb_build_object('joinId',manifest.join_id,'occurrenceId',manifest.join_occurrence_id,'jobId',queued.job_id,
    'runId',queued.run_id,'created',true);
end;
$$;

-- Ordinary workers cannot start marked jobs, including after an accidental
-- requeue. The specialized dispatcher below calls the same native attempt core
-- after validating the marker, generation, parent checkpoint and queue claim.
create or replace function public.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language sql security invoker set search_path='' as $$
  select case when not internal.is_factory_workflow_join_job(p_job_id)
    then internal.start_session_job_attempt(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
      p_model_provider,p_model_name,p_run_type,p_branch_name) end;
$$;

create function public.start_factory_workflow_join_attempt(
  p_job_id uuid,p_workspace_id uuid,p_session_id uuid,p_attempt_count integer,p_deadline_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  marker internal.factory_workflow_join_jobs;
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  parent public.sessions;
  captured public.agent_jobs;
  validation_input public.session_job_git_inputs;
  branch text;
  routing jsonb;
  provider text;
  model text;
  started uuid;
  deadline_at timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into marker from internal.factory_workflow_join_jobs where job_id=p_job_id;
  if not found then return jsonb_build_object('kind','ordinary'); end if;
  if (marker.workspace_id,marker.parent_session_id) is distinct from (p_workspace_id,p_session_id)
    or p_attempt_count is null or p_attempt_count<=0 or p_deadline_at is null or not isfinite(p_deadline_at)
    then return jsonb_build_object('kind','retired'); end if;

  -- Match the existing queue and start path's release -> workspace -> root
  -- locking order. The exact owner can be returned only to the claimed worker.
  perform 1 from internal.git_continuity_release_control where singleton for share;
  perform internal.lock_factory_workflow_root(marker.root_session_id,p_workspace_id,marker.factory_id);
  select * into execution from internal.factory_workflow_executions where root_session_id=marker.root_session_id for no key update;
  if not found or execution.lifecycle_status<>'running' or execution.generation<>marker.expected_generation
    then return jsonb_build_object('kind','retired'); end if;
  select * into strict manifest from internal.factory_workflow_joins where (root_session_id,join_id)=(marker.root_session_id,marker.join_id);
  if not internal.factory_workflow_join_head_is_current(manifest)
    or not internal.recheck_factory_workflow_delegation_lineage(marker.root_session_id,p_workspace_id,marker.factory_id,p_session_id)
    then return jsonb_build_object('kind','retired'); end if;
  select * into parent from public.sessions where (id,workspace_id,factory_id)=(p_session_id,p_workspace_id,marker.factory_id) for no key update;
  if not found or (parent.current_stage_id,parent.current_artifact_id,parent.current_artifact_version)
    is distinct from (marker.stage_id,marker.artifact_id,marker.artifact_version)
    then return jsonb_build_object('kind','retired'); end if;
  select * into captured from public.agent_jobs where (id,workspace_id,session_id,stage_id,attempt_count)
    =(p_job_id,p_workspace_id,p_session_id,marker.stage_id,p_attempt_count) and status in ('started','running') for update;
  if not found or internal.git_continuity_effective_attempt_count(p_job_id,p_workspace_id,p_session_id,p_attempt_count)<>1
    then return jsonb_build_object('kind','retired'); end if;
  if exists(select 1 from internal.factory_workflow_join_attempts bound
    where (bound.root_session_id,bound.join_id,bound.job_id,bound.attempt_count)=(marker.root_session_id,marker.join_id,p_job_id,p_attempt_count))
    then return jsonb_build_object('kind','started_elsewhere'); end if;

  select * into strict validation_input from public.session_job_git_inputs where job_id=p_job_id;
  if (validation_input.source_checkpoint_run_id,validation_input.repository_id,validation_input.input_sha)
    is distinct from (manifest.expected_head_run_id,manifest.repository_id,manifest.base_sha)
    then return jsonb_build_object('kind','retired'); end if;
  if p_deadline_at <= clock_timestamp() then return jsonb_build_object('kind','retired'); end if;
  routing:=internal.effective_factory_routing_execution(p_workspace_id,marker.factory_id,p_session_id);
  select model_provider,model_name into strict provider,model from public.agent_runs
  where agent_job_id=p_job_id and status='queued' and attempt_count is null;
  provider:=coalesce(routing#>>'{configuration,harness}',provider);
  model:=coalesce(routing->>'modelName',model);
  branch:='wallie/join/'||marker.join_id::text;

  started:=internal.start_session_job_attempt(p_job_id,p_attempt_count,marker.stage_id,marker.artifact_version,provider,model,'code',branch);
  if started is null then return jsonb_build_object('kind','retired'); end if;
  if started<>marker.queued_run_id then
    raise exception 'The workflow join did not start the admitted run.' using errcode='PT409';
  end if;
  perform public.pin_session_job_git_input(p_job_id,p_attempt_count,started,manifest.repository_id,validation_input.base_branch,manifest.base_sha);
  if not found or not public.bind_factory_workflow_join_attempt(marker.root_session_id,p_workspace_id,marker.factory_id,
    execution.generation,execution.ownership_token,marker.join_id,p_job_id,p_attempt_count,started,p_deadline_at)
    then raise exception 'The workflow join attempt could not bind its exact input and deadline.' using errcode='PT409'; end if;
  select bound.deadline_at into strict deadline_at from internal.factory_workflow_join_attempts bound where bound.run_id=started;
  if clock_timestamp() >= deadline_at then
    raise exception 'Workflow join attempt deadline elapsed before start.' using errcode='57014';
  end if;
  return jsonb_build_object('kind','started','rootSessionId',marker.root_session_id,'workspaceId',p_workspace_id,
    'factoryId',marker.factory_id,'parentSessionId',p_session_id,'joinId',marker.join_id,'jobId',p_job_id,'runId',started,
    'attemptCount',p_attempt_count,'generation',execution.generation,'ownershipToken',execution.ownership_token,
    'artifactVersion',marker.artifact_version,'baseSha',manifest.base_sha,'baseRef',validation_input.input_ref,'deadlineAt',deadline_at);
end;
$$;

-- Restore the pre-integration reviewable state during pause when the old
-- artifact still owns the session. No head, immutable run or attempt is changed.
create function internal.park_factory_workflow_join_review(p_job_ids uuid[])
returns void language sql security definer set search_path='' as $$
  update public.sessions parent set phase_status=marker.previous_phase, archived_at=marker.previous_archived_at
  from internal.factory_workflow_join_jobs marker join public.agent_jobs retired on retired.id=marker.job_id
  where marker.job_id=any(p_job_ids) and retired.status in ('error','canceled')
    and not exists (select 1 from public.agent_jobs active
      where (active.workspace_id,active.session_id)=(marker.workspace_id,marker.parent_session_id)
        and active.status in ('queued','started','running'))
    and (parent.id,parent.workspace_id,parent.factory_id,parent.current_stage_id,
    parent.current_artifact_id,parent.current_artifact_version)=(marker.parent_session_id,marker.workspace_id,marker.factory_id,
      marker.stage_id,marker.artifact_id,marker.artifact_version)
    and parent.archived_at is null and parent.phase_status in ('in_progress','rejected')
    and marker.previous_phase in ('awaiting_review','approved');
$$;
revoke all on function internal.park_factory_workflow_join_review(uuid[]) from public,anon,authenticated,service_role;
grant execute on function internal.park_factory_workflow_join_review(uuid[]) to service_role;
-- Generic worker deadline, stall and publication expiry still settle the same
-- exact job. A typed integration is one-shot and restores its prior review.
alter function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid) set schema internal;
alter function internal.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid)
  rename to fail_session_job_attempt_before_workflow_join;
revoke all on function internal.fail_session_job_attempt_before_workflow_join(uuid,integer,text,boolean,integer,uuid)
from public,anon,authenticated,service_role;
grant execute on function internal.fail_session_job_attempt_before_workflow_join(uuid,integer,text,boolean,integer,uuid)
to service_role;
create function public.fail_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_error text,p_retry boolean,p_max_retries integer,p_run_id uuid default null
) returns text language plpgsql security invoker set search_path='' as $$
declare typed boolean; outcome text;
begin
  perform internal.assert_checkpoint_publication_service();
  typed:=internal.is_factory_workflow_join_job(p_job_id);
  outcome:=internal.fail_session_job_attempt_before_workflow_join(p_job_id,p_attempt_count,p_error,
    p_retry and not typed,p_max_retries,p_run_id);
  if typed and outcome='error' then
    perform internal.park_factory_workflow_join_review(array[p_job_id]);
  end if;
  return outcome;
end;
$$;
revoke all on function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid)
from public,anon,authenticated,service_role;
grant execute on function public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid)
to service_role;

revoke all on function public.enqueue_factory_workflow_join(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,uuid[]),
  public.start_factory_workflow_join_attempt(uuid,uuid,uuid,integer,timestamptz)
from public,anon,authenticated,service_role;
grant execute on function public.enqueue_factory_workflow_join(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,uuid[]),
  public.start_factory_workflow_join_attempt(uuid,uuid,uuid,integer,timestamptz)
to service_role;

create or replace function public.control_factory_workflow_lifecycle(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid,
  p_expected_generation bigint, p_request_id uuid, p_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  prior internal.factory_workflow_lifecycle_commands;
  owner public.sessions;
  parent_id uuid;
  member_ids uuid[];
  prior_state text;
  next_state text;
  pause_receipt jsonb;
  retired jsonb := '[]'::jsonb;
  resumed jsonb := '[]'::jsonb;
  retirement record;
  restart record;
  resume_input jsonb;
  receipt jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_request_id is null or coalesce(p_action, '') not in ('pause', 'resume', 'cancel')
    or p_expected_generation is null or p_expected_generation not between 1 and 9007199254740990 then
    raise exception 'Invalid workflow lifecycle command.' using errcode = '22023';
  end if;

  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select workflow.* into execution from internal.factory_workflow_executions workflow
  where (workflow.root_session_id, workflow.workspace_id, workflow.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id) and workflow.graph_revision_id is not null
  for no key update;
  if not found then raise exception 'Workflow graph is unavailable.' using errcode = 'PT404'; end if;
  select command.* into prior from internal.factory_workflow_lifecycle_commands command
  where (command.root_session_id, command.request_id) = (p_root_session_id, p_request_id);
  if found then
    if (prior.expected_generation, prior.action) is distinct from (p_expected_generation, p_action) then
      raise exception 'The workflow request was already used with different intent.' using errcode = 'PT409';
    end if;
    return prior.receipt;
  end if;
  if execution.generation is distinct from p_expected_generation then
    raise exception 'Workflow generation is stale.' using errcode = 'PT409';
  end if;
  prior_state := execution.lifecycle_status;
  if prior_state = 'canceled' or (p_action = 'pause' and prior_state <> 'running')
    or (p_action = 'resume' and prior_state <> 'paused') then
    raise exception 'The workflow lifecycle transition is unavailable.' using errcode = 'PT409';
  end if;
  next_state := case p_action when 'pause' then 'paused' when 'resume' then 'running' else 'canceled' end;

  select array_prepend(p_root_session_id, coalesce(array_agg(marker.child_session_id order by marker.child_session_id), '{}'::uuid[]))
  into member_ids from internal.factory_workflow_delegations marker
  where (marker.root_session_id, marker.workspace_id, marker.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id);
  perform 1 from public.sessions session
  where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id) and session.id = any(member_ids)
  order by session.id <> p_root_session_id, session.id for no key update;

  if p_action = 'resume' then
    select root.* into owner from public.sessions root
    join public.session_factory_admission_inputs pin
      on (pin.session_id, pin.workspace_id, pin.factory_id, pin.definition_revision_id) =
        (root.id, root.workspace_id, root.factory_id, root.factory_definition_revision_id)
    where (root.id, root.workspace_id, root.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id)
      and (pin.definition_revision_id, pin.definition_digest) =
        (execution.definition_revision_id, execution.definition_digest)
      and root.execute_pinned_definition and (root.archived_at is null or root.phase_status = 'approved')
      and root.execution_policy_revision_id is not distinct from pin.execution_policy_revision_id;
    if not found then
      raise exception 'The workflow root cannot resume its pinned execution.' using errcode = 'PT409';
    end if;
    perform internal.recheck_session_execution_grant(owner);
    if not internal.session_execution_admissible(owner.id, owner.workspace_id) then
      raise exception 'The workflow root execution budget is exhausted.' using errcode = 'PT409';
    end if;

    select command.receipt into strict pause_receipt from internal.factory_workflow_lifecycle_commands command
    where (command.root_session_id, command.applied_generation, command.action) =
      (p_root_session_id, p_expected_generation, 'pause');
  end if;

  update internal.factory_workflow_executions workflow
  set lifecycle_status = next_state, generation = workflow.generation + 1, ownership_token = gen_random_uuid()
  where workflow.root_session_id = p_root_session_id returning * into execution;

  if p_action = 'resume' then
    for resume_input in select value from jsonb_array_elements(pause_receipt->'retired')
      where value->'restartRequired' = 'true'::jsonb
    loop
      select session.* into owner from public.sessions session
      where (session.id::text, session.workspace_id, session.factory_id, session.current_stage_id::text,
        session.current_artifact_version) = (resume_input->>'sessionId', p_workspace_id, p_factory_id,
        resume_input->>'stageId', (resume_input->>'artifactVersion')::integer)
        and session.id = any(member_ids) and session.archived_at is null
        and session.current_artifact_id::text is not distinct from resume_input->>'artifactId'
        and session.phase_status in ('in_progress', 'rejected', 'awaiting_review');
      if not found or not internal.session_execution_admissible(owner.id, owner.workspace_id) then continue; end if;

      if owner.id <> p_root_session_id then
        select marker.parent_session_id into parent_id from internal.factory_workflow_delegations marker
        where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.child_session_id) =
          (p_root_session_id, p_workspace_id, p_factory_id, owner.id);
        if not found or not internal.recheck_factory_workflow_delegation_lineage(
          p_root_session_id, p_workspace_id, p_factory_id, parent_id
        ) then continue; end if;
      end if;
      perform internal.recheck_session_execution_grant(owner);

      -- The job already owns the exact feedback, retry origin, and Git
      -- input. The queue assigns a fresh attempt and run on its next claim.
      update public.agent_jobs job
      set status = 'queued', finished_at = null, scheduled_at = null, started_at = null, last_error = null,
        claimed_worker_runtime = null, git_continuity_release_revision = null
      where (job.id::text, job.workspace_id, job.session_id, job.stage_id, job.attempt_count) =
        (resume_input#>>'{jobs,0,jobId}', owner.workspace_id, owner.id, owner.current_stage_id,
          (resume_input#>>'{jobs,0,attemptCount}')::integer)
        and job.status = 'canceled'
      returning job.id, job.attempt_count + 1 as next_attempt into restart;
      if found then
        if execution.workflow_json::jsonb ? 'delegationPolicy'
          and not internal.reserve_factory_workflow_attempt(execution, owner.id, restart.id, restart.next_attempt) then
          raise exception 'The workflow budget cannot restart the paused attempt.' using errcode = 'PT409';
        end if;
        resumed := resumed || jsonb_build_array(jsonb_build_object(
          'sessionId', owner.id, 'jobId', restart.id, 'attemptCount', restart.next_attempt));
      end if;
    end loop;
  else
    for owner in select session.* from public.sessions session
      where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
        and session.id = any(member_ids)
        and exists (select 1 from public.agent_jobs job
          where (job.session_id, job.workspace_id) = (session.id, session.workspace_id)
            and (job.status in ('started', 'running') or (job.status = 'queued' and (
              p_action = 'cancel' or internal.is_factory_workflow_join_job(job.id)))))
      order by session.id <> p_root_session_id, session.id
    loop
      select * into strict retirement from public.cancel_session_job_attempts(owner.id, owner.workspace_id,
        case p_action when 'pause' then 'Workflow paused.' else 'Workflow canceled.' end,
        null, p_action = 'cancel');
      if cardinality(retirement.job_ids) > 0 then
        perform internal.park_factory_workflow_join_review(retirement.job_ids);
        retired := retired || jsonb_build_array(jsonb_build_object(
          'sessionId', owner.id, 'jobIds', retirement.job_ids, 'runIds', retirement.run_ids,
          'jobs', (select jsonb_agg(jsonb_build_object('jobId', job.id, 'attemptCount', job.attempt_count) order by job.id)
            from public.agent_jobs job where job.id = any(retirement.job_ids)),
          'stageId', owner.current_stage_id, 'artifactId', owner.current_artifact_id,
          'artifactVersion', owner.current_artifact_version,
          'restartRequired', p_action = 'pause' and owner.archived_at is null
            and not exists (select 1 from unnest(retirement.job_ids) exact(id)
              where internal.is_factory_workflow_join_job(exact.id))
            and owner.phase_status in ('in_progress', 'rejected', 'awaiting_review')
            and not exists (select 1 from public.agent_runs run
              where run.id = any(retirement.run_ids) and run.status = 'success')
        ));
      end if;
    end loop;
  end if;

  receipt := jsonb_build_object('requestId', p_request_id, 'action', p_action,
    'generation', execution.generation, 'lifecycleStatus', execution.lifecycle_status, 'retired', retired, 'resumed', resumed);
  insert into internal.factory_workflow_lifecycle_commands(root_session_id, request_id, expected_generation, action, applied_generation, receipt)
  values (p_root_session_id, p_request_id, p_expected_generation, p_action, execution.generation, receipt);
  return receipt;
end;
$$;

-- Apply after the OP652 native draft. The table has one immutable ingress per
-- occurrence; a graph loop has fresh occurrence ids. An admitted join stops the
-- ancestry walk, including when it has no adopted output.
create function internal.factory_workflow_occurrence_join_checkpoint(
  p_root_session_id uuid,
  p_occurrence_id uuid
) returns table(join_occurrence_id uuid, parent_session_id uuid, checkpoint_run_id uuid)
language sql stable set search_path='' as $$
  with recursive ancestors(occurrence_id, node_kind, depth) as (
    select current.occurrence_id, current.node_kind, 0
    from internal.factory_workflow_node_occurrences current
    where (current.root_session_id, current.occurrence_id) = (p_root_session_id, p_occurrence_id)
    union all
    select predecessor.occurrence_id, predecessor.node_kind, ancestors.depth + 1
    from ancestors
    join internal.factory_workflow_transition_receipts receipt
      on (receipt.root_session_id, receipt.target_occurrence_id) = (p_root_session_id, ancestors.occurrence_id)
    join internal.factory_workflow_node_occurrences predecessor
      on (predecessor.root_session_id, predecessor.occurrence_id) = (receipt.root_session_id, receipt.source_occurrence_id)
    where ancestors.node_kind <> 'join' and ancestors.depth < 1024
  )
  select boundary.occurrence_id, manifest.parent_session_id,
    case when terminal.outcome = 'adopted' and result.outcome = 'succeeded'
      and result.evidence_ref = 'join-checkpoint:' || terminal.checkpoint_run_id::text
    then terminal.checkpoint_run_id end
  from ancestors boundary
  left join internal.factory_workflow_joins manifest
    on (manifest.root_session_id, manifest.join_occurrence_id) = (p_root_session_id, boundary.occurrence_id)
  left join internal.factory_workflow_join_outcomes terminal
    on (terminal.root_session_id, terminal.join_id) = (manifest.root_session_id, manifest.join_id)
  left join internal.factory_workflow_node_results result
    on (result.root_session_id, result.occurrence_id) = (p_root_session_id, boundary.occurrence_id)
  where boundary.node_kind = 'join'
  order by boundary.depth
  limit 1;
$$;
revoke all on function internal.factory_workflow_occurrence_join_checkpoint(uuid,uuid)
  from public, anon, authenticated, service_role;

create function internal.factory_workflow_causal_command_checkpoint(
  p_execution internal.factory_workflow_executions,p_occurrence_id uuid
) returns public.session_git_checkpoints language plpgsql set search_path='' as $$
declare source record; parent public.sessions; pinned public.session_factory_admission_inputs; accepted public.session_git_checkpoints;
begin
  select * into source from internal.factory_workflow_occurrence_join_checkpoint(p_execution.root_session_id,p_occurrence_id);
  if not found then return internal.factory_workflow_input_checkpoint(p_execution); end if;
  if source.checkpoint_run_id is null then return null; end if;
  select * into parent from public.sessions where (id,workspace_id,factory_id) =
    (source.parent_session_id,p_execution.workspace_id,p_execution.factory_id)
    and execute_pinned_definition and execution_purpose='production';
  if not found or not internal.recheck_factory_workflow_delegation_lineage(p_execution.root_session_id,
    p_execution.workspace_id,p_execution.factory_id,parent.id) then return null; end if;
  select * into pinned from public.session_factory_admission_inputs where (session_id,workspace_id,factory_id,definition_revision_id) =
    (parent.id,p_execution.workspace_id,p_execution.factory_id,parent.factory_definition_revision_id);
  if not found then return null; end if;
  perform 1 from public.session_git_heads head where (head.session_id,head.workspace_id,head.checkpoint_run_id) =
    (parent.id,p_execution.workspace_id,source.checkpoint_run_id) for share;
  if not found then return null; end if;
  accepted:=internal.factory_workflow_adopted_checkpoint(parent.id,p_execution.workspace_id,p_execution.factory_id,
    pinned.definition_revision_id,pinned.definition_digest,source.checkpoint_run_id);
  return accepted;
end;
$$;

create function internal.factory_workflow_occurrence_evidence_is_current(
  p_execution internal.factory_workflow_executions,p_occurrence_id uuid,p_command jsonb,p_evidence_ref text
) returns boolean language plpgsql set search_path='' as $$
declare
  source record;
  checkpoint public.session_git_checkpoints;
  parent public.sessions;
  evidence_id uuid;
  command_kind text:=case when p_command->>'kind'='human-gate' then 'human-gate'
    when p_command->>'kind'='deterministic' then p_command->>'operation' end;
begin
  if command_kind='policy' then
    return internal.factory_workflow_command_evidence_is_current(p_execution,p_command,p_evidence_ref);
  end if;
  select * into source from internal.factory_workflow_occurrence_join_checkpoint(p_execution.root_session_id,p_occurrence_id);
  if not found then
    return internal.factory_workflow_command_evidence_is_current(p_execution,p_command,p_evidence_ref);
  end if;
  if source.checkpoint_run_id is null or command_kind is null or p_evidence_ref is null
    or split_part(p_evidence_ref,':',1)<>command_kind
    or p_evidence_ref collate "C" !~ '^[a-z-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return false; end if;
  evidence_id:=split_part(p_evidence_ref,':',2)::uuid;
  checkpoint:=internal.factory_workflow_causal_command_checkpoint(p_execution,p_occurrence_id);
  if checkpoint.run_id is null then return false; end if;
  select * into strict parent from public.sessions where (id,workspace_id,factory_id)=
    (checkpoint.session_id,p_execution.workspace_id,p_execution.factory_id);
  case command_kind
    when 'checkpoint' then return checkpoint.run_id=evidence_id;
    when 'validation' then return checkpoint.run_id=evidence_id and internal.factory_workflow_validation_passes(parent,checkpoint);
    when 'human-gate' then return internal.factory_workflow_human_approval_passes(parent,checkpoint,p_command,evidence_id);
    else return false;
  end case;
end;
$$;

create function public.read_factory_workflow_command_source(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_occurrence_id uuid
) returns table(session_id uuid,run_id uuid) language plpgsql security definer set search_path='' as $$
declare execution internal.factory_workflow_executions; checkpoint public.session_git_checkpoints;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.lock_factory_workflow_root(p_root_session_id,p_workspace_id,p_factory_id);
  select * into execution from internal.factory_workflow_executions
  where (root_session_id,workspace_id,factory_id)=(p_root_session_id,p_workspace_id,p_factory_id)
    and lifecycle_status='running' for no key update;
  if not found or not exists(select 1 from internal.factory_workflow_node_occurrences occurrence
    where (occurrence.root_session_id,occurrence.occurrence_id)=(p_root_session_id,p_occurrence_id)) then return; end if;
  checkpoint:=internal.factory_workflow_causal_command_checkpoint(execution,p_occurrence_id);
  if checkpoint.run_id is not null then return query select checkpoint.session_id,checkpoint.run_id; end if;
end;
$$;
revoke all on function internal.factory_workflow_causal_command_checkpoint(internal.factory_workflow_executions,uuid),
  internal.factory_workflow_occurrence_evidence_is_current(internal.factory_workflow_executions,uuid,jsonb,text),
  public.read_factory_workflow_command_source(uuid,uuid,uuid,uuid)
from public,anon,authenticated,service_role;
grant execute on function public.read_factory_workflow_command_source(uuid,uuid,uuid,uuid) to service_role;
create or replace function public.record_factory_workflow_command_result(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_occurrence_id uuid, p_evidence_ref text
) returns table (result_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  command jsonb;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.graph_revision_id is null then return; end if;
  command := internal.factory_workflow_occurrence_command(execution, p_occurrence_id);
  if command is null then return; end if;
  if not exists (select 1 from internal.factory_workflow_node_results result
      where (result.root_session_id, result.occurrence_id) = (p_root_session_id, p_occurrence_id))
    and not internal.factory_workflow_occurrence_evidence_is_current(execution, p_occurrence_id, command, p_evidence_ref) then
    return;
  end if;
  return query select * from internal.insert_factory_workflow_node_result(execution, p_occurrence_id, 'succeeded', p_evidence_ref);
end;
$$;

create or replace function public.admit_factory_workflow_next(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_source_occurrence_id uuid, p_edge_id text, p_expected_result_id uuid
) returns table (transition_id uuid, target_occurrence_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  source_node_id text;
  source_node_kind internal.factory_workflow_node_kind;
  evidence_ref text;
  completion_ref text;
  joined public.session_git_checkpoints;
  command jsonb;
  target_node jsonb;
  edge jsonb;
  target_id uuid;
  receipt internal.factory_workflow_transition_receipts;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select occurrence.node_id, occurrence.node_kind, result.evidence_ref
    into source_node_id, source_node_kind, evidence_ref
    from internal.factory_workflow_node_occurrences occurrence
    join internal.factory_workflow_node_results result
      on (result.root_session_id, result.occurrence_id) = (occurrence.root_session_id, occurrence.occurrence_id)
   where (occurrence.root_session_id, occurrence.occurrence_id, result.result_id) =
     (p_root_session_id, p_source_occurrence_id, p_expected_result_id)
     and result.outcome = 'succeeded';
  if not found then
    raise exception 'The expected successful predecessor result is unavailable.' using errcode = 'PT409';
  end if;

  if execution.graph_revision_id is not null and source_node_kind = 'route' then
    raise exception 'This workflow node requires a guarded route decision.' using errcode = '42501';
  end if;

  select candidate into edge
    from jsonb_array_elements(execution.workflow_json::jsonb->'edges') candidate
   where candidate->>'from' = source_node_id and candidate->>'id' = p_edge_id and candidate->>'kind' = 'next';
  if not found then
    raise exception 'The workflow has no matching next edge.' using errcode = '22023';
  end if;

  select transition.* into receipt from internal.factory_workflow_transition_receipts transition
   where (transition.root_session_id, transition.source_occurrence_id, transition.edge_id) =
     (p_root_session_id, p_source_occurrence_id, p_edge_id);
  if found then
    return query select receipt.transition_id, receipt.target_occurrence_id, false;
    return;
  end if;

  if execution.graph_revision_id is not null and exists (
    select 1 from public.sessions root where root.id = p_root_session_id
      and root.archived_at is not null and root.phase_status <> 'approved'
  ) then return; end if;

  if execution.graph_revision_id is not null and source_node_kind in ('deterministic', 'human-gate') then
    command := internal.factory_workflow_occurrence_command(execution, p_source_occurrence_id);
    if not internal.factory_workflow_occurrence_evidence_is_current(execution, p_source_occurrence_id, command, evidence_ref) then
      return;
    end if;
    if command->>'operation' is distinct from 'policy'
      and internal.refresh_session_execution_exhaustion(p_root_session_id, p_workspace_id) is not null then
      return;
    end if;
  elsif execution.graph_revision_id is not null and source_node_kind = 'join' then
    joined := internal.factory_workflow_causal_command_checkpoint(execution,p_source_occurrence_id);
    if joined.run_id is null or evidence_ref is distinct from 'join-checkpoint:' || joined.run_id::text
      then return; end if;
  elsif execution.graph_revision_id is not null and source_node_kind = 'agent' then
    select internal.factory_workflow_delegated_completion_ref(marker) into completion_ref
    from internal.factory_workflow_delegations marker
    where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.target_occurrence_id) =
      (p_root_session_id, p_workspace_id, p_factory_id, p_source_occurrence_id);
    if completion_ref is null or completion_ref is distinct from evidence_ref then return; end if;
  end if;

  perform internal.assert_factory_workflow_route_capacity(execution, edge);
  select node into strict target_node
    from jsonb_array_elements(execution.workflow_json::jsonb->'nodes') node
   where node->>'id' = edge->>'to';
  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  values (p_root_session_id, target_node->>'id', (target_node->>'kind')::internal.factory_workflow_node_kind, p_expected_generation)
  returning occurrence_id into target_id;
  insert into internal.factory_workflow_transition_receipts(
    root_session_id, source_occurrence_id, source_result_id, target_occurrence_id, edge_id, edge_kind, recorded_generation
  ) values (p_root_session_id, p_source_occurrence_id, p_expected_result_id, target_id, p_edge_id, 'next', p_expected_generation)
  returning * into receipt;
  return query select receipt.transition_id, receipt.target_occurrence_id, true;
end;
$$;

create function internal.factory_workflow_join_attempt_is_unexpired(p_run_id uuid)
returns boolean language sql volatile set search_path='' as $$
  select exists (select 1 from internal.factory_workflow_join_attempts bound
    where bound.run_id=p_run_id and clock_timestamp()<bound.deadline_at)
$$;
revoke all on function internal.factory_workflow_join_attempt_is_unexpired(uuid)
  from public,anon,authenticated,service_role;

-- Lock order matches the shared dispatch and lifecycle commands.
create function internal.lock_active_factory_workflow_join_attempt(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_expected_generation bigint,
  p_ownership_token uuid,p_join_id uuid,p_job_id uuid,p_run_id uuid,p_attempt_count integer
) returns boolean language plpgsql set search_path='' as $$
declare
  release_revision bigint;
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  marker internal.factory_workflow_join_jobs;
begin
  select control.revision into release_revision from internal.git_continuity_release_control control
  where control.singleton and control.enabled for share;
  if not found then return false; end if;
  execution:=internal.lock_factory_workflow_owner(p_root_session_id,p_workspace_id,p_factory_id,
    p_expected_generation,p_ownership_token);
  if execution.lifecycle_status<>'running' then return false; end if;
  select sealed.* into manifest from internal.factory_workflow_joins sealed
  join internal.factory_workflow_join_attempts attempt using(root_session_id,join_id)
  where (sealed.root_session_id,sealed.workspace_id,sealed.factory_id,sealed.join_id,
    sealed.expected_generation,attempt.job_id,attempt.run_id,attempt.attempt_count)=
    (p_root_session_id,p_workspace_id,p_factory_id,p_join_id,p_expected_generation,p_job_id,p_run_id,p_attempt_count);
  if not found then return false; end if;
  select captured.* into marker from internal.factory_workflow_join_jobs captured
  where (captured.root_session_id,captured.workspace_id,captured.factory_id,captured.join_id,
    captured.expected_generation,captured.parent_session_id,captured.job_id)=
    (p_root_session_id,p_workspace_id,p_factory_id,p_join_id,p_expected_generation,manifest.parent_session_id,p_job_id);
  if not found or not internal.factory_workflow_join_head_is_current(manifest)
    or not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id,p_workspace_id,p_factory_id,manifest.parent_session_id)
    or exists (select 1 from internal.factory_workflow_join_outcomes outcome
      where (outcome.root_session_id,outcome.join_id)=(p_root_session_id,p_join_id))
  then return false; end if;
  perform 1 from public.sessions parent
  where (parent.id,parent.workspace_id,parent.factory_id,parent.current_stage_id,
    parent.current_artifact_id,parent.current_artifact_version)=
    (marker.parent_session_id,p_workspace_id,p_factory_id,marker.stage_id,marker.artifact_id,marker.artifact_version)
    and parent.archived_at is null and parent.phase_status='in_progress' for no key update;
  if not found then return false; end if;
  perform 1 from public.agent_jobs job where (job.id,job.workspace_id,job.session_id,
    job.stage_id,job.attempt_count,job.git_continuity_release_revision)=
    (p_job_id,p_workspace_id,marker.parent_session_id,marker.stage_id,p_attempt_count,release_revision)
    and job.status in ('started','running') for update;
  if not found then return false; end if;
  perform 1 from public.agent_runs run where (run.id,run.workspace_id,run.session_id,
    run.agent_job_id,run.attempt_count)=
    (p_run_id,p_workspace_id,marker.parent_session_id,p_job_id,p_attempt_count)
    and run.status in ('started','running') for update;
  -- The attempt may reach its deadline while waiting for these locks.
  return found and internal.factory_workflow_join_attempt_is_unexpired(p_run_id);
end;
$$;

create function public.is_factory_workflow_join_attempt_active(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_expected_generation bigint,
  p_ownership_token uuid,p_join_id uuid,p_job_id uuid,p_run_id uuid,p_attempt_count integer
) returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return internal.lock_active_factory_workflow_join_attempt(p_root_session_id,p_workspace_id,p_factory_id,
    p_expected_generation,p_ownership_token,p_join_id,p_job_id,p_run_id,p_attempt_count);
end;
$$;

create function public.record_active_factory_workflow_join_candidate(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_expected_generation bigint,
  p_ownership_token uuid,p_join_id uuid,p_job_id uuid,p_run_id uuid,p_attempt_count integer,
  p_commit_sha text,p_tree_sha text,p_bundle_sha256 text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare recorded boolean;
begin
  perform internal.assert_checkpoint_publication_service();
  if not internal.lock_active_factory_workflow_join_attempt(p_root_session_id,p_workspace_id,p_factory_id,
    p_expected_generation,p_ownership_token,p_join_id,p_job_id,p_run_id,p_attempt_count)
    then return false; end if;
  recorded:=public.record_factory_workflow_join_candidate(p_root_session_id,p_workspace_id,p_factory_id,
    p_expected_generation,p_ownership_token,p_join_id,p_run_id,p_commit_sha,p_tree_sha,p_bundle_sha256);
  if not internal.factory_workflow_join_attempt_is_unexpired(p_run_id) then
    raise exception 'Workflow join deadline elapsed before recording the candidate.' using errcode='57014';
  end if;
  return recorded;
end;
$$;

create function internal.factory_workflow_join_conflict_path(
  p_workspace_id uuid,p_root_session_id uuid,p_join_id uuid,p_run_id uuid,p_digest text
) returns text language sql immutable strict set search_path='' as $$
  select concat_ws('/',p_workspace_id,p_root_session_id,p_join_id,p_run_id,p_digest||'.json')
$$;

alter table public.workspace_resource_operations drop constraint workspace_resource_operations_storage_bucket_check;
alter table public.workspace_resource_operations add constraint workspace_resource_operations_storage_bucket_check
  check(storage_bucket in ('workspace-avatars','session-attachments','session-source-checkpoints',
    'session-validation-evidence','factory-workflow-join-conflicts'));
create unique index workspace_resource_operations_join_conflict_path_idx
  on public.workspace_resource_operations(workspace_id,resource_id)
  where kind='upload' and storage_bucket='factory-workflow-join-conflicts';

create function public.reserve_factory_workflow_join_conflict(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_expected_generation bigint,
  p_ownership_token uuid,p_join_id uuid,p_job_id uuid,p_run_id uuid,p_attempt_count integer,p_digest text
) returns uuid language plpgsql security definer set search_path='' as $$
declare path text; reservation public.workspace_resource_operations;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_digest is null or p_digest collate "C" !~ '^[0-9a-f]{64}$' then return null; end if;
  if not internal.lock_active_factory_workflow_join_attempt(p_root_session_id,p_workspace_id,p_factory_id,
    p_expected_generation,p_ownership_token,p_join_id,p_job_id,p_run_id,p_attempt_count)
    or exists (select 1 from internal.factory_workflow_join_candidates candidate
      where (candidate.root_session_id,candidate.join_id)=(p_root_session_id,p_join_id)) then return null; end if;
  path:=internal.factory_workflow_join_conflict_path(p_workspace_id,p_root_session_id,p_join_id,p_run_id,p_digest);
  select operation.* into reservation from public.workspace_resource_operations operation
  where (operation.workspace_id,operation.kind,operation.storage_bucket,operation.resource_id)
    =(p_workspace_id,'upload','factory-workflow-join-conflicts',path) for update;
  if not internal.factory_workflow_join_attempt_is_unexpired(p_run_id) then return null; end if;
  if found then
    if reservation.settled_at is not null or reservation.recovery_after<=clock_timestamp() then return null; end if;
    return reservation.id;
  end if;
  -- The active attempt already holds the workspace admission fence. Avoid
  -- upgrading that shared lock via the generic sandbox reservation path.
  insert into public.workspace_resource_operations(workspace_id,kind,storage_bucket,resource_id,recovery_after)
  values (p_workspace_id,'upload','factory-workflow-join-conflicts',path,clock_timestamp()+interval '5 minutes')
  returning id into reservation.id;
  if not internal.factory_workflow_join_attempt_is_unexpired(p_run_id) then
    raise exception 'Workflow join deadline elapsed before reserving the conflict report.' using errcode='57014';
  end if;
  return reservation.id;
end;
$$;

-- Once orphan cleanup begins, no active worker can reuse this exact run path.
-- Two delayed cleanup requests may remove the same orphan independently.
create function public.claim_factory_workflow_join_conflict_cleanup(
  p_workspace_id uuid,p_operation_id uuid,p_path text
) returns boolean language plpgsql security definer set search_path='' as $$
declare deleting_at timestamptz; reservation public.workspace_resource_operations; owner_run uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  select workspace.deletion_requested_at into deleting_at from public.workspaces workspace
  where workspace.id=p_workspace_id for share;
  if not found then return false; end if;
  select operation.* into reservation from public.workspace_resource_operations operation
  where (operation.id,operation.workspace_id,operation.kind,operation.storage_bucket,operation.resource_id)
    =(p_operation_id,p_workspace_id,'upload','factory-workflow-join-conflicts',p_path)
    and (operation.settled_at is not null or operation.recovery_after<=clock_timestamp())
  for update;
  if not found then return false; end if;
  if p_path collate "C" ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/){4}[0-9a-f]{64}[.]json$' then
    owner_run:=split_part(p_path,'/',4)::uuid;
  end if;
  if deleting_at is null and exists (
    select 1 from public.agent_runs run
    where (run.id,run.workspace_id)=(owner_run,p_workspace_id)
      and run.status in ('queued','started','running')
  ) then return false; end if;
  update public.workspace_resource_operations set settled_at=coalesce(settled_at,clock_timestamp())
  where id=reservation.id;
  return true;
end;
$$;

create function internal.guard_factory_workflow_join_conflict_object()
returns trigger language plpgsql security definer set search_path='' as $$
declare scoped_workspace uuid; upload public.workspace_resource_operations;
begin
  -- Each exact report has a single write. Storage retries use upsert=false.
  if tg_op<>'INSERT' then
    raise exception 'Join conflict reports are immutable.' using errcode='23514';
  end if;
  if new.name collate "C" !~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/){4}[0-9a-f]{64}[.]json$' then
    raise exception 'Join conflict scope is invalid.' using errcode='23514';
  end if;
  scoped_workspace:=split_part(new.name,'/',1)::uuid;
  perform internal.assert_workspace_accepts_work(scoped_workspace);
  select operation.* into upload from public.workspace_resource_operations operation
  where (operation.workspace_id,operation.kind,operation.storage_bucket,operation.resource_id)=
    (scoped_workspace,'upload',new.bucket_id,new.name) for update;
  if not found or upload.settled_at is not null or upload.recovery_after<=clock_timestamp()
    or not internal.factory_workflow_join_attempt_is_unexpired(split_part(new.name,'/',4)::uuid) then
    raise exception 'Join conflict upload reservation is not active.' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger factory_workflow_join_conflict_object_create
  before insert on storage.objects for each row
  when (new.bucket_id='factory-workflow-join-conflicts')
  execute function internal.guard_factory_workflow_join_conflict_object();
create trigger factory_workflow_join_conflict_object_update
  before update on storage.objects for each row
  when (old.bucket_id='factory-workflow-join-conflicts' or new.bucket_id='factory-workflow-join-conflicts')
  execute function internal.guard_factory_workflow_join_conflict_object();

-- The caller supplies scope only. The digest is read from the immutable receipt.
-- Storage itself remains service-only.
create function public.read_factory_workflow_join_conflict_digest(
  p_workspace_id uuid,p_root_session_id uuid,p_join_id uuid,p_run_id uuid
) returns text language sql stable security definer set search_path='' as $$
  select outcome.detail->>'reportSha256'
  from internal.factory_workflow_joins manifest
  join internal.factory_workflow_join_attempts attempt using(root_session_id,join_id)
  join internal.factory_workflow_join_outcomes outcome using(root_session_id,join_id)
  join public.workspaces workspace on workspace.id=manifest.workspace_id
  where (manifest.workspace_id,manifest.root_session_id,manifest.join_id,attempt.run_id,outcome.outcome)=
    (p_workspace_id,p_root_session_id,p_join_id,p_run_id,'conflict')
    and workspace.deletion_requested_at is null
    and auth.role()='authenticated' and auth.uid() is not null
    and internal.can_access_session(manifest.root_session_id)
    and internal.can_access_session(manifest.parent_session_id);
$$;

revoke all on function internal.lock_active_factory_workflow_join_attempt(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer),
  internal.factory_workflow_join_conflict_path(uuid,uuid,uuid,uuid,text),
  internal.guard_factory_workflow_join_conflict_object()
from public,anon,authenticated,service_role;
revoke all on function public.is_factory_workflow_join_attempt_active(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer),
  public.record_active_factory_workflow_join_candidate(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer,text,text,text),
  public.reserve_factory_workflow_join_conflict(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer,text),
  public.read_factory_workflow_join_conflict_digest(uuid,uuid,uuid,uuid),
  public.claim_factory_workflow_join_conflict_cleanup(uuid,uuid,text)
from public,anon,authenticated,service_role;
grant execute on function public.is_factory_workflow_join_attempt_active(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer),
  public.record_active_factory_workflow_join_candidate(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer,text,text,text),
  public.reserve_factory_workflow_join_conflict(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer,text),
  public.claim_factory_workflow_join_conflict_cleanup(uuid,uuid,text)
to service_role;
grant execute on function public.read_factory_workflow_join_conflict_digest(uuid,uuid,uuid,uuid)
to authenticated;
revoke execute on function public.record_factory_workflow_join_candidate(uuid,uuid,uuid,bigint,uuid,uuid,uuid,text,text,text),
  public.record_factory_workflow_join_blocker(uuid,uuid,uuid,bigint,uuid,uuid,uuid,text,jsonb),
  public.bind_factory_workflow_join_attempt(uuid,uuid,uuid,bigint,uuid,uuid,uuid,integer,uuid,timestamptz),
  public.open_factory_workflow_join(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,uuid[])
from service_role;

-- Add the scoped bucket before the settlement RPC refers to its receipt.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('factory-workflow-join-conflicts','factory-workflow-join-conflicts',false,16384,array['application/json']);

create function public.settle_factory_workflow_join_blocker(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid,
  p_expected_generation bigint, p_ownership_token uuid, p_join_id uuid,
  p_job_id uuid, p_run_id uuid, p_attempt_count integer, p_outcome text, p_detail jsonb
) returns text language plpgsql security definer set search_path='' as $$
declare
  owner internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  marker internal.factory_workflow_join_jobs;
  previous internal.factory_workflow_join_outcomes;
  parent public.sessions;
  exact_job public.agent_jobs;
  exact_run public.agent_runs;
  candidate internal.factory_workflow_join_candidates;
  failed text;
  conflict_path text;
  reservation public.workspace_resource_operations;
begin
  perform internal.assert_checkpoint_publication_service();
  perform 1 from internal.git_continuity_release_control where singleton for share;
  owner:=internal.lock_factory_workflow_owner(p_root_session_id,p_workspace_id,p_factory_id,
    p_expected_generation,p_ownership_token);
  if p_outcome is null or p_outcome not in ('conflict','validation_failed')
    or jsonb_typeof(p_detail) is distinct from 'object' or octet_length(p_detail::text)>8192 then
    raise exception 'An exact bounded join blocker is required.' using errcode='22023';
  end if;

  select recorded.* into manifest from internal.factory_workflow_joins recorded
  join internal.factory_workflow_join_attempts bound using (root_session_id,join_id)
  where (recorded.root_session_id,recorded.workspace_id,recorded.factory_id,recorded.join_id,
    bound.job_id,bound.run_id,bound.attempt_count)=(p_root_session_id,p_workspace_id,p_factory_id,p_join_id,
      p_job_id,p_run_id,p_attempt_count);
  if not found then return 'stale'; end if;
  select marked.* into marker from internal.factory_workflow_join_jobs marked
  where (marked.job_id,marked.root_session_id,marked.join_id,marked.expected_generation,
    marked.parent_session_id,marked.workspace_id,marked.factory_id)=(p_job_id,p_root_session_id,p_join_id,
      owner.generation,manifest.parent_session_id,p_workspace_id,p_factory_id);
  if not found then return 'stale'; end if;
  select receipt.* into previous from internal.factory_workflow_join_outcomes receipt
  where (receipt.root_session_id,receipt.join_id)=(p_root_session_id,p_join_id);
  if found then
    if (previous.outcome,previous.detail) is distinct from (p_outcome,p_detail) then
      raise exception 'The join already has a different terminal receipt.' using errcode='PT409';
    end if;
    return 'blocked';
  end if;
  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id,p_workspace_id,p_factory_id,manifest.parent_session_id)
    or not internal.factory_workflow_join_head_is_current(manifest) then return 'stale'; end if;

  if not internal.lock_active_factory_workflow_join_attempt(p_root_session_id,p_workspace_id,p_factory_id,
    p_expected_generation,p_ownership_token,p_join_id,p_job_id,p_run_id,p_attempt_count)
    then return 'stale'; end if;

  select captured.* into parent from public.sessions captured
  where (captured.id,captured.workspace_id,captured.factory_id,captured.current_stage_id,
    captured.current_artifact_id,captured.current_artifact_version)=(marker.parent_session_id,p_workspace_id,p_factory_id,
      marker.stage_id,marker.artifact_id,marker.artifact_version)
    and captured.archived_at is null and captured.phase_status='in_progress' for no key update;
  if not found then return 'stale'; end if;
  select captured.* into exact_job from public.agent_jobs captured
  where (captured.id,captured.workspace_id,captured.session_id,captured.stage_id,captured.attempt_count)=
    (p_job_id,p_workspace_id,parent.id,marker.stage_id,p_attempt_count)
    and captured.status in ('started','running') for update;
  if not found then return 'stale'; end if;
  select captured.* into exact_run from public.agent_runs captured
  where (captured.id,captured.workspace_id,captured.session_id,captured.agent_job_id,captured.attempt_count)=
    (p_run_id,p_workspace_id,parent.id,p_job_id,p_attempt_count)
    and captured.status in ('started','running') for update;
  if not found then return 'stale'; end if;
  -- Once prepared, the frozen publication and its timeout belong to recovery.
  if exists (select 1 from public.session_checkpoint_publications publication
    where (publication.run_id,publication.job_id,publication.attempt_count)=(p_run_id,p_job_id,p_attempt_count)) then
    return 'stale';
  end if;

  if p_outcome='conflict' then
    if p_detail-array['reportSha256','paths','pathsTruncated'] <> '{}'::jsonb
      or jsonb_typeof(p_detail->'reportSha256') is distinct from 'string'
      or p_detail->>'reportSha256' collate "C" !~ '^[0-9a-f]{64}$'
      or jsonb_typeof(p_detail->'paths') is distinct from 'array'
      or jsonb_typeof(p_detail->'pathsTruncated') is distinct from 'boolean' then
      raise exception 'A bounded conflict receipt is required.' using errcode='22023';
    end if;
    if jsonb_array_length(p_detail->'paths')>32 or
      (jsonb_array_length(p_detail->'paths')=0 and p_detail->'pathsTruncated'='false'::jsonb)
      or exists (select 1 from jsonb_array_elements(p_detail->'paths') path
        where jsonb_typeof(path) is distinct from 'string'
          or octet_length(path#>>'{}') not between 1 and 512
          or path#>>'{}' collate "C" !~ '^[^/[:cntrl:]][^[:cntrl:]]*$'
          or path#>>'{}' collate "C" ~ '(^|/)\.\.(/|$)') then
      raise exception 'A bounded conflict path list is required.' using errcode='22023';
    end if;
    if exists (select 1 from internal.factory_workflow_join_candidates row
      where (row.root_session_id,row.join_id)=(p_root_session_id,p_join_id)) then return 'stale'; end if;
    -- A cleanup claimant obtains this same reservation lock before Storage IO.
    conflict_path:=internal.factory_workflow_join_conflict_path(p_workspace_id,p_root_session_id,
      p_join_id,p_run_id,p_detail->>'reportSha256');
    select operation.* into reservation from public.workspace_resource_operations operation
    where (operation.workspace_id,operation.kind,operation.storage_bucket,operation.resource_id)=
      (p_workspace_id,'upload','factory-workflow-join-conflicts',conflict_path)
    for update;
    if not found or reservation.settled_at is not null or reservation.recovery_after<=clock_timestamp()
      then return 'unproved'; end if;
    perform 1 from storage.objects object join storage.buckets bucket on bucket.id=object.bucket_id
    where object.bucket_id='factory-workflow-join-conflicts' and not bucket.public
      and object.name=conflict_path and object.metadata->>'mimetype'='application/json';
    if not found then return 'unproved'; end if;
  else
    select stored.* into candidate from internal.factory_workflow_join_candidates stored
    where (stored.root_session_id,stored.join_id)=(p_root_session_id,p_join_id);
    if p_detail<>'{}'::jsonb or candidate.join_id is null
      or not exists (select 1 from public.session_validation_evidence evidence
        where (evidence.run_id,evidence.workspace_id,evidence.session_id,evidence.job_id,evidence.attempt_count,
          evidence.repository_id,evidence.commit_sha,evidence.validation_tree_sha)=
          (p_run_id,p_workspace_id,parent.id,p_job_id,p_attempt_count,manifest.repository_id,candidate.commit_sha,candidate.tree_sha))
      or internal.factory_workflow_join_validation_passes(manifest,
        (select bound from internal.factory_workflow_join_attempts bound where bound.run_id=p_run_id),candidate) then
      return 'unproved';
    end if;
  end if;

  if not internal.factory_workflow_join_attempt_is_unexpired(p_run_id) then return 'stale'; end if;
  failed:=public.fail_session_job_attempt(p_job_id,p_attempt_count,
    case when p_outcome='conflict' then 'Workflow join has conflicting changes.'
      else 'Workflow join required validation did not pass.' end,false,0,p_run_id);
  if failed<>'error' then raise exception 'The exact join attempt could not be retired.' using errcode='PT409'; end if;
  insert into internal.factory_workflow_join_outcomes(root_session_id,join_id,outcome,detail)
  values (p_root_session_id,p_join_id,p_outcome,p_detail);
  if reservation.id is not null then
    perform public.settle_workspace_resource_operation(reservation.id,true);
  end if;
  if not internal.factory_workflow_join_attempt_is_unexpired(p_run_id) then
    raise exception 'Workflow join deadline elapsed before settling the blocker.' using errcode='57014';
  end if;
  return 'blocked';
end;
$$;
revoke all on function public.settle_factory_workflow_join_blocker(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer,text,jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.settle_factory_workflow_join_blocker(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,integer,text,jsonb)
to service_role;

create or replace function public.finish_workspace_deletion(p_workspace_id uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare target public.workspaces%rowtype;
begin
  select * into target from public.workspaces where id = p_workspace_id for update;
  if not found then return true; end if;
  if target.deletion_requested_at is null then return false; end if;
  if exists(select 1 from public.workspace_resource_operations where workspace_id = p_workspace_id)
    or exists(select 1 from public.workspace_sandbox_connection_mutations where workspace_id = p_workspace_id
      and expires_at > now())
    or exists(select 1 from public.agent_jobs where workspace_id = p_workspace_id
      and status in ('queued', 'started', 'running'))
    or exists(select 1 from public.agent_runs where workspace_id = p_workspace_id
      and status in ('queued', 'started', 'running'))
    or exists(select 1 from public.session_source_deliveries where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > now())
    or exists(select 1 from public.session_pr_operations where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > clock_timestamp())
    or exists(select 1 from public.session_checkpoint_cleanup where workspace_id = p_workspace_id
      and status = 'claimed' and lease_expires_at > clock_timestamp())
    or exists(select 1 from storage.objects where bucket_id in (
      'workspace-avatars', 'session-attachments', 'session-source-checkpoints',
      'session-validation-evidence', 'workspace-run-exports', 'factory-workflow-usage-recovery', 'factory-workflow-join-conflicts'
    ) and split_part(name, '/', 1) = p_workspace_id::text) then
    return false;
  end if;
  delete from public.workspaces where id = p_workspace_id;
  return true;
end;
$$;

create function public.enqueue_factory_workflow_join_for_user(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,
  p_expected_generation bigint,p_request_id uuid,p_branch_group_id uuid,p_expected_head_run_id uuid,
  p_selected_outcome_ids uuid[]
) returns jsonb language plpgsql security definer set search_path='' as $$
declare execution internal.factory_workflow_executions;
begin
  perform internal.assert_checkpoint_publication_service();
  perform 1 from internal.git_continuity_release_control where singleton for share;
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  execution:=internal.lock_factory_workflow_generation(p_root_session_id,p_workspace_id,p_factory_id,p_expected_generation);
  return public.enqueue_factory_workflow_join(p_root_session_id,p_workspace_id,p_factory_id,
    p_expected_generation,execution.ownership_token,p_request_id,p_branch_group_id,p_expected_head_run_id,p_selected_outcome_ids);
end;
$$;
revoke all on function public.enqueue_factory_workflow_join_for_user(uuid,uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid[])
from public,anon,authenticated,service_role;
grant execute on function public.enqueue_factory_workflow_join_for_user(uuid,uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid[])
to service_role;

-- A join is a source boundary. A nearer delegated occurrence can establish a
-- new parent, but ancestry never crosses a join that has no adopted output.
create or replace function internal.factory_workflow_branch_source(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_branch_occurrence_id uuid
) returns table(parent_session_id uuid, checkpoint_run_id uuid)
language sql stable set search_path = '' as $$
  with recursive ancestry(occurrence_id, node_kind, depth) as (
    select occurrence.occurrence_id, occurrence.node_kind, 0
    from internal.factory_workflow_node_occurrences occurrence
    where (occurrence.root_session_id, occurrence.occurrence_id) = (p_root_session_id, p_branch_occurrence_id)
    union all
    select previous.occurrence_id, previous.node_kind, ancestry.depth + 1
    from ancestry
    join internal.factory_workflow_transition_receipts transition
      on (transition.root_session_id, transition.target_occurrence_id) = (p_root_session_id, ancestry.occurrence_id)
    join internal.factory_workflow_node_occurrences previous
      on (previous.root_session_id, previous.occurrence_id) = (transition.root_session_id, transition.source_occurrence_id)
    where ancestry.node_kind <> 'join' and ancestry.depth < 1023
  ), nearest_delegate as (
    select marker.child_session_id,
      substring(result.evidence_ref from '^delegated-checkpoint:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')::uuid
        as checkpoint_run_id
    from ancestry join internal.factory_workflow_delegations marker
      on (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.target_occurrence_id) =
        (p_root_session_id, p_workspace_id, p_factory_id, ancestry.occurrence_id)
    left join internal.factory_workflow_node_results result
      on (result.root_session_id, result.occurrence_id, result.outcome) =
        (marker.root_session_id, marker.target_occurrence_id, 'succeeded')
    order by ancestry.depth limit 1
  )
  select case when delegate.child_session_id is not null then delegate.child_session_id
    when joined.join_occurrence_id is not null then joined.parent_session_id else execution.root_session_id end,
    case when delegate.child_session_id is not null then delegate.checkpoint_run_id
      when joined.join_occurrence_id is not null then joined.checkpoint_run_id else execution.graph_input_run_id end
  from internal.factory_workflow_executions execution
  left join nearest_delegate delegate on true
  left join lateral internal.factory_workflow_occurrence_join_checkpoint(p_root_session_id, p_branch_occurrence_id) joined
    on delegate.child_session_id is null
  where (execution.root_session_id, execution.workspace_id, execution.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id)
$$;

-- The root can progress beyond its original triage artifact only through an
-- unbroken chain of adopted joins pinned to that exact scope checkpoint.
create function internal.factory_workflow_root_join_keeps_scope(
  p_binding internal.factory_workflow_triage_bindings, p_saved internal.factory_workflow_accepted_scopes
) returns boolean language plpgsql set search_path = '' as $$
declare
  current_run_id uuid;
  accepted public.session_git_checkpoints;
begin
  if (p_binding.session_id, p_binding.workspace_id, p_binding.factory_id,
    p_binding.graph_revision_id, p_binding.workflow_digest, p_binding.stage_id, p_binding.prompt_revision_id)
    is distinct from (p_saved.session_id, p_saved.workspace_id, p_saved.factory_id,
      p_saved.graph_revision_id, p_saved.workflow_digest, p_saved.stage_id, p_saved.prompt_revision_id)
    then return false; end if;
  select head.checkpoint_run_id into current_run_id
  from internal.factory_workflow_executions execution
  join public.sessions root on (root.id, root.workspace_id, root.factory_id) =
    (execution.root_session_id, execution.workspace_id, execution.factory_id)
  join public.session_git_heads head on (head.session_id, head.workspace_id) = (root.id, root.workspace_id)
  where (execution.root_session_id, execution.workspace_id, execution.factory_id, execution.graph_revision_id,
    execution.workflow_digest, execution.graph_input_run_id) = (p_saved.session_id, p_saved.workspace_id,
    p_saved.factory_id, p_saved.graph_revision_id, p_saved.workflow_digest, p_saved.run_id)
    and (root.factory_definition_revision_id, root.specification_stage_id, root.current_stage_id) =
      (p_binding.definition_revision_id, p_saved.stage_id, p_saved.stage_id)
    and root.execute_pinned_definition and root.execution_purpose = 'production'
    and root.phase_status in ('in_progress', 'awaiting_review', 'approved')
    and (root.archived_at is null or root.phase_status = 'approved')
    and head.checkpoint_run_id <> p_saved.run_id
    and not exists (select 1 from public.session_specification_clarifications clarification
      where (clarification.session_id, clarification.workspace_id, clarification.factory_id, clarification.stage_id) =
        (p_saved.session_id, p_saved.workspace_id, p_saved.factory_id, p_saved.stage_id)
        and clarification.status = 'pending')
    and not exists (select 1 from public.artifact_review_threads thread
      where (thread.session_id, thread.workspace_id) = (p_saved.session_id, p_saved.workspace_id)
        and thread.kind = 'blocking' and thread.status = 'open')
  for share of head;
  if not found then return false; end if;
  accepted := internal.factory_workflow_adopted_checkpoint(p_saved.session_id, p_saved.workspace_id,
    p_saved.factory_id, p_binding.definition_revision_id, p_binding.definition_digest, current_run_id);
  if accepted.run_id is null or accepted.repository_id is distinct from p_saved.repository_id then return false; end if;

  return exists (
    with recursive lineage(run_id, depth) as (
      select current_run_id, 0
      union all
      select manifest.expected_head_run_id, lineage.depth + 1
      from lineage
      join internal.factory_workflow_join_outcomes terminal on (terminal.root_session_id, terminal.checkpoint_run_id) =
        (p_saved.session_id, lineage.run_id) and terminal.outcome = 'adopted'
      join internal.factory_workflow_joins manifest using (root_session_id, join_id)
      join internal.factory_workflow_node_results result
        on (result.root_session_id, result.occurrence_id, result.outcome, result.evidence_ref) =
          (manifest.root_session_id, manifest.join_occurrence_id, 'succeeded', 'join-checkpoint:' || lineage.run_id)
      where (manifest.workspace_id, manifest.factory_id, manifest.parent_session_id,
        manifest.workflow_digest, manifest.repository_id) =
        (p_saved.workspace_id, p_saved.factory_id, p_saved.session_id, p_saved.workflow_digest, p_saved.repository_id)
        and lineage.depth < 1023 and lineage.run_id <> p_saved.run_id
    )
    select 1 from lineage where lineage.run_id = p_saved.run_id
  );
end;
$$;
revoke all on function internal.factory_workflow_root_join_keeps_scope(
  internal.factory_workflow_triage_bindings, internal.factory_workflow_accepted_scopes)
  from public, anon, authenticated, service_role;

create or replace function internal.read_factory_workflow_current_scope_artifact(
  p_binding internal.factory_workflow_triage_bindings, p_saved internal.factory_workflow_accepted_scopes
) returns text language plpgsql set search_path = '' as $$
declare
  observed internal.factory_workflow_accepted_scopes;
  artifact_md text;
begin
  observed := internal.observe_factory_workflow_accepted_scope(p_binding, p_saved.run_id, p_saved.approval_id);
  observed.receipt_id := p_saved.receipt_id;
  observed.recorded_at := p_saved.recorded_at;
  if observed is distinct from p_saved
    and not internal.factory_workflow_root_join_keeps_scope(p_binding, p_saved) then return null; end if;
  select artifact.artifact_json #>> '{}' into artifact_md from public.session_artifacts artifact
  where (artifact.id, artifact.workspace_id, artifact.session_id, artifact.stage_id, artifact.version) =
    (p_saved.artifact_id, p_saved.workspace_id, p_saved.session_id, p_saved.stage_id, p_saved.artifact_version)
    and encode(sha256(convert_to(internal.approved_predecessor_artifact_text(artifact.artifact_json), 'UTF8')), 'hex') =
      p_saved.artifact_digest;
  return artifact_md;
end;
$$;

create or replace function internal.bind_factory_workflow_delegated_scope() returns trigger
language plpgsql set search_path = '' as $$
declare
  binding internal.factory_workflow_triage_bindings;
  receipt internal.factory_workflow_accepted_scopes;
  execution internal.factory_workflow_executions;
  joined record;
begin
  if new.accepted_scope_receipt_id is not null then
    raise exception 'The delegated scope receipt must be resolved by the allocation.' using errcode = '42501';
  end if;
  select pinned.* into binding from internal.factory_workflow_triage_bindings pinned
  where (pinned.session_id, pinned.workspace_id, pinned.factory_id) =
    (new.root_session_id, new.workspace_id, new.factory_id);
  if not found then return new; end if;

  select workflow.* into strict execution from internal.factory_workflow_executions workflow
  where (workflow.root_session_id, workflow.workspace_id, workflow.factory_id) =
    (new.root_session_id, new.workspace_id, new.factory_id);
  select saved.* into receipt from internal.factory_workflow_accepted_scopes saved
  where (saved.session_id, saved.workspace_id, saved.factory_id, saved.graph_revision_id, saved.workflow_digest, saved.run_id) =
    (new.root_session_id, new.workspace_id, new.factory_id, execution.graph_revision_id,
      execution.workflow_digest, execution.graph_input_run_id);
  if not found or internal.read_factory_workflow_current_scope_artifact(binding, receipt) is null then
    raise exception 'The configured triage workflow requires its exact currently accepted scope.' using errcode = 'PT409';
  end if;

  if new.parent_session_id = new.root_session_id and new.source_checkpoint_run_id <> receipt.run_id then
    select * into joined from internal.factory_workflow_occurrence_join_checkpoint(new.root_session_id, new.target_occurrence_id);
    if not found or (joined.parent_session_id, joined.checkpoint_run_id)
      is distinct from (new.parent_session_id, new.source_checkpoint_run_id) then
      raise exception 'The delegated source does not match the approved scope lineage.' using errcode = '42501';
    end if;
  elsif new.parent_session_id <> new.root_session_id and not exists (
      select 1 from internal.factory_workflow_delegations parent
      where (parent.child_session_id, parent.root_session_id, parent.workspace_id, parent.factory_id,
        parent.accepted_scope_receipt_id) =
        (new.parent_session_id, new.root_session_id, new.workspace_id, new.factory_id, receipt.receipt_id)
    ) then
    raise exception 'The delegated source does not match the approved scope lineage.' using errcode = '42501';
  end if;
  new.accepted_scope_receipt_id := receipt.receipt_id;
  return new;
end;
$$;

create or replace function public.admit_factory_workflow_branch_slot(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_group_id uuid, p_branch_edge_id text
) returns table(target_occurrence_id uuid, child_session_id uuid, job_id uuid, run_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_branch_groups;
  slot internal.factory_workflow_branch_slots;
  prior internal.factory_workflow_delegations;
  transition internal.factory_workflow_transition_receipts;
  predecessor_result_id uuid;
  occurrence_id uuid;
  decision_edge jsonb;
  target jsonb;
  parent_input public.session_factory_admission_inputs;
  terminal_blocker text;
  title text;
  prompt text;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select groups.* into manifest from internal.factory_workflow_branch_groups groups
  where (groups.root_session_id, groups.workspace_id, groups.factory_id, groups.group_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_group_id);
  if not found then raise exception 'The workflow branch group is unavailable.' using errcode = 'PT404'; end if;
  select slots.* into slot from internal.factory_workflow_branch_slots slots
  where (slots.root_session_id, slots.group_id, slots.branch_edge_id) =
    (p_root_session_id, p_group_id, p_branch_edge_id);
  if not found then raise exception 'The workflow branch slot is unavailable.' using errcode = 'PT404'; end if;
  select marker.* into prior from internal.factory_workflow_delegations marker
  where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.source_branch_slot_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, slot.slot_id);
  if found then
    return query select prior.target_occurrence_id, prior.child_session_id, prior.child_job_id, prior.child_run_id, false;
    return;
  end if;
  select state.terminal_blocker into terminal_blocker
  from internal.factory_workflow_branch_slot_dispatches state
  where (state.root_session_id, state.slot_id) = (p_root_session_id, slot.slot_id);
  if terminal_blocker is not null then
    raise exception 'The workflow branch slot has reached its lifetime limit.'
      using errcode = 'PT409', detail = terminal_blocker;
  end if;

  -- Ready mandatory work takes the next capacity within this group.
  if not slot.required and exists (
    select 1 from internal.factory_workflow_branch_slots pending
    where (pending.root_session_id, pending.group_id) = (p_root_session_id, p_group_id)
      and pending.required and not exists (
        select 1 from internal.factory_workflow_delegations marker
        where (marker.root_session_id, marker.source_branch_slot_id) = (p_root_session_id, pending.slot_id)
      )
  ) then return; end if;

  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, manifest.parent_session_id) then
    raise exception 'The branch parent is unavailable.' using errcode = 'PT409';
  end if;
  select edge into strict decision_edge from jsonb_array_elements(execution.workflow_json::jsonb->'edges') edge
  where edge->>'id' = slot.branch_edge_id and edge->>'kind' = 'branch' and edge->>'to' = slot.target_node_id;
  target := execution.workflow_json::jsonb#>array['delegationPolicy', 'targets', slot.target_node_id];
  if (target->>'definitionRevisionId', target->>'definitionDigest') is distinct from
    (slot.child_definition_revision_id::text, slot.child_definition_digest) then
    raise exception 'The frozen branch target profile is unavailable.' using errcode = 'PT409';
  end if;
  select result.result_id into strict predecessor_result_id from internal.factory_workflow_node_results result
  where (result.root_session_id, result.occurrence_id, result.evidence_ref) =
    (p_root_session_id, manifest.branch_occurrence_id, 'branch-manifest:' || manifest.group_id)
    and result.outcome = 'succeeded';
  perform internal.assert_factory_workflow_route_capacity(execution, decision_edge);

  select pin.* into strict parent_input from public.session_factory_admission_inputs pin
  where (pin.session_id, pin.workspace_id, pin.factory_id) = (manifest.parent_session_id, p_workspace_id, p_factory_id);
  title := left('Branch ' || slot.target_node_id || ': ' || parent_input.original_title, 200);
  prompt := left(btrim(parent_input.original_prompt_md), 20000);

  -- The root's initial intake may contradict the clarified scope. Its branch
  -- task comes from the exact approved scope. Nested branches retain the
  -- narrower task already assigned to their immediate parent.
  if manifest.parent_session_id = p_root_session_id and exists (
    select 1 from internal.factory_workflow_triage_bindings binding
    where (binding.session_id, binding.workspace_id, binding.factory_id) =
      (p_root_session_id, p_workspace_id, p_factory_id)
  ) then
    title := 'Branch ' || slot.target_node_id;
    select saved.scope->>'scope' into prompt from internal.factory_workflow_accepted_scopes saved
    where (saved.session_id, saved.workspace_id, saved.factory_id, saved.graph_revision_id, saved.workflow_digest, saved.run_id) =
      (p_root_session_id, p_workspace_id, p_factory_id, execution.graph_revision_id, execution.workflow_digest,
        execution.graph_input_run_id);
    if not found or prompt is null then
      raise exception 'The branch task requires its exact approved scope.' using errcode = 'PT409';
    end if;
  end if;

  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  values (p_root_session_id, slot.target_node_id, 'agent', execution.generation)
  returning factory_workflow_node_occurrences.occurrence_id into occurrence_id;
  insert into internal.factory_workflow_transition_receipts(
    root_session_id, source_occurrence_id, edge_id, source_result_id, edge_kind, target_occurrence_id, recorded_generation
  ) values (
    p_root_session_id, manifest.branch_occurrence_id, slot.branch_edge_id, predecessor_result_id, 'branch', occurrence_id,
    execution.generation
  ) returning * into transition;

  return query select occurrence_id, child.* from internal.create_factory_workflow_child(
    execution, manifest.parent_session_id, occurrence_id, slot.target_node_id, manifest.source_checkpoint_run_id,
    manifest.repository_id, transition.transition_id, null, null, slot.slot_id, title, prompt,
    encode(sha256(convert_to(btrim(title), 'UTF8')), 'hex'),
    encode(sha256(convert_to(btrim(prompt), 'UTF8')), 'hex')
  ) child;
end;
$$;

create or replace function internal.handoff_factory_workflow_triage_approval()
returns trigger language plpgsql set search_path = '' as $$
declare
  binding internal.factory_workflow_triage_bindings;
  accepted_run_id uuid;
  saved internal.factory_workflow_accepted_scopes;
  issued record;
  enrollment record;
  result record;
  admitted record;
  plan jsonb;
  next_edge_id text;
begin
  select pinned.* into binding from internal.factory_workflow_triage_bindings pinned
  where (pinned.session_id, pinned.workspace_id) = (new.session_id, new.workspace_id);
  if not found then return new; end if;
  if binding.stage_id is distinct from new.stage_id then
    raise exception 'The review does not match the configured triage stage.' using errcode = 'PT409';
  end if;
  select head.checkpoint_run_id into accepted_run_id from public.session_git_heads head
  join public.session_git_checkpoints checkpoint
    on (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.artifact_id) =
      (head.checkpoint_run_id, head.workspace_id, head.session_id, new.artifact_id)
  where (head.session_id, head.workspace_id) = (new.session_id, new.workspace_id);
  -- An approval of an adopted joined artifact is the later human decision.
  -- Only the original specification approval enrolls and freezes triage scope.
  select receipt.* into saved from internal.factory_workflow_accepted_scopes receipt
  where (receipt.session_id,receipt.workspace_id,receipt.factory_id) =
    (binding.session_id,binding.workspace_id,binding.factory_id);
  if found and exists (
    select 1 from internal.factory_workflow_join_outcomes terminal
    join internal.factory_workflow_joins manifest using(root_session_id,join_id)
    where (manifest.root_session_id,manifest.parent_session_id,manifest.workspace_id,manifest.factory_id,
      terminal.outcome,terminal.checkpoint_run_id,terminal.artifact_id) =
      (binding.session_id,binding.session_id,binding.workspace_id,binding.factory_id,
        'adopted',accepted_run_id,new.artifact_id)
  ) and internal.factory_workflow_root_join_keeps_scope(binding,saved) then
    return new;
  end if;

  select * into issued from public.record_factory_workflow_accepted_scope(
    binding.session_id, binding.workspace_id, binding.factory_id, binding.graph_revision_id,
    binding.workflow_digest, accepted_run_id, new.id
  );
  if not found then
    raise exception 'Triage scope requires reviewed criteria and exact retained evidence.' using errcode = 'PT422';
  end if;
  select * into strict enrollment from public.start_factory_workflow_graph_execution(
    binding.session_id, binding.workspace_id, binding.factory_id, binding.graph_revision_id, accepted_run_id
  );
  if not enrollment.created then return new; end if;

  select * into result from public.record_factory_workflow_command_result(
    binding.session_id, binding.workspace_id, binding.factory_id, enrollment.execution_generation,
    enrollment.ownership_token, enrollment.entry_occurrence_id, 'human-gate:' || new.id::text
  );
  if not found then
    raise exception 'The exact triage approval did not satisfy the configured gate.' using errcode = 'PT409';
  end if;
  select graph.workflow_json::jsonb into strict plan from internal.factory_workflow_graph_revisions graph
  where (graph.id, graph.workspace_id, graph.factory_id, graph.workflow_digest) =
    (binding.graph_revision_id, binding.workspace_id, binding.factory_id, binding.workflow_digest);
  select edge->>'id' into next_edge_id from jsonb_array_elements(plan->'edges') edge
  where (edge->>'kind', edge->>'from') = ('next', plan->>'entryNodeId');
  if not found then return new; end if;
  select * into admitted from public.admit_factory_workflow_next(
    binding.session_id, binding.workspace_id, binding.factory_id, enrollment.execution_generation,
    enrollment.ownership_token, enrollment.entry_occurrence_id, next_edge_id, result.result_id
  );
  if not found then
    raise exception 'The configured triage successor is unavailable.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
