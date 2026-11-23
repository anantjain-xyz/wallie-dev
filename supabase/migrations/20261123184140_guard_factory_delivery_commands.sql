-- A deployment command never moves a source branch or merges a pull request.
-- Its external correlation ID is stable before any provider request is made.
create table internal.factory_delivery_commands (
  workspace_id uuid not null,
  factory_id uuid not null,
  id uuid not null,
  session_id uuid not null,
  repository_id uuid not null,
  checkpoint_run_id uuid not null,
  approval_id uuid not null,
  policy_revision_id uuid not null,
  artifact_review_revision bigint not null,
  merge_id uuid not null,
  merge_observation_id uuid not null,
  approved_head_sha text not null,
  source_sha text not null,
  deployment_source_id uuid not null,
  requested_by_member_id uuid not null,
  requested_at timestamptz not null default clock_timestamp(),
  dispatch_state text not null default 'queued' check (dispatch_state in (
    'queued', 'dispatching', 'accepted', 'rejected', 'unknown', 'blocked', 'cancelled'
  )),
  outcome text check (outcome in ('pending', 'unknown', 'succeeded', 'failed')),
  lease_id uuid,
  lease_expires_at timestamptz,
  dispatch_started_at timestamptz,
  deployment_observation_id uuid,
  deployment_observation_revision integer,
  primary key (workspace_id, factory_id, id),
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions (id, workspace_id, factory_id) on delete cascade,
  check ((dispatch_state = 'dispatching') = (lease_id is not null and lease_expires_at is not null)),
  check ((lease_id is null) = (lease_expires_at is null)),
  check ((dispatch_state in ('dispatching', 'accepted', 'rejected', 'unknown')) = (dispatch_started_at is not null)),
  check ((dispatch_state in ('accepted', 'unknown')) = (outcome is not null)),
  check ((deployment_observation_id is null) = (deployment_observation_revision is null))
);
create unique index factory_delivery_commands_one_dispatch_idx
  on internal.factory_delivery_commands (workspace_id, factory_id, session_id, deployment_source_id, source_sha)
  where dispatch_state not in ('blocked', 'cancelled', 'rejected');
create index factory_delivery_commands_expiring_idx
  on internal.factory_delivery_commands (lease_expires_at) where dispatch_state = 'dispatching';
create index factory_delivery_commands_report_idx
  on internal.factory_delivery_commands (workspace_id, factory_id, (id::text));

create table internal.factory_delivery_command_receipts (
  id bigint generated always as identity primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  command_id uuid not null,
  dispatch_state text not null,
  outcome text,
  deployment_observation_id uuid,
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, factory_id, command_id)
    references internal.factory_delivery_commands (workspace_id, factory_id, id) on delete cascade
);
create index factory_delivery_command_receipts_command_idx
  on internal.factory_delivery_command_receipts (workspace_id, factory_id, command_id);

alter table internal.factory_delivery_commands enable row level security;
alter table internal.factory_delivery_command_receipts enable row level security;
revoke all on internal.factory_delivery_commands, internal.factory_delivery_command_receipts
  from public, anon, authenticated, service_role;

create function internal.record_factory_delivery_command_receipt()
returns trigger language plpgsql set search_path = '' as $$
begin
  insert into internal.factory_delivery_command_receipts
    (workspace_id, factory_id, command_id, dispatch_state, outcome, deployment_observation_id)
  values (new.workspace_id, new.factory_id, new.id, new.dispatch_state, new.outcome, new.deployment_observation_id);
  return new;
end;
$$;
create trigger factory_delivery_command_receipt after insert or update on internal.factory_delivery_commands
  for each row execute function internal.record_factory_delivery_command_receipt();

