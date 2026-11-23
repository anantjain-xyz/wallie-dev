create table internal.factory_actions_delivery_requests (
  workspace_id uuid not null,
  factory_id uuid not null,
  command_id uuid not null,
  installation_row_id uuid not null,
  installation_id bigint not null check (installation_id between 1 and 9007199254740991),
  repository_numeric_id bigint not null check (repository_numeric_id between 1 and 9007199254740991),
  repository_full_name text not null check (repository_full_name ~ '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$'),
  workflow_id bigint not null check (workflow_id between 1 and 9007199254740991),
  workflow_path text not null check (workflow_path ~ '^\.github/workflows/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.ya?ml$'),
  tag text not null check (char_length(tag) <= 128 and tag ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*(/[A-Za-z0-9][A-Za-z0-9_.-]*)*$'
    and tag not like '%..%' and tag !~ '(\.lock|\.)(/|$)'),
  inputs jsonb not null,
  run_nonce uuid not null unique default gen_random_uuid(),
  reason text not null default 'awaiting_dispatch' check (reason in (
    'awaiting_dispatch', 'app_unavailable', 'installation_unavailable', 'permission_missing',
    'repository_unavailable', 'workflow_unavailable', 'workflow_contract_mismatch', 'immutable_tag_required',
    'guarded_source_changed', 'cancelled',
    'source_mismatch', 'github_unavailable', 'provider_refused', 'dispatch_unknown', 'awaiting_run',
    'run_unavailable', 'run_mismatch', 'run_verified', 'observation_expired'
  )),
  run_id bigint check (run_id between 1 and 9007199254740991),
  run_status text check (run_status in ('queued', 'requested', 'waiting', 'pending', 'in_progress', 'completed')),
  run_conclusion text check (run_conclusion in (
    'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure'
  )),
  next_check_at timestamptz not null default clock_timestamp(),
  observation_id uuid,
  primary key (workspace_id, factory_id, command_id),
  foreign key (workspace_id, factory_id, command_id)
    references internal.factory_delivery_commands(workspace_id, factory_id, id) on delete cascade,
  check (run_status is null or run_id is not null),
  check (run_conclusion is null or run_status = 'completed')
);
alter table internal.factory_actions_delivery_requests enable row level security;
revoke all on internal.factory_actions_delivery_requests from public, anon, authenticated, service_role;
create index factory_actions_delivery_due_idx on internal.factory_actions_delivery_requests
  (next_check_at, command_id) where next_check_at < 'infinity'::timestamptz;

create function internal.enforce_factory_actions_delivery_configuration() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from internal.factory_actions_delivery_requests configured
    where (configured.workspace_id, configured.factory_id, configured.command_id) = (new.workspace_id, new.factory_id, new.id)
  ) then raise exception 'GitHub Actions delivery requires an explicit immutable workflow target.' using errcode = 'PT409'; end if;
  return new;
end;
$$;
create constraint trigger factory_actions_delivery_requires_configuration
  after insert on internal.factory_delivery_commands deferrable initially deferred
  for each row when (new.provider = 'github-actions')
  execute function internal.enforce_factory_actions_delivery_configuration();

create function internal.park_terminal_factory_actions_delivery() returns trigger
language plpgsql set search_path = '' as $$
begin
  update internal.factory_actions_delivery_requests set next_check_at = 'infinity',
    reason = case new.dispatch_state when 'blocked' then 'guarded_source_changed' when 'cancelled' then 'cancelled' else reason end
    where (workspace_id, factory_id, command_id) = (new.workspace_id, new.factory_id, new.id);
  return new;
end;
$$;
create trigger factory_actions_delivery_park_terminal after update of dispatch_state on internal.factory_delivery_commands
  for each row when (new.provider = 'github-actions' and old.dispatch_state <> new.dispatch_state
    and new.dispatch_state in ('cancelled', 'blocked', 'rejected'))
  execute function internal.park_terminal_factory_actions_delivery();

