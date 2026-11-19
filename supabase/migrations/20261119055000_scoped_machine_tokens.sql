-- Machine command permission is distinct from execution resource permission.
-- Existing grants do not gain machine authority when this migration is applied.
create type public.factory_command_scope as enum (
  'sessions:read', 'sessions:create', 'sessions:follow-up', 'sessions:clarify', 'sessions:cancel'
);

alter table public.factory_execution_grants
  add column command_scopes public.factory_command_scope[] not null default '{}',
  add constraint factory_execution_grants_principal_identity_key
    unique (workspace_id, factory_id, service_principal_id, id);

drop function public.approve_factory_execution_grant(
  uuid, uuid, uuid, uuid, uuid, uuid[], text[], uuid, uuid, timestamptz, bigint, uuid
);

create function public.approve_factory_execution_grant(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_service_principal_id uuid,
  p_github_repository_id uuid, p_read_context_repository_ids uuid[], p_tool_ids text[],
  p_execution_policy_revision_id uuid, p_budget_payer_member_id uuid, p_expires_at timestamptz,
  p_expected_version bigint, p_grant_id uuid default null,
  p_command_scopes public.factory_command_scope[] default '{}'
) returns public.factory_execution_grants
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  execution_grant public.factory_execution_grants;
  decision_time timestamptz;
begin
  actor_member_id := internal.assert_factory_manager(
    p_workspace_id, p_factory_id, p_actor_user_id, p_budget_payer_member_id
  );
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_grant_id is not null then
    select * into execution_grant from public.factory_execution_grants target
    where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_grant_id)
    for update;
    if not found then raise exception 'Execution grant not found.' using errcode = 'P0002'; end if;
    if execution_grant.revoked_at is not null then
      raise exception 'A revoked execution grant cannot be changed.' using errcode = 'PT409';
    end if;
    if execution_grant.service_principal_id is distinct from p_service_principal_id then
      raise exception 'The service principal on an execution grant is fixed.' using errcode = '22023';
    end if;
  end if;
  if p_expected_version is distinct from coalesce(execution_grant.version, 0) then
    raise exception 'Execution grant changed. Reload before saving.' using errcode = 'PT409';
  end if;

  if not exists (
    select 1 from public.service_principals principal
    where (principal.workspace_id, principal.factory_id, principal.id) =
      (p_workspace_id, p_factory_id, p_service_principal_id)
  ) then
    raise exception 'Service principal not found.' using errcode = 'P0002';
  end if;
  if p_command_scopes is null or coalesce(array_ndims(p_command_scopes), 1) <> 1
    or cardinality(p_command_scopes) > cardinality(enum_range(null::public.factory_command_scope))
    or cardinality(p_command_scopes) <> (select count(distinct scope) from unnest(p_command_scopes) scope) then
    raise exception 'Execution grant command scopes must be distinct supported commands.' using errcode = '22023';
  end if;
  if p_github_repository_id is null
    or p_read_context_repository_ids is null
    or cardinality(p_read_context_repository_ids) > 50
    or array_position(p_read_context_repository_ids, null) is not null
    or p_github_repository_id = any(p_read_context_repository_ids)
    or cardinality(p_read_context_repository_ids) <> (select count(distinct id) from unnest(p_read_context_repository_ids) id)
    or p_tool_ids is null or cardinality(p_tool_ids) > 32
    or array_position(p_tool_ids, null) is not null
    or cardinality(p_tool_ids) <> (select count(distinct id) from unnest(p_tool_ids) id)
    or exists (select 1 from unnest(p_tool_ids) id where id !~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$')
    or internal.factory_execution_scope_is_current(p_workspace_id, p_factory_id, p_github_repository_id,
          p_read_context_repository_ids, p_execution_policy_revision_id, p_budget_payer_member_id) is not true then
    raise exception 'Execution grant scope must name live repositories, explicit tools, a workspace budget and an active payer.'
      using errcode = '22023';
  end if;

  decision_time := clock_timestamp();
  if p_expires_at is null or not isfinite(p_expires_at) or p_expires_at <= decision_time then
    raise exception 'Execution grant expiry must be a finite future time.' using errcode = '22023';
  end if;
  if p_grant_id is null then
    insert into public.factory_execution_grants(
      workspace_id, factory_id, service_principal_id, github_repository_id, read_context_repository_ids,
      tool_ids, execution_policy_revision_id, budget_payer_member_id, version, approved_by_member_id, approved_at, expires_at, command_scopes
    ) values (p_workspace_id, p_factory_id, p_service_principal_id, p_github_repository_id, p_read_context_repository_ids,
      p_tool_ids, p_execution_policy_revision_id, p_budget_payer_member_id, 1, actor_member_id, decision_time, p_expires_at, p_command_scopes)
    returning * into execution_grant;
  else
    update public.factory_execution_grants target set
      github_repository_id = p_github_repository_id,
      read_context_repository_ids = p_read_context_repository_ids,
      tool_ids = p_tool_ids,
      execution_policy_revision_id = p_execution_policy_revision_id,
      budget_payer_member_id = p_budget_payer_member_id,
      version = target.version + 1,
      approved_by_member_id = actor_member_id,
      approved_at = decision_time,
      expires_at = p_expires_at,
      command_scopes = p_command_scopes
    where target.id = p_grant_id returning * into execution_grant;
  end if;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id,
      case when p_grant_id is null then 'execution_grant.approved' else 'execution_grant.updated' end,
      actor_member_id, to_jsonb(execution_grant));
  return execution_grant;