create function internal.factory_delivery_command_summary(command internal.factory_delivery_commands)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', command.id, 'sessionId', command.session_id, 'repositoryId', command.repository_id,
    'checkpointRunId', command.checkpoint_run_id, 'approvalId', command.approval_id,
    'policyRevisionId', command.policy_revision_id, 'mergeObservationId', command.merge_observation_id,
    'approvedHeadSha', command.approved_head_sha, 'sourceRevision', command.source_sha,
    'deploymentSourceId', command.deployment_source_id, 'requestedByMemberId', command.requested_by_member_id,
    'requestedAt', command.requested_at, 'dispatchState', command.dispatch_state, 'outcome', command.outcome,
    'dispatchStartedAt', command.dispatch_started_at, 'deploymentObservationId', command.deployment_observation_id
  );
$$;

-- Resolve the same authority again in the claim transaction. Session writers
-- serialize approval, checkpoint adoption, readiness updates and rerouting on
-- the session row. The canonical merge writer serializes observations on its
-- owner row. Take the grant before the observation source, like report ingress.
create function internal.require_factory_delivery_command_authority(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_checkpoint_run_id uuid,
  p_approval_id uuid, p_policy_revision_id uuid, p_merge_observation_id uuid, p_deployment_source_id uuid
) returns internal.factory_delivery_commands language plpgsql set search_path = '' as $$
declare
  owner public.sessions;
  checkpoint public.session_git_checkpoints;
  merge_owner internal.factory_canonical_pull_request_merges;
  merged internal.current_factory_canonical_pull_request_merges;
  source internal.factory_deployment_sources;
  reporter public.factory_execution_grants;
  binding internal.factory_delivery_commands;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select target.* into owner from public.sessions target
  where (target.id, target.workspace_id, target.factory_id) = (p_session_id, p_workspace_id, p_factory_id)
  for share;
  if not found then raise exception 'Delivery session is unavailable.' using errcode = 'P0002'; end if;

  -- The reviewed factory definition pins policy throughout the approval. A
  -- legacy session's current policy cannot establish what the reviewer approved.
  if not owner.execute_pinned_definition or owner.phase_status <> 'approved'
    or owner.pinned_delivery_policy_revision_id is distinct from p_policy_revision_id
    or not exists (
      select 1 from public.delivery_policy_revisions policy
      where (policy.id, policy.workspace_id, policy.pipeline_id) =
        (p_policy_revision_id, p_workspace_id, owner.pipeline_id)
        and policy.requirements->>'deliveryMode' = 'code'
        and policy.requirements->'requireArtifactApprovalForDelivery' = 'true'::jsonb
    ) then raise exception 'Delivery requires an approved session and its pinned code policy.' using errcode = 'PT409'; end if;

  select retained.* into checkpoint from public.session_git_heads head
  join public.session_git_checkpoints retained
    on (retained.run_id, retained.workspace_id, retained.session_id) =
      (head.checkpoint_run_id, head.workspace_id, head.session_id)
  where (head.session_id, head.workspace_id, head.checkpoint_run_id) =
    (p_session_id, p_workspace_id, p_checkpoint_run_id)
    and retained.artifact_id = owner.current_artifact_id;
  if not found or not exists (
    select 1 from public.session_stage_approval_receipts approval
    join public.session_phase_completions completion
      on (completion.id, completion.workspace_id, completion.session_id, completion.stage_id) =
        (approval.completion_id, approval.workspace_id, approval.session_id, approval.stage_id)
    join public.session_artifacts artifact
      on (artifact.id, artifact.workspace_id, artifact.session_id, artifact.stage_id, artifact.version) =
        (approval.artifact_id, approval.workspace_id, approval.session_id, approval.stage_id, approval.artifact_version)
    where (approval.id, approval.workspace_id, approval.session_id, approval.stage_id,
      approval.artifact_id, approval.artifact_version) =
      (p_approval_id, p_workspace_id, p_session_id, owner.current_stage_id,
        checkpoint.artifact_id, owner.current_artifact_version)
      and approval.artifact_digest = encode(sha256(convert_to(
        internal.approved_predecessor_artifact_text(artifact.artifact_json), 'UTF8')), 'hex')
      and not exists (
        select 1 from public.session_stage_approval_receipts newer
        where newer.completion_id = approval.completion_id and newer.approval_number > approval.approval_number
      )
      and not exists (
        select 1 from public.artifact_review_threads thread
        where (thread.workspace_id, thread.session_id) = (p_workspace_id, p_session_id)
          and thread.kind = 'blocking' and thread.status = 'open'
      )
  ) then raise exception 'The current source checkpoint lacks its exact human approval.' using errcode = 'PT409'; end if;

  select canonical.* into merge_owner
  from internal.factory_canonical_pull_request_merges canonical
  join internal.factory_canonical_pull_request_merge_observations observed on observed.merge_id = canonical.id
  join public.session_pr_sync sync on (sync.session_id, sync.current_epoch_id) =
    (canonical.session_id, canonical.epoch_id)
  where (canonical.workspace_id, canonical.factory_id, canonical.session_id, canonical.repository_id, observed.id) =
    (p_workspace_id, p_factory_id, p_session_id, checkpoint.repository_id, p_merge_observation_id)
  for share of canonical;
  if not found then raise exception 'The exact canonical merge is unavailable.' using errcode = 'PT409'; end if;

  select canonical.* into merged
  from internal.current_factory_canonical_pull_request_merges canonical
  join internal.factory_canonical_pull_request_merge_runs run on run.observation_id = canonical.observation_id
  where (canonical.id, canonical.observation_id, canonical.merge_source_head_sha, run.run_id, run.attempt_count) =
    (merge_owner.id, p_merge_observation_id, checkpoint.output_sha, checkpoint.run_id, checkpoint.attempt_count)
    and canonical.status = 'observed';
  if not found then raise exception 'The exact canonical merge is stale or ambiguous.' using errcode = 'PT409'; end if;

  select target.* into source from internal.factory_deployment_sources target
  where (target.workspace_id, target.factory_id, target.repository_id, target.id) =
    (p_workspace_id, p_factory_id, checkpoint.repository_id, p_deployment_source_id)
    and target.revoked_at is null;
  if not found then raise exception 'The deployment observation source is unavailable.' using errcode = 'PT409'; end if;
  begin
    reporter := internal.require_factory_machine_grant(p_workspace_id, p_factory_id,
      source.execution_grant_id, source.execution_grant_version);
  exception when sqlstate 'PT409' then
    -- The grant's NOWAIT resource fence uses PT409 for an in-flight change.
    -- Preserve the queued command until the grant can be checked again.
    raise exception 'Deployment observation authority is changing.' using errcode = '55P03';
  end;
  perform 1 from internal.factory_deployment_sources target
    where target.id = source.id and target.revoked_at is null
    for share;
  if not found or reporter.github_repository_id is distinct from checkpoint.repository_id
    or reporter.service_principal_id is distinct from source.service_principal_id
    or not ('deployments:observe'::public.factory_command_scope = any(reporter.command_scopes)) then
    raise exception 'The deployment observation source is unavailable.' using errcode = 'PT409';
  end if;

  binding.workspace_id := p_workspace_id;
  binding.factory_id := p_factory_id;
  binding.session_id := p_session_id;
  binding.repository_id := checkpoint.repository_id;
  binding.checkpoint_run_id := checkpoint.run_id;
  binding.approval_id := p_approval_id;
  binding.policy_revision_id := p_policy_revision_id;
  binding.artifact_review_revision := owner.artifact_review_revision;
  binding.merge_id := merged.id;
  binding.merge_observation_id := merged.observation_id;
  binding.approved_head_sha := checkpoint.output_sha;
  binding.source_sha := merged.merge_commit_sha;
  binding.deployment_source_id := source.id;
  return binding;
