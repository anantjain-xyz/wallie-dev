-- Endpoint and operation approval is versioned separately from the authorizing grant.
create table public.factory_mcp_servers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null check (char_length(slug) between 1 and 60 and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, slug),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table public.factory_mcp_server_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  server_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  endpoint text not null,
  operation_names text[] not null check (cardinality(operation_names) between 1 and 32),
  auth_kind text not null check (auth_kind in ('none', 'bearer')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_by uuid,
  revoked_at timestamptz,
  unique (workspace_id, factory_id, id),
  unique (server_id, revision_number),
  foreign key (workspace_id, factory_id, server_id)
    references public.factory_mcp_servers(workspace_id, factory_id, id) on delete cascade,
  check ((revoked_at is null) = (revoked_by is null))
);

create table public.factory_mcp_secret_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  execution_grant_id uuid not null references public.factory_execution_grants(id) on delete cascade,
  service_principal_id uuid not null,
  factory_agent_id uuid not null,
  tool_revision_id uuid not null,
  workspace_secret_id uuid not null unique,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_by uuid,
  revoked_at timestamptz,
  foreign key (workspace_id, factory_id, service_principal_id)
    references public.service_principals(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, factory_agent_id)
    references public.factory_agents(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, tool_revision_id)
    references public.factory_mcp_server_revisions(workspace_id, factory_id, id) on delete cascade,
  check ((revoked_at is null) = (revoked_by is null))
);
create index factory_mcp_secret_bindings_factory_idx on public.factory_mcp_secret_bindings(workspace_id, factory_id);
create unique index factory_mcp_secret_bindings_active_scope_idx
  on public.factory_mcp_secret_bindings(execution_grant_id, factory_agent_id, tool_revision_id)
  where revoked_at is null;

alter table public.factory_mcp_servers enable row level security;
alter table public.factory_mcp_server_revisions enable row level security;
alter table public.factory_mcp_secret_bindings enable row level security;
revoke all on public.factory_mcp_servers, public.factory_mcp_server_revisions, public.factory_mcp_secret_bindings
  from public, anon, authenticated, service_role;
grant select on public.factory_mcp_servers, public.factory_mcp_server_revisions to authenticated, service_role;
grant select on public.factory_mcp_secret_bindings to service_role;
grant select (id, workspace_id, factory_id, execution_grant_id, service_principal_id, factory_agent_id,
  tool_revision_id, created_at, revoked_at) on public.factory_mcp_secret_bindings to authenticated;
create policy factory_mcp_servers_manage_read on public.factory_mcp_servers for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));
create policy factory_mcp_server_revisions_manage_read on public.factory_mcp_server_revisions for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));
create policy factory_mcp_secret_bindings_manage_read on public.factory_mcp_secret_bindings for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));

create function internal.preserve_factory_mcp_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factories factory where (factory.workspace_id, factory.id) = (old.workspace_id, old.factory_id)
  ) then
    return old;
  end if;
  if tg_op = 'UPDATE' and tg_table_name <> 'factory_mcp_servers' then
    if old.revoked_at is null and new.revoked_at is not null
      and (to_jsonb(old) - array['revoked_at', 'revoked_by']) = (to_jsonb(new) - array['revoked_at', 'revoked_by']) then
      return new;
    end if;
  end if;
  raise exception 'MCP server identities, revisions, and bindings are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_mcp_history() from public, anon, authenticated, service_role;
create trigger preserve_factory_mcp_servers before update or delete on public.factory_mcp_servers
  for each row execute function internal.preserve_factory_mcp_history();
create trigger preserve_factory_mcp_server_revisions before update or delete on public.factory_mcp_server_revisions
  for each row execute function internal.preserve_factory_mcp_history();
create trigger preserve_factory_mcp_secret_bindings before update or delete on public.factory_mcp_secret_bindings
  for each row execute function internal.preserve_factory_mcp_history();