end;
$$;
revoke all on function public.approve_factory_execution_grant(uuid, uuid, uuid, uuid, uuid, uuid[], text[], uuid, uuid, timestamptz, bigint, uuid, public.factory_command_scope[])
  from public, anon, authenticated, service_role;
grant execute on function public.approve_factory_execution_grant(uuid, uuid, uuid, uuid, uuid, uuid[], text[], uuid, uuid, timestamptz, bigint, uuid, public.factory_command_scope[])
  to service_role;

-- Browser queries and management responses can only select metadata. Reusable
-- plaintext is generated outside the database and never sent to Postgres.
create table public.factory_machine_tokens (
  id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null check (execution_grant_version between 1 and 9007199254740991),
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  scopes public.factory_command_scope[] not null check (cardinality(scopes) > 0),
  created_by_member_id uuid not null,
  created_at timestamptz not null,
  expires_at timestamptz check (isfinite(expires_at) and expires_at > created_at),
  revoked_by_member_id uuid,
  revoked_at timestamptz check (revoked_at >= created_at),
  last_used_at timestamptz check (last_used_at >= created_at),
  last_used_scope public.factory_command_scope,
  foreign key (workspace_id, factory_id, service_principal_id, execution_grant_id)
    references public.factory_execution_grants(workspace_id, factory_id, service_principal_id, id) on delete cascade,
  check ((revoked_at is null) = (revoked_by_member_id is null)),
  check ((last_used_at is null) = (last_used_scope is null)),
  check (last_used_scope is null or last_used_scope = any(scopes))
);
create index factory_machine_tokens_grant_idx
  on public.factory_machine_tokens(workspace_id, factory_id, execution_grant_id, id);

create table internal.factory_machine_token_digests (
  token_id uuid primary key references public.factory_machine_tokens(id) on delete cascade,
  digest text not null check (digest ~ '^[a-f0-9]{64}$')
);

alter table internal.factory_machine_token_digests enable row level security;
revoke all on internal.factory_machine_token_digests from public, anon, authenticated, service_role;
alter table public.factory_machine_tokens enable row level security;
revoke all on public.factory_machine_tokens from public, anon, authenticated, service_role;
grant select on public.factory_machine_tokens to authenticated;
create policy factory_machine_tokens_manager_read on public.factory_machine_tokens
  for select to authenticated using (internal.can_manage_factory(workspace_id, factory_id));

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
  'machine_token.issued', 'machine_token.revoked'
));

