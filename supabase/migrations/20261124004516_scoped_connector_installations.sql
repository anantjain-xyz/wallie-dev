create type public.connector_provider as enum ('github', 'linear');
create type public.connector_resource_kind as enum ('repository', 'team', 'project');

create table internal.connector_installations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider public.connector_provider not null,
  external_tenant_id text not null check (
    length(external_tenant_id) between 1 and 192 and external_tenant_id !~ '[[:space:][:cntrl:]]'
  ),
  external_installation_id text not null check (
    length(external_installation_id) between 1 and 192 and external_installation_id !~ '[[:space:][:cntrl:]]'
  ),
  generation bigint not null check (generation between 1 and 9007199254740991),
  legacy_credential_id uuid,
  linear_material_revision bigint,
  disconnected_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, provider, external_tenant_id),
  unique (provider, external_tenant_id, external_installation_id),
  unique (workspace_id, id, provider, external_tenant_id),
  check (
    (disconnected_at is not null and legacy_credential_id is null and linear_material_revision is null)
    or (disconnected_at is null and legacy_credential_id is not null
      and ((provider = 'linear') = (linear_material_revision is not null)))
  )
);

create unique index connector_installations_legacy_credential_idx
  on internal.connector_installations(provider, legacy_credential_id) where legacy_credential_id is not null;

create table public.factory_connector_resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  installation_id uuid not null,
  provider public.connector_provider not null,
  external_tenant_id text not null,
  resource_kind public.connector_resource_kind not null,
  external_resource_id text not null check (
    length(external_resource_id) between 1 and 256 and external_resource_id !~ '[[:space:][:cntrl:]]'
  ),
  current_revision bigint not null check (current_revision between 1 and 9007199254740991),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (provider, external_tenant_id, resource_kind, external_resource_id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  foreign key (workspace_id, installation_id, provider, external_tenant_id)
    references internal.connector_installations(workspace_id, id, provider, external_tenant_id) on delete cascade,
  check ((provider = 'github' and resource_kind = 'repository')
    or (provider = 'linear' and resource_kind in ('team', 'project')))
);

create index factory_connector_resources_installation_idx
  on public.factory_connector_resources(workspace_id, installation_id, provider, external_tenant_id);

create table public.factory_connector_mapping_revisions (
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  enabled boolean not null,
  created_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, resource_id, revision),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade
);

alter table public.factory_connector_resources add constraint factory_connector_current_revision_fk
  foreign key (workspace_id, factory_id, id, current_revision)
  references public.factory_connector_mapping_revisions(workspace_id, factory_id, resource_id, revision)
  deferrable initially deferred;

create trigger preserve_factory_connector_mapping_revisions before update or delete
  on public.factory_connector_mapping_revisions
  for each row execute function internal.preserve_factory_definition_history();

create table internal.connector_subscription_cursors (
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  stream text not null check (stream ~ '^[a-z][a-z0-9_-]{0,63}$'),
  generation bigint not null check (generation between 1 and 9007199254740991),
  position text check (length(position) between 1 and 4096 and position !~ '[[:cntrl:]]'),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, resource_id, stream),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade
);

alter table internal.connector_installations enable row level security;
alter table internal.connector_subscription_cursors enable row level security;
alter table public.factory_connector_resources enable row level security;
alter table public.factory_connector_mapping_revisions enable row level security;

revoke all on internal.connector_installations, internal.connector_subscription_cursors,
  public.factory_connector_resources, public.factory_connector_mapping_revisions
  from public, anon, authenticated, service_role;

grant select on public.factory_connector_resources, public.factory_connector_mapping_revisions
  to authenticated, service_role;

create policy factory_connector_resources_read on public.factory_connector_resources
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));

create policy factory_connector_mapping_revisions_read on public.factory_connector_mapping_revisions
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));

