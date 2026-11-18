-- Factory bindings reserve one existing encrypted workspace secret for an exact
-- grant, named agent, and provider. A deleted secret leaves the binding unavailable.
alter table public.workspace_secrets
  add column material_revision bigint not null default 1 check (material_revision > 0),
  add column material_rotated_at timestamptz;
alter table public.workspace_secrets alter column material_rotated_at set default clock_timestamp();

create table public.factory_secret_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  execution_grant_id uuid not null references public.factory_execution_grants(id) on delete cascade,
  service_principal_id uuid not null,
  factory_agent_id uuid not null,
  agent_provider text not null check (agent_provider in ('codex', 'claude-code', 'cursor', 'opencode')),
  open_code_provider_id text check (open_code_provider_id ~ '^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$'),
  workspace_secret_id uuid not null unique,
  version bigint not null default 1 check (version > 0),
  created_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_by_member_id uuid,
  revoked_at timestamptz,
  foreign key (workspace_id, factory_id, service_principal_id)
    references public.service_principals(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, factory_agent_id)
    references public.factory_agents(workspace_id, factory_id, id) on delete cascade,
  check ((revoked_by_member_id is null) = (revoked_at is null)),
  check ((agent_provider = 'opencode') = (open_code_provider_id is not null))
);
create unique index factory_secret_bindings_active_scope_idx
  on public.factory_secret_bindings(execution_grant_id, factory_agent_id, agent_provider, (coalesce(open_code_provider_id, '')))
  where revoked_at is null;
create index factory_secret_bindings_factory_idx on public.factory_secret_bindings(workspace_id, factory_id);
alter table public.factory_secret_bindings enable row level security;
revoke all on public.factory_secret_bindings from public, anon, authenticated, service_role;
grant select on public.factory_secret_bindings to service_role;

create table public.factory_run_credential_receipts (
  run_id uuid primary key references public.agent_runs(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  factory_id uuid not null,
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  attempt_count integer not null check (attempt_count > 0),
  binding_id uuid not null,
  binding_version bigint not null check (binding_version > 0),
  material_revision bigint not null check (material_revision > 0),
  service_principal_id uuid not null,
  agent_provider text not null check (agent_provider in ('codex', 'claude-code', 'cursor', 'opencode')),
  resolved_at timestamptz not null default clock_timestamp()
);
create index factory_run_credential_receipts_session_idx
  on public.factory_run_credential_receipts(workspace_id, session_id);
alter table public.factory_run_credential_receipts enable row level security;
revoke all on public.factory_run_credential_receipts from public, anon, authenticated, service_role;
grant select on public.factory_run_credential_receipts to authenticated, service_role;
create policy factory_run_credential_receipts_read_factory on public.factory_run_credential_receipts for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));
create trigger factory_run_credential_receipts_immutable before update or delete on public.factory_run_credential_receipts
  for each row execute function internal.guard_validation_evidence_history();

alter table public.factory_audit_events
  drop constraint factory_audit_events_action_check,
  add constraint factory_audit_events_action_check check (action in (
    'factory.created', 'factory.archived', 'factory.restored',
    'membership.granted', 'membership.revoked', 'membership.suspended', 'membership.reinstated',
    'agent.created', 'agent.prompt_revision_created',
    'skill.created', 'skill.revision_created', 'skill.revision_revoked',
    'service_principal.created', 'execution_grant.approved', 'execution_grant.updated', 'execution_grant.revoked',
    'credential_binding.created', 'credential_binding.revoked'
  ));

create function internal.revise_workspace_secret_material()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Existing secret writes retain responsibility for encryption and storage.
  new.material_revision := old.material_revision;
  new.material_rotated_at := coalesce(old.material_rotated_at, old.updated_at);
  if new.encrypted_value is distinct from old.encrypted_value then
    new.material_revision := old.material_revision + 1;
    new.material_rotated_at := clock_timestamp();
  end if;
  if exists (select 1 from public.factory_secret_bindings binding where binding.workspace_secret_id = old.id) then
    if (new.id, new.workspace_id, new.key) is distinct from (old.id, old.workspace_id, old.key) then
      raise exception 'A claimed secret cannot change its identity.' using errcode = '23514';
    end if;
    new.value_preview := null;
  end if;
  return new;
end;
$$;
revoke all on function internal.revise_workspace_secret_material() from public, anon, authenticated, service_role;
create trigger workspace_secrets_revise_material before update on public.workspace_secrets
  for each row execute function internal.revise_workspace_secret_material();

