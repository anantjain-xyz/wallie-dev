-- Exact review is separate from validation and human approval.

create table internal.factory_workflow_exact_reviews (
  root_session_id uuid not null,
  review_occurrence_id uuid not null,
  review_id uuid not null default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  workflow_digest text not null,
  parent_session_id uuid not null,
  join_id uuid not null,
  repository_id uuid not null,
  checkpoint_run_id uuid not null,
  commit_sha text not null check (commit_sha collate "C" ~ '^[0-9a-f]{40}$'),
  tree_sha text not null check (tree_sha collate "C" ~ '^[0-9a-f]{40}$'),
  reviewer_prompt_revision_id uuid not null,
  declared_rules jsonb not null,
  repair_policy jsonb,
  primary key (root_session_id, review_occurrence_id),
  unique (root_session_id, review_id),
  foreign key (root_session_id, review_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) on delete cascade,
  foreign key (root_session_id, join_id)
    references internal.factory_workflow_joins(root_session_id, join_id) on delete cascade,
  foreign key (checkpoint_run_id) references public.session_git_checkpoints(run_id) deferrable initially deferred,
  foreign key (parent_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) deferrable initially deferred
);

create table internal.factory_workflow_exact_review_reports (
  root_session_id uuid not null,
  review_id uuid not null,
  receipt_id uuid not null default gen_random_uuid(),
  review_run_id uuid not null,
  report jsonb not null,
  finding_keys jsonb not null,
  recorded_generation bigint not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, review_id),
  unique (root_session_id, receipt_id),
  foreign key (root_session_id, review_id)
    references internal.factory_workflow_exact_reviews(root_session_id, review_id) on delete cascade
);

create table internal.factory_workflow_review_repairs (
  root_session_id uuid not null,
  review_id uuid not null,
  receipt_id uuid not null default gen_random_uuid(),
  review_receipt_id uuid not null,
  repair_edge_id text not null,
  prior_repair_receipt_id uuid,
  job_id uuid not null unique,
  queued_run_id uuid not null,
  next_review_occurrence_id uuid not null,
  reserved_generation bigint not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id, review_id),
  unique (root_session_id, receipt_id),
  unique (root_session_id, next_review_occurrence_id),
  foreign key (root_session_id, next_review_occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) deferrable initially deferred,
  foreign key (root_session_id, review_id)
    references internal.factory_workflow_exact_reviews(root_session_id, review_id) on delete cascade,
  foreign key (root_session_id, review_receipt_id)
    references internal.factory_workflow_exact_review_reports(root_session_id, receipt_id) deferrable initially deferred,
  foreign key (root_session_id, prior_repair_receipt_id)
    references internal.factory_workflow_review_repairs(root_session_id, receipt_id) deferrable initially deferred
);

-- A reviewer holds one private attempt permit. A retry after transport loss
-- can recover the same permit and a new workflow generation cannot use it.
create table internal.factory_workflow_review_attempts (
  root_session_id uuid not null,
  review_id uuid not null,
  generation bigint not null,
  review_run_id uuid not null default gen_random_uuid(),
  permit uuid not null unique,
  deadline_at timestamptz not null,
  primary key (root_session_id, review_id, generation),
  unique (root_session_id, review_run_id),
  foreign key (root_session_id, review_id)
    references internal.factory_workflow_exact_reviews(root_session_id, review_id) on delete cascade
);

alter table internal.factory_workflow_exact_reviews enable row level security;
alter table internal.factory_workflow_exact_review_reports enable row level security;
alter table internal.factory_workflow_review_repairs enable row level security;
alter table internal.factory_workflow_review_attempts enable row level security;
revoke all on table internal.factory_workflow_exact_reviews, internal.factory_workflow_exact_review_reports,
  internal.factory_workflow_review_repairs, internal.factory_workflow_review_attempts
  from public, anon, authenticated, service_role;

create trigger freeze_factory_workflow_exact_review before update on internal.factory_workflow_exact_reviews
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_exact_review_report before update on internal.factory_workflow_exact_review_reports
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_review_repair before update on internal.factory_workflow_review_repairs
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_review_attempt before update on internal.factory_workflow_review_attempts
  for each row execute function internal.reject_factory_workflow_join_update();

create function internal.factory_workflow_review_source_is_current(p_review internal.factory_workflow_exact_reviews)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.session_git_heads head
    join public.session_git_checkpoints checkpoint on
      (checkpoint.run_id, checkpoint.session_id, checkpoint.workspace_id) =
      (head.checkpoint_run_id, head.session_id, head.workspace_id)
    join public.session_validation_plans validation on
      (validation.run_id, validation.session_id, validation.workspace_id, validation.repository_id,
        validation.commit_sha, validation.validation_tree_sha) =
      (checkpoint.run_id, checkpoint.session_id, checkpoint.workspace_id, checkpoint.repository_id, checkpoint.output_sha, p_review.tree_sha)
    where (head.session_id, head.workspace_id, head.checkpoint_run_id, checkpoint.repository_id, checkpoint.output_sha) =
      (p_review.parent_session_id, p_review.workspace_id, p_review.checkpoint_run_id, p_review.repository_id, p_review.commit_sha)
  )
$$;
revoke all on function internal.factory_workflow_review_source_is_current(internal.factory_workflow_exact_reviews)
  from public, anon, authenticated, service_role;

create function public.claim_factory_workflow_exact_review(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid,
  p_expected_generation bigint, p_ownership_token uuid, p_review_occurrence_id uuid, p_permit uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  review internal.factory_workflow_exact_reviews;
  attempt internal.factory_workflow_review_attempts;
  node_id text;
  declaration jsonb;
  source record;
  prompt public.factory_agent_prompt_revisions;
  repair jsonb;
  source_input record;
  authorized_deadline timestamptz;
  policy jsonb;
  policy_limits jsonb;
  usage record;
  spent record;
  maximum_tokens bigint;
  maximum_cost numeric;
  created boolean := false;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_permit is null then return null; end if;
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.lifecycle_status <> 'running' then return null; end if;
  select stored.* into review from internal.factory_workflow_exact_reviews stored
  where (stored.root_session_id, stored.review_occurrence_id) = (p_root_session_id, p_review_occurrence_id);
  if not found then
    select occurrence.node_id, manifest.join_id, manifest.parent_session_id, manifest.repository_id,
      outcome.checkpoint_run_id, outcome.detail->>'commitSha' as commit_sha, outcome.detail->>'treeSha' as tree_sha
    into source
    from internal.factory_workflow_node_occurrences occurrence
    join internal.factory_workflow_transition_receipts transition
      on (transition.root_session_id, transition.target_occurrence_id, transition.edge_kind) =
        (occurrence.root_session_id, occurrence.occurrence_id, 'next')
    join internal.factory_workflow_joins manifest
      on (manifest.root_session_id, manifest.join_occurrence_id) = (transition.root_session_id, transition.source_occurrence_id)
    join internal.factory_workflow_join_outcomes outcome
      on (outcome.root_session_id, outcome.join_id, outcome.outcome) = (manifest.root_session_id, manifest.join_id, 'adopted')
    join internal.factory_workflow_node_results result
      on (result.root_session_id, result.occurrence_id, result.result_id, result.outcome, result.evidence_ref) =
        (transition.root_session_id, transition.source_occurrence_id, transition.source_result_id, 'succeeded',
          'join-checkpoint:' || outcome.checkpoint_run_id)
    where (occurrence.root_session_id, occurrence.occurrence_id, occurrence.node_kind) =
      (p_root_session_id, p_review_occurrence_id, 'review')
      and (manifest.workspace_id, manifest.factory_id, manifest.workflow_digest) =
        (p_workspace_id, p_factory_id, execution.workflow_digest);
    if not found then
      select occurrence.node_id, earlier.join_id, earlier.parent_session_id, earlier.repository_id,
        checkpoint.run_id as checkpoint_run_id, checkpoint.output_sha as commit_sha,
        plan.validation_tree_sha as tree_sha into source
      from internal.factory_workflow_review_repairs repair
      join internal.factory_workflow_exact_reviews earlier using (root_session_id, review_id)
      join internal.factory_workflow_node_occurrences occurrence
        on (occurrence.root_session_id,occurrence.occurrence_id) = (repair.root_session_id,repair.next_review_occurrence_id)
      join public.session_git_heads head on (head.session_id,head.workspace_id) =
        (earlier.parent_session_id,earlier.workspace_id)
      join public.session_git_checkpoints checkpoint on
        (checkpoint.run_id,checkpoint.session_id,checkpoint.workspace_id,checkpoint.repository_id,checkpoint.job_id) =
        (head.checkpoint_run_id,head.session_id,head.workspace_id,earlier.repository_id,repair.job_id)
      join public.session_validation_plans plan on (plan.run_id,plan.job_id,plan.workspace_id,plan.session_id,
        plan.attempt_count,plan.repository_id,plan.commit_sha) = (checkpoint.run_id,checkpoint.job_id,checkpoint.workspace_id,
        checkpoint.session_id,checkpoint.attempt_count,checkpoint.repository_id,checkpoint.output_sha)
      where (repair.root_session_id,repair.next_review_occurrence_id,earlier.workspace_id,earlier.factory_id,earlier.workflow_digest) =
        (p_root_session_id,p_review_occurrence_id,p_workspace_id,p_factory_id,execution.workflow_digest);
      if not found then return null; end if;
    end if;
    node_id := source.node_id;
    select node into strict declaration from jsonb_array_elements(execution.workflow_json::jsonb->'nodes') node
    where node->>'id' = node_id and node->>'kind' = 'review';
    select revision.* into prompt from public.factory_agent_prompt_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id::text) =
      (p_workspace_id, p_factory_id, declaration->>'reviewerPromptRevisionId');
    if not found or jsonb_typeof(declaration->'ruleIds') is distinct from 'array'
      or jsonb_array_length(declaration->'ruleIds') not between 1 and 32
      or exists (select 1 from jsonb_array_elements_text(declaration->'ruleIds') rule(id)
        where rule.id is null or length(rule.id) > 96 or rule.id collate "C" !~ '^[a-z0-9]+([.-][a-z0-9]+)*$')
    then raise exception 'The exact workflow review profile is unavailable.' using errcode = 'PT422'; end if;
    repair := declaration->'repair';
    if repair is not null and (jsonb_typeof(repair) is distinct from 'object'
      or coalesce(repair->>'edgeId','') collate "C" !~ '^[a-z0-9]+([.-][a-z0-9]+)*$'
      or coalesce(repair->>'maxRepairs','') !~ '^[1-8]$'
      or jsonb_typeof(repair->'eligibleRuleIds') is distinct from 'array'
      or not ((repair->'eligibleRuleIds') <@ (declaration->'ruleIds'))) then
      raise exception 'The bounded repair declaration is unavailable.' using errcode = 'PT422';
    end if;
    insert into internal.factory_workflow_exact_reviews(root_session_id, review_occurrence_id, workspace_id, factory_id,
      workflow_digest, parent_session_id, join_id, repository_id, checkpoint_run_id, commit_sha, tree_sha,
      reviewer_prompt_revision_id, declared_rules, repair_policy)
    values (p_root_session_id, p_review_occurrence_id, p_workspace_id, p_factory_id, execution.workflow_digest,
      source.parent_session_id, source.join_id, source.repository_id, source.checkpoint_run_id, source.commit_sha, source.tree_sha,
      prompt.id, declaration->'ruleIds', repair) returning * into review;
  end if;
  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id,
    review.parent_session_id) or exists (select 1 from internal.factory_workflow_exact_review_reports report
      where (report.root_session_id, report.review_id) = (p_root_session_id, review.review_id))
    or exists (select 1 from internal.factory_workflow_exact_review_failures failure
      where (failure.root_session_id, failure.review_id) = (p_root_session_id, review.review_id))
    then return null; end if;

  if not internal.factory_workflow_review_source_is_current(review)
    or not internal.session_execution_admissible(p_root_session_id, p_workspace_id) then
    -- No provider can be issued from a stale head or terminal budget.
    if not exists (select 1 from internal.factory_workflow_review_attempts issued
      where (issued.root_session_id, issued.review_id) = (p_root_session_id, review.review_id)) then
      insert into internal.factory_workflow_exact_review_failures(root_session_id, review_id, reason)
      values (p_root_session_id, review.review_id, case when internal.factory_workflow_review_source_is_current(review)
        then 'budget_exhausted' else 'source_unavailable' end) on conflict do nothing;
    end if;
    return null;
  end if;
  select checkpoint.* into strict source_input from internal.checkpoint_execution_input(
    review.checkpoint_run_id, review.parent_session_id, p_workspace_id
  ) checkpoint;
  -- An outstanding attempt keeps its original finite window across retries.
  -- Do not issue again after a provider request might have executed.
  if exists (select 1 from internal.factory_workflow_review_attempts issued
    where (issued.root_session_id, issued.review_id) = (p_root_session_id, review.review_id)
      and issued.generation <> execution.generation) then return null; end if;
  select issued.* into attempt from internal.factory_workflow_review_attempts issued
  where (issued.root_session_id, issued.review_id, issued.generation) = (p_root_session_id, review.review_id, execution.generation);
  if not found then
    policy := execution.workflow_json::jsonb->'delegationPolicy';
    if policy is null then return null; end if;
    maximum_tokens := (policy->>'maxTokensPerAttempt')::bigint;
    maximum_cost := (policy->>'maxCostUsdPerAttempt')::numeric;
    select revision.requirements into policy_limits
    from public.sessions root join public.execution_policy_revisions revision
      on (revision.id,revision.workspace_id) = (root.execution_policy_revision_id,root.workspace_id)
    where (root.id,root.workspace_id) = (p_root_session_id,p_workspace_id);
    if not found then return null; end if;
    select * into spent from internal.factory_workflow_attempt_budget(p_root_session_id,policy);
    if spent.attempts + 1 > (policy->>'maxAttempts')::integer
      or spent.tokens + maximum_tokens > least((policy->>'maxTotalTokens')::bigint,(policy_limits->>'maxTotalTokens')::bigint)
      or spent.spend_usd + maximum_cost > least((policy->>'maxCostUsd')::numeric,(policy_limits->>'maxCostUsd')::numeric)
    then
      if internal.factory_workflow_branch_attempt_budget_exhausted(execution) then
        insert into internal.factory_workflow_exact_review_failures(root_session_id, review_id, reason)
        values (p_root_session_id, review.review_id, 'budget_exhausted') on conflict do nothing;
      end if;
      return null;
    end if;
    authorized_deadline := clock_timestamp();
    select * into usage from public.get_session_execution_budget(p_root_session_id);
    if usage.remaining_execution_ms is null or usage.remaining_execution_ms <= 0 then return null; end if;
    authorized_deadline := authorized_deadline + least(90000,usage.remaining_execution_ms) * interval '1 millisecond';
    if authorized_deadline <= clock_timestamp() then return null; end if;
    insert into internal.factory_workflow_review_attempts(root_session_id, review_id, generation, permit, deadline_at,
      reserved_tokens,reserved_cost_usd)
    values (p_root_session_id,review.review_id,execution.generation,p_permit,authorized_deadline,maximum_tokens,maximum_cost)
    returning * into attempt;
    created := true;
  end if;
  if attempt.permit is distinct from p_permit or attempt.deadline_at <= clock_timestamp()
    or exists (select 1 from internal.factory_workflow_exact_review_failures failure
      where (failure.root_session_id, failure.review_id) = (p_root_session_id, review.review_id))
    then return null; end if;
  return jsonb_build_object('reviewId', review.review_id, 'reviewRunId', attempt.review_run_id,
    'checkpointRunId', review.checkpoint_run_id, 'parentSessionId', review.parent_session_id,
    'commitSha', review.commit_sha, 'treeSha', review.tree_sha, 'repositoryId', review.repository_id,
    'repositoryFullName', source_input.repository_full_name, 'baseBranch', source_input.base_branch,
    'retainedRef', source_input.input_ref, 'reviewerPromptRevisionId', review.reviewer_prompt_revision_id,
    'ruleIds', review.declared_rules,
    'requiredEvidence', (select manifest.required_evidence from internal.factory_workflow_joins manifest
      where (manifest.root_session_id,manifest.join_id) = (review.root_session_id,review.join_id)),
    'deadlineAt', attempt.deadline_at, 'created', created,
    'reservedTokens', attempt.reserved_tokens, 'reservedCostUsd', attempt.reserved_cost_usd);