create or replace function internal.factory_delivery_command_summary(command internal.factory_delivery_commands)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', command.id, 'sessionId', command.session_id, 'repositoryId', command.repository_id,
    'checkpointRunId', command.checkpoint_run_id, 'approvalId', command.approval_id,
    'policyRevisionId', command.policy_revision_id, 'mergeObservationId', command.merge_observation_id,
    'approvedHeadSha', command.approved_head_sha, 'sourceRevision', command.source_sha,
    'deploymentSourceId', command.deployment_source_id, 'requestedByMemberId', command.requested_by_member_id,
    'requestedAt', command.requested_at, 'dispatchState', command.dispatch_state, 'outcome', command.outcome,
    'dispatchStartedAt', command.dispatch_started_at, 'deploymentObservationId', command.deployment_observation_id
  ) || coalesce((
    select jsonb_build_object('actions', jsonb_build_object(
      'workflowId', configured.workflow_id, 'workflowPath', configured.workflow_path, 'tag', configured.tag,
      'reason', configured.reason, 'runId', configured.run_id, 'runStatus', configured.run_status,
      'runConclusion', configured.run_conclusion
    ))
    from internal.factory_actions_delivery_requests configured
    where (configured.workspace_id, configured.factory_id, configured.command_id) =
      (command.workspace_id, command.factory_id, command.id)
  ), '{}'::jsonb);
$$;

create function public.prepare_factory_actions_delivery_command(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_command_id uuid,
  p_session_id uuid, p_checkpoint_run_id uuid, p_approval_id uuid, p_policy_revision_id uuid,
  p_merge_observation_id uuid, p_deployment_source_id uuid,
  p_workflow_id bigint, p_workflow_path text, p_tag text, p_inputs jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  command internal.factory_delivery_commands;
  configured internal.factory_actions_delivery_requests;
  repository public.github_repositories;
  installation public.github_installations;
begin
  if jsonb_typeof(p_inputs) is distinct from 'object' then
    raise exception 'Invalid Actions workflow inputs.' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_each(p_inputs)) > 8 or exists (
    select 1 from jsonb_each(p_inputs) option
    where option.key !~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$' or left(option.key, 7) = 'wallie_'
      or jsonb_typeof(option.value) <> 'string' or char_length(option.value #>> '{}') > 256
  ) then raise exception 'Invalid Actions workflow inputs.' using errcode = '22023'; end if;

  perform public.prepare_factory_delivery_command(p_workspace_id, p_factory_id, p_actor_user_id, p_command_id,
    p_session_id, p_checkpoint_run_id, p_approval_id, p_policy_revision_id, p_merge_observation_id, p_deployment_source_id);
  select * into strict command from internal.factory_delivery_commands
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id)
    for update;
  if command.provider <> 'github-actions' or command.provider_project_id is distinct from p_workflow_id::text then
    raise exception 'The approved deployment source does not match the selected GitHub workflow.' using errcode = 'PT409';
  end if;

  select * into configured from internal.factory_actions_delivery_requests
    where (workspace_id, factory_id, command_id) = (p_workspace_id, p_factory_id, p_command_id);
  if found then
    if (configured.workflow_id, configured.workflow_path, configured.tag, configured.inputs) is distinct from
      (p_workflow_id, p_workflow_path, p_tag, p_inputs) then
      raise exception 'The delivery command is already bound to a different Actions target.' using errcode = 'PT409';
    end if;
    return internal.factory_delivery_command_summary(command);
  end if;
  if command.dispatch_state <> 'queued' then
    raise exception 'The delivery command cannot be configured after dispatch.' using errcode = 'PT409';
  end if;

  select * into repository from public.github_repositories
    where (workspace_id, id) = (p_workspace_id, command.repository_id) and not is_archived;
  select * into installation from public.github_installations
    where (workspace_id, id) = (p_workspace_id, repository.github_installation_id) and not suspended;
  if not found then
    raise exception 'Connect the repository installation before preparing Actions delivery.' using errcode = 'PT409';
  end if;

  insert into internal.factory_actions_delivery_requests (
    workspace_id, factory_id, command_id, installation_row_id, installation_id, repository_numeric_id,
    repository_full_name, workflow_id, workflow_path, tag, inputs
  ) values (
    p_workspace_id, p_factory_id, p_command_id, installation.id, installation.installation_id,
    repository.repo_id, repository.full_name, p_workflow_id, p_workflow_path, p_tag, p_inputs
  );
  return internal.factory_delivery_command_summary(command);
