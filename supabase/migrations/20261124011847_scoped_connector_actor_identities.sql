create type public.connector_actor_kind as enum ('human', 'service');

create table internal.connector_actor_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid,
  installation_id uuid not null,
  provider public.connector_provider not null,
  external_tenant_id text not null,
  external_actor_id text not null check (
    length(external_actor_id) between 1 and 256 and external_actor_id !~ '[[:space:][:cntrl:]]'
  ),
  actor_kind public.connector_actor_kind not null,
  member_id uuid,
  service_principal_id uuid,
  verified_by_member_id uuid not null,
  verified_at timestamptz not null default clock_timestamp(),
  revoked_by_member_id uuid,
  revoked_at timestamptz,
  foreign key (workspace_id, installation_id, provider, external_tenant_id)
    references internal.connector_installations(workspace_id, id, provider, external_tenant_id) on delete cascade,
  foreign key (workspace_id, factory_id, service_principal_id)
    references public.service_principals(workspace_id, factory_id, id) on delete cascade,
  check ((actor_kind = 'human' and member_id is not null and factory_id is null and service_principal_id is null)
    or (actor_kind = 'service' and member_id is null and factory_id is not null and service_principal_id is not null)),
  check ((revoked_at is null) = (revoked_by_member_id is null))
);

create unique index connector_human_actor_active_idx
  on internal.connector_actor_links(installation_id, external_actor_id)
  where actor_kind = 'human' and revoked_at is null;
create unique index connector_service_actor_active_idx
  on internal.connector_actor_links(installation_id, factory_id, external_actor_id)
  where actor_kind = 'service' and revoked_at is null;
create index connector_actor_links_installation_idx
  on internal.connector_actor_links(workspace_id, installation_id, provider, external_tenant_id);
create index connector_actor_links_service_principal_idx
  on internal.connector_actor_links(workspace_id, factory_id, service_principal_id)
  where service_principal_id is not null;

alter table internal.connector_actor_links enable row level security;
revoke all on internal.connector_actor_links from public, anon, authenticated, service_role;