-- Provider setup calls after verifying the upstream installation and tenant.
-- Workspace owner/admin authorization matches the existing integration settings.
create function public.configure_connector_installation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_provider public.connector_provider,
  p_external_tenant_id text, p_external_installation_id text, p_expected_generation bigint,
  p_linear_secret_id uuid default null, p_linear_material_revision bigint default null
) returns table (installation_id uuid, generation bigint)
language plpgsql security definer set search_path = '' as $$
declare
  installation internal.connector_installations;
  credential_id uuid;
  material_revision bigint;
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select target.* into installation
  from internal.connector_installations target
  where (target.workspace_id, target.provider, target.external_tenant_id) =
    (p_workspace_id, p_provider, p_external_tenant_id)
  for update;
  if exists (
    select 1 from internal.connector_installations claimed
    where (claimed.provider, claimed.external_tenant_id, claimed.external_installation_id) =
      (p_provider, p_external_tenant_id, p_external_installation_id) and claimed.workspace_id <> p_workspace_id
  ) then
    raise exception 'Connector installation is unavailable.' using errcode = 'P0002';
  end if;
  if p_expected_generation is distinct from coalesce(installation.generation, 0) then
    raise exception 'Connector installation changed.' using errcode = 'PT409';
  end if;
  if installation.external_installation_id <> p_external_installation_id
    and internal.connector_installation_is_available(installation) then
    raise exception 'Disconnect the current connector installation before replacement.' using errcode = 'PT409';
  end if;

  if p_provider is null
    or num_nonnulls(p_linear_secret_id, p_linear_material_revision) <>
      (case when p_provider = 'linear' then 2 else 0 end) then
    raise exception 'Connector credential does not match its provider.' using errcode = '22023';
  end if;
  if p_provider = 'github' then
    select github.id into credential_id
    from public.github_installations github
    where github.workspace_id = p_workspace_id and github.installation_id::text = p_external_installation_id
      and not github.suspended
    for share;
    if not found then
      raise exception 'GitHub installation is unavailable.' using errcode = 'P0002';
    end if;
  elsif p_provider = 'linear' then
    select secret.id, secret.material_revision into credential_id, material_revision
    from public.workspace_secrets secret
    where secret.workspace_id = p_workspace_id and secret.key = 'LINEAR_API_KEY'
    for share;
    if (credential_id, material_revision) is distinct from (p_linear_secret_id, p_linear_material_revision) then
      raise exception 'Verified Linear credential changed.' using errcode = 'PT409';
    end if;
  end if;

  if installation.id is null then
    insert into internal.connector_installations as target (
      workspace_id, provider, external_tenant_id, external_installation_id, generation,
      legacy_credential_id, linear_material_revision
    ) values (
      p_workspace_id, p_provider, p_external_tenant_id, p_external_installation_id, 1,
      credential_id, material_revision
    ) returning target.id, target.generation into installation_id, generation;
  else
    update internal.connector_installations target set generation = target.generation + 1,
      external_installation_id = p_external_installation_id,
      legacy_credential_id = credential_id, linear_material_revision = material_revision,
      disconnected_at = null, updated_at = clock_timestamp()
    where target.id = installation.id returning target.id, target.generation into installation_id, generation;
  end if;
  return next;
exception when unique_violation then
  raise exception 'Connector installation or credential is already claimed.' using errcode = 'PT409';
when check_violation then
  raise exception 'Connector installation or credential is invalid.' using errcode = '22023';
end;
$$;

create function public.disconnect_connector_installation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_installation_id uuid, p_expected_generation bigint
) returns bigint language plpgsql security definer set search_path = '' as $$
declare installation internal.connector_installations;
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);

  select target.* into installation from internal.connector_installations target
  where (target.workspace_id, target.id) = (p_workspace_id, p_installation_id)
  for update;
  if not found then
    raise exception 'Connector installation is unavailable.' using errcode = 'P0002';
  end if;
  if installation.generation is distinct from p_expected_generation then
    raise exception 'Connector installation changed.' using errcode = 'PT409';
  end if;
  if installation.disconnected_at is null then
    update internal.connector_installations target
    set generation = target.generation + 1, legacy_credential_id = null, linear_material_revision = null,
      disconnected_at = clock_timestamp(), updated_at = clock_timestamp()
    where target.id = installation.id returning target.generation into installation.generation;
  end if;
  return installation.generation;