end;
$$;

create function public.record_factory_workflow_exact_review(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_review_id uuid, p_review_run_id uuid, p_permit uuid,
  p_checkpoint_run_id uuid, p_commit_sha text, p_tree_sha text, p_report jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  review internal.factory_workflow_exact_reviews;
  attempt internal.factory_workflow_review_attempts;
  receipt internal.factory_workflow_exact_review_reports;
  finding_keys jsonb := '[]'::jsonb;
  review_result_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.lifecycle_status <> 'running' then return null; end if;
  select bound.* into strict review from internal.factory_workflow_exact_reviews bound
  where (bound.root_session_id, bound.review_id) = (p_root_session_id, p_review_id);
  select issued.* into attempt from internal.factory_workflow_review_attempts issued
  where (issued.root_session_id, issued.review_id, issued.review_run_id, issued.permit, issued.generation) =
    (p_root_session_id, p_review_id, p_review_run_id, p_permit, execution.generation);
  if not found or (review.checkpoint_run_id, review.commit_sha, review.tree_sha) is distinct from
    (p_checkpoint_run_id, p_commit_sha, p_tree_sha) then return null; end if;

  select saved.* into receipt from internal.factory_workflow_exact_review_reports saved
  where (saved.root_session_id, saved.review_id) = (p_root_session_id, p_review_id);
  if found then
    if (receipt.review_run_id, receipt.report) is distinct from (p_review_run_id, p_report) then
      raise exception 'The exact workflow review already has a different report.' using errcode = 'PT409';
    end if;
    return receipt.receipt_id;
  end if;
  if attempt.deadline_at <= clock_timestamp()
    or exists (select 1 from internal.factory_workflow_exact_review_failures failure
      where (failure.root_session_id, failure.review_id) = (p_root_session_id, review.review_id))
    or not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, review.parent_session_id)
    or not internal.factory_workflow_review_source_is_current(review) then return null; end if;
  if not coalesce(jsonb_typeof(p_report) = 'object' and octet_length(p_report::text) <= 24576
    and p_report->'version' = '1'::jsonb and p_report->>'verdict' in ('pass', 'findings'), false) then
    raise exception 'Invalid exact workflow review report.' using errcode = '22023';
  end if;
  if p_report->>'verdict' = 'pass' then
    if p_report - array['version','verdict'] <> '{}'::jsonb then
      raise exception 'Invalid exact workflow review report.' using errcode = '22023';
    end if;
  else
    if p_report - array['version','verdict','findings'] <> '{}'::jsonb
      or jsonb_typeof(p_report->'findings') is distinct from 'array'
      or jsonb_array_length(p_report->'findings') not between 1 and 32
      or exists (select 1 from jsonb_array_elements(p_report->'findings') finding
        where jsonb_typeof(finding) is distinct from 'object'
          or not (finding ?& array['ruleId','message'])
          or finding - array['ruleId','message','path','line'] <> '{}'::jsonb
          or jsonb_typeof(finding->'ruleId') is distinct from 'string'
          or not (review.declared_rules ? (finding->>'ruleId'))
          or jsonb_typeof(finding->'message') is distinct from 'string'
          or char_length(btrim(finding->>'message')) not between 1 and 1000
          or (finding ? 'line' and (jsonb_typeof(finding->'line') is distinct from 'number'
            or coalesce(finding->>'line','') !~ '^[1-9][0-9]{0,14}$'))
          or (finding ? 'path' and (jsonb_typeof(finding->'path') is distinct from 'string'
            or char_length(finding->>'path') not between 1 and 512
            or finding->>'path' collate "C" ~ '^[a-zA-Z]:|[[:cntrl:]]|(^|/)[.]{1,2}(/|$)|(^/|/$|//)'
            or strpos(finding->>'path', chr(92)) > 0))) then
      raise exception 'Invalid exact workflow review findings.' using errcode = '22023';
    end if;
    select jsonb_agg(distinct jsonb_build_array(finding->>'ruleId', finding->>'path'))
    into finding_keys from jsonb_array_elements(p_report->'findings') finding;
  end if;
  insert into internal.factory_workflow_exact_review_reports(root_session_id, review_id, review_run_id,
    report, finding_keys, recorded_generation)
  values (p_root_session_id, p_review_id, p_review_run_id, p_report, finding_keys, execution.generation)
  returning * into receipt;
  if p_report->>'verdict' = 'pass' then
    select recorded.result_id into strict review_result_id from internal.insert_factory_workflow_node_result(
      execution, review.review_occurrence_id, 'succeeded', 'exact-review:' || receipt.receipt_id) recorded;
    perform internal.admit_factory_workflow_exact_review_successor(
      execution, review.review_occurrence_id, review_result_id, false);
  end if;
  if clock_timestamp() >= attempt.deadline_at then
    raise exception 'The workflow review deadline elapsed before recording its result.' using errcode = '57014';
  end if;
  return receipt.receipt_id;
end;
$$;

-- Any generic result or next-edge path must honor the native read-only
-- report. The result receipt is separate from validation and human decisions.
create function internal.guard_factory_workflow_exact_review_progress()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  source_occurrence_id uuid;
  source_kind internal.factory_workflow_node_kind;
  review internal.factory_workflow_exact_reviews;
  receipt internal.factory_workflow_exact_review_reports;
begin
  if tg_table_name = 'factory_workflow_node_results' then
    source_occurrence_id := new.occurrence_id;
  else
    source_occurrence_id := new.source_occurrence_id;
  end if;
  select occurrence.node_kind into source_kind from internal.factory_workflow_node_occurrences occurrence
  where (occurrence.root_session_id, occurrence.occurrence_id) = (new.root_session_id, source_occurrence_id);
  if source_kind is distinct from 'review' then return new; end if;

  select bound.* into review from internal.factory_workflow_exact_reviews bound
  where (bound.root_session_id, bound.review_occurrence_id) = (new.root_session_id, source_occurrence_id);
  select saved.* into receipt from internal.factory_workflow_exact_review_reports saved
  where (saved.root_session_id, saved.review_id) = (new.root_session_id, review.review_id);
  if not found or receipt.report->>'verdict' is distinct from 'pass'
    or not internal.factory_workflow_review_source_is_current(review) then
    raise exception 'Exact passing workflow review is required.' using errcode = '42501';
  end if;
  if tg_table_name = 'factory_workflow_node_results' then
    if (new.outcome, new.evidence_ref) is distinct from ('succeeded', 'exact-review:' || receipt.receipt_id) then
      raise exception 'Exact passing workflow review is required.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_factory_workflow_exact_review_progress() from public, anon, authenticated, service_role;
create trigger guard_factory_workflow_exact_review_result before insert on internal.factory_workflow_node_results
  for each row execute function internal.guard_factory_workflow_exact_review_progress();
create trigger guard_factory_workflow_exact_review_next before insert on internal.factory_workflow_transition_receipts
  for each row execute function internal.guard_factory_workflow_exact_review_progress();