create function internal.assert_factory_secret_binding_owner(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns uuid language plpgsql set search_path = '' as $$
declare actor_member_id uuid;
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if not exists (select 1 from public.workspace_members member
      where member.id = actor_member_id and member.role in ('owner', 'admin')) then
    raise exception 'Workspace owner or admin access is required to delegate a secret.' using errcode = '42501';
  end if;
  return actor_member_id;
end;
$$;
revoke all on function internal.assert_factory_secret_binding_owner(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.create_factory_secret_binding(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_execution_grant_id uuid, p_execution_grant_version bigint,
  p_factory_agent_id uuid, p_agent_provider text, p_workspace_secret_id uuid,
  p_open_code_provider_id text default null
) returns public.factory_secret_bindings language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; execution_grant public.factory_execution_grants; result public.factory_secret_bindings;
begin
  actor_member_id := internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select * into execution_grant from public.factory_execution_grants grant_row
  where (grant_row.workspace_id, grant_row.factory_id, grant_row.id) =
    (p_workspace_id, p_factory_id, p_execution_grant_id);
  if not found then raise exception 'The execution grant is unavailable.' using errcode = 'P0002'; end if;
  if execution_grant.version is distinct from p_execution_grant_version then
    raise exception 'The execution grant changed. Reload before delegating a secret.' using errcode = 'PT409';
  end if;
  execution_grant := internal.require_current_factory_execution_grant(
    p_workspace_id, p_factory_id, p_execution_grant_id, p_execution_grant_version,
    execution_grant.github_repository_id, execution_grant.read_context_repository_ids,
    execution_grant.tool_ids, execution_grant.execution_policy_revision_id
  );

  if p_agent_provider is null or p_agent_provider not in ('codex', 'claude-code', 'cursor', 'opencode') then
    raise exception 'The agent provider is unsupported.' using errcode = '22023';
  end if;
  if (p_agent_provider = 'opencode') <> (p_open_code_provider_id is not null)
    or p_open_code_provider_id !~ '^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$' then
    raise exception 'Select the exact upstream OpenCode provider for this binding.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.factory_agents agent
    where (agent.workspace_id, agent.factory_id, agent.id) = (p_workspace_id, p_factory_id, p_factory_agent_id)) then
    raise exception 'The factory agent is unavailable.' using errcode = 'P0002';
  end if;
  perform 1 from public.workspace_secrets source
    where (source.workspace_id, source.id) = (p_workspace_id, p_workspace_secret_id)
      and source.key <> 'LINEAR_API_KEY' for update;
  if not found then raise exception 'The workspace secret is unavailable for delegation.' using errcode = 'P0002'; end if;

  insert into public.factory_secret_bindings(
    workspace_id, factory_id, execution_grant_id, service_principal_id, factory_agent_id,
    agent_provider, open_code_provider_id, workspace_secret_id, created_by_member_id
  ) values (
    p_workspace_id, p_factory_id, p_execution_grant_id, execution_grant.service_principal_id,
    p_factory_agent_id, p_agent_provider, p_open_code_provider_id, p_workspace_secret_id, actor_member_id
  ) returning * into result;
  update public.workspace_secrets set value_preview = null
    where (workspace_id, id) = (p_workspace_id, p_workspace_secret_id) and value_preview is not null;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id, 'credential_binding.created', actor_member_id,
      jsonb_build_object('bindingId', result.id, 'version', result.version,
        'servicePrincipalId', result.service_principal_id, 'factoryAgentId', result.factory_agent_id,
        'executionGrantId', result.execution_grant_id, 'agentProvider', result.agent_provider,
        'openCodeProviderId', result.open_code_provider_id));
  return result;
exception when unique_violation then
  raise exception 'The workspace secret or execution credential scope is already claimed.' using errcode = 'PT409';