create function internal.require_factory_machine_grant(
  p_workspace_id uuid, p_factory_id uuid, p_grant_id uuid, p_grant_version bigint
) returns public.factory_execution_grants language plpgsql set search_path = '' as $$
declare approved public.factory_execution_grants;
begin
  select * into approved from public.factory_execution_grants
  where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_grant_id);
  if not found then
    raise exception 'Execution grant is unavailable.' using errcode = '42501';
  end if;
  return internal.require_current_factory_execution_grant(
    p_workspace_id, p_factory_id, p_grant_id, p_grant_version, approved.github_repository_id,
    approved.read_context_repository_ids, approved.tool_ids, approved.execution_policy_revision_id
  );
end;
$$;
revoke all on function internal.require_factory_machine_grant(uuid, uuid, uuid, bigint)
  from public, anon, authenticated, service_role;

create function internal.issue_factory_machine_token(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_grant_id uuid, p_grant_version bigint,
  p_token_id uuid, p_digest text, p_name text, p_scopes public.factory_command_scope[], p_expires_at timestamptz
) returns public.factory_machine_tokens language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  approved public.factory_execution_grants;
  token public.factory_machine_tokens;
  issued_at timestamptz;
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  approved := internal.require_factory_machine_grant(p_workspace_id, p_factory_id, p_grant_id, p_grant_version);
  issued_at := clock_timestamp();
  if p_token_id is null or p_digest is null or p_digest !~ '^[a-f0-9]{64}$'
    or p_name is null or char_length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]'
    or p_scopes is null or array_ndims(p_scopes) is distinct from 1
    or cardinality(p_scopes) not between 1 and cardinality(enum_range(null::public.factory_command_scope))
    or cardinality(p_scopes) <> (select count(distinct scope) from unnest(p_scopes) scope)
    or (p_expires_at is not null and (not isfinite(p_expires_at)
      or p_expires_at <= issued_at or p_expires_at > approved.expires_at)) then
    raise exception 'Provide a valid name, command scopes and optional expiry within the grant.' using errcode = '22023';
  end if;
  if (p_scopes <@ approved.command_scopes) is not true or approved.expires_at <= issued_at then
    raise exception 'Execution grant does not authorize these command scopes.' using errcode = '42501';
  end if;

  insert into public.factory_machine_tokens(
    id, workspace_id, factory_id, service_principal_id, execution_grant_id, execution_grant_version,
    name, scopes, created_by_member_id, created_at, expires_at
  ) values (
    p_token_id, p_workspace_id, p_factory_id, approved.service_principal_id, approved.id, approved.version,
    btrim(p_name), p_scopes, actor_member_id, issued_at, p_expires_at
  ) returning * into token;
  insert into internal.factory_machine_token_digests(token_id, digest) values (token.id, p_digest);
  insert into public.factory_audit_events(workspace_id, factory_id, actor_member_id, action, detail)
    values (p_workspace_id, p_factory_id, actor_member_id, 'machine_token.issued',
      jsonb_build_object('id', token.id, 'grantId', approved.id, 'servicePrincipalId', approved.service_principal_id,
        'version', approved.version, 'scopes', token.scopes, 'expiresAt', token.expires_at));
  return token;
end;
$$;

create function public.issue_factory_machine_token(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_grant_id uuid, p_grant_version bigint,
  p_token_id uuid, p_digest text, p_name text, p_scopes public.factory_command_scope[], p_expires_at timestamptz default null
) returns public.factory_machine_tokens language sql security invoker set search_path = '' as $$
  select internal.issue_factory_machine_token(p_workspace_id, p_factory_id, p_actor_user_id, p_grant_id,
    p_grant_version, p_token_id, p_digest, p_name, p_scopes, p_expires_at);
$$;