end;
$$;

create function internal.connector_installation_is_available(p_installation internal.connector_installations)
returns boolean language sql stable set search_path = '' as $$
  select p_installation.disconnected_at is null and case p_installation.provider
    when 'github' then exists (
      select 1 from public.github_installations github
      where (github.workspace_id, github.id) = (p_installation.workspace_id, p_installation.legacy_credential_id)
        and github.installation_id::text = p_installation.external_installation_id and not github.suspended
    )
    when 'linear' then exists (
      select 1 from public.workspace_secrets secret
      where (secret.workspace_id, secret.id, secret.material_revision) =
        (p_installation.workspace_id, p_installation.legacy_credential_id, p_installation.linear_material_revision)
        and secret.key = 'LINEAR_API_KEY'
    )
  end
$$;

create function internal.connector_repository_is_available(
  p_installation internal.connector_installations, p_factory_id uuid, p_external_resource_id text
) returns boolean language sql stable set search_path = '' as $$
  select p_installation.provider <> 'github' or exists (
    select 1 from public.github_repositories repository
    where (repository.workspace_id, repository.factory_id, repository.github_installation_id) =
      (p_installation.workspace_id, p_factory_id, p_installation.legacy_credential_id)
      and repository.repo_id::text = p_external_resource_id and not repository.is_archived
  )
$$;

-- Writers hold the connector installation before locking its native authority.
create function internal.lock_connector_authority(
  p_installation internal.connector_installations, p_factory_id uuid, p_external_resource_id text
) returns void language plpgsql set search_path = '' as $$
begin
  if p_installation.provider = 'github' then
    perform 1 from public.github_installations github
    where (github.workspace_id, github.id) = (p_installation.workspace_id, p_installation.legacy_credential_id)
    for share;
    perform 1 from public.github_repositories repository
    where (repository.workspace_id, repository.factory_id, repository.github_installation_id) =
      (p_installation.workspace_id, p_factory_id, p_installation.legacy_credential_id)
      and repository.repo_id::text = p_external_resource_id
    for share;
  elsif p_installation.provider = 'linear' then
    perform 1 from public.workspace_secrets secret
    where (secret.workspace_id, secret.id) = (p_installation.workspace_id, p_installation.legacy_credential_id)
    for share;
  end if;
end;
$$;

create function public.read_connector_installation_state(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_installation_id uuid
) returns table (
  installation_id uuid, provider public.connector_provider, external_tenant_id text,
  external_installation_id text, generation bigint, status text
) language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  return query
    select installation.id, installation.provider, installation.external_tenant_id,
      installation.external_installation_id, installation.generation, case
        when installation.disconnected_at is not null then 'disconnected'
        when internal.connector_installation_is_available(installation) then 'connected'
        else 'credential_unavailable'
      end
    from internal.connector_installations installation
    where (installation.workspace_id, installation.id) = (p_workspace_id, p_installation_id);
end;
$$;

-- Provider setup confirms access to an exact resource before it is enabled.
-- The stable resource has a single factory owner over its entire history.
create function public.publish_connector_resource_mapping(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_installation_id uuid,
  p_expected_installation_generation bigint, p_resource_kind public.connector_resource_kind,
  p_external_resource_id text, p_expected_revision bigint, p_enabled boolean
) returns table (resource_id uuid, revision bigint)
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  installation internal.connector_installations;
  resource public.factory_connector_resources;