alter table public.factory_audit_events drop constraint factory_audit_events_action_check;
alter table public.factory_audit_events add constraint factory_audit_events_action_check check (action in (
  'factory.created', 'factory.archived', 'factory.restored',
  'membership.granted', 'membership.revoked', 'membership.suspended', 'membership.reinstated',
  'agent.created', 'agent.prompt_revision_created',
  'skill.created', 'skill.revision_created', 'skill.revision_revoked',
  'service_principal.created', 'execution_grant.approved', 'execution_grant.updated', 'execution_grant.revoked',
  'credential_binding.created', 'credential_binding.revoked',
  'mcp_server.created', 'mcp_server.revision_created', 'mcp_server.revision_revoked',
  'mcp_secret_binding.created', 'mcp_secret_binding.revoked'
));

create function internal.assert_factory_mcp_operations(p_operation_names text[])
returns void language plpgsql immutable set search_path = '' as $$
begin
  if cardinality(p_operation_names) is null or cardinality(p_operation_names) not between 1 and 32
    or array_ndims(p_operation_names) <> 1 or array_position(p_operation_names, null) is not null
    or cardinality(p_operation_names) <> (select count(distinct name collate "C") from unnest(p_operation_names) name)
    or exists (select 1 from unnest(p_operation_names) name where name !~ '^[A-Za-z0-9_.-]{1,80}$') then
    raise exception 'Provide 1 to 32 distinct MCP operation names.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_mcp_operations(text[]) from public, anon, authenticated, service_role;

create function internal.add_factory_mcp_server_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_actor_member_id uuid,
  p_server_id uuid, p_revision_number integer, p_endpoint text, p_operation_names text[], p_auth_kind text
) returns public.factory_mcp_server_revisions language plpgsql set search_path = '' as $$
declare result public.factory_mcp_server_revisions; port text;
begin
  -- Credentials, queries, and fragments have their own scope and never belong in the endpoint.
  if p_endpoint is null or char_length(p_endpoint) > 2048 or strpos(p_endpoint, chr(92)) > 0
    or p_endpoint !~ '^https://([A-Za-z0-9.-]+|\[[A-Fa-f0-9:.]+\])(:[0-9]{1,5})?(/[^[:space:][:cntrl:]?#]*)?$' then
    raise exception 'Provide an HTTPS endpoint without credentials, a query, or a fragment.' using errcode = 'PT422';
  end if;
  port := substring(p_endpoint from '^https://(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:.]+\]):([0-9]{1,5})(?:/|$)');
  if port is not null and port::integer not between 1 and 65535 then
    raise exception 'Provide a valid HTTPS port.' using errcode = 'PT422';
  end if;
  if p_auth_kind is null or p_auth_kind not in ('none', 'bearer') then
    raise exception 'Select an approved MCP authentication kind.' using errcode = 'PT422';
  end if;
  perform internal.assert_factory_mcp_operations(p_operation_names);
  insert into public.factory_mcp_server_revisions(
    workspace_id, factory_id, server_id, revision_number, endpoint, operation_names, auth_kind, created_by
  ) values (
    p_workspace_id, p_factory_id, p_server_id, p_revision_number, p_endpoint,
    array(select name from unnest(p_operation_names) name order by name collate "C"), p_auth_kind, p_actor_user_id
  ) returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (p_workspace_id, p_factory_id,
    case when p_revision_number = 1 then 'mcp_server.created' else 'mcp_server.revision_created' end,
    p_actor_member_id, jsonb_build_object('serverId', p_server_id, 'revisionId', result.id, 'revisionNumber', p_revision_number));
  return result;
end;
$$;
revoke all on function internal.add_factory_mcp_server_revision(uuid, uuid, uuid, uuid, uuid, integer, text, text[], text)
  from public, anon, authenticated, service_role;

create function public.create_factory_mcp_server(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_name text, p_slug text,
  p_endpoint text, p_operation_names text[], p_auth_kind text
) returns public.factory_mcp_server_revisions language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; created_server_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  insert into public.factory_mcp_servers(workspace_id, factory_id, name, slug, created_by)
  values (p_workspace_id, p_factory_id, btrim(p_name), p_slug, p_actor_user_id) returning id into created_server_id;
  return internal.add_factory_mcp_server_revision(p_workspace_id, p_factory_id, p_actor_user_id, actor_member_id,
    created_server_id, 1, p_endpoint, p_operation_names, p_auth_kind);
