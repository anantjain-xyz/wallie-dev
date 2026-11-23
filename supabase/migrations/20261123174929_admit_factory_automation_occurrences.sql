alter table internal.factory_automations
  add column admission_generation bigint not null default 0 check (admission_generation between 0 and 9007199254740991),
  add column admission_paused boolean not null default false,
  add column max_concurrent_sessions integer not null default 1 check (max_concurrent_sessions between 1 and 100);

create table internal.factory_automation_occurrences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  automation_id uuid not null,
  revision_id uuid not null,
  source_namespace text not null check (source_namespace collate "C" ~ '^[a-z][a-z0-9._:-]{0,63}$'),
  source_key text not null check (char_length(source_key) between 1 and 240),
  event jsonb not null check (jsonb_typeof(event) = 'object'),
  causal_session_id uuid,
  status text not null default 'pending' check (status in ('pending', 'admitted', 'denied')),
  reason text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  next_attempt_at timestamptz default clock_timestamp(),
  -- Session and receipt IDs are historical handles and remain after session deletion.
  session_id uuid unique,
  mutation_receipt_id uuid unique,
  recorded_at timestamptz not null default clock_timestamp(),
  settled_at timestamptz,
  unique (automation_id, source_namespace, source_key),
  foreign key (workspace_id, factory_id, automation_id)
    references internal.factory_automations(workspace_id, factory_id, id) on delete cascade,
  foreign key (automation_id, revision_id)
    references internal.factory_automation_revisions(automation_id, id) on delete cascade,
  check ((status = 'admitted') = (session_id is not null) and (session_id is null) = (mutation_receipt_id is null)),
  check ((status = 'pending') = (next_attempt_at is not null and settled_at is null)),
  check (status = 'pending' or (next_attempt_at is null and settled_at is not null)),
  check (status <> 'denied' or reason is not null),
  check (status <> 'admitted' or reason is null),
  check (reason is null or reason in (
    'paused', 'capacity', 'authority_changing', 'automation_archived', 'revision_changed', 'event_no_match',
    'recursive_event', 'invalid_cause', 'invalid_assignment', 'budget_exhausted', 'retry_exhausted', 'factory_unavailable'
  ))
);
create index factory_automation_occurrences_due_idx
  on internal.factory_automation_occurrences(next_attempt_at, recorded_at, id) where status = 'pending';
create index factory_automation_occurrences_sessions_idx
  on internal.factory_automation_occurrences(automation_id, session_id) where status = 'admitted';

create function internal.preserve_factory_automation_occurrence() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.workspaces workspace where workspace.id = old.workspace_id) then
      return old;
    end if;
  elsif old.status = 'pending' and
    (new.id, new.workspace_id, new.factory_id, new.automation_id, new.revision_id,
      new.source_namespace, new.source_key, new.event, new.causal_session_id, new.recorded_at)
      is not distinct from
    (old.id, old.workspace_id, old.factory_id, old.automation_id, old.revision_id,
      old.source_namespace, old.source_key, old.event, old.causal_session_id, old.recorded_at) then
    return new;
  end if;
  raise exception 'The occurrence identity and settled receipt are immutable.' using errcode = '23514';
end;
$$;
create trigger preserve_factory_automation_occurrence
  before update or delete on internal.factory_automation_occurrences
  for each row execute function internal.preserve_factory_automation_occurrence();

