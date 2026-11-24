alter table public.factory_connector_resources
  drop constraint factory_connector_resources_check,
  add constraint factory_connector_resources_provider_kind_check check (
    (provider = 'github' and resource_kind = 'repository')
    or (provider = 'linear' and resource_kind in ('team', 'project'))
    or (provider = 'slack' and resource_kind = 'channel'
      and external_resource_id ~ '^[CG][A-Z0-9]{2,63}$')
  );

-- The installation row owns scope and generation. This private record carries only
-- Slack metadata and the current credential. Disconnect scrubs the credential in place.
create table internal.slack_connector_credentials (
  installation_id uuid primary key references internal.connector_installations(id) on delete cascade,
  credential_id uuid unique,
  team_name text not null check (length(team_name) between 1 and 256 and team_name !~ '[[:cntrl:]]'),
  bot_user_id text not null check (bot_user_id ~ '^[UW][A-Z0-9]{2,63}$'),
  encrypted_token text check (length(encrypted_token) <= 16384
    and encrypted_token ~ '^v2[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'),
  granted_scopes text[] not null check (cardinality(granted_scopes) <= 128),
  check ((credential_id is null) = (encrypted_token is null))
);

create table internal.slack_connector_oauth_states (
  state_digest text primary key check (state_digest ~ '^[a-f0-9]{64}$'),
  workspace_id uuid not null,
  factory_id uuid not null,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('install', 'link')),
  team_id text not null check (team_id ~ '^T[A-Z0-9]{2,63}$'),
  installation_id uuid references internal.connector_installations(id) on delete cascade,
  expected_generation bigint not null check (expected_generation between 0 and 9007199254740991),
  expires_at timestamptz not null default (clock_timestamp() + interval '10 minutes'),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  check ((purpose = 'link') = (installation_id is not null))
);

create index slack_connector_oauth_scope_idx
  on internal.slack_connector_oauth_states(workspace_id, factory_id, actor_user_id, expires_at);
create index slack_connector_oauth_actor_idx
  on internal.slack_connector_oauth_states(actor_user_id);
create index slack_connector_oauth_installation_idx
  on internal.slack_connector_oauth_states(installation_id) where installation_id is not null;

alter table internal.slack_connector_credentials enable row level security;
alter table internal.slack_connector_oauth_states enable row level security;
revoke all on internal.slack_connector_credentials, internal.slack_connector_oauth_states
  from public, anon, authenticated, service_role;

create unique index connector_slack_one_active_identity_per_member
  on internal.connector_actor_links(installation_id, member_id)
  where provider = 'slack' and actor_kind = 'human' and revoked_at is null;

create or replace function internal.connector_installation_is_available(p_installation internal.connector_installations)
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
    when 'slack' then exists (
      select 1 from internal.slack_connector_credentials credential
      where (credential.installation_id, credential.credential_id) =
        (p_installation.id, p_installation.legacy_credential_id) and credential.encrypted_token is not null
    )
  end
$$;