end;
$$;
revoke all on function public.create_factory_mcp_server(uuid, uuid, uuid, text, text, text, text[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_factory_mcp_server(uuid, uuid, uuid, text, text, text, text[], text) to service_role;

create function public.save_factory_mcp_server_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_server_id uuid,
  p_expected_revision_number integer, p_endpoint text, p_operation_names text[], p_auth_kind text
) returns public.factory_mcp_server_revisions language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; current_revision integer;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select max(revision_number) into current_revision from public.factory_mcp_server_revisions
    where (workspace_id, factory_id, server_id) = (p_workspace_id, p_factory_id, p_server_id);
  if current_revision is null then
    raise exception 'MCP server is unavailable in this factory.' using errcode = 'P0002';
  end if;
  if p_expected_revision_number is distinct from current_revision then
    raise exception 'The MCP server changed. Reload its revision before saving.' using errcode = 'PT409';
  end if;
  return internal.add_factory_mcp_server_revision(p_workspace_id, p_factory_id, p_actor_user_id, actor_member_id,
    p_server_id, current_revision + 1, p_endpoint, p_operation_names, p_auth_kind);
end;
$$;
revoke all on function public.save_factory_mcp_server_revision(uuid, uuid, uuid, uuid, integer, text, text[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_factory_mcp_server_revision(uuid, uuid, uuid, uuid, integer, text, text[], text) to service_role;

create function public.revoke_factory_mcp_server_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_server_id uuid, p_revision_id uuid
) returns public.factory_mcp_server_revisions language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; result public.factory_mcp_server_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into result from public.factory_mcp_server_revisions
    where (workspace_id, factory_id, server_id, id) = (p_workspace_id, p_factory_id, p_server_id, p_revision_id);
  if not found then
    raise exception 'MCP server revision is unavailable in this factory.' using errcode = 'P0002';
  end if;
  if result.revoked_at is not null then return result; end if;
  update public.factory_mcp_server_revisions set revoked_by = p_actor_user_id, revoked_at = clock_timestamp()
    where id = result.id returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id, 'mcp_server.revision_revoked', actor_member_id,
      jsonb_build_object('serverId', p_server_id, 'revisionId', result.id, 'revisionNumber', result.revision_number));
  return result;
end;
$$;
revoke all on function public.revoke_factory_mcp_server_revision(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_factory_mcp_server_revision(uuid, uuid, uuid, uuid, uuid) to service_role;

-- Share the original encrypted source row fence across both credential purposes.
create function internal.assert_exclusive_workspace_secret_claim()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Advance the source row version even when its preview is already null.
  -- This makes concurrent claims conflict under repeatable read as well.
  update public.workspace_secrets source set value_preview = null
    where (source.workspace_id, source.id) = (new.workspace_id, new.workspace_secret_id)
      and source.key <> 'LINEAR_API_KEY';
  if not found then
    raise exception 'The workspace secret is unavailable for delegation.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.factory_secret_bindings where workspace_secret_id = new.workspace_secret_id)
    or exists (select 1 from public.factory_mcp_secret_bindings where workspace_secret_id = new.workspace_secret_id) then
    raise exception 'The workspace secret has already been delegated.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
revoke all on function internal.assert_exclusive_workspace_secret_claim() from public, anon, authenticated, service_role;
create trigger factory_secret_bindings_exclusive_claim before insert on public.factory_secret_bindings
  for each row execute function internal.assert_exclusive_workspace_secret_claim();
create trigger factory_mcp_secret_bindings_exclusive_claim before insert on public.factory_mcp_secret_bindings
  for each row execute function internal.assert_exclusive_workspace_secret_claim();

create or replace function internal.revise_workspace_secret_material()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.material_revision := old.material_revision;
  new.material_rotated_at := coalesce(old.material_rotated_at, old.updated_at);
  if new.encrypted_value is distinct from old.encrypted_value then
    new.material_revision := old.material_revision + 1;
    new.material_rotated_at := clock_timestamp();
  end if;
  if exists (select 1 from public.factory_secret_bindings binding where binding.workspace_secret_id = old.id)
    or exists (select 1 from public.factory_mcp_secret_bindings binding where binding.workspace_secret_id = old.id) then
    if (new.id, new.workspace_id, new.key) is distinct from (old.id, old.workspace_id, old.key) then
      raise exception 'A claimed secret cannot change its identity.' using errcode = '23514';
    end if;
    new.value_preview := null;
  end if;
  return new;
end;
$$;

create or replace function public.list_factory_bindable_workspace_secrets(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns table (id uuid, key text) language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  return query select source.id, source.key from public.workspace_secrets source
    where source.workspace_id = p_workspace_id and source.key <> 'LINEAR_API_KEY'
      and not exists (select 1 from public.factory_secret_bindings binding where binding.workspace_secret_id = source.id)
      and not exists (select 1 from public.factory_mcp_secret_bindings binding where binding.workspace_secret_id = source.id)
    order by source.key limit 1000;
end;
$$;

create function public.create_factory_mcp_secret_binding(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_execution_grant_id uuid, p_execution_grant_version bigint,
  p_factory_agent_id uuid, p_tool_revision_id uuid, p_workspace_secret_id uuid
) returns public.factory_mcp_secret_bindings language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; execution_grant public.factory_execution_grants; result public.factory_mcp_secret_bindings;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into execution_grant from public.factory_execution_grants target
    where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_execution_grant_id);
  if not found then
    raise exception 'The execution grant is unavailable.' using errcode = 'P0002';
  end if;
  if execution_grant.version is distinct from p_execution_grant_version then
    raise exception 'The execution grant changed. Reload before delegating a secret.' using errcode = 'PT409';
  end if;
  execution_grant := internal.require_current_factory_execution_grant(
    p_workspace_id, p_factory_id, p_execution_grant_id, p_execution_grant_version,
    execution_grant.github_repository_id, execution_grant.read_context_repository_ids,
    '{}'::text[], execution_grant.execution_policy_revision_id
  );
  if not exists (select 1 from public.factory_agents agent
    where (agent.workspace_id, agent.factory_id, agent.id) = (p_workspace_id, p_factory_id, p_factory_agent_id)) then
    raise exception 'The factory agent is unavailable.' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.factory_mcp_server_revisions revision
    cross join lateral unnest(revision.operation_names) operation(name)
    where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, p_tool_revision_id)
      and revision.auth_kind = 'bearer' and revision.revoked_at is null
      and (revision.id::text || '/' || operation.name) = any(execution_grant.tool_ids)
  ) then
    raise exception 'The execution grant does not authorize this bearer MCP revision.' using errcode = '42501';
  end if;
  insert into public.factory_mcp_secret_bindings(
    workspace_id, factory_id, execution_grant_id, service_principal_id, factory_agent_id,
    tool_revision_id, workspace_secret_id, created_by
  ) values (
    p_workspace_id, p_factory_id, p_execution_grant_id, execution_grant.service_principal_id, p_factory_agent_id,
    p_tool_revision_id, p_workspace_secret_id, p_actor_user_id
  ) returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id, 'mcp_secret_binding.created', actor_member_id,
      jsonb_build_object('bindingId', result.id, 'revisionId', p_tool_revision_id, 'grantId', p_execution_grant_id,
        'agentId', p_factory_agent_id));
  return result;