end;
$$;

create function public.prepare_factory_delivery_command(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_command_id uuid,
  p_session_id uuid, p_checkpoint_run_id uuid, p_approval_id uuid, p_policy_revision_id uuid,
  p_merge_observation_id uuid, p_deployment_source_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  command internal.factory_delivery_commands;
  binding internal.factory_delivery_commands;
begin
  actor := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_command_id is null or p_session_id is null or p_checkpoint_run_id is null or p_approval_id is null
    or p_policy_revision_id is null or p_merge_observation_id is null or p_deployment_source_id is null then
    raise exception 'Provide all delivery command identities.' using errcode = '22023';
  end if;
  select * into command from internal.factory_delivery_commands
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id);
  if not found then
    binding := internal.require_factory_delivery_command_authority(p_workspace_id, p_factory_id,
      p_session_id, p_checkpoint_run_id, p_approval_id, p_policy_revision_id, p_merge_observation_id,
      p_deployment_source_id);
    insert into internal.factory_delivery_commands (
      workspace_id, factory_id, id, session_id, repository_id, checkpoint_run_id, approval_id, policy_revision_id,
      artifact_review_revision, merge_id, merge_observation_id, approved_head_sha, source_sha, deployment_source_id,
      requested_by_member_id
    ) values (
      p_workspace_id, p_factory_id, p_command_id, binding.session_id, binding.repository_id,
      binding.checkpoint_run_id, binding.approval_id, binding.policy_revision_id, binding.artifact_review_revision,
      binding.merge_id, binding.merge_observation_id, binding.approved_head_sha, binding.source_sha,
      binding.deployment_source_id, actor
    ) on conflict (workspace_id, factory_id, id) do nothing returning * into command;
    if not found then
      select * into strict command from internal.factory_delivery_commands
        where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id);
    end if;
  end if;
  if (command.session_id, command.checkpoint_run_id, command.approval_id, command.policy_revision_id,
      command.merge_observation_id, command.deployment_source_id, command.requested_by_member_id) is distinct from
     (p_session_id, p_checkpoint_run_id, p_approval_id, p_policy_revision_id, p_merge_observation_id,
      p_deployment_source_id, actor) then
    raise exception 'Delivery command identity is already bound to another request.' using errcode = 'PT409';
  end if;
  return internal.factory_delivery_command_summary(command);
