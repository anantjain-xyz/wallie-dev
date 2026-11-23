-- Automation intake has its own history. Verification refresh receipts
-- describe refresh obligations and can expire independently of this ledger.
create table internal.github_automation_pr_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  repository_id uuid not null,
  github_repository_id bigint not null,
  installation_id bigint not null,
  delivery_id uuid not null,
  pull_request_id bigint not null,
  pull_request_number integer not null,
  repository_full_name text not null,
  provider_updated_at timestamptz not null,
  source_key text not null check (source_key ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null,
  disposition text not null check (disposition in ('accepted', 'duplicate', 'stale', 'ambiguous', 'causal_suppressed')),
  causal_session_id uuid,
  occurrence_count integer not null check (occurrence_count >= 0),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (installation_id, github_repository_id, delivery_id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
create index github_automation_pr_delivery_cursor_idx on internal.github_automation_pr_deliveries(
  workspace_id, factory_id, repository_id, pull_request_number, provider_updated_at desc,
  ((snapshot->>'state') = 'merged') desc, recorded_at desc, id desc
) where disposition in ('accepted', 'causal_suppressed');
create unique index github_automation_pr_semantic_event_idx on internal.github_automation_pr_deliveries(
  workspace_id, factory_id, repository_id, source_key
)
  where disposition in ('accepted', 'causal_suppressed');
alter table internal.github_automation_pr_deliveries enable row level security;
revoke all on internal.github_automation_pr_deliveries from public, anon, authenticated, service_role;
create trigger preserve_github_automation_pr_deliveries
  before update or delete on internal.github_automation_pr_deliveries
  for each row execute function internal.preserve_factory_definition_history();

create function internal.github_automation_pr_receipt(p_receipt internal.github_automation_pr_deliveries, p_replayed boolean)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('receiptId', p_receipt.id, 'status', p_receipt.disposition,
    'occurrenceCount', p_receipt.occurrence_count, 'replayed', p_replayed)
$$;

create function public.ingest_factory_github_automation_pr(
  p_installation_id bigint, p_github_repository_id bigint, p_delivery_id uuid,
  p_pull_request_id bigint, p_pull_request_number integer, p_action text, p_state text, p_draft boolean,
  p_provider_updated_at timestamptz, p_base_branch text, p_head_branch text, p_head_sha text,
  p_head_repository_id bigint default null, p_merge_commit_sha text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  repository public.github_repositories;
  receipt internal.github_automation_pr_deliveries;
  current_pr internal.github_automation_pr_deliveries;
  snapshot jsonb;
  normalized_event jsonb;
  event_key text;
  causal_sessions uuid[];
  causal_session uuid;
  disposition text := 'accepted';
  rule record;
  occurrence_count integer := 0;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_installation_id is null or p_installation_id not between 1 and 9007199254740991
    or p_github_repository_id is null or p_github_repository_id not between 1 and 9007199254740991
    or p_delivery_id is null or p_pull_request_id is null or p_pull_request_id not between 1 and 9007199254740991
    or p_pull_request_number is null or p_pull_request_number < 1 or p_draft is null
    or p_provider_updated_at is null or not isfinite(p_provider_updated_at)
    or p_base_branch is null or char_length(p_base_branch) > 120
    or not internal.is_git_branch_ref('refs/heads/' || p_base_branch)
    or p_head_branch is null or not internal.is_git_branch_ref('refs/heads/' || p_head_branch)
    or p_head_sha is null or p_head_sha !~ '^[a-f0-9]{40}$'
    or (p_head_repository_id is not null and p_head_repository_id not between 1 and 9007199254740991)
    or ((p_action, p_state) in (('opened','open'), ('reopened','open'), ('synchronize','open'),
        ('ready_for_review','open'), ('closed','closed'), ('merged','merged'))) is not true
    or (p_action = 'merged' and (p_merge_commit_sha is null or p_merge_commit_sha !~ '^[a-f0-9]{40}$'))
    or (p_action <> 'merged' and p_merge_commit_sha is not null) then
    raise exception 'Invalid GitHub pull request automation event.' using errcode = '22023';
  end if;
  snapshot := jsonb_build_object('githubRepositoryId', p_github_repository_id,
    'pullRequestId', p_pull_request_id, 'pullRequestNumber', p_pull_request_number,
    'action', p_action, 'state', p_state, 'draft', p_draft, 'updatedAtEpoch', extract(epoch from p_provider_updated_at),
    'baseBranch', p_base_branch, 'headBranch', p_head_branch, 'headSha', p_head_sha,
    'headRepositoryId', p_head_repository_id, 'mergeCommitSha', p_merge_commit_sha);
  event_key := encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex');

  select source.* into repository from public.github_repositories source
  join public.github_installations installation
    on (installation.workspace_id, installation.id) = (source.workspace_id, source.github_installation_id)
  where (installation.installation_id, source.repo_id) = (p_installation_id, p_github_repository_id);
  if not found then return null; end if;
  perform 1 from public.workspaces workspace
  where workspace.id = repository.workspace_id and workspace.deletion_requested_at is null for share;
  if not found then return null; end if;
  perform 1 from public.factories factory
  where (factory.workspace_id, factory.id, factory.status) = (repository.workspace_id, repository.factory_id, 'active') for share;
  if not found then return null; end if;
  select source.* into repository from public.github_repositories source
  join public.github_installations installation
    on (installation.workspace_id, installation.id) = (source.workspace_id, source.github_installation_id)
  where (source.workspace_id, source.factory_id, source.id, source.repo_id, installation.installation_id) =
    (repository.workspace_id, repository.factory_id, repository.id, p_github_repository_id, p_installation_id)
    and not source.is_archived and not installation.suspended
  for share of source, installation nowait;
  if not found then return null; end if;

  -- One provider delivery and one PR cursor each get a transaction fence.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'github-automation-delivery:' || p_installation_id::text || ':' || p_github_repository_id::text || ':' || p_delivery_id::text, 0));
  select * into receipt from internal.github_automation_pr_deliveries delivery
  where (delivery.installation_id, delivery.github_repository_id, delivery.delivery_id) =
    (p_installation_id, p_github_repository_id, p_delivery_id);
  if found then
    if (receipt.workspace_id, receipt.factory_id, receipt.repository_id, receipt.snapshot) is distinct from
      (repository.workspace_id, repository.factory_id, repository.id, snapshot) then
      raise exception 'The GitHub delivery already identifies different input.' using errcode = 'PT409';
    end if;
    return internal.github_automation_pr_receipt(receipt, true);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'github-automation-pr:' || repository.factory_id::text || ':' || repository.id::text || ':' || p_pull_request_number::text, 0));

  select * into current_pr from internal.github_automation_pr_deliveries delivery
  where (delivery.workspace_id, delivery.factory_id, delivery.repository_id, delivery.pull_request_number) =
    (repository.workspace_id, repository.factory_id, repository.id, p_pull_request_number)
    and delivery.disposition in ('accepted', 'causal_suppressed')
  order by delivery.provider_updated_at desc, ((delivery.snapshot->>'state') = 'merged') desc,
    delivery.recorded_at desc, delivery.id desc limit 1;
  if exists (
    select 1 from internal.github_automation_pr_deliveries delivery
    where (delivery.workspace_id, delivery.factory_id, delivery.repository_id, delivery.source_key) =
      (repository.workspace_id, repository.factory_id, repository.id, event_key)
      and delivery.disposition in ('accepted', 'causal_suppressed')
  ) then
    disposition := 'duplicate';
  elsif current_pr.id is not null then
    if current_pr.pull_request_id <> p_pull_request_id then
      disposition := 'ambiguous';
    elsif current_pr.snapshot->>'state' = 'merged' or current_pr.provider_updated_at > p_provider_updated_at then
      disposition := 'stale';
    elsif current_pr.provider_updated_at = p_provider_updated_at and p_state <> 'merged'
      and (current_pr.snapshot - array['action','mergeCommitSha']) is distinct from (snapshot - array['action','mergeCommitSha']) then
      -- Seconds-resolution timestamps cannot order conflicting snapshots.
      disposition := 'ambiguous';
    end if;
  end if;

  if disposition = 'accepted' and (p_head_repository_id is null or p_head_repository_id = p_github_repository_id) then
    select array_agg(distinct candidate.session_id) into causal_sessions from (
      select epoch.session_id from public.session_pr_epochs epoch
      where (epoch.workspace_id, epoch.repository_id, epoch.github_repository_id, epoch.pr_number,
        epoch.branch_name, epoch.base_branch) =
        (repository.workspace_id, repository.id, p_github_repository_id, p_pull_request_number, p_head_branch, p_base_branch)
      union
      select link.session_id from public.session_pull_requests link
      where (link.workspace_id, link.github_repository_id, link.pull_request_number, link.branch_name) =
        (repository.workspace_id, repository.id, p_pull_request_number, p_head_branch)
    ) candidate join public.sessions source
      on (source.id, source.workspace_id, source.factory_id, source.github_repository_id) =
        (candidate.session_id, repository.workspace_id, repository.factory_id, repository.id);
    if cardinality(causal_sessions) = 1 then
      causal_session := causal_sessions[1];
      if exists (
        select 1 from internal.factory_automation_occurrences origin
        where (origin.workspace_id, origin.factory_id) = (repository.workspace_id, repository.factory_id)
          and origin.session_id in (causal_session, (
            select child.root_session_id from internal.factory_workflow_delegations child
            where (child.workspace_id, child.factory_id, child.child_session_id) =
              (repository.workspace_id, repository.factory_id, causal_session)
          ))
      ) then
        disposition := 'causal_suppressed';
      end if;
    elsif cardinality(causal_sessions) > 1 or starts_with(p_head_branch, 'wallie/') then
      -- A reserved same-repo head can arrive before the canonical PR receipt.
      -- Setup and improvement PRs also use this namespace without a session.
      disposition := 'causal_suppressed';
    end if;
  end if;

  if disposition = 'accepted' then
    normalized_event := jsonb_build_object('kind', 'pull-request', 'repositoryId', repository.id,
      'action', p_action, 'baseBranch', p_base_branch);
    for rule in
      select automation.id, revision.id as revision_id, revision.definition
      from internal.factory_automations automation
      join internal.factory_automation_revisions revision
        on (revision.automation_id, revision.id) = (automation.id, automation.published_revision_id)
      where (automation.workspace_id, automation.factory_id) = (repository.workspace_id, repository.factory_id)
        and automation.archived_at is null
        and revision.definition#>>'{trigger,kind}' = 'pull-request'
        and revision.definition#>>'{trigger,repositoryId}' = repository.id::text
      order by automation.id
    loop
      if internal.evaluate_factory_automation_event(rule.definition, normalized_event)->'matched' = 'true'::jsonb then
        perform public.record_factory_automation_occurrence(repository.workspace_id, repository.factory_id,
          rule.id, rule.revision_id, 'github.pr', event_key, normalized_event, causal_session);
        occurrence_count := occurrence_count + 1;
      end if;
    end loop;
  end if;

  insert into internal.github_automation_pr_deliveries(
    workspace_id, factory_id, repository_id, github_repository_id, installation_id, delivery_id,
    pull_request_id, pull_request_number, repository_full_name, provider_updated_at, source_key, snapshot,
    disposition, causal_session_id, occurrence_count
  ) values (
    repository.workspace_id, repository.factory_id, repository.id, p_github_repository_id, p_installation_id, p_delivery_id,
    p_pull_request_id, p_pull_request_number, repository.full_name, p_provider_updated_at, event_key, snapshot,
    disposition, causal_session, occurrence_count
  ) returning * into receipt;
  return internal.github_automation_pr_receipt(receipt, false);