begin
  actor_member_id := internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  if p_enabled then
    perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  end if;
  select target.* into installation from internal.connector_installations target
  where (target.workspace_id, target.id) = (p_workspace_id, p_installation_id)
  for update;
  if not found then
    raise exception 'Connector installation is unavailable.' using errcode = 'P0002';
  end if;
  if installation.generation is distinct from p_expected_installation_generation then
    raise exception 'Connector installation changed.' using errcode = 'PT409';
  end if;

  select target.* into resource from public.factory_connector_resources target
  where (target.provider, target.external_tenant_id, target.resource_kind, target.external_resource_id) =
    (installation.provider, installation.external_tenant_id, p_resource_kind, p_external_resource_id);
  if resource.id is not null and (resource.workspace_id, resource.factory_id, resource.installation_id) <>
    (p_workspace_id, p_factory_id, p_installation_id) then
    raise exception 'Connector resource is unavailable.' using errcode = 'P0002';
  end if;
  if p_expected_revision is distinct from coalesce(resource.current_revision, 0) then
    raise exception 'Connector mapping changed.' using errcode = 'PT409';
  end if;
  if p_enabled or resource.id is null then
    perform internal.lock_connector_authority(installation, p_factory_id, p_external_resource_id);
    if not internal.connector_installation_is_available(installation)
      or not internal.connector_repository_is_available(installation, p_factory_id, p_external_resource_id) then
      raise exception 'Connector resource is unavailable.' using errcode = 'P0002';
    end if;
  end if;

  resource_id := coalesce(resource.id, gen_random_uuid());
  revision := coalesce(resource.current_revision, 0) + 1;
  if resource.id is null then
    insert into public.factory_connector_resources (
      id, workspace_id, factory_id, installation_id, provider, external_tenant_id,
      resource_kind, external_resource_id, current_revision
    ) values (
      resource_id, p_workspace_id, p_factory_id, p_installation_id, installation.provider, installation.external_tenant_id,
      p_resource_kind, p_external_resource_id, revision
    );
  else
    update public.factory_connector_resources target set current_revision = revision where target.id = resource_id;
  end if;
  insert into public.factory_connector_mapping_revisions (
    workspace_id, factory_id, resource_id, revision, enabled, created_by_member_id
  ) values (p_workspace_id, p_factory_id, resource_id, revision, p_enabled, actor_member_id);
  return next;
exception when unique_violation then
  raise exception 'Connector resource is already claimed.' using errcode = 'PT409';
when check_violation then
  raise exception 'Connector resource is invalid.' using errcode = '22023';
end;
$$;

create function public.read_connector_subscription(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_stream text default 'intake'
) returns table (
  installation_id uuid, installation_generation bigint, mapping_revision bigint,
  cursor_generation bigint, cursor_position text, credential_kind text, credential_ref uuid,
  credential_material_revision bigint
) language sql stable security definer set search_path = '' as $$
  select installation.id, installation.generation, mapping.revision, coalesce(cursor_state.generation, 0),
    cursor_state.position, case installation.provider
      when 'github' then 'github_installation'
      when 'linear' then 'workspace_secret'
    end,
    installation.legacy_credential_id, installation.linear_material_revision
  from public.factory_connector_resources resource
  join public.factory_connector_mapping_revisions mapping
    on (mapping.workspace_id, mapping.factory_id, mapping.resource_id, mapping.revision) =
      (resource.workspace_id, resource.factory_id, resource.id, resource.current_revision)
  join internal.connector_installations installation
    on (installation.workspace_id, installation.id) = (resource.workspace_id, resource.installation_id)
  join public.workspaces workspace on workspace.id = resource.workspace_id
  join public.factories factory
    on (factory.workspace_id, factory.id) = (resource.workspace_id, resource.factory_id)
  left join internal.connector_subscription_cursors cursor_state
    on (cursor_state.workspace_id, cursor_state.factory_id, cursor_state.resource_id, cursor_state.stream) =
      (resource.workspace_id, resource.factory_id, resource.id, p_stream)
  where (resource.workspace_id, resource.factory_id, resource.id) = (p_workspace_id, p_factory_id, p_resource_id)
    and p_stream ~ '^[a-z][a-z0-9_-]{0,63}$' and mapping.enabled
    and workspace.deletion_requested_at is null and factory.status = 'active'
    and internal.connector_installation_is_available(installation)
    and internal.connector_repository_is_available(installation, resource.factory_id, resource.external_resource_id)