exception when unique_violation then
  raise exception 'This source already has a delivery command for this deployment target.' using errcode = 'PT409';
end;
$$;

create function public.read_factory_delivery_command(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_command_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare command internal.factory_delivery_commands;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into command from internal.factory_delivery_commands
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id);
  if not found then raise exception 'Delivery command not found.' using errcode = 'P0002'; end if;
  return internal.factory_delivery_command_summary(command);
end;
$$;

create function public.read_factory_delivery_command_candidate(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_session_id uuid, p_deployment_source_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  observed record;
  binding internal.factory_delivery_commands;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select head.checkpoint_run_id, owner.pinned_delivery_policy_revision_id, approval.id as approval_id,
    canonical.observation_id into observed
  from public.sessions owner
  join public.session_git_heads head on (head.session_id, head.workspace_id) = (owner.id, owner.workspace_id)
  join public.session_pr_sync sync on (sync.session_id, sync.workspace_id) = (owner.id, owner.workspace_id)
  join internal.current_factory_canonical_pull_request_merges canonical
    on (canonical.session_id, canonical.workspace_id, canonical.factory_id, canonical.epoch_id) =
      (owner.id, owner.workspace_id, owner.factory_id, sync.current_epoch_id)
  cross join lateral (
    select receipt.id from public.session_stage_approval_receipts receipt
    where (receipt.session_id, receipt.workspace_id, receipt.stage_id, receipt.artifact_id) =
      (owner.id, owner.workspace_id, owner.current_stage_id, owner.current_artifact_id)
    order by receipt.approval_number desc limit 1
  ) approval
  where (owner.id, owner.workspace_id, owner.factory_id) = (p_session_id, p_workspace_id, p_factory_id);
  if not found then raise exception 'No exact approved delivery candidate is available.' using errcode = 'PT409'; end if;
  binding := internal.require_factory_delivery_command_authority(p_workspace_id, p_factory_id, p_session_id,
    observed.checkpoint_run_id, observed.approval_id, observed.pinned_delivery_policy_revision_id,
    observed.observation_id, p_deployment_source_id);
  return jsonb_build_object(
    'sessionId', binding.session_id, 'repositoryId', binding.repository_id,
    'checkpointRunId', binding.checkpoint_run_id, 'approvalId', binding.approval_id,
    'policyRevisionId', binding.policy_revision_id, 'mergeObservationId', binding.merge_observation_id,
    'approvedHeadSha', binding.approved_head_sha, 'sourceRevision', binding.source_sha,
    'deploymentSourceId', binding.deployment_source_id
  );
end;
$$;

create function public.cancel_factory_delivery_command(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_command_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare command internal.factory_delivery_commands;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into command from internal.factory_delivery_commands
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id) for update;
  if not found then raise exception 'Delivery command not found.' using errcode = 'P0002'; end if;
  if command.dispatch_state = 'cancelled' then return internal.factory_delivery_command_summary(command); end if;
  if command.dispatch_state <> 'queued' then
    raise exception 'Only an undispatched delivery command can be cancelled.' using errcode = 'PT409';
  end if;
  update internal.factory_delivery_commands set dispatch_state = 'cancelled'
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id)
    returning * into command;
  return internal.factory_delivery_command_summary(command);
