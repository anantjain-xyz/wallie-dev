-- HTTP adapters construct the audience from the configured application origin.
-- The database independently fences its exact workspace and factory path.
create function internal.factory_mcp_resource_factory_id(p_uri text,p_workspace_id uuid)
returns uuid language sql immutable strict set search_path = '' as $$
  select parts[2]::uuid from regexp_match(p_uri,
    '^(?:https://(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])|http://(?:localhost|127\.0\.0\.1|\[::1\]))(?::[1-9][0-9]{0,4})?'
    '/api/v1/workspaces/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
    '/factories/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/mcp$') parts
  where length(p_uri)<=2048 and parts[1]=p_workspace_id::text;
$$;
revoke all on function internal.factory_mcp_resource_factory_id(text,uuid) from public,anon,authenticated,service_role;

alter table internal.factory_oauth_authorizations add column resource_uri text
  check (resource_uri is null or internal.factory_mcp_resource_factory_id(resource_uri,workspace_id) is not null);

-- Keep resource paths out of directly readable consent metadata.
create table internal.factory_oauth_grant_resources (
  grant_id uuid primary key,
  workspace_id uuid not null,
  resource_uri text not null check (internal.factory_mcp_resource_factory_id(resource_uri,workspace_id) is not null),
  foreign key (workspace_id,grant_id) references public.factory_oauth_grants(workspace_id,id) on delete cascade
);
alter table internal.factory_oauth_grant_resources enable row level security;
revoke all on internal.factory_oauth_grant_resources from public,anon,authenticated,service_role;

drop function
  public.begin_factory_oauth_authorization(uuid, uuid, uuid, text, text, public.factory_command_scope[], text),
  public.exchange_factory_oauth_code(uuid, text, uuid, text, text, uuid, text, uuid, text),
  public.rotate_factory_oauth_refresh_token(uuid, uuid, text, uuid, text, uuid, text, public.factory_command_scope[]);