$$;

create function public.advance_connector_subscription_cursor(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_installation_generation bigint,
  p_mapping_revision bigint, p_stream text, p_expected_generation bigint, p_position text
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  installation internal.connector_installations;
  resource public.factory_connector_resources;
  subscription record;
  next_generation bigint;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select target.* into installation
  from public.factory_connector_resources mapped
  join internal.connector_installations target
    on (target.workspace_id, target.id) = (mapped.workspace_id, mapped.installation_id)
  where (mapped.workspace_id, mapped.factory_id, mapped.id) = (p_workspace_id, p_factory_id, p_resource_id)
  for update of target;
  if not found then
    raise exception 'Connector subscription is unavailable.' using errcode = 'P0002';
  end if;
  if installation.generation is distinct from p_installation_generation then
    raise exception 'Connector installation changed.' using errcode = 'PT409';
  end if;
  select target.* into resource from public.factory_connector_resources target
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_resource_id);
  if resource.current_revision is distinct from p_mapping_revision then
    raise exception 'Connector mapping changed.' using errcode = 'PT409';
  end if;

  perform internal.lock_connector_authority(installation, p_factory_id, resource.external_resource_id);
  select * into subscription from public.read_connector_subscription(
    p_workspace_id, p_factory_id, p_resource_id, p_stream
  );
  if not found then
    raise exception 'Connector subscription is unavailable.' using errcode = 'P0002';
  end if;
  if subscription.cursor_generation is distinct from p_expected_generation then
    raise exception 'Connector cursor changed.' using errcode = 'PT409';
  end if;

  insert into internal.connector_subscription_cursors as cursor_state (
    workspace_id, factory_id, resource_id, stream, generation, position
  ) values (p_workspace_id, p_factory_id, p_resource_id, p_stream, p_expected_generation + 1, p_position)
  on conflict (workspace_id, factory_id, resource_id, stream) do update set
    generation = excluded.generation, position = excluded.position, updated_at = clock_timestamp()
  returning cursor_state.generation into next_generation;
  return next_generation;
end;
$$;

revoke all on function internal.connector_installation_is_available(internal.connector_installations),
  internal.connector_repository_is_available(internal.connector_installations, uuid, text),
  internal.lock_connector_authority(internal.connector_installations, uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function public.configure_connector_installation(uuid, uuid, uuid, public.connector_provider, text, text, bigint, uuid, bigint),
  public.disconnect_connector_installation(uuid, uuid, uuid, uuid, bigint),
  public.read_connector_installation_state(uuid, uuid, uuid, uuid),
  public.publish_connector_resource_mapping(uuid, uuid, uuid, uuid, bigint, public.connector_resource_kind, text, bigint, boolean),
  public.read_connector_subscription(uuid, uuid, uuid, text),
  public.advance_connector_subscription_cursor(uuid, uuid, uuid, bigint, bigint, text, bigint, text)
  from public, anon, authenticated, service_role;

grant execute on function public.configure_connector_installation(uuid, uuid, uuid, public.connector_provider, text, text, bigint, uuid, bigint),
  public.disconnect_connector_installation(uuid, uuid, uuid, uuid, bigint),
  public.read_connector_installation_state(uuid, uuid, uuid, uuid),
  public.publish_connector_resource_mapping(uuid, uuid, uuid, uuid, bigint, public.connector_resource_kind, text, bigint, boolean),
  public.read_connector_subscription(uuid, uuid, uuid, text),
  public.advance_connector_subscription_cursor(uuid, uuid, uuid, bigint, bigint, text, bigint, text)
  to service_role;