end;
$$;

-- An adapter may claim only a command for its own explicitly configured
-- provider. A lost or interrupted claim never becomes eligible for redispatch.
create function public.claim_factory_delivery_command(
  p_workspace_id uuid, p_factory_id uuid, p_command_id uuid, p_provider text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  command internal.factory_delivery_commands;
  binding internal.factory_delivery_commands;
  source internal.factory_deployment_sources;
  started_at timestamptz;
begin
  select target.* into command from internal.factory_delivery_commands target
  join internal.factory_deployment_sources settings on settings.id = target.deployment_source_id
  where (target.workspace_id, target.factory_id, target.id, settings.provider) =
    (p_workspace_id, p_factory_id, p_command_id, p_provider)
    and target.dispatch_state = 'queued';
  if not found then return null; end if;
  begin
    binding := internal.require_factory_delivery_command_authority(p_workspace_id, p_factory_id,
      command.session_id, command.checkpoint_run_id, command.approval_id, command.policy_revision_id,
      command.merge_observation_id, command.deployment_source_id);
  exception when sqlstate 'PT409' or sqlstate 'P0010' or sqlstate 'P0011' or sqlstate 'P0002'
    or sqlstate '42501' or sqlstate '23503' then
    update internal.factory_delivery_commands set dispatch_state = 'blocked'
      where (workspace_id, factory_id, id, dispatch_state) = (p_workspace_id, p_factory_id, p_command_id, 'queued');
    return null;
  end;
  if binding.artifact_review_revision is distinct from command.artifact_review_revision then
    update internal.factory_delivery_commands set dispatch_state = 'blocked'
      where (workspace_id, factory_id, id, dispatch_state) = (p_workspace_id, p_factory_id, p_command_id, 'queued');
    return null;
  end if;
  select * into strict source from internal.factory_deployment_sources where id = command.deployment_source_id;
  started_at := clock_timestamp();
  update internal.factory_delivery_commands set dispatch_state = 'dispatching', lease_id = gen_random_uuid(),
    dispatch_started_at = started_at, lease_expires_at = started_at + interval '60 seconds'
    where (workspace_id, factory_id, id, dispatch_state) = (p_workspace_id, p_factory_id, p_command_id, 'queued')
    returning * into command;
  if not found then return null; end if;
  return internal.factory_delivery_command_summary(command) || jsonb_build_object(
    'provider', source.provider, 'providerProjectId', source.provider_project_id, 'environment', source.environment,
    'externalDeploymentId', command.id::text, 'leaseId', command.lease_id, 'leaseExpiresAt', command.lease_expires_at
  );
end;
$$;

create function public.settle_factory_delivery_dispatch(
  p_workspace_id uuid, p_factory_id uuid, p_command_id uuid, p_lease_id uuid, p_dispatch_state text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_dispatch_state is null or p_dispatch_state not in ('accepted', 'rejected', 'unknown') then
    raise exception 'Invalid provider dispatch result.' using errcode = '22023';
  end if;
  update internal.factory_delivery_commands set dispatch_state = p_dispatch_state,
    outcome = case p_dispatch_state when 'accepted' then 'pending' when 'unknown' then 'unknown' end,
    lease_id = null, lease_expires_at = null
    where (workspace_id, factory_id, id, lease_id, dispatch_state) =
      (p_workspace_id, p_factory_id, p_command_id, p_lease_id, 'dispatching') and lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function public.expire_factory_delivery_dispatches() returns integer
language plpgsql security definer set search_path = '' as $$
declare expired integer;
begin
  with due as (
    select workspace_id, factory_id, id from internal.factory_delivery_commands
    where dispatch_state = 'dispatching' and lease_expires_at <= clock_timestamp()
    order by lease_expires_at limit 50 for update skip locked
  )
  update internal.factory_delivery_commands command
    set dispatch_state = 'unknown', outcome = 'unknown', lease_id = null, lease_expires_at = null
    from due where (command.workspace_id, command.factory_id, command.id) = (due.workspace_id, due.factory_id, due.id);
  get diagnostics expired = row_count;
  return expired;
end;
$$;

-- M06 authenticates reporters and serializes revisions by provider deployment
-- identity. Reuse that identity so credential rotation preserves correlation.
-- A newer contradictory report invalidates the last outcome.
create function internal.correlate_factory_delivery_observation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update internal.factory_delivery_commands command
    set dispatch_state = case when new.source_sha = command.source_sha then 'accepted' else 'unknown' end,
      outcome = case when new.source_sha = command.source_sha then new.outcome else 'unknown' end,
      lease_id = null, lease_expires_at = null, deployment_observation_id = new.id,
      deployment_observation_revision = new.revision
    from internal.factory_deployments identity, internal.factory_deployment_sources configured
    where identity.id = new.deployment_id
      and configured.id = command.deployment_source_id
      and (command.workspace_id, command.factory_id, command.repository_id, command.id::text) =
        (identity.workspace_id, identity.factory_id, identity.repository_id, identity.external_deployment_id)
      and (configured.provider, configured.provider_project_id, configured.environment) =
        (identity.provider, identity.provider_project_id, identity.environment)
      and command.dispatch_state in ('dispatching', 'accepted', 'unknown')
      and new.observed_at >= command.dispatch_started_at
      and new.revision > coalesce(command.deployment_observation_revision, 0)
      and not exists (
        select 1 from internal.factory_deployment_observation_revisions latest
        where latest.deployment_id = new.deployment_id and latest.revision > new.revision
      );
  return new;
end;
$$;
create trigger correlate_factory_delivery_observation after insert on internal.factory_deployment_observation_revisions
  for each row execute function internal.correlate_factory_delivery_observation();

revoke all on function
  internal.record_factory_delivery_command_receipt(),
  internal.factory_delivery_command_summary(internal.factory_delivery_commands),
  internal.require_factory_delivery_command_authority(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid),
  internal.correlate_factory_delivery_observation(),
  public.prepare_factory_delivery_command(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid),
  public.read_factory_delivery_command(uuid, uuid, uuid, uuid),
  public.read_factory_delivery_command_candidate(uuid, uuid, uuid, uuid, uuid),
  public.cancel_factory_delivery_command(uuid, uuid, uuid, uuid),
  public.claim_factory_delivery_command(uuid, uuid, uuid, text),
  public.settle_factory_delivery_dispatch(uuid, uuid, uuid, uuid, text),
  public.expire_factory_delivery_dispatches() from public, anon, authenticated, service_role;

grant execute on function
  public.prepare_factory_delivery_command(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid),
  public.read_factory_delivery_command(uuid, uuid, uuid, uuid),
  public.read_factory_delivery_command_candidate(uuid, uuid, uuid, uuid, uuid),
  public.cancel_factory_delivery_command(uuid, uuid, uuid, uuid),
  public.claim_factory_delivery_command(uuid, uuid, uuid, text),
  public.settle_factory_delivery_dispatch(uuid, uuid, uuid, uuid, text),
  public.expire_factory_delivery_dispatches() to service_role;