alter table internal.factory_workflow_review_attempts
  add column reserved_tokens bigint not null check (reserved_tokens > 0),
  add column reserved_cost_usd numeric not null check (reserved_cost_usd > 0);

alter function internal.factory_workflow_attempt_budget(uuid,jsonb)
  rename to factory_workflow_attempt_budget_before_exact_review;
revoke all on function internal.factory_workflow_attempt_budget_before_exact_review(uuid,jsonb)
  from public,anon,authenticated,service_role;

create function internal.factory_workflow_attempt_budget(p_root_session_id uuid, p_policy jsonb)
returns table(attempts bigint,tokens numeric,spend_usd numeric,active_children bigint)
language sql stable set search_path = '' as $$
  select other.attempts + reviews.attempts, other.tokens + reviews.tokens,
    other.spend_usd + reviews.spend_usd, other.active_children
  from internal.factory_workflow_attempt_budget_before_exact_review(p_root_session_id,p_policy) other
  cross join lateral (
    select count(*) as attempts, coalesce(sum(issued.reserved_tokens),0) as tokens,
      coalesce(sum(issued.reserved_cost_usd),0) as spend_usd
    from internal.factory_workflow_review_attempts issued where issued.root_session_id = p_root_session_id
  ) reviews
$$;
revoke all on function internal.factory_workflow_attempt_budget(uuid,jsonb)
  from public,anon,authenticated,service_role;

create function public.admit_factory_workflow_review_repair(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_review_id uuid, p_review_receipt_id uuid, p_expected_head_run_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  review internal.factory_workflow_exact_reviews;
  report internal.factory_workflow_exact_review_reports;
  receipt internal.factory_workflow_review_repairs;
  parent public.sessions;
  limit_count integer;
  recorded_repairs integer;
  prior_repair_id uuid;
  repeated_finding boolean;
  queued record;
  next_occurrence_id uuid;
  blocker text;
begin
  perform internal.assert_checkpoint_publication_service();
  perform 1 from internal.git_continuity_release_control where singleton for share;
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.lifecycle_status <> 'running' then return jsonb_build_object('status', 'stale_review'); end if;
  select bound.* into review from internal.factory_workflow_exact_reviews bound
  where (bound.root_session_id, bound.workspace_id, bound.factory_id, bound.review_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_review_id);
  if not found or review.checkpoint_run_id is distinct from p_expected_head_run_id then
    return jsonb_build_object('status', 'stale_review');
  end if;
  select saved.* into report from internal.factory_workflow_exact_review_reports saved
  where (saved.root_session_id, saved.review_id, saved.receipt_id) = (p_root_session_id, p_review_id, p_review_receipt_id);
  if not found then return jsonb_build_object('status', 'stale_review'); end if;

  select existing.* into receipt from internal.factory_workflow_review_repairs existing
  where (existing.root_session_id, existing.review_id) = (p_root_session_id, p_review_id);
  if found then
    return jsonb_build_object('status','repair_recorded','receiptId',receipt.receipt_id,
      'jobId',receipt.job_id,'runId',receipt.queued_run_id,'created',false);
  end if;
  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, review.parent_session_id)
    or not internal.factory_workflow_review_source_is_current(review) then
    return jsonb_build_object('status', 'stale_review');
  end if;
  if report.report->>'verdict' = 'pass' then return jsonb_build_object('status','review_passed'); end if;
  if review.repair_policy is null or exists (
    select 1 from jsonb_array_elements(report.finding_keys) key
    where not (review.repair_policy->'eligibleRuleIds' ? (key->>0))
  ) then return jsonb_build_object('status','escalated','code','finding_ineligible'); end if;

  -- Walk exact accepted checkpoint runs rather than comparing only their SHA.
  -- Only successful repairs on these ancestors can consume this declaration
  -- or prove a repeated finding for this causal chain.
  with recursive ancestry(run_id, depth) as (
    select review.checkpoint_run_id, 0
    union all
    select input.source_checkpoint_run_id, ancestry.depth + 1
    from ancestry
    join public.session_git_checkpoints checkpoint on (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id) =
      (ancestry.run_id, p_workspace_id, review.parent_session_id)
    join public.session_job_git_inputs input on (input.job_id, input.workspace_id, input.session_id) =
      (checkpoint.job_id, checkpoint.workspace_id, checkpoint.session_id)
    where ancestry.depth < 1023 and input.source_checkpoint_run_id is not null
  ), lineage as (
    select prior.receipt_id, prior_report.finding_keys, ancestry.depth, prior.repair_edge_id
    from ancestry
    join public.session_git_checkpoints checkpoint on checkpoint.run_id = ancestry.run_id
    join internal.factory_workflow_review_repairs prior
      on (prior.root_session_id, prior.job_id) = (p_root_session_id, checkpoint.job_id)
    join internal.factory_workflow_exact_review_reports prior_report on
      (prior_report.root_session_id, prior_report.receipt_id) = (prior.root_session_id, prior.review_receipt_id)
  )
  select count(*) filter (where lineage.repair_edge_id = review.repair_policy->>'edgeId'),
    (array_agg(lineage.receipt_id order by lineage.depth))[1],
    coalesce(bool_or(exists (
      select 1 from jsonb_array_elements(report.finding_keys) key where lineage.finding_keys @> jsonb_build_array(key)
    )),false)
  into recorded_repairs, prior_repair_id, repeated_finding from lineage;
  if repeated_finding then return jsonb_build_object('status','escalated','code','finding_repeated'); end if;

  select session.* into strict parent from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (review.parent_session_id,p_workspace_id,p_factory_id)
  for no key update;
  select (policy.requirements->>'maxRepairAttempts')::integer into limit_count
  from public.sessions root
  join public.execution_policy_revisions policy
    on (policy.id, policy.workspace_id) = (root.execution_policy_revision_id, root.workspace_id)
  where root.id = p_root_session_id and root.execution_repair_attempts < (policy.requirements->>'maxRepairAttempts')::integer;
  if limit_count is null or recorded_repairs >= (review.repair_policy->>'maxRepairs')::integer
    or not internal.session_execution_admissible(p_root_session_id,p_workspace_id)
    or not internal.session_execution_admissible(parent.id,p_workspace_id) then
    return jsonb_build_object('status','escalated','code','repair_budget_exhausted');
  end if;
  if parent.phase_status <> 'awaiting_review' or parent.archived_at is not null
    or exists (select 1 from public.agent_jobs active where (active.session_id,active.workspace_id) =
      (parent.id,p_workspace_id) and active.status in ('queued','started','running')) then
    return jsonb_build_object('status','escalated','code','repair_stage_unavailable');
  end if;

  begin
    -- Use the normal queue and stage/input guards. Automatic repair accounting
    -- resides here, so the job does not use a trigger type that also debits it.
    select * into strict queued from public.enqueue_session_job_with_run(
      parent.id, p_workspace_id, parent.current_stage_id, p_run_type => 'code'
    );
    if not coalesce(queued.created,false) then raise sqlstate 'P6001'; end if;
    perform internal.prepare_session_job_git_input(queued.job_id,review.checkpoint_run_id);
    if not exists (select 1 from public.session_job_git_inputs input
      where (input.job_id,input.session_id,input.workspace_id,input.source_checkpoint_run_id,input.input_sha,input.repository_id) =
        (queued.job_id,parent.id,p_workspace_id,review.checkpoint_run_id,review.commit_sha,review.repository_id)) then
      raise exception 'The repair job retained a different source.' using errcode = '23514';
    end if;
    if not internal.reserve_factory_workflow_attempt(execution,parent.id,queued.job_id,1)
      or not internal.reserve_session_repair_attempt(p_root_session_id,p_workspace_id) then raise sqlstate 'P6001'; end if;

    perform internal.assert_factory_workflow_route_capacity(execution, jsonb_build_object('kind','branch-result'));
    if (select count(*) from internal.factory_workflow_node_occurrences occurrence
      where occurrence.root_session_id = p_root_session_id) >= 1024 then raise sqlstate 'P6001'; end if;
    insert into internal.factory_workflow_node_occurrences(root_session_id,node_id,node_kind,admitted_generation)
    select p_root_session_id, occurrence.node_id, 'review', execution.generation
    from internal.factory_workflow_node_occurrences occurrence
    where (occurrence.root_session_id,occurrence.occurrence_id) = (p_root_session_id,review.review_occurrence_id)
    returning occurrence_id into strict next_occurrence_id;

    insert into internal.factory_workflow_review_repairs(root_session_id,review_id,review_receipt_id,repair_edge_id,
      prior_repair_receipt_id,job_id,queued_run_id,reserved_generation,next_review_occurrence_id)
    values (p_root_session_id,p_review_id,p_review_receipt_id,review.repair_policy->>'edgeId',prior_repair_id,
      queued.job_id,queued.run_id,execution.generation,next_occurrence_id)
    returning * into receipt;
    update public.sessions session set phase_status = 'in_progress' where session.id = parent.id;
  exception when sqlstate 'P6001' then
    return jsonb_build_object('status','escalated','code','repair_budget_exhausted');
  when sqlstate 'PT409' then
    get stacked diagnostics blocker = pg_exception_detail;
    if blocker is distinct from 'workflow_visit_limit_exhausted' then raise; end if;
    return jsonb_build_object('status','escalated','code','repair_budget_exhausted');
  end;

  return jsonb_build_object('status','repair_recorded','receiptId',receipt.receipt_id,
    'jobId',receipt.job_id,'runId',receipt.queued_run_id,'created',true);
end;
$$;