exception when unique_violation then
  raise exception 'The MCP credential scope is already claimed.' using errcode = 'PT409';
end;
$$;
revoke all on function public.create_factory_mcp_secret_binding(uuid, uuid, uuid, uuid, bigint, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_factory_mcp_secret_binding(uuid, uuid, uuid, uuid, bigint, uuid, uuid, uuid) to service_role;

create function public.revoke_factory_mcp_secret_binding(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_binding_id uuid
) returns public.factory_mcp_secret_bindings language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; result public.factory_mcp_secret_bindings;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into result from public.factory_mcp_secret_bindings
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_binding_id);
  if not found then
    raise exception 'MCP secret binding is unavailable in this factory.' using errcode = 'P0002';
  end if;
  if result.revoked_at is not null then return result; end if;
  update public.factory_mcp_secret_bindings set revoked_by = p_actor_user_id, revoked_at = clock_timestamp()
    where id = result.id returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
    values (p_workspace_id, p_factory_id, 'mcp_secret_binding.revoked', actor_member_id,
      jsonb_build_object('bindingId', result.id, 'revisionId', result.tool_revision_id));
  return result;
end;
$$;
revoke all on function public.revoke_factory_mcp_secret_binding(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_factory_mcp_secret_binding(uuid, uuid, uuid, uuid) to service_role;

create function internal.assert_factory_mcp_manifest(
  p_workspace_id uuid, p_factory_id uuid, p_definition jsonb,
  p_execution_grant_id uuid, p_service_principal_id uuid
) returns void language plpgsql set search_path = '' as $$
declare
  manifest jsonb := p_definition->'mcpManifest';
  scope_keys jsonb := p_definition->'toolIds';
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  server_entry jsonb; revision public.factory_mcp_server_revisions; server_slug text;
  operation_names text[]; expected_scope_keys text[] := '{}'; server_ids uuid[] := '{}';
  agent_id uuid; auth_ref jsonb;
begin
  if manifest is null then
    -- Old definitions can carry inert component IDs. Current operation scope keys
    -- must have an explicit compiled manifest before they can authorize anything.
    if jsonb_typeof(scope_keys) = 'array' and exists (
      select 1 from jsonb_array_elements_text(scope_keys) key
      where key ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[a-z0-9_.-]{1,80}$'
    ) then
      raise exception 'MCP operation scopes require an explicit tool manifest.' using errcode = 'PT422';
    end if;
    return;
  end if;
  if p_execution_grant_id is null or p_service_principal_id is null then
    raise exception 'MCP tools require a reviewed execution grant.' using errcode = '42501';
  end if;
  if jsonb_typeof(manifest) is distinct from 'object' or manifest - array['agentId','servers'] <> '{}'::jsonb
    or jsonb_typeof(manifest->'agentId') is distinct from 'string' or manifest->>'agentId' !~ uuid_pattern
    or jsonb_typeof(manifest->'servers') is distinct from 'array' or jsonb_typeof(scope_keys) is distinct from 'array'
    or manifest->>'agentId' is distinct from p_definition#>>'{implementationAgent,agentId}' then
    raise exception 'The MCP manifest must identify the pinned implementation agent and exact operations.' using errcode = 'PT422';
  end if;
  if jsonb_array_length(manifest->'servers') not between 1 and 32 then
    raise exception 'Select 1 to 32 distinct approved MCP servers.' using errcode = 'PT422';
  end if;
  agent_id := (manifest->>'agentId')::uuid;
  if not exists (select 1 from public.factory_agents agent
    where (agent.workspace_id, agent.factory_id, agent.id) = (p_workspace_id, p_factory_id, agent_id)) then
    raise exception 'The MCP implementation agent is unavailable in this factory.' using errcode = 'PT422';
  end if;

  -- The current execution grant already owns a shared factory fence. A
  -- revision/binding revocation takes that factory exclusively before changes.
  for server_entry in select value from jsonb_array_elements(manifest->'servers') loop
    if jsonb_typeof(server_entry) is distinct from 'object'
      or server_entry - array['toolRevisionId','serverId','serverSlug','revisionNumber','endpoint','operations','auth'] <> '{}'::jsonb
      or jsonb_typeof(server_entry->'toolRevisionId') is distinct from 'string'
      or server_entry->>'toolRevisionId' !~ uuid_pattern
      or jsonb_typeof(server_entry->'operations') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(server_entry->'operations') item
        where jsonb_typeof(item) is distinct from 'string') then
      raise exception 'Select an exact MCP server revision and its allowed operations.' using errcode = 'PT422';
    end if;
    select target.* into revision from public.factory_mcp_server_revisions target
      where (target.workspace_id, target.factory_id, target.id) =
        (p_workspace_id, p_factory_id, (server_entry->>'toolRevisionId')::uuid)
        and target.revoked_at is null;
    if not found then
      raise exception 'A selected MCP revision is unavailable or revoked in this factory.' using errcode = 'PT422';
    end if;
    select server.slug into strict server_slug from public.factory_mcp_servers server
      where (server.workspace_id, server.factory_id, server.id) = (p_workspace_id, p_factory_id, revision.server_id);
    if revision.server_id = any(server_ids)
      or server_entry->'serverId' is distinct from to_jsonb(revision.server_id)
      or server_entry->'serverSlug' is distinct from to_jsonb(server_slug)
      or server_entry->'revisionNumber' is distinct from to_jsonb(revision.revision_number)
      or server_entry->'endpoint' is distinct from to_jsonb(revision.endpoint) then
      raise exception 'The MCP manifest does not match its approved server revision.' using errcode = 'PT422';
    end if;
    server_ids := array_append(server_ids, revision.server_id);
    operation_names := array(select jsonb_array_elements_text(server_entry->'operations'));
    perform internal.assert_factory_mcp_operations(operation_names);
    if (operation_names <@ revision.operation_names) is not true
      or operation_names <> array(select name from unnest(operation_names) name order by name collate "C") then
      raise exception 'The MCP manifest contains operations outside its approved server revision.' using errcode = 'PT422';
    end if;
    expected_scope_keys := expected_scope_keys || array(
      select revision.id::text || '/' || name from unnest(operation_names) name
    );
    auth_ref := server_entry->'auth';
    if revision.auth_kind = 'none' then
      if auth_ref is distinct from '{"kind":"none"}'::jsonb then
        raise exception 'This MCP revision uses unauthenticated transport.' using errcode = 'PT422';
      end if;
    elsif jsonb_typeof(auth_ref) is distinct from 'object' or auth_ref->>'kind' is distinct from 'bearer'
      or auth_ref - array['kind','secretBindingId'] <> '{}'::jsonb
      or jsonb_typeof(auth_ref->'secretBindingId') is distinct from 'string'
      or auth_ref->>'secretBindingId' !~ uuid_pattern then
      raise exception 'This MCP revision requires a scoped bearer secret reference.' using errcode = 'PT422';
    else
      perform 1 from public.factory_mcp_secret_bindings binding
      join public.workspace_secrets source on (source.workspace_id, source.id) = (binding.workspace_id, binding.workspace_secret_id)
      where (binding.workspace_id, binding.factory_id, binding.id, binding.execution_grant_id,
        binding.service_principal_id, binding.factory_agent_id, binding.tool_revision_id) =
        (p_workspace_id, p_factory_id, (auth_ref->>'secretBindingId')::uuid, p_execution_grant_id,
          p_service_principal_id, agent_id, revision.id) and binding.revoked_at is null
      for share of source;
      if not found then
        raise exception 'The MCP bearer binding is unavailable for this grant, agent, and revision.' using errcode = '42501';
      end if;
    end if;
  end loop;
  if cardinality(expected_scope_keys) > 32 or scope_keys is distinct from
    to_jsonb(array(select key from unnest(expected_scope_keys) key order by key collate "C")) then
    raise exception 'The MCP manifest operation scopes do not match the definition grant keys.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_mcp_manifest(uuid, uuid, jsonb, uuid, uuid)
  from public, anon, authenticated, service_role;