-- A first-party permit belongs to one checked occurrence and one transaction.
-- Machine API and OAuth permits retain their existing issuance and verification.
create table internal.factory_automation_admission_permits (
  occurrence_id uuid primary key references internal.factory_automation_occurrences(id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null,
  writer_repository_id uuid not null,
  transaction_id xid8 not null
);

alter table internal.factory_automation_occurrences enable row level security;
alter table internal.factory_automation_admission_permits enable row level security;
revoke all on internal.factory_automation_occurrences, internal.factory_automation_admission_permits
  from public, anon, authenticated, service_role;

create or replace function internal.assert_session_mutation_actor(
  p_actor internal.session_mutation_actor, p_operation public.factory_session_mutation_operation
) returns void language plpgsql set search_path = '' as $$
declare approved public.factory_execution_grants;
begin
  if (p_actor.grant_id is null) <> (p_actor.grant_version is null) then
    raise exception 'An exact grant version is required.' using errcode = '42501';
  end if;
  if p_actor.member_id is not null then
    if p_actor.service_principal_id is not null or p_actor.admission_id is not null or p_actor.consenting_member_id is not null then
      raise exception 'The session request actor is invalid.' using errcode = '42501';
    end if;
    perform internal.assert_session_mutation_human_access(p_actor.workspace_id, p_actor.factory_id, p_actor.member_id);
  elsif not exists (
    select 1 from internal.factory_command_admissions admission
    join internal.factory_command_leases lease on lease.admission_id = admission.id
    where (admission.id, admission.workspace_id, admission.factory_id, admission.service_principal_id,
      admission.execution_grant_id, admission.execution_grant_version, admission.scope, lease.verified_transaction) =
      (p_actor.admission_id, p_actor.workspace_id, p_actor.factory_id, p_actor.service_principal_id,
        p_actor.grant_id, p_actor.grant_version, internal.session_mutation_scope(p_operation), pg_current_xact_id())
      and admission.consenting_member_id is not distinct from p_actor.consenting_member_id
  ) and (
    p_operation = 'create' and p_actor.consenting_member_id is null and exists (
      select 1 from internal.factory_automation_admission_permits permit
      where (permit.occurrence_id, permit.workspace_id, permit.factory_id, permit.service_principal_id,
        permit.execution_grant_id, permit.execution_grant_version, permit.writer_repository_id, permit.transaction_id) =
        (p_actor.admission_id, p_actor.workspace_id, p_actor.factory_id, p_actor.service_principal_id,
          p_actor.grant_id, p_actor.grant_version, p_actor.writer_repository_id, pg_current_xact_id())
    )
  ) is not true then
    raise exception 'The session command admission is unavailable.' using errcode = '42501';
  end if;

  if p_actor.grant_id is not null and (p_actor.service_principal_id is not null or p_operation <> 'cancel') then
    approved := internal.require_factory_machine_grant(
      p_actor.workspace_id, p_actor.factory_id, p_actor.grant_id, p_actor.grant_version);
    if approved.github_repository_id is distinct from p_actor.writer_repository_id
      or (p_actor.service_principal_id is not null and approved.service_principal_id <> p_actor.service_principal_id) then
      raise exception 'The session command does not match the approved execution grant.' using errcode = '42501';
    end if;
  end if;
end;
$$;

create function internal.factory_automation_occurrence_receipt(
  p_occurrence internal.factory_automation_occurrences, p_replayed boolean
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'occurrenceId', p_occurrence.id, 'workspaceId', p_occurrence.workspace_id, 'factoryId', p_occurrence.factory_id,
    'automationId', p_occurrence.automation_id, 'revisionId', p_occurrence.revision_id,
    'status', p_occurrence.status, 'reason', p_occurrence.reason, 'sessionId', p_occurrence.session_id,
    'mutationReceiptId', p_occurrence.mutation_receipt_id, 'attemptCount', p_occurrence.attempt_count,
    'nextAttemptAt', p_occurrence.next_attempt_at, 'recordedAt', p_occurrence.recorded_at,
    'settledAt', p_occurrence.settled_at, 'replayed', p_replayed)
$$;

create function public.record_factory_automation_occurrence(
  p_workspace_id uuid, p_factory_id uuid, p_automation_id uuid, p_expected_revision_id uuid,
  p_source_namespace text, p_source_key text, p_event jsonb, p_causal_session_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  normalized_event jsonb;
  occurrence internal.factory_automation_occurrences;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_source_namespace is null or p_source_namespace collate "C" !~ '^[a-z][a-z0-9._:-]{0,63}$'
    or p_source_key is null or char_length(p_source_key) not between 1 and 240
    or p_source_key <> internal.trim_factory_automation_text(p_source_key)
    or p_source_key ~ U&'[\0001-\001F\007F-\009F]' then
    raise exception 'A valid automation occurrence source and key are required.' using errcode = '22023';
  end if;
  normalized_event := internal.normalize_factory_automation_event(p_event);

  perform 1 from public.workspaces workspace where workspace.id = p_workspace_id for share;
  perform 1 from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id) for share;
  perform 1 from internal.factory_automations automation
  where (automation.workspace_id, automation.factory_id, automation.id) =
    (p_workspace_id, p_factory_id, p_automation_id) for no key update;
  if not found then
    raise exception 'The automation is unavailable.' using errcode = 'P0002';
  end if;

  select * into occurrence from internal.factory_automation_occurrences recorded
  where (recorded.automation_id, recorded.source_namespace, recorded.source_key) =
    (p_automation_id, p_source_namespace, p_source_key);
  if found then
    if (occurrence.event, occurrence.causal_session_id) is distinct from (normalized_event, p_causal_session_id) then
      raise exception 'The automation source key already identifies different input.' using errcode = 'PT409';
    end if;
    return internal.factory_automation_occurrence_receipt(occurrence, true);
  end if;
  if not exists (
    select 1 from internal.factory_automation_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.automation_id, revision.id) =
      (p_workspace_id, p_factory_id, p_automation_id, p_expected_revision_id)
  ) then
    raise exception 'The selected automation revision is unavailable.' using errcode = 'PT409';
  end if;

  insert into internal.factory_automation_occurrences(
    workspace_id, factory_id, automation_id, revision_id, source_namespace, source_key, event, causal_session_id
  ) values (p_workspace_id, p_factory_id, p_automation_id, p_expected_revision_id,
    p_source_namespace, p_source_key, normalized_event, p_causal_session_id)
  returning * into occurrence;
  return internal.factory_automation_occurrence_receipt(occurrence, false);
