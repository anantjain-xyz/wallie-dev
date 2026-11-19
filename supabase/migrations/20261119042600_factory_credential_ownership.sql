drop index public.factory_secret_bindings_factory_idx;
create index factory_secret_bindings_factory_idx
  on public.factory_secret_bindings(workspace_id, factory_id, id);

create function internal.factory_secret_binding_metadata(
  p_workspace_id uuid, p_factory_id uuid, p_after_id uuid, p_binding_id uuid, p_limit integer
) returns table (
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
  from (
    select binding.* from public.factory_secret_bindings binding
    where (binding.workspace_id, binding.factory_id) = (p_workspace_id, p_factory_id)
      and binding.id >= coalesce(p_binding_id, p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and binding.id <= coalesce(p_binding_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
      and (p_binding_id is not null or p_after_id is null or binding.id <> p_after_id)
    order by binding.id
    limit p_limit
  ) binding
  join public.factories factory on (factory.workspace_id, factory.id) = (binding.workspace_id, binding.factory_id)
  join public.workspaces workspace on workspace.id = binding.workspace_id
  left join public.factory_execution_grants grant_row
    on (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.service_principal_id) =
       (binding.workspace_id, binding.factory_id, binding.execution_grant_id, binding.service_principal_id)
  left join public.workspace_secrets source
    on (source.workspace_id, source.id) = (binding.workspace_id, binding.workspace_secret_id)
    and source.key <> 'LINEAR_API_KEY';
$$;
revoke all on function internal.factory_secret_binding_metadata(uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;

create or replace function internal.factory_secret_binding_metadata(p_workspace_id uuid, p_factory_id uuid)
returns table (
  id uuid, workspace_id uuid, factory_id uuid, execution_grant_id uuid, service_principal_id uuid,
  factory_agent_id uuid, agent_provider text, open_code_provider_id text, workspace_secret_id uuid,
  version bigint, created_at timestamptz, revoked_at timestamptz,
  material_revision bigint, rotated_at timestamptz, status text, secret_key text, grant_version bigint
) language sql stable set search_path = '' as $$
  select * from internal.factory_secret_binding_metadata(p_workspace_id, p_factory_id, null, null, null);
$$;

create function internal.read_factory_credential_ownership(
  p_workspace_id uuid, p_factory_id uuid, p_after_id uuid, p_binding_id uuid, p_limit integer
) returns table (
  id uuid, service_principal_id uuid, execution_grant_id uuid, factory_agent_id uuid,
  agent_provider text, open_code_provider_id text, status text, version bigint,
  material_revision bigint, rotated_at timestamptz, created_at timestamptz, revoked_at timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not internal.can_manage_factory(p_workspace_id, p_factory_id) then
    raise exception 'Factory manager access is required.' using errcode = '42501';
  end if;
  return query
    select binding.id, binding.service_principal_id, binding.execution_grant_id, binding.factory_agent_id,
      binding.agent_provider, binding.open_code_provider_id, binding.status, binding.version,
      binding.material_revision, binding.rotated_at, binding.created_at, binding.revoked_at
    from internal.factory_secret_binding_metadata(p_workspace_id, p_factory_id, p_after_id, p_binding_id,
      least(greatest(coalesce(p_limit, 21), 1), 101)) binding
    order by binding.id;
end;
$$;
revoke all on function internal.read_factory_credential_ownership(uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function internal.read_factory_credential_ownership(uuid, uuid, uuid, uuid, integer)
  to authenticated;

create function public.read_factory_credential_ownership(
  p_workspace_id uuid, p_factory_id uuid, p_after_id uuid default null,
  p_binding_id uuid default null, p_limit integer default 21
) returns table (
  id uuid, service_principal_id uuid, execution_grant_id uuid, factory_agent_id uuid,
  agent_provider text, open_code_provider_id text, status text, version bigint,
  material_revision bigint, rotated_at timestamptz, created_at timestamptz, revoked_at timestamptz
) language sql stable security invoker set search_path = '' as $$
  select * from internal.read_factory_credential_ownership(p_workspace_id, p_factory_id, p_after_id, p_binding_id, p_limit);
$$;
revoke all on function public.read_factory_credential_ownership(uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_credential_ownership(uuid, uuid, uuid, uuid, integer)
  to authenticated;