end;
$$;

create function internal.factory_actions_delivery_packet(
  command internal.factory_delivery_commands, configured internal.factory_actions_delivery_requests
) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'workspaceId', command.workspace_id, 'factoryId', command.factory_id, 'commandId', command.id,
    'installationId', configured.installation_id, 'repositoryNumericId', configured.repository_numeric_id,
    'repositoryFullName', configured.repository_full_name, 'workflowId', configured.workflow_id,
    'workflowPath', configured.workflow_path, 'tag', configured.tag, 'inputs', configured.inputs,
    'runNonce', configured.run_nonce, 'sourceRevision', command.source_sha, 'environment', command.environment
  );
$$;

create function internal.factory_actions_delivery_installation_is_current(
  command internal.factory_delivery_commands, configured internal.factory_actions_delivery_requests
) returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.github_repositories repository
    join public.github_installations installation
      on (installation.workspace_id, installation.id) = (repository.workspace_id, repository.github_installation_id)
    where (repository.workspace_id, repository.id, repository.repo_id, repository.full_name) =
      (command.workspace_id, command.repository_id, configured.repository_numeric_id, configured.repository_full_name)
      and (installation.id, installation.installation_id) = (configured.installation_row_id, configured.installation_id)
      and not repository.is_archived and not installation.suspended
  );
$$;

create function public.list_factory_actions_dispatches() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('workspaceId', due.workspace_id,
    'factoryId', due.factory_id, 'commandId', due.command_id)), '[]'::jsonb)
  from (
    select configured.workspace_id, configured.factory_id, configured.command_id
    from internal.factory_actions_delivery_requests configured
    join internal.factory_delivery_commands command on (command.workspace_id, command.factory_id, command.id) =
      (configured.workspace_id, configured.factory_id, configured.command_id)
    where command.dispatch_state = 'queued' and configured.next_check_at < 'infinity'
      and configured.next_check_at <= statement_timestamp()
    order by configured.next_check_at, configured.command_id limit 8
  ) due;
$$;

create function public.claim_factory_actions_dispatch(p_workspace_id uuid, p_factory_id uuid, p_command_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  command internal.factory_delivery_commands;
  configured internal.factory_actions_delivery_requests;
  claimed jsonb;
begin
  select * into configured from internal.factory_actions_delivery_requests
    where (workspace_id, factory_id, command_id) = (p_workspace_id, p_factory_id, p_command_id);
  if not found then return null; end if;
  select * into command from internal.factory_delivery_commands
    where (workspace_id, factory_id, id, dispatch_state) = (p_workspace_id, p_factory_id, p_command_id, 'queued');
  if not found then return null; end if;
  if not internal.factory_actions_delivery_installation_is_current(command, configured) then
    update internal.factory_delivery_commands set dispatch_state = 'blocked'
      where (workspace_id, factory_id, id, dispatch_state) = (p_workspace_id, p_factory_id, p_command_id, 'queued');
    if found then
      update internal.factory_actions_delivery_requests set reason = 'installation_unavailable', next_check_at = 'infinity'
        where (workspace_id, factory_id, command_id) = (p_workspace_id, p_factory_id, p_command_id);
    end if;
    return null;
  end if;
  claimed := public.claim_factory_delivery_command(p_workspace_id, p_factory_id, p_command_id, 'github-actions');
  if claimed is null then return null; end if;
  select * into strict command from internal.factory_delivery_commands
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id);
  if not internal.factory_actions_delivery_installation_is_current(command, configured) then
    perform public.settle_factory_delivery_dispatch(p_workspace_id, p_factory_id, p_command_id, command.lease_id, 'rejected');
    update internal.factory_actions_delivery_requests set reason = 'installation_unavailable', next_check_at = 'infinity'
      where (workspace_id, factory_id, command_id) = (p_workspace_id, p_factory_id, p_command_id);
    return null;
  end if;
  return internal.factory_actions_delivery_packet(command, configured) ||
    jsonb_build_object('leaseId', command.lease_id, 'leaseExpiresAt', command.lease_expires_at);