create or replace function internal.lock_connector_authority(
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
  elsif p_installation.provider = 'slack' then
    perform 1 from internal.slack_connector_credentials credential
    where (credential.installation_id, credential.credential_id) =
      (p_installation.id, p_installation.legacy_credential_id)
    for share;
  end if;
end;
$$;

create or replace function public.disconnect_connector_installation(
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
    if installation.provider = 'slack' then
      update internal.slack_connector_credentials credential
      set credential_id = null, encrypted_token = null
      where credential.installation_id = installation.id;
    end if;
    update internal.connector_installations target
    set generation = target.generation + 1, legacy_credential_id = null, linear_material_revision = null,
      disconnected_at = clock_timestamp(), updated_at = clock_timestamp()
    where target.id = installation.id returning target.generation into installation.generation;
  end if;
  return installation.generation;
end;
$$;

create or replace function public.read_connector_subscription(
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
      when 'slack' then 'slack_bot'
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

create function internal.assert_slack_connector_human(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns uuid language plpgsql set search_path = '' as $$
declare actor_member_id uuid;
begin
  select member.id into actor_member_id from public.workspace_members member
  where member.workspace_id = p_workspace_id and member.user_id = p_actor_user_id
    and member.kind = 'human' and member.is_active;
  if not found then
    raise exception 'Slack connector access requires an active human.' using errcode = '42501';
  end if;
  perform internal.assert_session_mutation_human_access(p_workspace_id, p_factory_id, actor_member_id);
  return actor_member_id;
end;
$$;
revoke all on function internal.assert_slack_connector_human(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

create function public.start_slack_connector_oauth(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_state_digest text, p_purpose text,
  p_team_id text, p_expected_generation bigint, p_installation_id uuid default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  installation internal.connector_installations;
  actor_member_id uuid;
begin
  if p_state_digest is null or p_state_digest !~ '^[a-f0-9]{64}$'
    or p_team_id is null or p_team_id !~ '^T[A-Z0-9]{2,63}$'
    or p_purpose is null or p_purpose not in ('install', 'link')
    or (p_purpose = 'link') <> (p_installation_id is not null) then
    raise exception 'Slack connector authorization is invalid.' using errcode = '22023';
  end if;
  if p_purpose = 'install' then
    perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  else
    actor_member_id := internal.assert_slack_connector_human(p_workspace_id, p_factory_id, p_actor_user_id);
  end if;
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select target.* into installation from internal.connector_installations target
  where (target.workspace_id, target.provider, target.external_tenant_id) =
    (p_workspace_id, 'slack', p_team_id)
    and (p_purpose = 'install' or (target.id = p_installation_id and (
      exists (select 1 from public.workspace_members member
        where (member.workspace_id, member.id) = (p_workspace_id, actor_member_id)
          and member.role in ('owner', 'admin'))
      or exists (select 1 from public.factory_connector_resources resource
        where (resource.workspace_id, resource.factory_id, resource.installation_id) =
          (p_workspace_id, p_factory_id, target.id))
    )))
  for share;
  if p_purpose = 'link' and installation.id is distinct from p_installation_id then
    raise exception 'Slack connector installation is unavailable.' using errcode = 'P0002';
  end if;
  if p_expected_generation is distinct from coalesce(installation.generation, 0) then
    raise exception 'Slack connector installation changed.' using errcode = 'PT409';
  end if;
  if p_purpose = 'link' and not internal.connector_installation_is_available(installation) then
    raise exception 'Slack connector installation is unavailable.' using errcode = 'P0002';
  end if;

  delete from internal.slack_connector_oauth_states prior
  where prior.state_digest in (
    select expired.state_digest from internal.slack_connector_oauth_states expired
    where (expired.workspace_id, expired.factory_id, expired.actor_user_id) =
      (p_workspace_id, p_factory_id, p_actor_user_id) and expired.expires_at <= clock_timestamp()
    order by expired.expires_at
    limit 32
  );
  insert into internal.slack_connector_oauth_states (
    state_digest, workspace_id, factory_id, actor_user_id, purpose, team_id, installation_id, expected_generation
  ) values (
    p_state_digest, p_workspace_id, p_factory_id, p_actor_user_id, p_purpose, p_team_id,
    p_installation_id, p_expected_generation
  );
  return true;
exception when unique_violation then
  raise exception 'Slack connector authorization is already in use.' using errcode = 'PT409';
end;
$$;

create function public.consume_slack_connector_oauth(p_state_digest text, p_actor_user_id uuid)
returns table (
  workspace_id uuid, factory_id uuid, purpose text, team_id text, installation_id uuid, expected_generation bigint
) language sql security definer set search_path = '' as $$
  delete from internal.slack_connector_oauth_states state
  where (state.state_digest, state.actor_user_id) = (p_state_digest, p_actor_user_id)
    and state.expires_at > clock_timestamp()
  returning state.workspace_id, state.factory_id, state.purpose, state.team_id,
    state.installation_id, state.expected_generation
$$;

create function public.configure_slack_connector_installation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_team_id text, p_team_name text,
  p_app_id text, p_bot_user_id text, p_expected_generation bigint, p_encrypted_token text, p_granted_scopes text[]
) returns table (installation_id uuid, generation bigint)
language plpgsql security definer set search_path = '' as $$
declare
  installation internal.connector_installations;
  next_credential_id uuid := gen_random_uuid();
  granted_scopes text[];
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_team_id is null or p_team_id !~ '^T[A-Z0-9]{2,63}$'
    or p_app_id is null or p_app_id !~ '^A[A-Z0-9]{2,63}$'
    or p_encrypted_token is null or p_granted_scopes is null or cardinality(p_granted_scopes) > 128
    or coalesce(array_ndims(p_granted_scopes), 1) <> 1
    or exists (select 1 from unnest(p_granted_scopes) scope
      where scope is null or scope !~ '^[a-z][a-z0-9_.:-]{0,127}$') then
    raise exception 'Slack connector credential is invalid.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct scope order by scope), array[]::text[]) into granted_scopes
  from unnest(p_granted_scopes) scope;

  select target.* into installation from internal.connector_installations target
  where (target.workspace_id, target.provider, target.external_tenant_id) = (p_workspace_id, 'slack', p_team_id)
  for update;
  if exists (
    select 1 from internal.connector_installations claimed
    where (claimed.provider, claimed.external_tenant_id, claimed.external_installation_id) = ('slack', p_team_id, p_app_id)
      and claimed.workspace_id <> p_workspace_id
  ) then
    raise exception 'Slack connector installation is unavailable.' using errcode = 'P0002';
  end if;
  if p_expected_generation is distinct from coalesce(installation.generation, 0) then
    raise exception 'Slack connector installation changed.' using errcode = 'PT409';
  end if;
  if installation.external_installation_id <> p_app_id
    and internal.connector_installation_is_available(installation) then
    raise exception 'Disconnect the current Slack connector installation before replacement.' using errcode = 'PT409';
  end if;

  if installation.id is null then
    insert into internal.connector_installations as target (
      workspace_id, provider, external_tenant_id, external_installation_id, generation, legacy_credential_id
    ) values (p_workspace_id, 'slack', p_team_id, p_app_id, 1, next_credential_id)
    returning target.id, target.generation into installation_id, generation;
  else
    update internal.connector_installations target
    set external_installation_id = p_app_id, generation = target.generation + 1,
      legacy_credential_id = next_credential_id, disconnected_at = null, updated_at = clock_timestamp()
    where target.id = installation.id returning target.id, target.generation into installation_id, generation;
  end if;
  insert into internal.slack_connector_credentials (
    installation_id, credential_id, team_name, bot_user_id, encrypted_token, granted_scopes
  ) values (
    installation_id, next_credential_id, btrim(p_team_name), p_bot_user_id, p_encrypted_token, granted_scopes
  )
  on conflict on constraint slack_connector_credentials_pkey do update set
    credential_id = excluded.credential_id, team_name = excluded.team_name, bot_user_id = excluded.bot_user_id,
    encrypted_token = excluded.encrypted_token, granted_scopes = excluded.granted_scopes;
  return next;
exception when unique_violation then
  raise exception 'Slack connector installation is already claimed.' using errcode = 'PT409';
when check_violation or not_null_violation then
  raise exception 'Slack connector credential is invalid.' using errcode = '22023';
end;
$$;

create function public.read_slack_connector_setup(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns table (
  installation_id uuid, team_id text, team_name text, app_id text, generation bigint, status text,
  granted_scopes text[], actor_link_id uuid, actor_user_id text
) language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  workspace_admin boolean;
begin
  actor_member_id := internal.assert_slack_connector_human(p_workspace_id, p_factory_id, p_actor_user_id);
  select member.role in ('owner', 'admin') into strict workspace_admin from public.workspace_members member
  where (member.workspace_id, member.id) = (p_workspace_id, actor_member_id);
  return query
    select installation.id, installation.external_tenant_id,
      coalesce(credential.team_name, installation.external_tenant_id), installation.external_installation_id,
      installation.generation, case
        when installation.disconnected_at is not null then 'disconnected'
        when internal.connector_installation_is_available(installation) then 'connected'
        else 'credential_unavailable'
      end, coalesce(credential.granted_scopes, array[]::text[]), own_link.id, own_link.external_actor_id
    from internal.connector_installations installation
    left join internal.slack_connector_credentials credential on credential.installation_id = installation.id
    left join internal.connector_actor_links own_link
      on (own_link.installation_id, own_link.member_id) = (installation.id, actor_member_id)
      and own_link.provider = 'slack' and own_link.actor_kind = 'human' and own_link.revoked_at is null
    where installation.workspace_id = p_workspace_id and installation.provider = 'slack'
      and (workspace_admin or own_link.id is not null or exists (
        select 1 from public.factory_connector_resources resource
        where (resource.workspace_id, resource.factory_id, resource.installation_id) =
          (p_workspace_id, p_factory_id, installation.id)
      ))
    order by installation.external_tenant_id;
end;
$$;

create function public.read_slack_connector_credential(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_installation_id uuid, p_expected_generation bigint
) returns table (team_id text, app_id text, bot_user_id text, encrypted_token text, granted_scopes text[])
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_factory_secret_binding_owner(p_workspace_id, p_factory_id, p_actor_user_id);
  return query
    select installation.external_tenant_id, installation.external_installation_id,
      credential.bot_user_id, credential.encrypted_token, credential.granted_scopes
    from internal.connector_installations installation
    join internal.slack_connector_credentials credential
      on (credential.installation_id, credential.credential_id) = (installation.id, installation.legacy_credential_id)
    join public.workspaces workspace on workspace.id = installation.workspace_id
    join public.factories factory on (factory.workspace_id, factory.id) = (installation.workspace_id, p_factory_id)
    where (installation.workspace_id, installation.id, installation.generation) =
      (p_workspace_id, p_installation_id, p_expected_generation)
      and installation.provider = 'slack' and installation.disconnected_at is null
      and credential.encrypted_token is not null
      and workspace.deletion_requested_at is null and factory.status = 'active';
end;
$$;

revoke all on function public.start_slack_connector_oauth(uuid,uuid,uuid,text,text,text,bigint,uuid),
  public.consume_slack_connector_oauth(text,uuid),
  public.configure_slack_connector_installation(uuid,uuid,uuid,text,text,text,text,bigint,text,text[]),
  public.read_slack_connector_setup(uuid,uuid,uuid),
  public.read_slack_connector_credential(uuid,uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role;

grant execute on function public.start_slack_connector_oauth(uuid,uuid,uuid,text,text,text,bigint,uuid),
  public.consume_slack_connector_oauth(text,uuid),
  public.configure_slack_connector_installation(uuid,uuid,uuid,text,text,text,text,bigint,text,text[]),
  public.read_slack_connector_setup(uuid,uuid,uuid),
  public.read_slack_connector_credential(uuid,uuid,uuid,uuid,bigint)
  to service_role;