exception when lock_not_available then
  raise exception 'GitHub automation repository access is changing. Retry ingestion.' using errcode = 'PT409';
end;
$$;

create function internal.github_automation_pr_prompt_context(p_occurrence internal.factory_automation_occurrences)
returns text language sql stable set search_path = '' as $$
  select format(E'\n\nGitHub pull request: %s#%s\nSource head: %s',
    receipt.repository_full_name, receipt.pull_request_number, receipt.snapshot->>'headSha')
  from internal.github_automation_pr_deliveries receipt
  where p_occurrence.source_namespace = 'github.pr'
    and (receipt.workspace_id, receipt.factory_id, receipt.repository_id::text, receipt.source_key) =
      (p_occurrence.workspace_id, p_occurrence.factory_id, p_occurrence.event->>'repositoryId', p_occurrence.source_key)
    and (receipt.snapshot->>'action', receipt.snapshot->>'baseBranch') =
      (p_occurrence.event->>'action', p_occurrence.event->>'baseBranch')
    and receipt.disposition = 'accepted' and receipt.causal_session_id is not distinct from p_occurrence.causal_session_id
$$;

revoke all on function
  internal.github_automation_pr_receipt(internal.github_automation_pr_deliveries, boolean),
  internal.github_automation_pr_prompt_context(internal.factory_automation_occurrences),
  public.ingest_factory_github_automation_pr(bigint, bigint, uuid, bigint, integer, text, text, boolean,
    timestamptz, text, text, text, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_factory_github_automation_pr(bigint, bigint, uuid, bigint, integer, text, text,
  boolean, timestamptz, text, text, text, bigint, text) to service_role;

create or replace function internal.create_factory_automation_session(
  p_occurrence internal.factory_automation_occurrences, p_definition jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  approved public.factory_execution_grants;
  actor internal.session_mutation_actor;
  target jsonb := p_definition->'target';
  intent jsonb;
  result jsonb;
begin
  perform internal.assert_factory_automation_target(p_occurrence.workspace_id, p_occurrence.factory_id, p_definition);
  approved := internal.require_factory_machine_grant(
    p_occurrence.workspace_id, p_occurrence.factory_id, (p_definition#>>'{executionGrant,id}')::uuid,
    (p_definition#>>'{executionGrant,version}')::bigint);
  if ('sessions:create'::public.factory_command_scope = any(approved.command_scopes)) is not true
    or not exists (
      select 1 from public.execution_policy_revisions policy
      where (policy.workspace_id, policy.id) = (approved.workspace_id, approved.execution_policy_revision_id)
        and internal.valid_execution_requirements(policy.requirements)
    ) then
    raise exception 'The automation requires session creation authority and a root execution policy.' using errcode = 'PT422';
  end if;

  actor := row(p_occurrence.workspace_id, p_occurrence.factory_id, null, approved.service_principal_id,
    null, approved.id, approved.version, approved.github_repository_id, p_occurrence.id)::internal.session_mutation_actor;
  perform internal.lock_session_mutation_key(p_occurrence.workspace_id, p_occurrence.factory_id, 'create', p_occurrence.id);
  perform internal.assert_no_legacy_machine_creation_key(actor, p_occurrence.id);
  if exists (
    select 1 from internal.session_mutation_receipts receipt
    where (receipt.workspace_id, receipt.factory_id, receipt.operation, receipt.request_id) =
      (p_occurrence.workspace_id, p_occurrence.factory_id, 'create', p_occurrence.id)
  ) then
    raise exception 'The occurrence create request identity is already used.' using errcode = 'P0005';
  end if;

  intent := jsonb_build_object('title', p_definition->>'name',
    'prompt', 'Review the automation event and carry out the configured workflow or agent task. The event is context.'
      || E'\n\n' || p_occurrence.event::text
      || coalesce(internal.github_automation_pr_prompt_context(p_occurrence), ''), 'agentId', target->>'agentId',
    'repositoryId', approved.github_repository_id, 'draftSpecification', false);
  if target->>'kind' = 'workflow' then
    intent := intent || jsonb_build_object('workflowSelection',
      jsonb_build_object('workflowId', target->>'workflowId', 'activationId', target->>'workflowActivationId'));
  end if;
  intent := internal.normalize_factory_session_mutation('create', intent);
  insert into internal.factory_automation_admission_permits(
    occurrence_id, workspace_id, factory_id, service_principal_id, execution_grant_id, execution_grant_version,
    writer_repository_id, transaction_id
  ) values (p_occurrence.id, p_occurrence.workspace_id, p_occurrence.factory_id, approved.service_principal_id,
    approved.id, approved.version, approved.github_repository_id, pg_current_xact_id());
  result := internal.create_machine_session(actor, intent);
  result := internal.record_session_mutation_receipt(
    actor, 'create', p_occurrence.id, intent, (result->>'sessionId')::uuid, result
  );
  delete from internal.factory_automation_admission_permits permit where permit.occurrence_id = p_occurrence.id;
  return result;
end;
$$;