end;
$$;

create function public.defer_factory_actions_dispatch(p_workspace_id uuid, p_factory_id uuid, p_command_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update internal.factory_actions_delivery_requests configured set next_check_at = clock_timestamp() + interval '1 minute'
    where (configured.workspace_id, configured.factory_id, configured.command_id) = (p_workspace_id, p_factory_id, p_command_id)
      and configured.next_check_at <= clock_timestamp() and exists (
        select 1 from internal.factory_delivery_commands command
        where (command.workspace_id, command.factory_id, command.id) = (p_workspace_id, p_factory_id, p_command_id)
          and command.dispatch_state = 'queued'
      );
  return found;
end;
$$;

create function public.settle_factory_actions_dispatch(p_workspace_id uuid, p_factory_id uuid, p_command_id uuid,
  p_lease_id uuid, p_dispatch_state text, p_reason text, p_run_id bigint default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if (p_dispatch_state = 'accepted') is distinct from (p_run_id is not null)
    or (p_dispatch_state = 'accepted') is distinct from (p_reason = 'awaiting_run')
    or (p_dispatch_state = 'unknown') is distinct from (p_reason = 'dispatch_unknown') then
    raise exception 'The dispatch receipt does not match the provider result.' using errcode = '22023';
  end if;
  if not public.settle_factory_delivery_dispatch(p_workspace_id, p_factory_id, p_command_id, p_lease_id, p_dispatch_state)
    then return false; end if;
  update internal.factory_actions_delivery_requests set reason = p_reason, run_id = p_run_id,
    next_check_at = case when p_dispatch_state = 'rejected' then 'infinity'::timestamptz else clock_timestamp() end
    where (workspace_id, factory_id, command_id) = (p_workspace_id, p_factory_id, p_command_id);
  if not found then raise exception 'Actions delivery target disappeared.' using errcode = 'PT409'; end if;
  return true;
end;
$$;

create function public.reserve_factory_actions_observations() returns jsonb
language sql security definer set search_path = '' as $$
  with due as (
    select configured.workspace_id, configured.factory_id, configured.command_id,
      command.dispatch_started_at,
      internal.factory_actions_delivery_installation_is_current(command, configured) as installation_current
    from internal.factory_actions_delivery_requests configured
    join internal.factory_delivery_commands command on (command.workspace_id, command.factory_id, command.id) =
      (configured.workspace_id, configured.factory_id, configured.command_id)
    where command.dispatch_state in ('accepted', 'unknown') and configured.next_check_at < 'infinity'
      and configured.next_check_at <= statement_timestamp()
    order by configured.next_check_at, configured.command_id limit 8 for update of configured skip locked
  ), reserved as (
    update internal.factory_actions_delivery_requests configured
      set next_check_at = case when due.dispatch_started_at <= statement_timestamp() - interval '30 minutes'
        then 'infinity'::timestamptz else statement_timestamp() + interval '90 seconds' end,
        reason = case when due.dispatch_started_at <= statement_timestamp() - interval '30 minutes' and configured.run_status is null
          then 'observation_expired' when not due.installation_current then 'installation_unavailable'
          else configured.reason end,
        observation_id = gen_random_uuid()
    from due where (configured.workspace_id, configured.factory_id, configured.command_id) =
      (due.workspace_id, due.factory_id, due.command_id)
    returning configured.*
  )
  select coalesce(jsonb_agg(internal.factory_actions_delivery_packet(command, reserved) || jsonb_build_object(
    'dispatchStartedAt', command.dispatch_started_at, 'observationId', reserved.observation_id, 'runId', reserved.run_id
  )), '[]'::jsonb)
  from reserved
  join internal.factory_delivery_commands command on (command.workspace_id, command.factory_id, command.id) =
    (reserved.workspace_id, reserved.factory_id, reserved.command_id)
  where reserved.next_check_at <> 'infinity' and internal.factory_actions_delivery_installation_is_current(command, reserved);
$$;

create function public.settle_factory_actions_observation(
  p_workspace_id uuid, p_factory_id uuid, p_command_id uuid, p_observation_id uuid,
  p_reason text, p_run_id bigint default null, p_run_status text default null, p_run_conclusion text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare command internal.factory_delivery_commands;
begin
  if (p_reason = 'run_verified') is distinct from (p_run_id is not null and p_run_status is not null)
    or (p_run_id is null) <> (p_run_status is null) then
    raise exception 'The run receipt does not match the verified workflow.' using errcode = '22023';
  end if;
  select * into command from internal.factory_delivery_commands
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id)
    for update;
  if not found then return false; end if;
  update internal.factory_actions_delivery_requests configured
    set reason = p_reason, run_id = coalesce(p_run_id, run_id), run_status = coalesce(p_run_status, run_status),
      run_conclusion = coalesce(p_run_conclusion, run_conclusion), observation_id = null,
      next_check_at = case when p_run_status = 'completed' then 'infinity'::timestamptz else next_check_at end
    where (workspace_id, factory_id, command_id, observation_id) = (p_workspace_id, p_factory_id, p_command_id, p_observation_id)
      and next_check_at > clock_timestamp() and (p_run_id is null or run_id is null or p_run_id = run_id)
      and (p_run_id is null or internal.factory_actions_delivery_installation_is_current(command, configured));
  if not found then return false; end if;
  if p_run_id is not null and command.dispatch_state = 'unknown' and command.deployment_observation_id is null then
    update internal.factory_delivery_commands set dispatch_state = 'accepted', outcome = 'pending'
      where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_command_id);
  end if;
  return true;
end;
$$;

revoke all on function
  internal.enforce_factory_actions_delivery_configuration(),
  internal.park_terminal_factory_actions_delivery(),
  internal.factory_actions_delivery_packet(internal.factory_delivery_commands, internal.factory_actions_delivery_requests),
  internal.factory_actions_delivery_installation_is_current(internal.factory_delivery_commands, internal.factory_actions_delivery_requests)
from public, anon, authenticated, service_role;

revoke all on function
  public.prepare_factory_actions_delivery_command(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, jsonb),
  public.list_factory_actions_dispatches(),
  public.claim_factory_actions_dispatch(uuid, uuid, uuid),
  public.defer_factory_actions_dispatch(uuid, uuid, uuid),
  public.settle_factory_actions_dispatch(uuid, uuid, uuid, uuid, text, text, bigint),
  public.reserve_factory_actions_observations(),
  public.settle_factory_actions_observation(uuid, uuid, uuid, uuid, text, bigint, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.prepare_factory_actions_delivery_command(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint, text, text, jsonb),
  public.list_factory_actions_dispatches(),
  public.claim_factory_actions_dispatch(uuid, uuid, uuid),
  public.defer_factory_actions_dispatch(uuid, uuid, uuid),
  public.settle_factory_actions_dispatch(uuid, uuid, uuid, uuid, text, text, bigint),
  public.reserve_factory_actions_observations(),
  public.settle_factory_actions_observation(uuid, uuid, uuid, uuid, text, bigint, text, text)
to service_role;