-- This resolver is used by activation, admission, capability checks, and
-- recheck_session_execution_grant at each attempt start and credential release.
create or replace function internal.resolve_definition_execution_grant(
  p_workspace_id uuid, p_factory_id uuid, p_definition jsonb,
  p_repository_id uuid, p_execution_policy_revision_id uuid
) returns public.factory_execution_grants language plpgsql set search_path = '' as $$
declare grant_ref jsonb := p_definition->'executionGrant'; execution_grant public.factory_execution_grants;
begin
  if grant_ref is null then
    perform internal.assert_factory_mcp_manifest(p_workspace_id, p_factory_id, p_definition, null, null);
    return null;
  end if;
  if jsonb_typeof(grant_ref) is distinct from 'object'
    or jsonb_typeof(grant_ref->'id') is distinct from 'string'
    or (grant_ref->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(grant_ref->'version') is distinct from 'number'
    or (grant_ref->>'version') !~ '^[1-9][0-9]{0,15}$'
    or grant_ref - 'id' - 'version' <> '{}'::jsonb then
    raise exception 'The factory definition execution grant is invalid.' using errcode = 'PT422';
  end if;
  if (grant_ref->>'version')::bigint > 9007199254740991
    or p_definition ? 'writableRepositoryIds'
    or p_execution_policy_revision_id is null then
    raise exception 'A grant-backed definition requires one writer and an explicit execution budget.' using errcode = 'PT422';
  end if;
  execution_grant := internal.require_current_factory_execution_grant(
    p_workspace_id, p_factory_id, (grant_ref->>'id')::uuid, (grant_ref->>'version')::bigint,
    p_repository_id,
    array(select id::uuid from jsonb_array_elements_text(p_definition->'readContextRepositoryIds') as ids(id)),
    array(select id from jsonb_array_elements_text(p_definition->'toolIds') as ids(id)),
    p_execution_policy_revision_id
  );
  perform internal.assert_factory_mcp_manifest(p_workspace_id, p_factory_id, p_definition,
    execution_grant.id, execution_grant.service_principal_id);
  return execution_grant;
end;
$$;

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
  else
    perform internal.assert_factory_mcp_manifest(new.workspace_id, new.factory_id, definition, null, null);
  end if;
  if definition ? 'credentialBindingId' then
    perform internal.lock_definition_credential_binding(new.workspace_id, new.factory_id, definition,
      execution_grant.id, execution_grant.service_principal_id);
  end if;
  return new;
end;
$$;

create or replace function internal.guard_admitted_factory_credential_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
declare definition jsonb;
begin
  select revision.definition_json::jsonb into definition
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (new.workspace_id, new.factory_id, new.definition_revision_id);
  if new.execution_grant_id is null then
    perform internal.assert_factory_mcp_manifest(new.workspace_id, new.factory_id, definition, null, null);
  end if;
  if definition ? 'credentialBindingId' then
    perform internal.lock_definition_credential_binding(new.workspace_id, new.factory_id, definition,
      new.execution_grant_id, new.credential_owner_service_principal_id);
  end if;
  return new;
end;
$$;

-- The existing admission and attempt receipts pin the immutable definition and
-- its digest. Inspection keeps this historical identity even after revocation.
create function internal.get_run_mcp_manifest(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'kind', case when attempt.run_id is null then 'planned' else 'pinned' end,
    'manifest', revision.definition_json::jsonb->'mcpManifest'
  )
  from public.agent_runs run
  join public.sessions owner on (owner.workspace_id, owner.id) = (run.workspace_id, run.session_id)
  join public.session_factory_admission_inputs admission
    on (admission.workspace_id, admission.factory_id, admission.session_id, admission.definition_revision_id) =
      (owner.workspace_id, owner.factory_id, owner.id, owner.factory_definition_revision_id)
  join public.factory_definition_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
      (admission.workspace_id, admission.factory_id, admission.definition_revision_id, admission.definition_digest)
  left join public.session_attempt_manifests attempt on attempt.run_id = run.id
  where (run.workspace_id, run.id) = (target_workspace_id, target_run_id)
    and run.attempt_count is not distinct from target_attempt_count
    and owner.execute_pinned_definition and admission.execution_grant_id is not null
    and revision.definition_json::jsonb ? 'mcpManifest'
    and (attempt.run_id is null or (
      (attempt.workspace_id, attempt.session_id, attempt.job_id, attempt.attempt_count, attempt.definition_revision_id, attempt.definition_digest) =
        (run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, revision.id, revision.canonical_digest)
      and to_jsonb(attempt.definition_tool_ids) = revision.definition_json::jsonb->'toolIds'
    ))
    and auth.uid() is not null and internal.can_access_session(owner.id)
$$;
revoke all on function internal.get_run_mcp_manifest(uuid, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function internal.get_run_mcp_manifest(uuid, uuid, integer) to authenticated;

create function public.get_run_mcp_manifest(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer default null
) returns jsonb language sql stable set search_path = '' as $$
  select internal.get_run_mcp_manifest(target_workspace_id, target_run_id, target_attempt_count)
$$;
revoke all on function public.get_run_mcp_manifest(uuid, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_run_mcp_manifest(uuid, uuid, integer) to authenticated;
