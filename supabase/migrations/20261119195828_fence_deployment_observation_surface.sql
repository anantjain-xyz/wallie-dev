-- Installation time is a capture boundary, not proof that any provider has
-- reported all of its deployments.
insert into internal.factory_outcome_capture_coverage (source, live_from)
  values ('deployments', clock_timestamp());

-- A credential can hold both API and MCP scopes. At the MCP boundary expose
-- only scopes supported on that surface, including during identity discovery.
create or replace function internal.resolve_factory_command_credential(
  p_workspace_id uuid, p_factory_id uuid, p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid, p_credential_digest text, p_surface public.factory_command_surface, p_resource text
) returns internal.factory_command_authority language plpgsql set search_path = '' as $$
declare
  token public.factory_machine_tokens;
  authorized internal.factory_oauth_access_authority;
  binding public.factory_oauth_grant_bindings;
  identity internal.factory_command_identity;
  scopes public.factory_command_scope[];
begin
  if p_workspace_id is null or p_factory_id is null or p_credential_kind is null or p_credential_id is null
    or p_credential_digest is null or p_credential_digest !~ '^[a-f0-9]{64}$' or p_surface is null
    or (p_resource is not null and (p_surface <> 'mcp' or
      internal.factory_mcp_resource_factory_id(p_resource, p_workspace_id) is distinct from p_factory_id))
    or (p_credential_kind = 'oauth_access_token' and p_surface = 'mcp' and p_resource is null) then
    raise exception 'Machine credential is unavailable.' using errcode = '42501';
  end if;
  if p_credential_kind = 'machine_token' then
    token := internal.resolve_factory_machine_token(p_workspace_id, p_factory_id, p_credential_id, p_credential_digest);
    identity := row(token.service_principal_id, token.execution_grant_id, token.execution_grant_version, null, null);
    scopes := token.scopes;
  else
    authorized := internal.resolve_factory_oauth_access_token(
      p_workspace_id, p_factory_id, p_credential_id, p_credential_digest, p_resource);
    binding := authorized.binding;
    identity := row(binding.service_principal_id, binding.execution_grant_id, binding.execution_grant_version,
      authorized.consenting_member_id, binding.grant_id);
    scopes := authorized.scopes;
  end if;
  if p_surface = 'mcp' then
    scopes := array_remove(scopes, 'deployments:observe'::public.factory_command_scope);
    if cardinality(scopes) = 0 then
      raise exception 'Machine credential does not authorize MCP.' using errcode = 'PT403';
    end if;
  end if;
  return row(identity, scopes)::internal.factory_command_authority;
end;
$$;

-- Only authorization requests without an MCP resource may offer this scope.
-- Any access token or refresh derives its allowed scopes from that consent.
alter table internal.factory_oauth_authorizations
  add constraint factory_oauth_authorizations_deployment_api_audience
  check (resource_uri is null or not ('deployments:observe'::public.factory_command_scope = any(scopes)));