end;
$$;
revoke all on function public.create_factory_secret_binding(uuid, uuid, uuid, uuid, bigint, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_factory_secret_binding(uuid, uuid, uuid, uuid, bigint, uuid, text, uuid, text) to service_role;

create function public.revoke_factory_secret_binding(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_binding_id uuid, p_expected_version bigint
) returns public.factory_secret_bindings language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; binding public.factory_secret_bindings;
begin
  actor_member_id := internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into binding from public.factory_secret_bindings target
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_binding_id)
  for update;
  if not found then raise exception 'The credential binding is unavailable.' using errcode = 'P0002'; end if;
  if binding.version is distinct from p_expected_version or binding.revoked_at is not null then
    raise exception 'The credential binding changed. Reload before revoking.' using errcode = 'PT409';
  end if;
  update public.factory_secret_bindings target set
    version = target.version + 1, revoked_at = clock_timestamp(), revoked_by_member_id = actor_member_id
  where target.id = binding.id returning * into binding;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id, 'credential_binding.revoked', actor_member_id,
      jsonb_build_object('bindingId', binding.id, 'version', binding.version));
  return binding;
end;
$$;
revoke all on function public.revoke_factory_secret_binding(uuid, uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_factory_secret_binding(uuid, uuid, uuid, uuid, bigint) to service_role;

create function internal.factory_secret_binding_metadata(p_workspace_id uuid, p_factory_id uuid)
returns table (
  id uuid, workspace_id uuid, factory_id uuid, execution_grant_id uuid, service_principal_id uuid,
  factory_agent_id uuid, agent_provider text, open_code_provider_id text, workspace_secret_id uuid,
  version bigint, created_at timestamptz, revoked_at timestamptz,
  material_revision bigint, rotated_at timestamptz, status text, secret_key text, grant_version bigint
) language sql stable set search_path = '' as $$
  select binding.id, binding.workspace_id, binding.factory_id, binding.execution_grant_id,
    binding.service_principal_id, binding.factory_agent_id, binding.agent_provider, binding.open_code_provider_id,
    binding.workspace_secret_id,
    binding.version, binding.created_at, binding.revoked_at, source.material_revision,
    coalesce(source.material_rotated_at, source.updated_at),
    case
      when binding.revoked_at is not null then 'revoked'
      when grant_row.id is null or grant_row.revoked_at is not null or grant_row.expires_at <= statement_timestamp()
        or factory.archived_at is not null or workspace.deletion_requested_at is not null then 'grant_unavailable'
      when source.id is null then 'missing'
      else 'ready'
    end,
    source.key,
    grant_row.version
  from public.factory_secret_bindings binding
  join public.factories factory on (factory.workspace_id, factory.id) = (binding.workspace_id, binding.factory_id)
  join public.workspaces workspace on workspace.id = binding.workspace_id
  left join public.factory_execution_grants grant_row
    on (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.service_principal_id) =
       (binding.workspace_id, binding.factory_id, binding.execution_grant_id, binding.service_principal_id)
  left join public.workspace_secrets source
    on (source.workspace_id, source.id) = (binding.workspace_id, binding.workspace_secret_id)
    and source.key <> 'LINEAR_API_KEY'
  where (binding.workspace_id, binding.factory_id) = (p_workspace_id, p_factory_id);
$$;
revoke all on function internal.factory_secret_binding_metadata(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.list_factory_secret_bindings(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns table (
  id uuid, workspace_id uuid, factory_id uuid, execution_grant_id uuid, service_principal_id uuid,
  factory_agent_id uuid, agent_provider text, open_code_provider_id text, workspace_secret_id uuid, version bigint,
  created_at timestamptz, revoked_at timestamptz, material_revision bigint, rotated_at timestamptz,
  status text, secret_key text
) language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  return query
    select binding.id, binding.workspace_id, binding.factory_id, binding.execution_grant_id,
      binding.service_principal_id, binding.factory_agent_id, binding.agent_provider, binding.open_code_provider_id,
      binding.workspace_secret_id,
      binding.version, binding.created_at, binding.revoked_at, binding.material_revision, binding.rotated_at,
      binding.status, binding.secret_key
    from internal.factory_secret_binding_metadata(p_workspace_id, p_factory_id) binding
    order by binding.created_at desc, binding.id;
end;
$$;
revoke all on function public.list_factory_secret_bindings(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_factory_secret_bindings(uuid, uuid, uuid) to service_role;

create function public.list_factory_bindable_workspace_secrets(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns table (id uuid, key text) language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  return query select source.id, source.key from public.workspace_secrets source
    where source.workspace_id = p_workspace_id and source.key <> 'LINEAR_API_KEY'
      and not exists (select 1 from public.factory_secret_bindings binding where binding.workspace_secret_id = source.id)
    order by source.key limit 1000;
end;
$$;
revoke all on function public.list_factory_bindable_workspace_secrets(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_bindable_workspace_secrets(uuid, uuid, uuid) to service_role;

-- Mirrors parseOpenCodeModelId: the first segment names the upstream provider.
create function internal.open_code_model_provider(p_agent_model text)
returns text language sql immutable strict set search_path = '' as $$
  select case when btrim(p_agent_model) ~ '^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?(?:/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?)+$'
    then split_part(btrim(p_agent_model), '/', 1) end;
$$;
revoke all on function internal.open_code_model_provider(text) from public, anon, authenticated, service_role;

create function public.check_factory_credential_binding(
  p_workspace_id uuid, p_factory_id uuid, p_binding_id uuid, p_execution_grant_id uuid,
  p_execution_grant_version bigint, p_factory_agent_id uuid, p_agent_provider text, p_agent_model text
) returns text language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when binding.status = 'ready' and binding.grant_version is distinct from p_execution_grant_version
      then 'grant_unavailable' else binding.status end
    from internal.factory_secret_binding_metadata(p_workspace_id, p_factory_id) binding
    where (binding.id, binding.execution_grant_id, binding.factory_agent_id, binding.agent_provider) =
      (p_binding_id, p_execution_grant_id, p_factory_agent_id, p_agent_provider)
      and binding.open_code_provider_id is not distinct from
        case when p_agent_provider = 'opencode' then internal.open_code_model_provider(p_agent_model) end
  ), 'missing');
$$;
revoke all on function public.check_factory_credential_binding(uuid, uuid, uuid, uuid, bigint, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.check_factory_credential_binding(uuid, uuid, uuid, uuid, bigint, uuid, text, text) to service_role;

-- This lock is taken after the grant fence. Revocation and secret rotation
-- therefore serialize with each activation, admission, and actual resolution.
create function internal.lock_definition_credential_binding(
  p_workspace_id uuid, p_factory_id uuid, p_definition jsonb,
  p_execution_grant_id uuid, p_service_principal_id uuid
) returns public.factory_secret_bindings language plpgsql set search_path = '' as $$
declare binding public.factory_secret_bindings;
  binding_ref text := p_definition->>'credentialBindingId';
  agent_ref text := p_definition#>>'{implementationAgent,agentId}';
begin
  if jsonb_typeof(p_definition->'credentialBindingId') is distinct from 'string'
    or not coalesce(pg_input_is_valid(binding_ref, 'uuid'), false)
    or not coalesce(pg_input_is_valid(agent_ref, 'uuid'), false)
    or p_service_principal_id is null or p_execution_grant_id is null then
    raise exception 'A current scoped credential binding is required.' using errcode = 'PT422';
  end if;
  select target.* into binding from public.factory_secret_bindings target
  join public.workspace_secrets source on (source.workspace_id, source.id) = (target.workspace_id, target.workspace_secret_id)
  where (target.workspace_id, target.factory_id, target.id) =
    (p_workspace_id, p_factory_id, binding_ref::uuid)
    and target.execution_grant_id = p_execution_grant_id
    and target.service_principal_id = p_service_principal_id
    and target.factory_agent_id = agent_ref::uuid
    and target.agent_provider = p_definition#>>'{agent,provider}'
    and target.open_code_provider_id is not distinct from
      case when target.agent_provider = 'opencode'
        then internal.open_code_model_provider(p_definition#>>'{agent,model}') end
    and target.revoked_at is null and source.key <> 'LINEAR_API_KEY'
  for share of target, source nowait;
  if not found then
    raise exception 'A current scoped credential binding is required.' using errcode = 'PT422';
  end if;
  return binding;
exception when lock_not_available then
  raise exception 'The credential binding or material is changing. Retry the operation.' using errcode = 'PT409';
end;
$$;
revoke all on function internal.lock_definition_credential_binding(uuid, uuid, jsonb, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function internal.guard_service_grant_activation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare definition jsonb; execution_grant public.factory_execution_grants;
begin
  select revision.definition_json::jsonb into definition
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (new.workspace_id, new.factory_id, new.revision_id);
  if definition ? 'executionGrant' then
    execution_grant := internal.resolve_definition_execution_grant(new.workspace_id, new.factory_id, definition,
      (definition->>'repositoryId')::uuid, (definition->>'executionPolicyRevisionId')::uuid);
  end if;
  if definition ? 'credentialBindingId' then
    perform internal.lock_definition_credential_binding(new.workspace_id, new.factory_id, definition,
      execution_grant.id, execution_grant.service_principal_id);
  end if;
  return new;
end;
$$;

create function internal.guard_admitted_factory_credential_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
declare definition jsonb;
begin
  select revision.definition_json::jsonb into definition
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (new.workspace_id, new.factory_id, new.definition_revision_id);
  if definition ? 'credentialBindingId' then
    perform internal.lock_definition_credential_binding(new.workspace_id, new.factory_id, definition,
      new.execution_grant_id, new.credential_owner_service_principal_id);
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_admitted_factory_credential_binding() from public, anon, authenticated, service_role;
create trigger factory_admission_credential_binding_scope after insert on public.session_factory_admission_inputs
  for each row execute function internal.guard_admitted_factory_credential_binding();

create function public.resolve_factory_run_credential(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns table (
  encrypted_value text, binding_id uuid, binding_version bigint,
  material_revision bigint, service_principal_id uuid, agent_provider text
) language plpgsql security definer set search_path = '' as $$
declare
  control internal.git_continuity_release_control;
  owner public.sessions;
  job public.agent_jobs;
  run public.agent_runs;
  admission public.session_factory_admission_inputs;
  binding public.factory_secret_bindings;
  source public.workspace_secrets;
  receipt public.factory_run_credential_receipts;
  definition jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_attempt_count is null or p_attempt_count <= 0 then
    raise exception 'The worker does not own a current credential resolution attempt.' using errcode = '42501';
  end if;
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  perform 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for share;
  if not found then
    raise exception 'The worker does not own a current credential resolution attempt.' using errcode = '42501';
  end if;
  select session.* into owner from public.sessions session
  join public.agent_jobs queued on (queued.workspace_id, queued.session_id) = (session.workspace_id, session.id)
  where queued.id = p_job_id and session.workspace_id = p_workspace_id
  for no key update of session;
  if not found or owner.archived_at is not null or owner.phase_status is distinct from 'in_progress'
    or not owner.execute_pinned_definition then
    raise exception 'The worker does not own a current credential resolution attempt.' using errcode = '42501';
  end if;

  -- Keep the attempt-start lock order (release, workspace, session, grant, job, run).
  perform internal.recheck_session_execution_grant(owner);
  select * into job from public.agent_jobs queued where queued.id = p_job_id for update;
  if not found or (job.workspace_id, job.session_id) is distinct from (owner.workspace_id, owner.id)
    or job.status not in ('started', 'running') or job.attempt_count is distinct from p_attempt_count
    or job.stage_id is null or job.stage_id is distinct from owner.current_stage_id then
    raise exception 'The worker does not own a current credential resolution attempt.' using errcode = '42501';
  end if;
  if owner.pipeline_id is not null and (not control.enabled
    or job.git_continuity_release_revision is distinct from control.revision
    or not exists (select 1 from public.session_git_continuity_enrollments enrollment
      where (enrollment.session_id, enrollment.workspace_id) = (owner.id, owner.workspace_id))) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode = 'P499P';
  end if;
  select * into run from public.agent_runs active where active.id = p_run_id for update;
  if not found or run.status is distinct from 'running'
    or (run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.stage_id)
      is distinct from (owner.workspace_id, owner.id, job.id, p_attempt_count, job.stage_id)
    or not exists (select 1 from public.session_attempt_manifests manifest
      where (manifest.workspace_id, manifest.session_id, manifest.job_id, manifest.run_id, manifest.attempt_count) =
        (owner.workspace_id, owner.id, job.id, run.id, p_attempt_count)
        and manifest.credential_owner_member_id is null) then
    raise exception 'The worker does not own a current credential resolution attempt.' using errcode = '42501';
  end if;

  select * into admission from public.session_factory_admission_inputs input
  where (input.workspace_id, input.factory_id, input.session_id, input.definition_revision_id) =
    (owner.workspace_id, owner.factory_id, owner.id, owner.factory_definition_revision_id);
  if not found or admission.execution_grant_id is null or admission.credential_owner_service_principal_id is null then
    raise exception 'The service credential authority is unavailable.' using errcode = '42501';
  end if;
  definition := internal.pinned_session_execution_definition(owner);
  binding := internal.lock_definition_credential_binding(
    owner.workspace_id, owner.factory_id, definition, admission.execution_grant_id,
    admission.credential_owner_service_principal_id);
  if (binding.factory_agent_id, binding.agent_provider, definition#>>'{agent,model}')
    is distinct from (run.agent_id, run.model_provider, run.model_name) then
    raise exception 'The service credential authority is unavailable.' using errcode = '42501';
  end if;
  select * into strict source from public.workspace_secrets material
  where (material.workspace_id, material.id) = (binding.workspace_id, binding.workspace_secret_id);

  select * into receipt from public.factory_run_credential_receipts evidence where evidence.run_id = run.id;
  if found then
    if (receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.job_id, receipt.attempt_count,
        receipt.binding_id, receipt.binding_version, receipt.material_revision, receipt.service_principal_id, receipt.agent_provider)
      is distinct from
        (owner.workspace_id, owner.factory_id, owner.id, job.id, p_attempt_count, binding.id, binding.version,
          source.material_revision, binding.service_principal_id, binding.agent_provider) then
      raise exception 'The resolved credential changed within this attempt. Start a new attempt.' using errcode = 'PT409';
    end if;
  else
    insert into public.factory_run_credential_receipts(
      run_id, workspace_id, factory_id, session_id, job_id, attempt_count,
      binding_id, binding_version, material_revision, service_principal_id, agent_provider
    ) values (
      run.id, owner.workspace_id, owner.factory_id, owner.id, job.id, p_attempt_count,
      binding.id, binding.version, source.material_revision, binding.service_principal_id, binding.agent_provider
    );
  end if;
  return query select source.encrypted_value, binding.id, binding.version, source.material_revision,
    binding.service_principal_id, binding.agent_provider;
end;
$$;
revoke all on function public.resolve_factory_run_credential(uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_factory_run_credential(uuid, uuid, uuid, integer) to service_role;

-- Service attribution lives in the resolution receipt. Leave the personal
-- credential selector empty when a service principal owns this attempt.
create or replace function public.pin_session_attempt_manifest(
  p_job_id uuid, p_run_id uuid, p_attempt_count integer,
  p_prompt_sha256 text, p_prompt_utf8_bytes integer, p_renderer_version integer,
  p_checkout_sha text, p_predecessors jsonb, p_worker_runtime text,
  p_max_turns integer default null, p_agent_effort text default null,
  p_credential_owner_member_id uuid default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  workspace uuid;
  owner public.sessions;
  expected_credential_owner_member_id uuid;
  job public.agent_jobs;
  execution public.agent_runs;
  pinned public.session_job_git_inputs;
  revision public.factory_definition_revisions;
  definition jsonb;
  prior public.session_attempt_manifests;
  retry_source uuid;
  reference jsonb;
  predecessor_stage uuid;
  predecessor_slug text;
  predecessor_receipt public.session_stage_approval_receipts;
  seen_stages uuid[] := '{}';
  seen_legacy_slugs text[] := '{}';
begin
  perform internal.assert_checkpoint_publication_service();
  select j.workspace_id into workspace from public.agent_jobs j where j.id = p_job_id;
  if not found or p_attempt_count is null or p_attempt_count <= 0 then return false; end if;
  perform 1 from public.workspaces w where w.id = workspace and w.deletion_requested_at is null for share;
  if not found then return false; end if;
  select s.* into owner from public.sessions s join public.agent_jobs j
    on (j.session_id, j.workspace_id) = (s.id, s.workspace_id)
    where j.id = p_job_id and s.workspace_id = workspace for no key update of s;
  if not found or owner.archived_at is not null or owner.phase_status is distinct from 'in_progress' then return false; end if;
  if not owner.execute_pinned_definition or not exists (
    select 1 from public.session_factory_admission_inputs admission
      where (admission.workspace_id, admission.factory_id, admission.session_id, admission.definition_revision_id) =
        (owner.workspace_id, owner.factory_id, owner.id, owner.factory_definition_revision_id)
        and admission.credential_owner_service_principal_id is not null
  ) then
    expected_credential_owner_member_id := owner.creator_member_id;
  end if;
  if expected_credential_owner_member_id is distinct from p_credential_owner_member_id then return false; end if;
  select * into job from public.agent_jobs j where j.id = p_job_id for update;
  if not found or job.workspace_id is distinct from owner.workspace_id or job.session_id is distinct from owner.id
    or job.status not in ('started', 'running') or job.attempt_count is distinct from p_attempt_count
    or job.stage_id is null or job.stage_id is distinct from owner.current_stage_id then return false; end if;
  select * into execution from public.agent_runs r where r.id = p_run_id for update;
  if not found or execution.status is distinct from 'running' or execution.agent_job_id is distinct from job.id
    or execution.workspace_id is distinct from owner.workspace_id or execution.session_id is distinct from owner.id
    or execution.stage_id is distinct from job.stage_id or execution.attempt_count is distinct from p_attempt_count then return false; end if;
  select * into prior from public.session_attempt_manifests m where m.run_id = p_run_id;
  if found then
    if prior.job_id = job.id and prior.attempt_count = p_attempt_count
      and prior.prompt_sha256 = p_prompt_sha256 and prior.prompt_utf8_bytes = p_prompt_utf8_bytes
      and prior.renderer_version = p_renderer_version and prior.checkout_sha = p_checkout_sha
      and prior.predecessors = p_predecessors and prior.worker_runtime = p_worker_runtime
      and prior.max_turns is not distinct from p_max_turns and prior.agent_effort is not distinct from p_agent_effort
      and prior.credential_owner_member_id is not distinct from p_credential_owner_member_id then return true; end if;
    raise exception 'Attempt inputs have already been pinned.' using errcode = 'PT409';
  end if;
  if p_prompt_sha256 is null or p_prompt_sha256 !~ '^[a-f0-9]{64}$'
    or p_checkout_sha is null or p_checkout_sha !~ '^[a-f0-9]{40}$'
    or p_prompt_utf8_bytes is null or p_prompt_utf8_bytes <= 0
    or p_renderer_version is null or p_renderer_version <= 0
    or p_worker_runtime is null or p_worker_runtime not in ('node', 'workerd')
    or p_max_turns <= 0 or p_agent_effort not in ('low', 'medium', 'high', 'xhigh', 'max')
    or jsonb_typeof(p_predecessors) is distinct from 'array' then
    raise exception 'Invalid attempt input manifest.' using errcode = '23514';
  end if;

  select * into pinned from public.session_job_git_inputs p where p.job_id = job.id
    and (p.session_id, p.workspace_id) = (owner.id, owner.workspace_id);
  if not found or pinned.pinned_run_id is null then
    raise exception 'The attempt has no bound Git input.' using errcode = '23514';
  end if;
  if p_checkout_sha <> pinned.input_sha then
    select checkpoint.source_run_id into retry_source
    from public.session_retry_checkpoint_jobs binding
    join public.session_retry_checkpoints checkpoint
      on (checkpoint.source_run_id, checkpoint.workspace_id) = (binding.source_run_id, binding.workspace_id)
    join public.agent_runs source_run on source_run.id = checkpoint.source_run_id
    where (binding.job_id, binding.workspace_id) = (job.id, owner.workspace_id)
      and (source_run.workspace_id, source_run.session_id, source_run.stage_id) = (owner.workspace_id, owner.id, job.stage_id)
      and source_run.attempt_count = checkpoint.source_attempt_count
      and job.trigger_type = 'manual_retry' and checkpoint.input_sha = pinned.input_sha
      and checkpoint.head_sha = p_checkout_sha;
    if not found then
      raise exception 'The checkout does not match the attempt source input.' using errcode = '23514';
    end if;
  end if;

  -- Only exact approvals still linked to an effective stage completion can
  -- authorize an artifact identity. The captured slug is the renderer's key
  -- and can differ from the live label after a concurrent rename.
  for reference in select value from jsonb_array_elements(p_predecessors) loop
    if jsonb_typeof(reference) is distinct from 'object'
      or not reference ?& array['stageId', 'stageSlug', 'status']
      or jsonb_typeof(reference->'stageSlug') is distinct from 'string'
      or btrim(reference->>'stageSlug') = ''
      or jsonb_typeof(reference->'status') is distinct from 'string'
      or jsonb_typeof(reference->'stageId') not in ('string', 'null')
      or (reference->>'stageId' is not null and reference->>'stageId' !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') then
      raise exception 'Invalid predecessor input identity.' using errcode = '23514';
    end if;
    predecessor_stage := (reference->>'stageId')::uuid;
    predecessor_slug := reference->>'stageSlug';
    if predecessor_stage = any(seen_stages) or predecessor_stage = job.stage_id
      or (predecessor_stage is null and predecessor_slug = any(seen_legacy_slugs)) then
      raise exception 'Invalid predecessor input identity.' using errcode = '23514';
    end if;
    if predecessor_stage is null then
      seen_legacy_slugs := array_append(seen_legacy_slugs, predecessor_slug);
    else
      seen_stages := array_append(seen_stages, predecessor_stage);
    end if;

    select receipt.* into predecessor_receipt from public.session_stage_approval_receipts receipt
    join public.session_phase_completions completion on completion.id = receipt.completion_id
      and (completion.session_id, completion.workspace_id, completion.stage_id) = (receipt.session_id, receipt.workspace_id, receipt.stage_id)
    where (receipt.session_id, receipt.workspace_id, receipt.stage_id) = (owner.id, owner.workspace_id, predecessor_stage)
    order by receipt.approval_number desc limit 1;
    case reference->>'status'
      when 'approved' then
        if not found or predecessor_stage is null
          or not reference ?& array['approvalReceiptId', 'artifactId', 'artifactVersion', 'artifactDigest']
          or (select count(*) from jsonb_object_keys(reference)) <> 7
          or jsonb_typeof(reference->'artifactVersion') is distinct from 'number'
          or reference->>'approvalReceiptId' is distinct from predecessor_receipt.id::text
          or reference->>'artifactId' is distinct from predecessor_receipt.artifact_id::text
          or reference->>'artifactVersion' is distinct from predecessor_receipt.artifact_version::text
          or reference->>'artifactDigest' is distinct from predecessor_receipt.artifact_digest then
          raise exception 'The predecessor is not the exact approved artifact.' using errcode = '23514';
        end if;
      when 'legacy_unverified' then
        if found or (select count(*) from jsonb_object_keys(reference)) <> 3 or not exists (
          select 1 from public.session_phase_completions completion
          where (completion.session_id, completion.workspace_id) = (owner.id, owner.workspace_id)
            and completion.stage_id is not distinct from predecessor_stage
            and (predecessor_stage is not null or completion.stage_slug = predecessor_slug)
        ) then raise exception 'The predecessor has no matching unverified legacy completion.' using errcode = '23514'; end if;
      else raise exception 'Invalid predecessor input identity.' using errcode = '23514';
    end case;
  end loop;

  if owner.factory_definition_provenance = 'pinned' then
    select * into revision from public.factory_definition_revisions d
      where (d.id, d.workspace_id) = (owner.factory_definition_revision_id, owner.workspace_id);
    if not found then raise exception 'The pinned factory definition is unavailable.' using errcode = '23514'; end if;
    definition := revision.definition_json::jsonb;
  end if;
  insert into public.session_attempt_manifests(
    run_id, workspace_id, session_id, job_id, attempt_count, stage_id,
    definition_provenance, definition_revision_id, definition_digest, definition_skill_ids, definition_tool_ids,
    definition_execution_policy_revision_id, definition_delivery_policy_revision_id, execution_policy_revision_id,
    repository_id, repository_full_name, base_branch, initial_base_sha, input_sha, input_ref, source_checkpoint_run_id,
    checkout_sha, retry_source_run_id, prompt_sha256, prompt_utf8_bytes, renderer_version, predecessors,
    worker_runtime, run_type, model_provider, model_name, sandbox_provider, sandbox_connection_revision,
    agent_effort, max_turns, credential_owner_member_id
  ) values (
    execution.id, owner.workspace_id, owner.id, job.id, p_attempt_count, job.stage_id,
    owner.factory_definition_provenance, revision.id, revision.canonical_digest,
    array(select jsonb_array_elements_text(definition->'skillIds')), array(select jsonb_array_elements_text(definition->'toolIds')),
    (definition->>'executionPolicyRevisionId')::uuid, (definition->>'deliveryPolicyRevisionId')::uuid, execution.execution_policy_revision_id,
    pinned.repository_id, pinned.repository_full_name, pinned.base_branch, pinned.initial_base_sha, pinned.input_sha,
    pinned.input_ref, pinned.source_checkpoint_run_id, p_checkout_sha, retry_source,
    p_prompt_sha256, p_prompt_utf8_bytes, p_renderer_version, p_predecessors, p_worker_runtime,
    execution.run_type::text, execution.model_provider, execution.model_name, execution.sandbox_provider,
    execution.sandbox_connection_revision, p_agent_effort, p_max_turns, p_credential_owner_member_id
  );
  return true;
end;
$$;