-- The provider adapter verifies the external subject before calling this RPC.
-- Human links always bind to the signed-in Wallie user supplied by the adapter.
create function public.link_connector_actor(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_installation_id uuid,
  p_installation_generation bigint, p_provider public.connector_provider, p_external_tenant_id text,
  p_external_actor_id text, p_actor_kind public.connector_actor_kind, p_service_principal_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  link_factory_id uuid;
  installation internal.connector_installations;
  linked internal.connector_actor_links;
begin
  if p_actor_kind is null or (p_actor_kind = 'service') <> (p_service_principal_id is not null) then
    raise exception 'Connector actor does not match its identity type.' using errcode = '22023';
  end if;

  if p_actor_kind = 'service' then
    actor_member_id := internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
    link_factory_id := p_factory_id;
    perform 1 from public.service_principals principal
    where (principal.workspace_id, principal.factory_id, principal.id) =
      (p_workspace_id, p_factory_id, p_service_principal_id)
    for share;
    if not found then
      raise exception 'Connector service principal is unavailable.' using errcode = '42501';
    end if;
  else
    select member.id into actor_member_id from public.workspace_members member
    where member.workspace_id = p_workspace_id and member.user_id = p_actor_user_id
      and member.kind = 'human' and member.is_active;
    if not found then
      raise exception 'Connector identity requires an active human.' using errcode = '42501';
    end if;
    perform internal.assert_session_mutation_human_access(p_workspace_id, p_factory_id, actor_member_id);
  end if;
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select target.* into installation from internal.connector_installations target
  where (target.workspace_id, target.id, target.provider, target.external_tenant_id) =
    (p_workspace_id, p_installation_id, p_provider, p_external_tenant_id)
  for update;
  if not found then
    raise exception 'Connector identity scope is unavailable.' using errcode = '42501';
  end if;
  if installation.generation is distinct from p_installation_generation then
    raise exception 'Connector installation changed.' using errcode = 'PT409';
  end if;
  perform internal.lock_connector_authority(installation, p_factory_id, null);
  if not internal.connector_installation_is_available(installation) then
    raise exception 'Connector identity scope is unavailable.' using errcode = '42501';
  end if;

  select target.* into linked from internal.connector_actor_links target
  where target.installation_id = installation.id and target.external_actor_id = p_external_actor_id
    and target.actor_kind = p_actor_kind and target.factory_id is not distinct from link_factory_id
    and target.revoked_at is null
  for share;
  if found then
    if (linked.member_id, linked.service_principal_id) is distinct from (
      case when p_actor_kind = 'human' then actor_member_id end, p_service_principal_id
    ) then
      raise exception 'Connector actor is already linked.' using errcode = 'PT409';
    end if;
    return linked.id;
  end if;

  insert into internal.connector_actor_links (
    workspace_id, factory_id, installation_id, provider, external_tenant_id, external_actor_id,
    actor_kind, member_id, service_principal_id, verified_by_member_id
  ) values (
    p_workspace_id, link_factory_id, installation.id, p_provider, p_external_tenant_id, p_external_actor_id,
    p_actor_kind, case when p_actor_kind = 'human' then actor_member_id end, p_service_principal_id, actor_member_id
  ) returning * into linked;
  return linked.id;
exception when check_violation or not_null_violation then
  raise exception 'Connector actor identity is invalid.' using errcode = '22023';
end;
$$;

create function public.revoke_connector_actor_link(
  p_workspace_id uuid, p_actor_user_id uuid, p_link_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  actor public.workspace_members;
  linked internal.connector_actor_links;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  select member.* into actor from public.workspace_members member
  where member.workspace_id = p_workspace_id and member.user_id = p_actor_user_id
    and member.kind = 'human' and member.is_active
  for share;
  if not found then
    raise exception 'Connector identity revocation requires an active human.' using errcode = '42501';
  end if;

  select target.* into linked from internal.connector_actor_links target
  where (target.workspace_id, target.id) = (p_workspace_id, p_link_id)
  for update;
  if not found then
    raise exception 'Connector actor link is unavailable.' using errcode = 'P0002';
  end if;
  if linked.member_id is distinct from actor.id and actor.role not in ('owner', 'admin') then
    raise exception 'Connector actor link revocation is not authorized.' using errcode = '42501';
  end if;
  if linked.revoked_at is not null then return false; end if;

  update internal.connector_actor_links target set revoked_at = clock_timestamp(), revoked_by_member_id = actor.id
  where target.id = linked.id;
  return true;
end;
$$;

create function internal.require_scoped_connector_actor(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_installation_generation bigint,
  p_mapping_revision bigint, p_provider public.connector_provider, p_external_tenant_id text,
  p_external_actor_id text, p_actor_kind public.connector_actor_kind
) returns internal.connector_actor_links language plpgsql set search_path = '' as $$
declare
  resource public.factory_connector_resources;
  installation internal.connector_installations;
  linked internal.connector_actor_links;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select target.* into installation
  from public.factory_connector_resources mapped
  join internal.connector_installations target
    on (target.workspace_id, target.id, target.provider, target.external_tenant_id) =
      (mapped.workspace_id, mapped.installation_id, mapped.provider, mapped.external_tenant_id)
  where (mapped.workspace_id, mapped.factory_id, mapped.id, mapped.provider, mapped.external_tenant_id) =
    (p_workspace_id, p_factory_id, p_resource_id, p_provider, p_external_tenant_id)
  for share of target;
  if not found then
    raise exception 'Connector actor scope is unavailable.' using errcode = '42501';
  end if;

  select mapped.* into resource from public.factory_connector_resources mapped
  where (mapped.workspace_id, mapped.factory_id, mapped.id) = (p_workspace_id, p_factory_id, p_resource_id);
  if (installation.generation, resource.current_revision) is distinct from (p_installation_generation, p_mapping_revision) then
    raise exception 'Connector installation or mapping changed.' using errcode = 'PT409';
  end if;

  perform internal.lock_connector_authority(installation, p_factory_id, resource.external_resource_id);
  if not exists (
    select 1 from public.read_connector_subscription(p_workspace_id, p_factory_id, p_resource_id)
  ) then
    raise exception 'Connector actor scope is unavailable.' using errcode = '42501';
  end if;

  select target.* into linked from internal.connector_actor_links target
  where target.installation_id = installation.id and target.external_actor_id = p_external_actor_id
    and target.actor_kind = p_actor_kind and target.revoked_at is null
    and target.factory_id is not distinct from (case when p_actor_kind = 'service' then p_factory_id end)
  for share;
  if not found then
    raise exception 'Connector actor has no verified identity link.' using errcode = '42501';
  end if;
  if linked.actor_kind = 'human' then
    perform internal.assert_factory_grant_invoker(p_workspace_id, p_factory_id, linked.member_id);
  end if;
  return linked;
end;
$$;

create function public.resolve_connector_event_authority(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_installation_generation bigint,
  p_mapping_revision bigint, p_provider public.connector_provider, p_external_tenant_id text,
  p_external_actor_id text, p_actor_kind public.connector_actor_kind, p_execution_grant_id uuid,
  p_execution_grant_version bigint
) returns table (
  actor_link_id uuid, actor_kind public.connector_actor_kind, initiating_member_id uuid,
  initiating_service_principal_id uuid, execution_grant_id uuid, execution_grant_version bigint,
  service_principal_id uuid, budget_payer_member_id uuid
) language plpgsql security definer set search_path = '' as $$
declare
  linked internal.connector_actor_links;
  approved public.factory_execution_grants;
begin
  linked := internal.require_scoped_connector_actor(
    p_workspace_id, p_factory_id, p_resource_id, p_installation_generation, p_mapping_revision,
    p_provider, p_external_tenant_id, p_external_actor_id, p_actor_kind
  );
  approved := internal.require_factory_machine_grant(
    p_workspace_id, p_factory_id, p_execution_grant_id, p_execution_grant_version
  );
  if not ('sessions:create' = any(approved.command_scopes))
    or (linked.actor_kind = 'service' and linked.service_principal_id <> approved.service_principal_id) then
    raise exception 'Connector actor has no matching execution authority.' using errcode = '42501';
  end if;
  if p_provider = 'github' and not exists (
    select 1 from public.factory_connector_resources resource
    join public.github_repositories repository
      on (repository.workspace_id, repository.factory_id, repository.id) =
        (resource.workspace_id, resource.factory_id, approved.github_repository_id)
      and repository.repo_id::text = resource.external_resource_id
    where (resource.workspace_id, resource.factory_id, resource.id) = (p_workspace_id, p_factory_id, p_resource_id)
  ) then
    raise exception 'Connector execution does not match the GitHub repository.' using errcode = '42501';
  end if;

  return query select linked.id, linked.actor_kind, linked.member_id, linked.service_principal_id,
    approved.id, approved.version, approved.service_principal_id, approved.budget_payer_member_id;
end;
$$;

create function public.resolve_connector_review_actor(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_installation_generation bigint,
  p_mapping_revision bigint, p_provider public.connector_provider, p_external_tenant_id text,
  p_external_actor_id text, p_actor_kind public.connector_actor_kind
) returns uuid language plpgsql security definer set search_path = '' as $$
declare linked internal.connector_actor_links;
begin
  if p_actor_kind is distinct from 'human'::public.connector_actor_kind then
    raise exception 'Connector review requires a verified human identity.' using errcode = '42501';
  end if;
  linked := internal.require_scoped_connector_actor(
    p_workspace_id, p_factory_id, p_resource_id, p_installation_generation, p_mapping_revision,
    p_provider, p_external_tenant_id, p_external_actor_id, p_actor_kind
  );
  return linked.member_id;
end;
$$;

revoke all on function internal.require_scoped_connector_actor(uuid, uuid, uuid, bigint, bigint, public.connector_provider,
  text, text, public.connector_actor_kind) from public, anon, authenticated, service_role;

revoke all on function public.link_connector_actor(uuid, uuid, uuid, uuid, bigint, public.connector_provider,
    text, text, public.connector_actor_kind, uuid),
  public.revoke_connector_actor_link(uuid, uuid, uuid),
  public.resolve_connector_event_authority(uuid, uuid, uuid, bigint, bigint, public.connector_provider,
    text, text, public.connector_actor_kind, uuid, bigint),
  public.resolve_connector_review_actor(uuid, uuid, uuid, bigint, bigint, public.connector_provider,
    text, text, public.connector_actor_kind)
  from public, anon, authenticated, service_role;

grant execute on function public.link_connector_actor(uuid, uuid, uuid, uuid, bigint, public.connector_provider,
    text, text, public.connector_actor_kind, uuid),
  public.revoke_connector_actor_link(uuid, uuid, uuid),
  public.resolve_connector_event_authority(uuid, uuid, uuid, bigint, bigint, public.connector_provider,
    text, text, public.connector_actor_kind, uuid, bigint),
  public.resolve_connector_review_actor(uuid, uuid, uuid, bigint, bigint, public.connector_provider,
    text, text, public.connector_actor_kind)
  to service_role;