end;
$$;

create function internal.factory_automation_admission_control(p_automation internal.factory_automations)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('automationId', p_automation.id, 'generation', p_automation.admission_generation,
    'paused', p_automation.admission_paused, 'maxConcurrentSessions', p_automation.max_concurrent_sessions)
$$;

create function public.read_factory_automation_admission_control(
  p_workspace_id uuid, p_factory_id uuid, p_automation_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select internal.factory_automation_admission_control(automation)
  from internal.factory_automations automation
  where (automation.workspace_id, automation.factory_id, automation.id) = (p_workspace_id, p_factory_id, p_automation_id)
    and auth.uid() is not null and internal.can_manage_factory(p_workspace_id, p_factory_id)
$$;

alter table public.factory_audit_events drop constraint factory_audit_events_action_check;
alter table public.factory_audit_events add constraint factory_audit_events_action_check check (action in (
  'factory.created', 'factory.archived', 'factory.restored',
  'membership.granted', 'membership.revoked', 'membership.suspended', 'membership.reinstated',
  'agent.created', 'agent.prompt_revision_created',
  'skill.created', 'skill.revision_created', 'skill.revision_revoked',
  'service_principal.created', 'execution_grant.approved', 'execution_grant.updated', 'execution_grant.revoked',
  'credential_binding.created', 'credential_binding.revoked',
  'mcp_server.created', 'mcp_server.revision_created', 'mcp_server.revision_revoked',
  'mcp_secret_binding.created', 'mcp_secret_binding.revoked',
  'machine_token.issued', 'machine_token.revoked',
  'oauth_client.registered', 'oauth_client.revoked', 'oauth_grant.connected', 'oauth_grant.revoked',
  'scorer.created', 'scorer.revision_created',
  'automation.created', 'automation.draft_saved', 'automation.published', 'automation.archived',
  'automation.admission_configured'
));

create function public.configure_factory_automation_admission(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_automation_id uuid,
  p_expected_generation bigint, p_paused boolean, p_max_concurrent_sessions integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  automation internal.factory_automations;
begin
  actor := internal.factory_automation_actor(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_expected_generation is null or p_expected_generation < 0 or p_paused is null
    or p_max_concurrent_sessions is null or p_max_concurrent_sessions not between 1 and 100 then
    raise exception 'Valid automation admission controls are required.' using errcode = '22023';
  end if;
  select * into automation from internal.factory_automations candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_automation_id)
  for no key update;
  if not found then
    raise exception 'The automation is unavailable.' using errcode = 'P0002';
  end if;
  if automation.archived_at is not null or automation.admission_generation <> p_expected_generation then
    raise exception 'The automation admission controls are no longer current.' using errcode = 'PT409';
  end if;
  if (automation.admission_paused, automation.max_concurrent_sessions) is distinct from (p_paused, p_max_concurrent_sessions) then
    update internal.factory_automations candidate
    set admission_paused = p_paused, max_concurrent_sessions = p_max_concurrent_sessions,
      admission_generation = candidate.admission_generation + 1
    where candidate.id = p_automation_id returning * into automation;
    insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id, 'automation.admission_configured', actor,
      internal.factory_automation_admission_control(automation));
  end if;
  return internal.factory_automation_admission_control(automation);
end;
$$;

create function internal.factory_automation_causal_blocker(p_occurrence internal.factory_automation_occurrences)
returns text language plpgsql set search_path = '' as $$
declare
  causal_root_id uuid;
  causal_root public.sessions;
  workflow_status text;
  delegation_policy jsonb;
  root_requirements jsonb;
  committed_budget record;
begin
  if p_occurrence.causal_session_id is null then return null; end if;
  select coalesce(delegation.root_session_id, source.id) into causal_root_id
  from public.sessions source
  left join internal.factory_workflow_delegations delegation on
    (delegation.workspace_id, delegation.factory_id, delegation.child_session_id) =
    (source.workspace_id, source.factory_id, source.id)
  where (source.workspace_id, source.factory_id, source.id) =
    (p_occurrence.workspace_id, p_occurrence.factory_id, p_occurrence.causal_session_id)
    and (p_occurrence.event->>'kind' <> 'pull-request'
      or source.github_repository_id = (p_occurrence.event->>'repositoryId')::uuid);
  if not found then return 'invalid_cause'; end if;

  if exists (
    select 1 from internal.factory_automation_occurrences origin
    where origin.session_id in (causal_root_id, p_occurrence.causal_session_id)
      and (origin.workspace_id, origin.factory_id) = (p_occurrence.workspace_id, p_occurrence.factory_id)
  ) then
    return 'recursive_event';
  end if;

  select * into causal_root from public.sessions root
  where (root.workspace_id, root.factory_id, root.id) = (p_occurrence.workspace_id, p_occurrence.factory_id, causal_root_id)
  for no key update nowait;
  if not found or causal_root.phase_status = 'rejected' then return 'invalid_cause'; end if;
  if internal.refresh_session_execution_exhaustion(causal_root_id, p_occurrence.workspace_id) is not null then
    return 'budget_exhausted';
  end if;

  select execution.workflow_json::jsonb->'delegationPolicy', execution.lifecycle_status
  into delegation_policy, workflow_status
  from internal.factory_workflow_executions execution
  where execution.root_session_id = causal_root_id
    and (execution.workspace_id, execution.factory_id) = (p_occurrence.workspace_id, p_occurrence.factory_id);
  if workflow_status = 'canceled' then return 'invalid_cause'; end if;
  if delegation_policy is not null then
    select requirements into root_requirements from public.execution_policy_revisions
    where (workspace_id, id) = (p_occurrence.workspace_id, causal_root.execution_policy_revision_id);
    select * into committed_budget from internal.factory_workflow_attempt_budget(causal_root_id, delegation_policy);
    if committed_budget.attempts >= (delegation_policy->>'maxAttempts')::integer
      or committed_budget.tokens >= least((root_requirements->>'maxTotalTokens')::bigint,
        (delegation_policy->>'maxTotalTokens')::bigint)
      or committed_budget.spend_usd >= least((root_requirements->>'maxCostUsd')::numeric,
        (delegation_policy->>'maxCostUsd')::numeric) then
      return 'budget_exhausted';
    end if;
  end if;
  return null;
end;
$$;

-- A graph can continue after the session's serial approval archives the root.
create function internal.factory_automation_session_is_active(p_session public.sessions)
returns boolean language sql stable set search_path = '' as $$
  select (p_session.archived_at is null and p_session.phase_status in ('in_progress', 'awaiting_review'))
    or (p_session.phase_status = 'approved' and exists (
      select 1 from internal.factory_workflow_executions execution
      where (execution.root_session_id, execution.workspace_id, execution.factory_id) =
        (p_session.id, p_session.workspace_id, p_session.factory_id) and execution.lifecycle_status in ('running', 'paused')
        and (
          exists (
            select 1 from internal.factory_workflow_node_occurrences node
            where node.root_session_id = execution.root_session_id and not exists (
              select 1 from internal.factory_workflow_node_results result
              where (result.root_session_id, result.occurrence_id) = (node.root_session_id, node.occurrence_id)
            )
          )
          or exists (
            select 1 from internal.factory_workflow_repository_delivery_state delivery
            where delivery.root_session_id = execution.root_session_id
              and delivery.status in ('awaiting_validation', 'pending', 'claimed')
          )
        )
    ))
$$;

-- The caller holds the workspace, factory, rule and occurrence locks. The
-- permit, session mutation, workflow pin and occurrence link commit together.
create function internal.create_factory_automation_session(
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
      || E'\n\n' || p_occurrence.event::text, 'agentId', target->>'agentId',
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

create function public.admit_next_factory_automation_occurrence() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  candidate record;
  automation internal.factory_automations;
  occurrence internal.factory_automation_occurrences;
  workspace_deleting boolean;
  factory_status text;
  definition jsonb;
  disposition text;
  reason_code text;
  next_attempt_count integer;
  retry_at timestamptz;
  result jsonb;
  checked_at timestamptz := clock_timestamp();
begin
  perform internal.assert_checkpoint_publication_service();
  -- Acquire locks in the same order as publishing, archiving and pausing.
  -- A bounded scan skips work held by another worker or an operator command.
  for candidate in
    select due.id, due.workspace_id, due.factory_id, due.automation_id
    from internal.factory_automation_occurrences due
    join internal.factory_automations rule on rule.id = due.automation_id
    where due.status = 'pending'
      and (due.next_attempt_at <= checked_at or (due.reason = 'paused' and not rule.admission_paused))
      and (due.reason is distinct from 'paused' or not rule.admission_paused or rule.archived_at is not null)
    order by due.next_attempt_at, due.recorded_at, due.id
    limit 32
  loop
    select workspace.deletion_requested_at is not null into workspace_deleting
    from public.workspaces workspace where workspace.id = candidate.workspace_id for share skip locked;
    if not found then continue; end if;
    select factory.status into factory_status from public.factories factory
    where (factory.workspace_id, factory.id) = (candidate.workspace_id, candidate.factory_id) for share skip locked;
    if not found then continue; end if;
    select * into automation from internal.factory_automations rule
    where (rule.workspace_id, rule.factory_id, rule.id) =
      (candidate.workspace_id, candidate.factory_id, candidate.automation_id) for no key update skip locked;
    if not found then continue; end if;
    select * into occurrence from internal.factory_automation_occurrences pending
    where (pending.id, pending.automation_id, pending.status) = (candidate.id, automation.id, 'pending')
      and (pending.next_attempt_at <= checked_at or (pending.reason = 'paused' and not automation.admission_paused))
      and (pending.reason is distinct from 'paused' or not automation.admission_paused or automation.archived_at is not null)
    for update skip locked;
    if not found then continue; end if;

    disposition := 'denied';
    reason_code := null;
    next_attempt_count := occurrence.attempt_count;
    retry_at := null;
    result := null;
    if workspace_deleting or factory_status <> 'active' then
      reason_code := 'factory_unavailable';
    elsif automation.archived_at is not null then
      reason_code := 'automation_archived';
    elsif automation.published_revision_id is distinct from occurrence.revision_id then
      reason_code := 'revision_changed';
    elsif automation.admission_paused then
      disposition := 'pending';
      reason_code := 'paused';
      retry_at := clock_timestamp() + interval '30 seconds';
    else
      select revision.definition into strict definition from internal.factory_automation_revisions revision
      where (revision.automation_id, revision.id) = (automation.id, occurrence.revision_id);
      if internal.evaluate_factory_automation_event(definition, occurrence.event)->'matched' is distinct from 'true'::jsonb then
        reason_code := 'event_no_match';
      else
        begin
          reason_code := internal.factory_automation_causal_blocker(occurrence);
          if reason_code is null then
            if (
              select count(*) from internal.factory_automation_occurrences active
              join public.sessions session on (session.id, session.workspace_id, session.factory_id) =
                (active.session_id, active.workspace_id, active.factory_id)
              where active.automation_id = automation.id and active.status = 'admitted'
                and internal.factory_automation_session_is_active(session)
            ) >= automation.max_concurrent_sessions then
              disposition := 'pending';
              reason_code := 'capacity';
              retry_at := clock_timestamp() + interval '30 seconds';
            else
              next_attempt_count := occurrence.attempt_count + 1;
              result := internal.create_factory_automation_session(occurrence, definition);
              disposition := 'admitted';
            end if;
          end if;
        exception when sqlstate 'PT409' or lock_not_available then
          -- Failed work and its private permit roll back before recording the retry.
          next_attempt_count := occurrence.attempt_count + 1;
          if next_attempt_count >= 5 then
            reason_code := 'retry_exhausted';
          else
            disposition := 'pending';
            reason_code := 'authority_changing';
            retry_at := clock_timestamp() + make_interval(secs => 5 * power(2, next_attempt_count - 1));
          end if;
        when sqlstate 'P0003' then
          reason_code := 'revision_changed';
        when sqlstate 'P0005' or sqlstate 'PT422' or insufficient_privilege or no_data_found then
          reason_code := 'invalid_assignment';
        end;
      end if;
    end if;

    update internal.factory_automation_occurrences pending
    set status = disposition, reason = reason_code, attempt_count = next_attempt_count,
      next_attempt_at = retry_at,
      session_id = case when disposition = 'admitted' then (result->>'sessionId')::uuid end,
      mutation_receipt_id = case when disposition = 'admitted' then (result->>'receiptId')::uuid end,
      settled_at = case when disposition <> 'pending' then clock_timestamp() end
    where pending.id = occurrence.id returning * into occurrence;
    return internal.factory_automation_occurrence_receipt(occurrence, false);
  end loop;
  return null;
end;
$$;

revoke all on function
  internal.preserve_factory_automation_occurrence(),
  internal.factory_automation_occurrence_receipt(internal.factory_automation_occurrences, boolean),
  internal.factory_automation_admission_control(internal.factory_automations),
  internal.factory_automation_causal_blocker(internal.factory_automation_occurrences),
  internal.factory_automation_session_is_active(public.sessions),
  internal.create_factory_automation_session(internal.factory_automation_occurrences, jsonb),
  public.record_factory_automation_occurrence(uuid, uuid, uuid, uuid, text, text, jsonb, uuid),
  public.read_factory_automation_admission_control(uuid, uuid, uuid),
  public.configure_factory_automation_admission(uuid, uuid, uuid, uuid, bigint, boolean, integer),
  public.admit_next_factory_automation_occurrence()
  from public, anon, authenticated, service_role;

grant execute on function
  public.record_factory_automation_occurrence(uuid, uuid, uuid, uuid, text, text, jsonb, uuid),
  public.configure_factory_automation_admission(uuid, uuid, uuid, uuid, bigint, boolean, integer),
  public.admit_next_factory_automation_occurrence()
  to service_role;
grant execute on function public.read_factory_automation_admission_control(uuid, uuid, uuid) to authenticated;