create function public.read_factory_workflow_review_repair_input(
  p_workspace_id uuid, p_session_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  repair internal.factory_workflow_review_repairs;
  review internal.factory_workflow_exact_reviews;
  input jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  select marked.* into repair from internal.factory_workflow_review_repairs marked
  join internal.factory_workflow_exact_reviews stored using (root_session_id, review_id)
  where (marked.job_id, stored.workspace_id, stored.parent_session_id) = (p_job_id, p_workspace_id, p_session_id);
  if not found then return null; end if;

  select * into strict review from internal.factory_workflow_exact_reviews stored
  where (stored.root_session_id, stored.review_id) = (repair.root_session_id, repair.review_id);
  perform 1 from internal.git_continuity_release_control where singleton for share;
  perform internal.lock_factory_workflow_root(review.root_session_id, review.workspace_id, review.factory_id);
  perform 1 from internal.factory_workflow_executions execution
  where execution.root_session_id = review.root_session_id and execution.lifecycle_status = 'running'
  for no key update;
  if not found or not internal.recheck_factory_workflow_delegation_lineage(
    review.root_session_id, review.workspace_id, review.factory_id, review.parent_session_id
  ) or not internal.factory_workflow_review_source_is_current(review) then
    raise exception 'The workflow repair source is stale.' using errcode = 'PT409';
  end if;

  select jsonb_build_object('repairReceiptId', repair.receipt_id, 'sourceCheckpointRunId', review.checkpoint_run_id,
    'sourceCommitSha', review.commit_sha, 'sourceTreeSha', review.tree_sha, 'findings', report.report->'findings',
    'priorRepairReceiptId', repair.prior_repair_receipt_id, 'requiredEvidence', manifest.required_evidence)
  into input
  from public.agent_jobs job
  join public.agent_runs run on (run.agent_job_id, run.workspace_id, run.session_id, run.attempt_count, run.id) =
    (job.id, job.workspace_id, job.session_id, job.attempt_count, p_run_id)
  join public.session_job_git_inputs git on (git.job_id, git.workspace_id, git.session_id, git.source_checkpoint_run_id) =
    (job.id, job.workspace_id, job.session_id, review.checkpoint_run_id)
  join internal.factory_workflow_attempt_reservations hold on (hold.root_session_id, hold.workspace_id, hold.factory_id,
    hold.session_id, hold.job_id, hold.attempt_count, hold.run_id) =
    (repair.root_session_id, job.workspace_id, review.factory_id, job.session_id, job.id, job.attempt_count, run.id)
  join internal.factory_workflow_exact_review_reports report on
    (report.root_session_id, report.receipt_id) = (repair.root_session_id, repair.review_receipt_id)
  join internal.factory_workflow_joins manifest on
    (manifest.root_session_id, manifest.join_id) = (review.root_session_id, review.join_id)
  where (job.id, job.workspace_id, job.session_id, job.attempt_count) = (repair.job_id, p_workspace_id, p_session_id, p_attempt_count)
    and job.status in ('started', 'running') and run.status in ('started', 'running')
  for update of job, run;
  if not found then raise exception 'The workflow repair attempt is stale.' using errcode = 'PT409'; end if;
  return input;
end;
$$;
revoke all on function public.claim_factory_workflow_exact_review(uuid,uuid,uuid,bigint,uuid,uuid,uuid),
  public.record_factory_workflow_exact_review(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,uuid,text,text,jsonb),
  public.admit_factory_workflow_review_repair(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid),
  public.read_factory_workflow_review_repair_input(uuid,uuid,uuid,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_factory_workflow_exact_review(uuid,uuid,uuid,bigint,uuid,uuid,uuid),
  public.record_factory_workflow_exact_review(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,uuid,text,text,jsonb),
  public.admit_factory_workflow_review_repair(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid),
  public.read_factory_workflow_review_repair_input(uuid,uuid,uuid,uuid,integer)
  to service_role;

-- A marked repair may update source in an original triage stage. It must
-- retain this attempt's exact pinned input and prove its own validation.
create function internal.factory_workflow_repair_delivery_is_proved(
  p_run_id uuid, p_job_id uuid, p_attempt_count integer, p_workspace_id uuid,
  p_session_id uuid, p_repository_id uuid, p_input_sha text, p_output_sha text
) returns boolean language plpgsql stable set search_path = '' as $$
declare
  prior internal.factory_workflow_exact_reviews;
  manifest internal.factory_workflow_joins;
  plan public.session_validation_plans;
  evidence_key text;
begin
  select review.* into prior from internal.factory_workflow_review_repairs repair
  join internal.factory_workflow_exact_reviews review using (root_session_id, review_id)
  join internal.factory_workflow_executions execution using (root_session_id)
  join public.session_job_git_inputs input on (input.job_id, input.workspace_id, input.session_id,
    input.source_checkpoint_run_id, input.pinned_run_id, input.pinned_attempt_count) =
    (repair.job_id, review.workspace_id, review.parent_session_id, review.checkpoint_run_id, p_run_id, p_attempt_count)
  where (repair.job_id, review.workspace_id, review.parent_session_id, review.repository_id, review.commit_sha) =
    (p_job_id, p_workspace_id, p_session_id, p_repository_id, p_input_sha)
    and execution.lifecycle_status = 'running';
  if not found or not internal.factory_workflow_review_source_is_current(prior) then return false; end if;

  select * into strict manifest from internal.factory_workflow_joins stored
  where (stored.root_session_id, stored.join_id) = (prior.root_session_id, prior.join_id);
  select validation.* into plan from public.session_validation_plans validation
  where (validation.run_id, validation.job_id, validation.attempt_count, validation.workspace_id,
    validation.session_id, validation.repository_id, validation.commit_sha) =
    (p_run_id, p_job_id, p_attempt_count, p_workspace_id, p_session_id, p_repository_id, p_output_sha);
  if not found then return false; end if;
  for evidence_key in select jsonb_array_elements_text(manifest.required_evidence) loop
    if evidence_key collate "C" ~ '^browser:(screenshot|video):[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then
      if internal.factory_workflow_browser_evidence_passes(plan, evidence_key) then continue; end if;
    elsif internal.factory_workflow_command_evidence_passes(plan, evidence_key) then continue;
    end if;
    return false;
  end loop;
  return true;
end;
$$;
revoke all on function internal.factory_workflow_repair_delivery_is_proved(uuid,uuid,integer,uuid,uuid,uuid,text,text)
  from public, anon, authenticated, service_role;

create function internal.guard_factory_workflow_repair_checkpoint()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from internal.factory_workflow_review_repairs repair where repair.job_id = new.job_id)
    then return new; end if;
  if not exists (
    select 1 from internal.factory_workflow_join_adoption_fences fence
    where (fence.run_id, fence.transaction_id) = (new.run_id, pg_current_xact_id_if_assigned())
  ) then raise exception 'A repaired artifact requires atomic checkpoint adoption.' using errcode = '42501'; end if;
  if not internal.factory_workflow_repair_delivery_is_proved(new.run_id, new.job_id, new.attempt_count, new.workspace_id,
    new.session_id, new.repository_id, new.input_sha, new.output_sha) then
    raise exception 'The exact workflow repair has no fresh passing evidence.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_factory_workflow_repair_checkpoint() from public,anon,authenticated,service_role;
create trigger guard_factory_workflow_repair_checkpoint before insert on public.session_git_checkpoints
  for each row execute function internal.guard_factory_workflow_repair_checkpoint();

create index factory_workflow_exact_review_due_idx
  on internal.factory_workflow_node_occurrences(admitted_at,root_session_id,occurrence_id) where node_kind = 'review';

-- The scheduler returns only an exact authorized single-issue permit. A
-- second process cannot start remote inference for the same causal occurrence.
create function public.dispatch_next_factory_workflow_exact_review(p_permit uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  due record;
  execution internal.factory_workflow_executions;
  claim jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_permit is null then return null; end if;
  for due in
    select occurrence.root_session_id, occurrence.occurrence_id, workflow.workspace_id, workflow.factory_id
    from internal.factory_workflow_node_occurrences occurrence
    join internal.factory_workflow_executions workflow using (root_session_id)
    join public.workspaces workspace on workspace.id = workflow.workspace_id and workspace.deletion_requested_at is null
    join public.factories factory on (factory.id,factory.workspace_id,factory.status) =
      (workflow.factory_id,workflow.workspace_id,'active')
    left join internal.factory_workflow_exact_reviews review on (review.root_session_id,review.review_occurrence_id) =
      (occurrence.root_session_id,occurrence.occurrence_id)
    where occurrence.node_kind = 'review' and workflow.lifecycle_status = 'running'
      and not exists (select 1 from internal.factory_workflow_exact_review_failures failure
        where (failure.root_session_id, failure.review_id) = (review.root_session_id, review.review_id))
      and not exists (select 1 from internal.factory_workflow_review_attempts attempt
        where (attempt.root_session_id,attempt.review_id) = (review.root_session_id,review.review_id))
      and (not exists (select 1 from internal.factory_workflow_review_repairs repair
          where (repair.root_session_id,repair.next_review_occurrence_id) = (occurrence.root_session_id,occurrence.occurrence_id))
        or exists (select 1 from internal.factory_workflow_review_repairs repair
          join internal.factory_workflow_exact_reviews prior on (prior.root_session_id,prior.review_id) = (repair.root_session_id,repair.review_id)
          join public.session_git_heads head on (head.session_id,head.workspace_id) = (prior.parent_session_id,prior.workspace_id)
          join public.session_git_checkpoints checkpoint on (checkpoint.run_id,checkpoint.job_id) = (head.checkpoint_run_id,repair.job_id)
          where (repair.root_session_id,repair.next_review_occurrence_id) = (occurrence.root_session_id,occurrence.occurrence_id)))
    order by occurrence.admitted_at,occurrence.root_session_id,occurrence.occurrence_id
    limit 16
  loop
    perform 1 from public.workspaces workspace where workspace.id = due.workspace_id and workspace.deletion_requested_at is null
    for share skip locked;
    if not found then continue; end if;
    perform 1 from public.factories factory where (factory.workspace_id,factory.id,factory.status) =
      (due.workspace_id,due.factory_id,'active') for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions session where (session.id,session.workspace_id,session.factory_id) =
      (due.root_session_id,due.workspace_id,due.factory_id) for no key update skip locked;
    if not found then continue; end if;
    select workflow.* into execution from internal.factory_workflow_executions workflow
    where workflow.root_session_id = due.root_session_id and workflow.lifecycle_status = 'running'
    for no key update skip locked;
    if not found then continue; end if;
    begin
      claim := public.claim_factory_workflow_exact_review(due.root_session_id,due.workspace_id,due.factory_id,
        execution.generation,execution.ownership_token,due.occurrence_id,p_permit);
    exception when sqlstate 'PT422' or insufficient_privilege then
      continue;
    end;
    if claim is not null then
      return claim || jsonb_build_object('rootSessionId',due.root_session_id,'workspaceId',due.workspace_id,
        'factoryId',due.factory_id,'occurrenceId',due.occurrence_id,'generation',execution.generation,
        'ownershipToken',execution.ownership_token);
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public.dispatch_next_factory_workflow_exact_review(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.dispatch_next_factory_workflow_exact_review(uuid) to service_role;

create table internal.factory_workflow_repair_dispatch_outcomes (
  root_session_id uuid not null,
  review_id uuid not null,
  progress jsonb not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (root_session_id,review_id),
  foreign key (root_session_id,review_id)
    references internal.factory_workflow_exact_review_reports(root_session_id,review_id) on delete cascade
);
alter table internal.factory_workflow_repair_dispatch_outcomes enable row level security;
revoke all on table internal.factory_workflow_repair_dispatch_outcomes from public,anon,authenticated,service_role;
create trigger freeze_factory_workflow_repair_dispatch_outcome before update on internal.factory_workflow_repair_dispatch_outcomes
  for each row execute function internal.reject_factory_workflow_join_update();

-- An interrupted worker can leave a report without repair admission. Process
-- persisted findings independently. Active parent work delays this dispatch.
create function public.dispatch_next_factory_workflow_review_repair()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  due record;
  execution internal.factory_workflow_executions;
  progress jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  perform 1 from internal.git_continuity_release_control where singleton for share;
  for due in
    select review.root_session_id,review.workspace_id,review.factory_id,review.review_id,report.receipt_id,review.checkpoint_run_id
    from internal.factory_workflow_exact_review_reports report
    join internal.factory_workflow_exact_reviews review using (root_session_id,review_id)
    join internal.factory_workflow_executions workflow on workflow.root_session_id = review.root_session_id
    join public.workspaces workspace on workspace.id = review.workspace_id and workspace.deletion_requested_at is null
    join public.factories factory on (factory.workspace_id,factory.id,factory.status) =
      (review.workspace_id,review.factory_id,'active')
    where report.report->>'verdict' = 'findings' and workflow.lifecycle_status = 'running'
      and not exists (select 1 from internal.factory_workflow_repair_dispatch_outcomes outcome
        where (outcome.root_session_id,outcome.review_id) = (review.root_session_id,review.review_id))
      and not exists (select 1 from internal.factory_workflow_review_repairs admitted
        where (admitted.root_session_id,admitted.review_id) = (review.root_session_id,review.review_id))
      and not exists (select 1 from public.agent_jobs job where (job.session_id,job.workspace_id) =
        (review.parent_session_id,review.workspace_id) and job.status in ('queued','started','running'))
    order by report.recorded_at,report.root_session_id,report.review_id
    limit 16
  loop
    perform 1 from public.workspaces workspace where workspace.id = due.workspace_id and workspace.deletion_requested_at is null
    for share skip locked;
    if not found then continue; end if;
    perform 1 from public.factories factory where (factory.workspace_id,factory.id,factory.status) =
      (due.workspace_id,due.factory_id,'active') for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions root where (root.id,root.workspace_id,root.factory_id) =
      (due.root_session_id,due.workspace_id,due.factory_id) for no key update skip locked;
    if not found then continue; end if;
    select workflow.* into execution from internal.factory_workflow_executions workflow
    where workflow.root_session_id = due.root_session_id and workflow.lifecycle_status = 'running'
    for no key update skip locked;
    if not found then continue; end if;

    progress := public.admit_factory_workflow_review_repair(due.root_session_id,due.workspace_id,due.factory_id,
      execution.generation,execution.ownership_token,due.review_id,due.receipt_id,due.checkpoint_run_id);
    insert into internal.factory_workflow_repair_dispatch_outcomes(root_session_id,review_id,progress)
    values (due.root_session_id,due.review_id,progress) on conflict do nothing;
    return true;
  end loop;
  return false;
end;
$$;
revoke all on function public.dispatch_next_factory_workflow_review_repair()
  from public,anon,authenticated,service_role;
grant execute on function public.dispatch_next_factory_workflow_review_repair() to service_role;

-- Provider calls can die after dispatch. That attempt remains charged and its
-- final state is durable. A failed or expired permit never starts again.
create table internal.factory_workflow_exact_review_failures (
  root_session_id uuid not null,
  review_id uuid not null,
  review_run_id uuid,
  reason text not null check (reason in ('source_unavailable','provider_unavailable','invalid_report',
    'deadline','generation_retired','budget_exhausted')),
  recorded_at timestamptz not null default clock_timestamp(),
  check (review_run_id is not null or reason in ('budget_exhausted','source_unavailable')),
  primary key (root_session_id, review_id),
  foreign key (root_session_id, review_id)
    references internal.factory_workflow_exact_reviews(root_session_id, review_id) on delete cascade,
  foreign key (root_session_id, review_run_id)
    references internal.factory_workflow_review_attempts(root_session_id, review_run_id) on delete cascade
);
alter table internal.factory_workflow_exact_review_failures enable row level security;
revoke all on table internal.factory_workflow_exact_review_failures from public, anon, authenticated, service_role;
create trigger freeze_factory_workflow_exact_review_failure before update on internal.factory_workflow_exact_review_failures
  for each row execute function internal.reject_factory_workflow_join_update();

create function public.is_factory_workflow_exact_review_active(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_review_id uuid, p_review_run_id uuid, p_permit uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  review internal.factory_workflow_exact_reviews;
begin
  perform internal.assert_checkpoint_publication_service();
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.lifecycle_status <> 'running' then return false; end if;
  select bound.* into review from internal.factory_workflow_exact_reviews bound
  where (bound.root_session_id, bound.workspace_id, bound.factory_id, bound.review_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_review_id);
  if not found or not internal.recheck_factory_workflow_delegation_lineage(
    p_root_session_id, p_workspace_id, p_factory_id, review.parent_session_id
  ) or not internal.factory_workflow_review_source_is_current(review) then return false; end if;
  return exists (select 1 from internal.factory_workflow_review_attempts attempt
    where (attempt.root_session_id, attempt.review_id, attempt.review_run_id, attempt.generation, attempt.permit) =
      (p_root_session_id, p_review_id, p_review_run_id, p_expected_generation, p_permit)
      and attempt.deadline_at > clock_timestamp())
    and not exists (select 1 from internal.factory_workflow_exact_review_reports report
      where (report.root_session_id, report.review_id) = (p_root_session_id, p_review_id))
    and not exists (select 1 from internal.factory_workflow_exact_review_failures failure
      where (failure.root_session_id, failure.review_id) = (p_root_session_id, p_review_id));
end;
$$;

create function public.fail_factory_workflow_exact_review(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_review_id uuid, p_review_run_id uuid, p_permit uuid, p_reason text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  attempt internal.factory_workflow_review_attempts;
  reason text;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_reason is null or p_reason not in ('source_unavailable','provider_unavailable','invalid_report','budget_exhausted') then
    raise exception 'Invalid exact review failure.' using errcode = '22023';
  end if;
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  if execution.lifecycle_status <> 'running' then return false; end if;
  select issued.* into attempt from internal.factory_workflow_review_attempts issued
  where (issued.root_session_id, issued.review_id, issued.review_run_id, issued.generation, issued.permit) =
    (p_root_session_id, p_review_id, p_review_run_id, p_expected_generation, p_permit);
  if not found or exists (select 1 from internal.factory_workflow_exact_review_reports report
    where (report.root_session_id, report.review_id) = (p_root_session_id, p_review_id)) then return false; end if;
  reason := case when clock_timestamp() >= attempt.deadline_at then 'deadline' else p_reason end;
  insert into internal.factory_workflow_exact_review_failures(root_session_id, review_id, review_run_id, reason)
  values (p_root_session_id, p_review_id, p_review_run_id, reason)
  on conflict (root_session_id, review_id) do nothing;
  return true;
end;
$$;

-- Maintenance records at most one interrupted or expired permit per call.
create function public.expire_next_factory_workflow_exact_review()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  due record;
  execution internal.factory_workflow_executions;
begin
  perform internal.assert_checkpoint_publication_service();
  for due in
    select attempt.*, workflow.workspace_id, workflow.factory_id
    from internal.factory_workflow_review_attempts attempt
    join internal.factory_workflow_executions workflow using (root_session_id)
    where workflow.lifecycle_status = 'running'
      and (attempt.deadline_at <= clock_timestamp() or attempt.generation <> workflow.generation)
      and not exists (select 1 from internal.factory_workflow_exact_review_reports report
        where (report.root_session_id, report.review_id) = (attempt.root_session_id, attempt.review_id))
      and not exists (select 1 from internal.factory_workflow_exact_review_failures failure
        where (failure.root_session_id, failure.review_id) = (attempt.root_session_id, attempt.review_id))
    order by attempt.deadline_at, attempt.root_session_id
    limit 16
  loop
    perform 1 from public.workspaces workspace where workspace.id = due.workspace_id and workspace.deletion_requested_at is null
    for share skip locked;
    if not found then continue; end if;
    perform 1 from public.factories factory where (factory.workspace_id,factory.id,factory.status) =
      (due.workspace_id,due.factory_id,'active') for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions session where (session.id,session.workspace_id,session.factory_id) =
      (due.root_session_id,due.workspace_id,due.factory_id) for no key update skip locked;
    if not found then continue; end if;
    select workflow.* into execution from internal.factory_workflow_executions workflow
    where workflow.root_session_id = due.root_session_id and workflow.lifecycle_status = 'running'
    for no key update skip locked;
    if not found or exists (select 1 from internal.factory_workflow_exact_review_reports report
      where (report.root_session_id, report.review_id) = (due.root_session_id, due.review_id)) then continue; end if;
    insert into internal.factory_workflow_exact_review_failures(root_session_id, review_id, review_run_id, reason)
    values (due.root_session_id, due.review_id, due.review_run_id,
      case when due.generation <> execution.generation then 'generation_retired' else 'deadline' end)
    on conflict (root_session_id, review_id) do nothing;
    if found then return true; end if;
  end loop;
  return false;
end;
$$;

revoke all on function public.is_factory_workflow_exact_review_active(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid),
  public.fail_factory_workflow_exact_review(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text),
  public.expire_next_factory_workflow_exact_review() from public, anon, authenticated, service_role;
grant execute on function public.is_factory_workflow_exact_review_active(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid),
  public.fail_factory_workflow_exact_review(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text),
  public.expire_next_factory_workflow_exact_review() to service_role;

-- A reviewer receives the exact named prompt and the parent definition's
-- inherited inference authority. Review does not change repository or grant.
create function public.read_factory_workflow_exact_review_provider(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_review_id uuid, p_review_run_id uuid, p_permit uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  review internal.factory_workflow_exact_reviews;
  owner public.sessions;
  pinned public.session_factory_admission_inputs;
  definition jsonb;
  prompt public.factory_agent_prompt_revisions;
  binding public.factory_secret_bindings;
  input_sha text;
  encrypted_credential text;
begin
  if not public.is_factory_workflow_exact_review_active(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token, p_review_id, p_review_run_id, p_permit) then return null; end if;
  select bound.* into strict review from internal.factory_workflow_exact_reviews bound
  where (bound.root_session_id, bound.review_id) = (p_root_session_id, p_review_id);
  select * into strict owner from public.sessions session where (session.id, session.workspace_id, session.factory_id) =
    (review.parent_session_id, p_workspace_id, p_factory_id);
  select * into strict pinned from public.session_factory_admission_inputs admission
  where (admission.session_id, admission.workspace_id, admission.factory_id, admission.definition_revision_id) =
    (owner.id, p_workspace_id, p_factory_id, owner.factory_definition_revision_id);
  definition := internal.pinned_session_execution_definition(owner);
  if definition#>>'{agent,provider}' is distinct from 'codex'
    or definition#>>'{agent,model}' is null or definition->>'repositoryId' is distinct from review.repository_id::text
    then return null; end if;
  select revision.* into prompt from public.factory_agent_prompt_revisions revision
  where (revision.id, revision.workspace_id, revision.factory_id) =
    (review.reviewer_prompt_revision_id, p_workspace_id, p_factory_id)
    and revision.prompt_sha256 = encode(sha256(convert_to(revision.prompt_md, 'UTF8')), 'hex')
    and octet_length(revision.prompt_md) <= 24576;
  if not found then return null; end if;
  binding := internal.lock_definition_credential_binding(p_workspace_id, p_factory_id, definition,
    pinned.execution_grant_id, pinned.credential_owner_service_principal_id);
  select secret.encrypted_value into strict encrypted_credential from public.workspace_secrets secret
  where (secret.workspace_id, secret.id) = (p_workspace_id, binding.workspace_secret_id);
  select checkpoint.input_sha into strict input_sha from public.session_git_checkpoints checkpoint
  where (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.repository_id) =
    (review.checkpoint_run_id, p_workspace_id, review.parent_session_id, review.repository_id);
  return jsonb_build_object('model', definition#>>'{agent,model}', 'promptMd', prompt.prompt_md,
    'promptSha256', prompt.prompt_sha256, 'encryptedCredential', encrypted_credential, 'inputSha', input_sha);
end;
$$;
revoke all on function public.read_factory_workflow_exact_review_provider(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_workflow_exact_review_provider(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid)
  to service_role;

create or replace function internal.factory_workflow_branch_attempt_budget_exhausted(
  p_execution internal.factory_workflow_executions
) returns boolean language sql stable set search_path = '' as $$
  with policy as (
    select p_execution.workflow_json::jsonb->'delegationPolicy' as graph_limits
  ), caps as (
    select (policy.graph_limits->>'maxAttempts')::integer as max_attempts,
      (policy.graph_limits->>'maxTokensPerAttempt')::bigint as next_tokens,
      (policy.graph_limits->>'maxCostUsdPerAttempt')::numeric as next_cost,
      least((policy.graph_limits->>'maxTotalTokens')::bigint,
        (revision.requirements->>'maxTotalTokens')::bigint) as max_tokens,
      least((policy.graph_limits->>'maxCostUsd')::numeric,
        (revision.requirements->>'maxCostUsd')::numeric) as max_cost
    from policy cross join public.sessions root
    left join public.execution_policy_revisions revision
      on (revision.workspace_id, revision.id) = (root.workspace_id, root.execution_policy_revision_id)
    where (root.id, root.workspace_id, root.factory_id) =
      (p_execution.root_session_id, p_execution.workspace_id, p_execution.factory_id)
  ), committed_attempts as (
    -- Binding makes the attempt count durable. Exact measured reservation
    -- receipts can only grow, even if they arrive after cancellation.
    select case when reservation.token_provenance = 'measured' then reservation.reported_tokens end as tokens,
      case when reservation.cost_provenance = 'measured' then reservation.reported_cost_usd end as cost
    from internal.factory_workflow_attempt_reservations reservation
    where reservation.root_session_id = p_execution.root_session_id and reservation.run_id is not null
    union all
    -- Match the canonical pre-enrollment root fallback exactly. Its legacy
    -- writer can replace measurements while a run is still active.
    select case when run.status in ('success', 'error', 'canceled') and run.token_provenance = 'measured'
        then run.input_tokens::numeric + run.output_tokens end,
      case when run.status in ('success', 'error', 'canceled') and run.cost_provenance = 'measured'
        then run.total_cost_usd end
    from public.agent_runs run
    where run.session_id = p_execution.root_session_id and run.attempt_count > 0
      and not exists (
        select 1 from internal.factory_workflow_attempt_reservations reservation
        where (reservation.job_id, reservation.attempt_count) = (run.agent_job_id, run.attempt_count)
      )
    union all
    -- Foreman issues are one-shot and their observed usage only increases.
    -- A partial receipt proves its known token components, not the hold.
    select coalesce(invocation.input_tokens, 0)::numeric + coalesce(invocation.output_tokens, 0), invocation.cost_usd
    from internal.factory_workflow_foreman_runs invocation
    where invocation.root_session_id = p_execution.root_session_id
    union all
    -- An issued exact review conservatively retains its full finite charge.
    select attempt.reserved_tokens, attempt.reserved_cost_usd
    from internal.factory_workflow_review_attempts attempt
    where attempt.root_session_id = p_execution.root_session_id
  ), committed as (
    select count(*) as attempts, coalesce(sum(tokens), 0) as tokens, coalesce(sum(cost), 0) as cost
    from committed_attempts
  )
  select coalesce((
    select committed.attempts + 1 > caps.max_attempts
      or committed.tokens + caps.next_tokens > caps.max_tokens
      or committed.cost + caps.next_cost > caps.max_cost
    from caps cross join committed
  ), false)
$$;

-- Validate the review policies in the native registration path as well as the compiler.
create function internal.is_enrollable_factory_workflow_review(
  p_workspace_id uuid, p_factory_id uuid, p_plan jsonb
) returns boolean language sql stable set search_path = '' as $$
  with nodes as (
    select value as body, value->>'id' as id, value->>'kind' as kind
    from jsonb_array_elements(p_plan->'nodes')
  ), edges as (
    select value->>'id' as id, value->>'from' as source, value->>'to' as target, value->>'kind' as kind
    from jsonb_array_elements(p_plan->'edges')
  ), reviews as (
    select id, body, body->'ruleIds' as rules, body->'repair' as repair
    from nodes where kind = 'review'
  )
  select not exists (
    select 1 from reviews review
    where review.id = p_plan->>'entryNodeId'
      or p_plan->'delegationPolicy' is null
      or review.body - array['id','kind','reviewerPromptRevisionId','ruleIds','repair'] <> '{}'::jsonb
      or (select count(*) from edges where edges.target = review.id) <> 1
      or not exists (select 1 from edges join nodes source on source.id = edges.source
        where edges.target = review.id and edges.kind = 'next' and source.kind = 'join')
      or not exists (select 1 from public.factory_agent_prompt_revisions prompt
        where (prompt.workspace_id, prompt.factory_id, prompt.id::text) =
          (p_workspace_id, p_factory_id, review.body->>'reviewerPromptRevisionId'))
      or case when jsonb_typeof(review.rules) is distinct from 'array' then true else
        jsonb_array_length(review.rules) not between 1 and 32
        or (select count(distinct rule) from jsonb_array_elements(review.rules) rule) <> jsonb_array_length(review.rules)
        or exists (select 1 from jsonb_array_elements(review.rules) rule
          where jsonb_typeof(rule) is distinct from 'string' or length(rule #>> '{}') > 96
            or (rule #>> '{}') collate "C" !~ '^[a-z0-9]+([.-][a-z0-9]+)*$')
      end
      or (review.repair is not null and case when jsonb_typeof(review.repair) is distinct from 'object'
          or jsonb_typeof(review.repair->'eligibleRuleIds') is distinct from 'array' then true else
        review.repair - array['edgeId','maxRepairs','eligibleRuleIds'] <> '{}'::jsonb
        or jsonb_typeof(review.repair->'edgeId') is distinct from 'string'
        or length(review.repair->>'edgeId') > 96
        or (review.repair->>'edgeId') collate "C" !~ '^[a-z0-9]+([.-][a-z0-9]+)*$'
        or jsonb_typeof(review.repair->'maxRepairs') is distinct from 'number'
        or (review.repair->>'maxRepairs') collate "C" !~ '^[1-8]$'
        or jsonb_array_length(review.repair->'eligibleRuleIds') not between 1 and 32
        or (select count(distinct rule) from jsonb_array_elements(review.repair->'eligibleRuleIds') rule)
            <> jsonb_array_length(review.repair->'eligibleRuleIds')
        or not (review.rules @> (review.repair->'eligibleRuleIds'))
        or exists (select 1 from edges where edges.id = review.repair->>'edgeId')
        or exists (select 1 from reviews sibling where sibling.id <> review.id
          and sibling.repair->>'edgeId' = review.repair->>'edgeId')
      end)
  );
$$;
revoke all on function internal.is_enrollable_factory_workflow_review(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

-- Newer review and join occurrences both end the causal walk. A pending review
-- never falls through to an older passing review or to the first join.
create function internal.factory_workflow_occurrence_review_checkpoint(
  p_root_session_id uuid, p_occurrence_id uuid
) returns table(review_occurrence_id uuid, parent_session_id uuid, checkpoint_run_id uuid)
language sql stable set search_path = '' as $$
  with recursive ancestry(occurrence_id, kind, depth) as (
    select occurrence.occurrence_id, occurrence.node_kind, 0
    from internal.factory_workflow_node_occurrences occurrence
    where (occurrence.root_session_id, occurrence.occurrence_id) = (p_root_session_id, p_occurrence_id)
    union all
    select predecessor.occurrence_id, predecessor.node_kind, ancestry.depth + 1
    from ancestry
    join internal.factory_workflow_transition_receipts transition on
      (transition.root_session_id, transition.target_occurrence_id) = (p_root_session_id, ancestry.occurrence_id)
    join internal.factory_workflow_node_occurrences predecessor on
      (predecessor.root_session_id, predecessor.occurrence_id) = (transition.root_session_id, transition.source_occurrence_id)
    where ancestry.kind not in ('join', 'review') and ancestry.depth < 1023
  )
  select boundary.occurrence_id, review.parent_session_id, case when report.report->>'verdict' = 'pass'
    and result.evidence_ref = 'exact-review:' || report.receipt_id
    then review.checkpoint_run_id end
  from ancestry boundary
  left join internal.factory_workflow_exact_reviews review on
    (review.root_session_id, review.review_occurrence_id) = (p_root_session_id, boundary.occurrence_id)
  left join internal.factory_workflow_exact_review_reports report on
    (report.root_session_id, report.review_id) = (review.root_session_id, review.review_id)
  left join internal.factory_workflow_node_results result on
    (result.root_session_id, result.occurrence_id, result.outcome) = (p_root_session_id, boundary.occurrence_id, 'succeeded')
  where boundary.kind = 'review';
$$;
revoke all on function internal.factory_workflow_occurrence_review_checkpoint(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Admission still goes through the guarded next-edge command.
create function internal.admit_factory_workflow_exact_review_successor(
  p_execution internal.factory_workflow_executions, p_occurrence_id uuid, p_result_id uuid,
  p_review_target_only boolean
) returns void language plpgsql set search_path = '' as $$
declare
  next_edge text;
  blocker text;
begin
  select edge->>'id' into next_edge
  from internal.factory_workflow_node_occurrences occurrence
  cross join lateral jsonb_array_elements(p_execution.workflow_json::jsonb->'edges') edge
  join lateral jsonb_array_elements(p_execution.workflow_json::jsonb->'nodes') target
    on target->>'id' = edge->>'to'
  where (occurrence.root_session_id, occurrence.occurrence_id) = (p_execution.root_session_id, p_occurrence_id)
    and edge->>'from' = occurrence.node_id and edge->>'kind' = 'next'
    and (not p_review_target_only or target->>'kind' = 'review');
  if next_edge is null then return; end if;

  -- Retain the exact accepted result if earlier routed work consumed the
  -- remaining visit capacity. Guarded next reports that limit to observers.
  begin
    perform public.admit_factory_workflow_next(p_execution.root_session_id, p_execution.workspace_id, p_execution.factory_id,
      p_execution.generation, p_execution.ownership_token, p_occurrence_id, next_edge, p_result_id);
  exception when sqlstate 'PT409' then
    get stacked diagnostics blocker = pg_exception_detail;
    if blocker is distinct from 'workflow_visit_limit_exhausted' then raise; end if;
  end;
end;
$$;
revoke all on function internal.admit_factory_workflow_exact_review_successor(
  internal.factory_workflow_executions, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;

-- Primary adoption and delayed repository settlement can both produce this
-- result. Only the durable successful result can admit a direct review.
create function internal.admit_factory_workflow_review_after_join_result()
returns trigger language plpgsql set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
begin
  select workflow.* into execution
  from internal.factory_workflow_executions workflow
  join internal.factory_workflow_joins manifest on manifest.root_session_id = workflow.root_session_id
  join internal.factory_workflow_join_outcomes terminal
    on (terminal.root_session_id, terminal.join_id) = (manifest.root_session_id, manifest.join_id)
  where (manifest.root_session_id, manifest.join_occurrence_id, terminal.outcome) =
    (new.root_session_id, new.occurrence_id, 'adopted')
    and new.evidence_ref = 'join-checkpoint:' || terminal.checkpoint_run_id
    and workflow.lifecycle_status = 'running';
  if found then
    perform internal.admit_factory_workflow_exact_review_successor(execution, new.occurrence_id, new.result_id, true);
  end if;
  return new;
end;
$$;
revoke all on function internal.admit_factory_workflow_review_after_join_result()
  from public, anon, authenticated, service_role;
create trigger admit_factory_workflow_review_after_join_result after insert on internal.factory_workflow_node_results
  for each row when (new.outcome = 'succeeded' and new.evidence_ref like 'join-checkpoint:%')
  execute function internal.admit_factory_workflow_review_after_join_result();

create or replace function public.start_factory_workflow_graph_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_graph_revision_id uuid,
  p_input_run_id uuid default null
) returns table (execution_generation bigint, entry_occurrence_id uuid, created boolean, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  graph internal.factory_workflow_graph_revisions;
  execution internal.factory_workflow_executions;
  input_job_id uuid;
  input_attempt_count integer;
  input_publication public.session_checkpoint_publications;
  plan jsonb;
  entry jsonb;
  has_branches boolean;
  triage internal.factory_workflow_triage_bindings;
begin
  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select revision.* into graph from internal.factory_workflow_graph_revisions revision
    join public.session_factory_admission_inputs pin
      on (pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest) =
        (revision.workspace_id, revision.factory_id, revision.definition_revision_id, revision.definition_digest)
    join public.sessions session on session.id = pin.session_id
   where (revision.workspace_id, revision.factory_id, revision.id, pin.session_id) =
     (p_workspace_id, p_factory_id, p_graph_revision_id, p_root_session_id)
     and session.execute_pinned_definition
     and session.factory_definition_revision_id = pin.definition_revision_id;
  if not found then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  select workflow.* into execution from internal.factory_workflow_executions workflow
   where workflow.root_session_id = p_root_session_id;
  if found then
    if (execution.graph_revision_id, execution.graph_input_run_id) is distinct from (graph.id, p_input_run_id) then
      raise exception 'The root session already has a different workflow or input run.' using errcode = 'PT409';
    end if;
    return query select execution.generation, occurrence.occurrence_id, false, null::uuid
      from internal.factory_workflow_node_occurrences occurrence
     where occurrence.root_session_id = p_root_session_id and occurrence.is_entry;
    return;
  end if;

  if exists (select 1 from internal.factory_workflow_delegations marker
    where (marker.child_session_id, marker.workspace_id, marker.factory_id) =
      (p_root_session_id, p_workspace_id, p_factory_id)) then
    raise exception 'A delegated child cannot start an independent workflow graph.' using errcode = 'PT409';
  end if;
  select binding.* into triage from internal.factory_workflow_triage_bindings binding
  where (binding.session_id, binding.workspace_id, binding.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id);
  if found then
    perform internal.assert_factory_workflow_accepted_scope_enrollment(triage, graph.id, graph.workflow_digest, p_input_run_id);
  elsif exists (select 1 from public.sessions session
    where session.id = p_root_session_id and session.archived_at is not null) then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  -- Existing command and route capabilities, plus guarded routed child admission.
  plan := graph.workflow_json::jsonb;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node
    where coalesce(node->>'kind', '') not in ('deterministic', 'human-gate', 'route', 'agent', 'branch', 'join', 'review')
      or (node->>'kind' = 'deterministic' and coalesce(node->>'operation', '') not in ('validation', 'policy', 'checkpoint'))) then
    raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode = 'PT422';
  end if;
  if not internal.is_enrollable_factory_workflow_review(p_workspace_id, p_factory_id, plan) then
    raise exception 'The graph requires an exact join review and bounded repair declaration.' using errcode = 'PT422';
  end if;
  has_branches := exists (select 1 from jsonb_array_elements(plan->'nodes') node
    where node->>'kind' in ('branch', 'join'));
  if has_branches and not internal.is_bounded_factory_workflow_branch_graph(plan) then
    raise exception 'The graph must match a bounded workflow branch topology.' using errcode = 'PT422';
  end if;
  if not internal.is_enrollable_factory_workflow_delegation(p_workspace_id, p_factory_id, plan) then
    raise exception 'The graph requires bounded delegation and exact scoped child profiles.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'kind' = 'route') then
    if not has_branches and not internal.is_bounded_factory_workflow_route_graph(plan) then
      raise exception 'The graph must match a bounded workflow route policy.' using errcode = 'PT422';
    end if;
    if exists (
      select 1 from jsonb_array_elements(plan->'nodes') node
      where node->>'kind' = 'route' and (
        jsonb_typeof(node->'agentPromptRevisionId') is distinct from 'string'
        or not exists (
          select 1 from public.factory_agent_prompt_revisions prompt
          where (prompt.workspace_id, prompt.factory_id, prompt.id::text) =
            (p_workspace_id, p_factory_id, node->>'agentPromptRevisionId')
        )
      )
    ) then
      raise exception 'The graph requires scoped route prompt revisions.' using errcode = 'PT422';
    end if;
    if not internal.is_enrollable_factory_workflow_foreman(p_workspace_id, p_factory_id, plan) then
      raise exception 'The graph requires a scoped foreman profile and bounded delegation.' using errcode = 'PT422';
    end if;
  elsif not has_branches and not internal.is_bounded_factory_workflow_next_path(plan) then
    raise exception 'The graph must form one next-only path with at most 128 nodes.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'operation' = 'validation')
    and not exists (
      select 1 from public.sessions session
      join public.delivery_policy_revisions policy
        on (policy.id, policy.workspace_id, policy.pipeline_id) =
          (session.pinned_delivery_policy_revision_id, session.workspace_id, session.pipeline_id)
      where session.id = p_root_session_id and jsonb_array_length(policy.requirements->'requiredEvidence') > 0
        and not exists (
          select 1 from jsonb_array_elements_text(policy.requirements->'requiredEvidence') evidence(key)
          where evidence.key collate "C" !~
            '^([A-Za-z0-9][A-Za-z0-9._/-]{0,199}|browser:(screenshot|video):[A-Za-z0-9][A-Za-z0-9._-]{0,99})$'
        )
    ) then
    raise exception 'The graph requires a pinned delivery policy with valid required evidence.' using errcode = 'PT422';
  end if;
  if p_input_run_id is null and (has_branches or exists (
    select 1 from jsonb_array_elements(plan->'nodes') node
    where node->>'kind' = 'human-gate' or node->>'operation' in ('validation', 'checkpoint')
  )) then
    raise exception 'The graph requires a scoped checkpoint input run.' using errcode = 'PT422';
  end if;
  select node into strict entry from jsonb_array_elements(plan->'nodes') node where node->>'id' = plan->>'entryNodeId';

  if p_input_run_id is not null then
    -- Follow the root, job, run, publication lock order used by checkpoint adoption.
    select job.id, job.attempt_count into input_job_id, input_attempt_count
    from public.agent_jobs job
    join public.agent_runs run on (run.agent_job_id, run.session_id, run.workspace_id) =
      (job.id, job.session_id, job.workspace_id)
    where run.id = p_input_run_id and (job.session_id, job.workspace_id) = (p_root_session_id, p_workspace_id)
      and job.attempt_count > 0
    for share of job;

    perform 1 from public.agent_runs run
    where (run.id, run.agent_job_id, run.session_id, run.workspace_id, run.attempt_count) =
      (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
    for share;
    if found then
      select publication.* into input_publication from public.session_checkpoint_publications publication
      where (publication.run_id, publication.job_id, publication.session_id, publication.workspace_id, publication.attempt_count) =
        (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
      for share;
    end if;
    if input_publication.run_id is null or not (
      input_publication.status = 'adopted'
      or (input_publication.status in ('pending', 'claimed')
        and input_publication.deadline_at > clock_timestamp()
        and internal.checkpoint_publication_is_current(input_publication))
    ) then
      raise exception 'The graph input run has no current scoped checkpoint publication intent.' using errcode = 'PT409';
    end if;
  end if;

  return query
    with enrolled as (
      insert into internal.factory_workflow_executions (
        root_session_id, workspace_id, factory_id, definition_revision_id, definition_digest,
        graph_revision_id, graph_input_run_id, workflow_json, workflow_digest
      ) values (p_root_session_id, p_workspace_id, p_factory_id, graph.definition_revision_id, graph.definition_digest,
        graph.id, p_input_run_id, graph.workflow_json, graph.workflow_digest)
      returning factory_workflow_executions.generation, factory_workflow_executions.ownership_token
    ), admitted as (
      insert into internal.factory_workflow_node_occurrences (
        root_session_id, node_id, node_kind, is_entry, admitted_generation
      ) select p_root_session_id, entry->>'id', (entry->>'kind')::internal.factory_workflow_node_kind, true, enrolled.generation
        from enrolled
      returning occurrence_id
    )
    select enrolled.generation, admitted.occurrence_id, true, enrolled.ownership_token from enrolled cross join admitted;
end;
$$;

create or replace function internal.factory_workflow_causal_command_checkpoint(
  p_execution internal.factory_workflow_executions,p_occurrence_id uuid
) returns public.session_git_checkpoints language plpgsql set search_path='' as $$
declare source record; parent public.sessions; pinned public.session_factory_admission_inputs; accepted public.session_git_checkpoints;
begin
  select * into source from internal.factory_workflow_occurrence_review_checkpoint(p_execution.root_session_id,p_occurrence_id);
  if not found then
    select * into source from internal.factory_workflow_occurrence_join_checkpoint(p_execution.root_session_id,p_occurrence_id);
  end if;
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

create or replace function internal.factory_workflow_occurrence_evidence_is_current(
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
  select * into source from internal.factory_workflow_occurrence_review_checkpoint(p_execution.root_session_id,p_occurrence_id);
  if not found then
    select * into source from internal.factory_workflow_occurrence_join_checkpoint(p_execution.root_session_id,p_occurrence_id);
  end if;
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
  ) and not internal.factory_workflow_repair_delivery_is_proved(new.run_id,new.job_id,new.attempt_count,
    new.workspace_id,new.session_id,new.repository_id,new.base_sha,new.head_sha) then
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
  is_repair boolean;
begin
  select exists (select 1 from internal.factory_workflow_review_repairs repair where repair.job_id = p_job_id)
    into is_repair;
  if is_repair and not exists (
    select 1 from internal.factory_workflow_join_adoption_fences fence
    where (fence.run_id, fence.transaction_id) = (p_run_id, pg_current_xact_id_if_assigned())
  ) then raise exception 'A repaired artifact requires atomic checkpoint adoption.' using errcode = '42501'; end if;
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
  elsif is_repair then
    message.body_md := 'A workflow repair is ready for review.';
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
  prior_review internal.factory_workflow_exact_reviews;
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
  select reviewed.* into prior_review from internal.factory_workflow_review_repairs repair
  join internal.factory_workflow_exact_reviews reviewed using (root_session_id,review_id)
  join public.session_checkpoint_publications publication on publication.job_id = repair.job_id
  where publication.run_id = p_run_id and publication.status <> 'adopted';
  if found then
    perform internal.lock_factory_workflow_root(prior_review.root_session_id,prior_review.workspace_id,prior_review.factory_id);
    -- An exact replay may have committed its new head while the root lock was held.
    if not exists (select 1 from public.session_checkpoint_publications publication
      where publication.run_id = p_run_id and publication.status = 'adopted') then
      perform 1 from internal.factory_workflow_executions workflow where workflow.root_session_id = prior_review.root_session_id
        and workflow.lifecycle_status = 'running' for no key update;
      if not found or not internal.recheck_factory_workflow_delegation_lineage(
        prior_review.root_session_id,prior_review.workspace_id,prior_review.factory_id,prior_review.parent_session_id
      ) or not internal.factory_workflow_review_source_is_current(prior_review) then return false; end if;
    end if;
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
  if join_manifest.join_id is not null or prior_review.review_id is not null then
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
  end if;
  if join_manifest.join_id is not null or prior_review.review_id is not null then
    delete from internal.factory_workflow_join_adoption_fences where run_id = p_run_id;
  end if;
  if clock_timestamp()>=p.deadline_at or clock_timestamp()>=p.lease_expires_at then
    raise exception 'Checkpoint publication lease or deadline expired before adoption.' using errcode='57014';
  end if;
  return true;
end;
$$;

create or replace function internal.factory_workflow_root_join_keeps_scope(
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
        and thread.artifact_id = p_saved.artifact_id and thread.kind = 'blocking' and thread.status = 'open')
  for share of head;
  if not found then return false; end if;
  accepted := internal.factory_workflow_adopted_checkpoint(p_saved.session_id, p_saved.workspace_id,
    p_saved.factory_id, p_binding.definition_revision_id, p_binding.definition_digest, current_run_id);
  if accepted.run_id is null or accepted.repository_id is distinct from p_saved.repository_id then return false; end if;

  return exists (
    with recursive accepted_edges(run_id, prior_run_id) as (
      select terminal.checkpoint_run_id, manifest.expected_head_run_id
      from internal.factory_workflow_join_outcomes terminal
      join internal.factory_workflow_joins manifest using (root_session_id, join_id)
      join internal.factory_workflow_node_results result on
        (result.root_session_id, result.occurrence_id, result.outcome, result.evidence_ref) =
        (manifest.root_session_id, manifest.join_occurrence_id, 'succeeded', 'join-checkpoint:' || terminal.checkpoint_run_id)
      where (manifest.root_session_id, manifest.workspace_id, manifest.factory_id, manifest.parent_session_id,
        manifest.workflow_digest, manifest.repository_id, terminal.outcome) =
        (p_saved.session_id, p_saved.workspace_id, p_saved.factory_id, p_saved.session_id, p_saved.workflow_digest,
          p_saved.repository_id, 'adopted')
      union all
      select checkpoint.run_id, review.checkpoint_run_id
      from internal.factory_workflow_review_repairs repair
      join internal.factory_workflow_exact_reviews review using (root_session_id, review_id)
      join public.session_git_checkpoints checkpoint on
        (checkpoint.job_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.repository_id, checkpoint.input_sha) =
        (repair.job_id, review.workspace_id, review.parent_session_id, review.repository_id, review.commit_sha)
      join public.session_job_git_inputs input on
        (input.job_id, input.workspace_id, input.session_id, input.source_checkpoint_run_id, input.pinned_run_id,
          input.pinned_attempt_count) =
        (repair.job_id, review.workspace_id, review.parent_session_id, review.checkpoint_run_id, checkpoint.run_id,
          checkpoint.attempt_count)
      join public.session_checkpoint_publications publication on
        (publication.run_id, publication.workspace_id, publication.session_id, publication.job_id,
          publication.attempt_count, publication.artifact_id, publication.status) =
        (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id,
          checkpoint.attempt_count, checkpoint.artifact_id, 'adopted')
      where (review.root_session_id, review.workspace_id, review.factory_id, review.parent_session_id,
        review.workflow_digest, review.repository_id) =
        (p_saved.session_id, p_saved.workspace_id, p_saved.factory_id, p_saved.session_id, p_saved.workflow_digest,
          p_saved.repository_id)
    ), lineage(run_id, depth) as (
      select current_run_id, 0
      union all
      select edge.prior_run_id, lineage.depth + 1
      from lineage join accepted_edges edge using (run_id)
      where lineage.depth < 1023 and lineage.run_id <> p_saved.run_id
    )
    select 1 from lineage where lineage.run_id = p_saved.run_id
  );
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
  -- A later approval of an exact adopted join or repair is a new human decision.
  -- Only the original specification approval enrolls and freezes triage scope.
  select receipt.* into saved from internal.factory_workflow_accepted_scopes receipt
  where (receipt.session_id,receipt.workspace_id,receipt.factory_id) =
    (binding.session_id,binding.workspace_id,binding.factory_id);
  if found and accepted_run_id is not null and internal.factory_workflow_root_join_keeps_scope(binding,saved) then
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

create or replace function public.read_factory_workflow_delegated_scope(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  marker internal.factory_workflow_delegations;
  repair internal.factory_workflow_exact_reviews;
  binding internal.factory_workflow_triage_bindings;
  saved internal.factory_workflow_accepted_scopes;
  owner_job public.agent_jobs;
  artifact_md text;
begin
  perform internal.assert_checkpoint_publication_service();
  select delegated.* into marker from public.agent_jobs job
  join internal.factory_workflow_delegations delegated on (delegated.child_session_id, delegated.workspace_id) =
    (job.session_id, job.workspace_id)
  where (job.id, job.workspace_id) = (p_job_id, p_workspace_id);
  if not found then
    select review.* into repair from internal.factory_workflow_review_repairs marked
    join internal.factory_workflow_exact_reviews review using (root_session_id, review_id)
    where (marked.job_id, review.workspace_id, review.parent_session_id) =
      (p_job_id, p_workspace_id, review.root_session_id);
    if not found then return jsonb_build_object('status', 'ordinary'); end if;

    select receipt.receipt_id into marker.accepted_scope_receipt_id
    from internal.factory_workflow_accepted_scopes receipt
    where (receipt.session_id, receipt.workspace_id, receipt.factory_id) =
      (repair.root_session_id, repair.workspace_id, repair.factory_id);
    marker.root_session_id := repair.root_session_id;
    marker.workspace_id := repair.workspace_id;
    marker.factory_id := repair.factory_id;
    marker.parent_session_id := repair.parent_session_id;
    marker.child_session_id := repair.parent_session_id;
  end if;

  select pinned.* into binding from internal.factory_workflow_triage_bindings pinned
  where (pinned.session_id, pinned.workspace_id, pinned.factory_id) =
    (marker.root_session_id, marker.workspace_id, marker.factory_id);
  if not found and marker.accepted_scope_receipt_id is null then
    return jsonb_build_object('status','ordinary');
  end if;
  if binding.session_id is null or marker.accepted_scope_receipt_id is null then
    raise exception 'The delegated accepted scope pin is unavailable.' using errcode = '42501';
  end if;

  -- Match the release → workspace/factory → root → child/job/run order of start.
  perform 1 from internal.git_continuity_release_control where singleton for share;
  perform internal.lock_factory_workflow_root(marker.root_session_id, marker.workspace_id, marker.factory_id);
  if not internal.recheck_factory_workflow_delegation_lineage(
    marker.root_session_id, marker.workspace_id, marker.factory_id, marker.parent_session_id
  ) then
    raise exception 'The delegated scope authority is unavailable.' using errcode = '42501';
  end if;
  if repair.review_id is not null and public.read_factory_workflow_review_repair_input(
    p_workspace_id, repair.parent_session_id, p_job_id, p_run_id, p_attempt_count
  ) is null then
    raise exception 'The workflow repair scope belongs to a different attempt.' using errcode = '42501';
  end if;
  owner_job := internal.lock_factory_run_context_attempt(p_workspace_id, p_job_id, p_run_id, p_attempt_count);
  if owner_job.session_id is distinct from marker.child_session_id or not exists (
    select 1 from internal.factory_workflow_attempt_reservations hold
    where (hold.root_session_id, hold.workspace_id, hold.factory_id, hold.session_id,
      hold.job_id, hold.attempt_count, hold.run_id) =
      (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.child_session_id,
        p_job_id, p_attempt_count, p_run_id)
  ) then
    raise exception 'The delegated scope belongs to a different attempt.' using errcode = '42501';
  end if;

  select receipt.* into saved from internal.factory_workflow_accepted_scopes receipt
  where (receipt.receipt_id, receipt.session_id, receipt.workspace_id, receipt.factory_id) =
    (marker.accepted_scope_receipt_id, marker.root_session_id, marker.workspace_id, marker.factory_id);
  if not found then raise exception 'The delegated accepted scope pin is unavailable.' using errcode = '42501'; end if;
  artifact_md := internal.read_factory_workflow_current_scope_artifact(binding,saved);
  if artifact_md is null then
    raise exception 'The delegated accepted scope is no longer current.' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'status', 'required', 'receiptId', saved.receipt_id, 'artifactMarkdown', artifact_md, 'pin', jsonb_build_object(
      'workspaceId', saved.workspace_id, 'factoryId', saved.factory_id, 'rootSessionId', saved.session_id,
      'graphRevisionId', saved.graph_revision_id, 'workflowDigest', saved.workflow_digest,
      'promptRevisionId', saved.prompt_revision_id, 'stageId', saved.stage_id,
      'artifactId', saved.artifact_id, 'artifactVersion', saved.artifact_version, 'artifactDigest', saved.artifact_digest,
      'approvalId', saved.approval_id, 'jobId', saved.job_id, 'runId', saved.run_id, 'attemptCount', saved.attempt_count,
      'repositoryId', saved.repository_id, 'commitSha', saved.commit_sha, 'contextManifestDigest', saved.context_manifest_digest
    )
  );
end;
$$;

-- Service readers can see why a review stopped without accessing its provider
-- permit or manufacturing a workflow success receipt.
create function public.read_factory_workflow_exact_review_progress(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_occurrence_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select case
    when failure.reason is not null then jsonb_build_object('status', 'blocked', 'code', failure.reason)
    when progress.progress->>'status' = 'escalated' then jsonb_build_object('status', 'blocked', 'code', progress.progress->>'code')
    when progress.progress->>'status' = 'stale_review' then jsonb_build_object('status', 'blocked', 'code', 'stale_review')
    when repair.job_id is not null and job.status in ('error', 'canceled') and execution.lifecycle_status = 'running'
      and not internal.factory_workflow_branch_resume_waits_for_claim(execution.root_session_id, job)
      then jsonb_build_object('status', 'blocked', 'code', 'repair_unsuccessful')
    when repair.job_id is not null then jsonb_build_object('status', 'pending', 'code', 'repair_pending')
    else jsonb_build_object('status', 'pending', 'code', 'exact_review_pending')
  end
  from internal.factory_workflow_node_occurrences occurrence
  join internal.factory_workflow_executions execution using (root_session_id)
  left join internal.factory_workflow_exact_reviews review
    on (review.root_session_id, review.review_occurrence_id) = (occurrence.root_session_id, occurrence.occurrence_id)
  left join internal.factory_workflow_exact_review_failures failure on
    (failure.root_session_id, failure.review_id) = (review.root_session_id, review.review_id)
  left join internal.factory_workflow_repair_dispatch_outcomes progress on
    (progress.root_session_id, progress.review_id) = (review.root_session_id, review.review_id)
  left join internal.factory_workflow_review_repairs repair on
    (repair.root_session_id, repair.review_id) = (review.root_session_id, review.review_id)
  left join public.agent_jobs job on job.id = repair.job_id
  where (execution.root_session_id, execution.workspace_id, execution.factory_id, occurrence.occurrence_id, occurrence.node_kind) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_occurrence_id, 'review');
$$;
revoke all on function public.read_factory_workflow_exact_review_progress(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_workflow_exact_review_progress(uuid, uuid, uuid, uuid)
  to service_role;

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
    where ancestry.node_kind not in ('join', 'review') and ancestry.depth < 1023
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
    when reviewed.review_occurrence_id is not null then reviewed.parent_session_id
    when joined.join_occurrence_id is not null then joined.parent_session_id else execution.root_session_id end,
    case when delegate.child_session_id is not null then delegate.checkpoint_run_id
      when reviewed.review_occurrence_id is not null then reviewed.checkpoint_run_id
      when joined.join_occurrence_id is not null then joined.checkpoint_run_id else execution.graph_input_run_id end
  from internal.factory_workflow_executions execution
  left join nearest_delegate delegate on true
  left join lateral internal.factory_workflow_occurrence_review_checkpoint(p_root_session_id, p_branch_occurrence_id) reviewed
    on delegate.child_session_id is null
  left join lateral internal.factory_workflow_occurrence_join_checkpoint(p_root_session_id, p_branch_occurrence_id) joined
    on delegate.child_session_id is null and reviewed.review_occurrence_id is null
  where (execution.root_session_id, execution.workspace_id, execution.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id)
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
    select * into joined from internal.factory_workflow_occurrence_review_checkpoint(new.root_session_id, new.target_occurrence_id);
    if not found then
      select * into joined from internal.factory_workflow_occurrence_join_checkpoint(new.root_session_id, new.target_occurrence_id);
    end if;
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

create function internal.factory_workflow_repair_publication_is_current(
  p public.session_checkpoint_publications, d public.session_source_deliveries
) returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from internal.factory_workflow_review_repairs repair where repair.job_id = p.job_id)
    or internal.factory_workflow_repair_delivery_is_proved(p.run_id, p.job_id, p.attempt_count,
      p.workspace_id, p.session_id, d.repository_id, d.base_sha, d.head_sha);
$$;
revoke all on function internal.factory_workflow_repair_publication_is_current(
  public.session_checkpoint_publications, public.session_source_deliveries)
  from public, anon, authenticated, service_role;
grant execute on function internal.factory_workflow_repair_publication_is_current(
  public.session_checkpoint_publications, public.session_source_deliveries) to service_role;


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
      and internal.factory_workflow_repair_publication_is_current(p,d)
  );
$$;