create function public.begin_factory_oauth_authorization(
  p_client_id uuid, p_actor_user_id uuid, p_actor_session_id uuid, p_redirect_uri text,
  p_code_challenge text, p_requested_scopes public.factory_command_scope[], p_state text default null, p_resource text default null
) returns table(authorization_id uuid, client_name text, workspace_id uuid, workspace_name text,
  scopes public.factory_command_scope[], factories jsonb, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  client public.factory_oauth_clients;
  actor public.workspace_members;
  resource_factory_id uuid;
  binding record;
  approved public.factory_execution_grants;
  effective_scopes public.factory_command_scope[];
  offers internal.factory_oauth_factory_offer[] := '{}';
  offered_factories jsonb := '[]';
  request_row internal.factory_oauth_authorizations;
begin
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$'
    or not internal.valid_factory_oauth_scopes(p_requested_scopes)
    or (p_state is not null and (length(p_state) > 1024 or p_state ~ '[[:cntrl:]]')) then
    raise exception 'Invalid OAuth authorization request.' using errcode = '22023';
  end if;
  select target.* into client from public.factory_oauth_clients target where target.id = p_client_id;
  if not found then raise exception 'OAuth client is unavailable.' using errcode = '42501'; end if;
  perform internal.assert_workspace_accepts_work(client.workspace_id);
  select target.* into client from public.factory_oauth_clients target where target.id = p_client_id for share;
  if not found or client.revoked_at is not null or p_redirect_uri is null
    or not (p_redirect_uri = any(client.redirect_uris)) or not (p_requested_scopes <@ client.allowed_scopes) then
    raise exception 'OAuth client, redirect or scope is unavailable.' using errcode = '42501';
  end if;
  perform internal.assert_factory_oauth_browser_session(p_actor_user_id, p_actor_session_id);
  actor := internal.factory_oauth_member(client.workspace_id, p_actor_user_id);
  if p_resource is not null then
    resource_factory_id := internal.factory_mcp_resource_factory_id(p_resource, client.workspace_id);
    if resource_factory_id is null or not exists (
      select 1 from public.factory_oauth_client_bindings pinned
      where (pinned.workspace_id,pinned.client_id,pinned.factory_id) = (client.workspace_id,client.id,resource_factory_id)
    ) then
      raise exception 'Invalid OAuth resource.' using errcode = 'PT400';
    end if;
  end if;
  for binding in select pinned.*, factory.name from public.factory_oauth_client_bindings pinned
    join public.factories factory on (factory.workspace_id, factory.id) = (pinned.workspace_id, pinned.factory_id)
    where pinned.client_id = client.id
      and (resource_factory_id is null or pinned.factory_id = resource_factory_id)
    order by pinned.factory_id
  loop
    begin
      approved := internal.require_factory_oauth_binding(client.workspace_id, binding.factory_id, binding.service_principal_id,
        binding.execution_grant_id, binding.execution_grant_version, actor.id, '{}');
      effective_scopes := array(select requested from unnest(p_requested_scopes) requested
        where requested = any(approved.command_scopes));
      if cardinality(effective_scopes) = 0 then continue; end if;
      offers := array_append(offers, row(binding.factory_id, effective_scopes)::internal.factory_oauth_factory_offer);
      offered_factories := offered_factories || jsonb_build_array(jsonb_build_object(
        'factory_id', binding.factory_id, 'name', binding.name, 'service_principal_id', binding.service_principal_id,
        'execution_grant_id', binding.execution_grant_id, 'execution_grant_version', binding.execution_grant_version,
        'scopes', effective_scopes));
    exception when insufficient_privilege or sqlstate 'P0011' then
      continue;
    end;
  end loop;
  if cardinality(offers) = 0 then
    raise exception 'No registered factory authorizes this request.' using errcode = '42501';
  end if;
  insert into internal.factory_oauth_authorizations (
    workspace_id, client_id, consenting_member_id, browser_session_id, redirect_uri, pkce_challenge,
    state, scopes, offered_factories, expires_at, resource_uri
  ) values (client.workspace_id, client.id, actor.id, p_actor_session_id, p_redirect_uri, p_code_challenge,
    p_state, p_requested_scopes, offers, clock_timestamp() + interval '10 minutes', p_resource) returning * into request_row;
  return query select request_row.id, client.name, client.workspace_id, workspace.name,
    request_row.scopes, offered_factories, request_row.expires_at
  from public.workspaces workspace where workspace.id = client.workspace_id;
end;
$$;

create function public.exchange_factory_oauth_code(
  p_client_id uuid, p_redirect_uri text, p_code_id uuid, p_code_digest text, p_pkce_challenge text,
  p_access_token_id uuid, p_access_token_digest text, p_refresh_token_id uuid, p_refresh_token_digest text,
  p_resource text default null
) returns table(status text, expires_in integer, scopes public.factory_command_scope[])
language plpgsql security definer set search_path = '' as $$
declare
  request_row internal.factory_oauth_authorizations;
  client public.factory_oauth_clients;
  binding record;
  approved public.factory_execution_grants;
  effective_scopes public.factory_command_scope[] := '{}';
  consent public.factory_oauth_grants;
  granted_at timestamptz;
  expiry timestamptz := clock_timestamp() + interval '90 days';
  granted_factories integer := 0;
  ttl integer;
begin
  select * into request_row from internal.factory_oauth_authorizations request
  where (request.code_id, request.code_digest, request.client_id, request.redirect_uri, request.pkce_challenge) =
    (p_code_id, p_code_digest, p_client_id, p_redirect_uri, p_pkce_challenge);
  if not found then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  perform internal.assert_workspace_accepts_work(request_row.workspace_id);
  select * into client from public.factory_oauth_clients target where target.id = p_client_id for share;
  if not found or client.revoked_at is not null or not (p_redirect_uri = any(client.redirect_uris)) then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  select * into request_row from internal.factory_oauth_authorizations request
  where request.id = request_row.id for update;
  if not found or request_row.code_consumed_at is not null or request_row.code_expires_at <= clock_timestamp() then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  if request_row.resource_uri is distinct from p_resource then
    return query select 'invalid_target'::text, null::integer, null::public.factory_command_scope[];
    return;
  end if;
  for binding in select pinned.*, offer.scopes from public.factory_oauth_client_bindings pinned
    join unnest(request_row.offered_factories) offer on offer.factory_id = pinned.factory_id
    where pinned.client_id = client.id and pinned.factory_id = any(request_row.consented_factory_ids) order by pinned.factory_id
  loop
    approved := internal.require_factory_oauth_binding(binding.workspace_id, binding.factory_id,
      binding.service_principal_id, binding.execution_grant_id, binding.execution_grant_version,
      request_row.consenting_member_id, binding.scopes);
    expiry := least(expiry, approved.expires_at);
    effective_scopes := effective_scopes || binding.scopes;
    granted_factories := granted_factories + 1;
  end loop;
  granted_at := clock_timestamp();
  if granted_factories = 0 or granted_factories <> cardinality(request_row.consented_factory_ids)
    or request_row.code_expires_at <= granted_at or expiry <= granted_at then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  effective_scopes := array(select requested from unnest(request_row.scopes) requested
    where requested = any(effective_scopes));
  insert into public.factory_oauth_grants (client_id, workspace_id, consenting_member_id, scopes, created_at, expires_at)
  values (client.id, client.workspace_id, request_row.consenting_member_id, effective_scopes, granted_at, expiry)
  returning * into consent;
  insert into public.factory_oauth_grant_bindings (
    grant_id, workspace_id, factory_id, service_principal_id, execution_grant_id, execution_grant_version, scopes
  ) select consent.id, pinned.workspace_id, pinned.factory_id, pinned.service_principal_id, pinned.execution_grant_id,
    pinned.execution_grant_version, offer.scopes from public.factory_oauth_client_bindings pinned
  join unnest(request_row.offered_factories) offer on offer.factory_id = pinned.factory_id
  where pinned.client_id = client.id and pinned.factory_id = any(request_row.consented_factory_ids);
  if request_row.resource_uri is not null then
    insert into internal.factory_oauth_grant_resources(grant_id,workspace_id,resource_uri)
    values (consent.id,consent.workspace_id,request_row.resource_uri);
  end if;
  ttl := internal.issue_factory_oauth_token_pair(consent, consent.scopes,
    p_access_token_id, p_access_token_digest, p_refresh_token_id, p_refresh_token_digest);
  update internal.factory_oauth_authorizations request set code_consumed_at = granted_at where request.id = request_row.id;
  perform internal.audit_factory_oauth_grant(consent, 'oauth_grant.connected', consent.consenting_member_id);
  return query select 'issued'::text, ttl, consent.scopes;
exception when insufficient_privilege or sqlstate 'P0010' or sqlstate 'P0011' then
  return query select 'invalid_grant'::text, null::integer, null::public.factory_command_scope[];
end;
$$;

create function public.rotate_factory_oauth_refresh_token(
  p_client_id uuid, p_refresh_token_id uuid, p_refresh_token_digest text,
  p_next_access_token_id uuid, p_next_access_token_digest text,
  p_next_refresh_token_id uuid, p_next_refresh_token_digest text,
  p_requested_scopes public.factory_command_scope[] default null, p_resource text default null
) returns table(status text, expires_in integer, scopes public.factory_command_scope[])
language plpgsql security definer set search_path = '' as $$
declare
  consent public.factory_oauth_grants;
  client public.factory_oauth_clients;
  token internal.factory_oauth_token_pairs;
  binding public.factory_oauth_grant_bindings;
  desired public.factory_command_scope[];
  resource_uri text;
  ttl integer;
begin
  -- A guessed refresh identifier or a mismatched client must never revoke a
  -- token family. Authenticate the presented old token before taking its lock.
  select grant_row.* into consent from public.factory_oauth_grants grant_row
  join internal.factory_oauth_token_pairs pair on pair.grant_id = grant_row.id
  where (grant_row.client_id, pair.refresh_token_id, pair.refresh_digest) =
    (p_client_id, p_refresh_token_id, p_refresh_token_digest);
  if not found then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  perform internal.assert_workspace_accepts_work(consent.workspace_id);
  select * into client from public.factory_oauth_clients target where target.id = p_client_id for share;
  if not found or client.revoked_at is not null then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  select * into consent from public.factory_oauth_grants target where target.id = consent.id for update;
  if not found or consent.revoked_at is not null or consent.expires_at <= clock_timestamp() then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  select * into token from internal.factory_oauth_token_pairs pair
  where (pair.grant_id, pair.refresh_token_id, pair.refresh_digest) = (consent.id, p_refresh_token_id, p_refresh_token_digest);
  if not found then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  if token.replaced_at is not null then
    perform internal.revoke_factory_oauth_grant(consent, 'refresh_reuse', null);
    -- A structured error commits the revocation and its audit history. Raising
    -- an exception here would roll both back and leave the stolen family live.
    return query select 'invalid_grant'::text, null::integer, null::public.factory_command_scope[];
    return;
  end if;
  if token.refresh_expires_at <= clock_timestamp() then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  select resource.resource_uri into resource_uri from internal.factory_oauth_grant_resources resource
  where resource.grant_id = consent.id;
  if resource_uri is distinct from p_resource then
    return query select 'invalid_target'::text, null::integer, null::public.factory_command_scope[];
    return;
  end if;
  desired := coalesce(p_requested_scopes, consent.scopes);
  if not internal.valid_factory_oauth_scopes(desired) or not (desired <@ consent.scopes) then
    return query select 'invalid_scope'::text, null::integer, null::public.factory_command_scope[];
    return;
  end if;
  if not exists (select 1 from public.factory_oauth_grant_bindings where grant_id = consent.id) then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  for binding in select * from public.factory_oauth_grant_bindings pinned
    where pinned.grant_id = consent.id order by pinned.factory_id
  loop
    perform internal.require_factory_oauth_binding(binding.workspace_id, binding.factory_id, binding.service_principal_id,
      binding.execution_grant_id, binding.execution_grant_version, consent.consenting_member_id, binding.scopes);
  end loop;
  if token.refresh_expires_at <= clock_timestamp() or consent.expires_at <= clock_timestamp() then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  update internal.factory_oauth_token_pairs pair set replaced_at = clock_timestamp()
  where pair.refresh_token_id = token.refresh_token_id;
  ttl := internal.issue_factory_oauth_token_pair(consent, desired,
    p_next_access_token_id, p_next_access_token_digest, p_next_refresh_token_id, p_next_refresh_token_digest);
  return query select 'issued'::text, ttl, desired;
exception when insufficient_privilege or sqlstate 'P0010' or sqlstate 'P0011' then
  return query select 'invalid_grant'::text, null::integer, null::public.factory_command_scope[];
end;
$$;

revoke all on function
  public.begin_factory_oauth_authorization(uuid, uuid, uuid, text, text, public.factory_command_scope[], text, text),
  public.exchange_factory_oauth_code(uuid, text, uuid, text, text, uuid, text, uuid, text, text),
  public.rotate_factory_oauth_refresh_token(uuid, uuid, text, uuid, text, uuid, text, public.factory_command_scope[], text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.begin_factory_oauth_authorization(uuid, uuid, uuid, text, text, public.factory_command_scope[], text, text),
  public.exchange_factory_oauth_code(uuid, text, uuid, text, text, uuid, text, uuid, text, text),
  public.rotate_factory_oauth_refresh_token(uuid, uuid, text, uuid, text, uuid, text, public.factory_command_scope[], text)
  to service_role;