create function internal.revoke_factory_machine_token(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_grant_id uuid, p_token_id uuid
) returns public.factory_machine_tokens language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  token public.factory_machine_tokens;
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into token from public.factory_machine_tokens
  where (workspace_id, factory_id, execution_grant_id, id) = (p_workspace_id, p_factory_id, p_grant_id, p_token_id)
  for update;
  if not found then raise exception 'Machine token not found.' using errcode = 'P0002'; end if;
  if token.revoked_at is not null then return token; end if;

  update public.factory_machine_tokens
  set revoked_by_member_id = actor_member_id, revoked_at = clock_timestamp()
  where id = token.id returning * into token;
  delete from internal.factory_machine_token_digests where token_id = token.id;
  insert into public.factory_audit_events(workspace_id, factory_id, actor_member_id, action, detail)
    values (p_workspace_id, p_factory_id, actor_member_id, 'machine_token.revoked',
      jsonb_build_object('id', token.id, 'grantId', token.execution_grant_id,
        'servicePrincipalId', token.service_principal_id, 'version', token.execution_grant_version));
  return token;
end;
$$;

create function public.revoke_factory_machine_token(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_grant_id uuid, p_token_id uuid
) returns public.factory_machine_tokens language sql security invoker set search_path = '' as $$
  select internal.revoke_factory_machine_token(p_workspace_id, p_factory_id, p_actor_user_id, p_grant_id, p_token_id);
$$;

revoke all on function
  internal.issue_factory_machine_token(uuid, uuid, uuid, uuid, bigint, uuid, text, text, public.factory_command_scope[], timestamptz),
  public.issue_factory_machine_token(uuid, uuid, uuid, uuid, bigint, uuid, text, text, public.factory_command_scope[], timestamptz),
  internal.revoke_factory_machine_token(uuid, uuid, uuid, uuid, uuid),
  public.revoke_factory_machine_token(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  internal.issue_factory_machine_token(uuid, uuid, uuid, uuid, bigint, uuid, text, text, public.factory_command_scope[], timestamptz),
  public.issue_factory_machine_token(uuid, uuid, uuid, uuid, bigint, uuid, text, text, public.factory_command_scope[], timestamptz),
  internal.revoke_factory_machine_token(uuid, uuid, uuid, uuid, uuid),
  public.revoke_factory_machine_token(uuid, uuid, uuid, uuid, uuid)
  to service_role;

-- Call inside the protected command's transaction. The workspace, factory,
-- token and grant locks serialize access against deletion, archive, and revoke.
-- Never treat an earlier lookup as authorization to perform a later command.
create function internal.require_factory_machine_token(
  p_workspace_id uuid, p_factory_id uuid, p_token_id uuid, p_digest text, p_scope public.factory_command_scope
) returns public.factory_machine_tokens language plpgsql set search_path = '' as $$
declare
  token public.factory_machine_tokens;
  approved public.factory_execution_grants;
  used_at timestamptz;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select target.* into token from public.factory_machine_tokens target
  join internal.factory_machine_token_digests secret on secret.token_id = target.id
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_token_id)
    and secret.digest = p_digest
  for update of target;
  if not found or p_scope is null or not (p_scope = any(token.scopes))
    or token.revoked_at is not null or token.expires_at <= clock_timestamp() then
    raise exception 'Machine token is unavailable or does not authorize this command.' using errcode = '42501';
  end if;
  approved := internal.require_factory_machine_grant(p_workspace_id, p_factory_id,
    token.execution_grant_id, token.execution_grant_version);
  used_at := clock_timestamp();
  if (token.scopes <@ approved.command_scopes) is not true
    or approved.expires_at <= used_at or token.expires_at <= used_at then
    raise exception 'Machine token is unavailable or does not authorize this command.' using errcode = '42501';
  end if;

  update public.factory_machine_tokens target
    set last_used_at = used_at, last_used_scope = p_scope
  where target.id = token.id returning * into token;
  return token;
end;
$$;
revoke all on function internal.require_factory_machine_token(uuid, uuid, uuid, text, public.factory_command_scope)
  from public, anon, authenticated, service_role;

comment on function internal.require_factory_machine_token(uuid, uuid, uuid, text, public.factory_command_scope) is
  'Authorize and record successful machine commands in their authoritative database transaction.';
