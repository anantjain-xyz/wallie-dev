create table public.factory_context_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  -- A disconnected installation or removed repository must not erase history
  -- or silently reconnect a source to a different installation.
  repository_id uuid not null,
  github_installation_id uuid not null,
  upstream_repository_id bigint not null check (upstream_repository_id between 1 and 9007199254740991),
  grant_id uuid not null,
  grant_version bigint not null check (grant_version between 1 and 9007199254740991),
  file_path text not null check (
    octet_length(file_path) between 1 and 512
    and file_path = btrim(file_path)
    and file_path !~ '(^/|/$|//|[[:cntrl:]])'
    and file_path !~ '(^|/)[.]{1,2}(/|$)'
    and strpos(file_path, chr(92)) = 0
    and cardinality(string_to_array(file_path, '/')) <= 12
    and file_path ~* '[.](md|markdown|txt)$'
  ),
  status text not null default 'pending' check (
    status in ('pending', 'synced', 'stale', 'unavailable', 'access_revoked', 'upstream_deleted', 'deleted')
  ),
  current_revision_id uuid,
  upstream_revision text check (upstream_revision ~ '^[0-9a-f]{40}$'),
  upstream_updated_at timestamptz check (isfinite(upstream_updated_at)),
  last_successful_sync_at timestamptz,
  last_sync_attempt_at timestamptz,
  sync_lease_id uuid,
  sync_lease_expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  check ((sync_lease_id is null) = (sync_lease_expires_at is null)),
  check ((deleted_at is not null) = (status = 'deleted')),
  check (deleted_at is null or sync_lease_id is null),
  check ((last_successful_sync_at is null) = (upstream_revision is null)),
  check ((last_successful_sync_at is null) = (upstream_updated_at is null)),
  check ((status in ('synced', 'stale')) = (current_revision_id is not null)),
  check (current_revision_id is null or last_successful_sync_at is not null)
);
create unique index factory_context_sources_live_identity_idx
  on public.factory_context_sources (workspace_id, factory_id, upstream_repository_id, file_path)
  where deleted_at is null;

create table public.factory_context_source_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  source_id uuid not null,
  upstream_revision text not null check (upstream_revision ~ '^[0-9a-f]{40}$'),
  upstream_updated_at timestamptz not null check (isfinite(upstream_updated_at)),
  media_type text not null check (media_type in ('text/markdown', 'text/plain')),
  content text not null check (octet_length(content) <= 131072),
  content_bytes integer generated always as (octet_length(content)) stored,
  content_sha256 text generated always as (encode(extensions.digest(content, 'sha256'), 'hex')) stored,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, source_id, id),
  unique (workspace_id, factory_id, source_id, content_sha256),
  foreign key (workspace_id, factory_id, source_id)
    references public.factory_context_sources(workspace_id, factory_id, id) on delete cascade
);
alter table public.factory_context_sources add foreign key (workspace_id, factory_id, id, current_revision_id)
  references public.factory_context_source_revisions(workspace_id, factory_id, source_id, id);

alter table public.factory_context_sources enable row level security;
alter table public.factory_context_source_revisions enable row level security;
revoke all on public.factory_context_sources, public.factory_context_source_revisions
  from public, anon, authenticated, service_role;
grant select on public.factory_context_sources, public.factory_context_source_revisions to service_role;
grant select (
  id, workspace_id, factory_id, repository_id, github_installation_id, upstream_repository_id,
  grant_id, grant_version, file_path, status, current_revision_id, upstream_revision, upstream_updated_at,
  last_successful_sync_at, last_sync_attempt_at, deleted_at, created_at
) on public.factory_context_sources to authenticated;
create policy factory_context_sources_manager_read on public.factory_context_sources
  for select to authenticated using (internal.can_manage_factory(workspace_id, factory_id));

comment on column public.factory_context_source_revisions.content is
  'Untrusted external text. A fetched revision is data and must never supply trusted prompt instructions.';

create function internal.require_factory_context_connection(
  p_workspace_id uuid, p_factory_id uuid, p_grant_id uuid, p_grant_version bigint, p_repository_id uuid,
  p_installation_row_id uuid default null, p_upstream_repository_id bigint default null
) returns table (installation_row_id uuid, installation_id bigint, repository_id bigint, repository_full_name text)
language plpgsql set search_path = '' as $$
declare execution_grant public.factory_execution_grants;
begin
  select * into execution_grant from public.factory_execution_grants grant_row
  where (grant_row.workspace_id, grant_row.factory_id, grant_row.id) =
    (p_workspace_id, p_factory_id, p_grant_id);
  perform internal.require_current_factory_execution_grant(
    p_workspace_id, p_factory_id, p_grant_id, p_grant_version, execution_grant.github_repository_id,
    array[p_repository_id], '{}'::text[], execution_grant.execution_policy_revision_id
  );

  return query
  select installation.id, installation.installation_id, repository.repo_id, repository.full_name
  from public.github_repositories repository
  join public.github_installations installation
    on (installation.workspace_id, installation.id) = (repository.workspace_id, repository.github_installation_id)
  where (repository.workspace_id, repository.factory_id, repository.id) = (p_workspace_id, p_factory_id, p_repository_id)
    and not repository.is_archived and not installation.suspended
    and (p_installation_row_id is null or installation.id = p_installation_row_id)
    and (p_upstream_repository_id is null or repository.repo_id = p_upstream_repository_id)
    and installation.installation_id between 1 and 9007199254740991
    and repository.repo_id between 1 and 9007199254740991;
  if not found then
    raise exception 'The approved context repository connection is unavailable.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function internal.require_factory_context_connection(uuid, uuid, uuid, bigint, uuid, uuid, bigint)
  from public, anon, authenticated, service_role;

create function public.register_factory_context_source(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_repository_id uuid,
  p_grant_id uuid, p_grant_version bigint, p_file_path text
) returns public.factory_context_sources
language plpgsql security definer set search_path = '' as $$
declare
  source public.factory_context_sources;
  connection record;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into connection from internal.require_factory_context_connection(
    p_workspace_id, p_factory_id, p_grant_id, p_grant_version, p_repository_id
  );
  insert into public.factory_context_sources(
    workspace_id, factory_id, repository_id, github_installation_id, upstream_repository_id,
    grant_id, grant_version, file_path
  ) values (
    p_workspace_id, p_factory_id, p_repository_id, connection.installation_row_id, connection.repository_id,
    p_grant_id, p_grant_version, p_file_path
  )
  on conflict (workspace_id, factory_id, upstream_repository_id, file_path) where deleted_at is null do nothing
  returning * into source;
  if found then return source; end if;

  select * into source from public.factory_context_sources target
  where (target.workspace_id, target.factory_id, target.upstream_repository_id, target.file_path) =
    (p_workspace_id, p_factory_id, connection.repository_id, p_file_path)
    and target.deleted_at is null;
  if found and
    (source.repository_id, source.github_installation_id, source.grant_id, source.grant_version) =
    (p_repository_id, connection.installation_row_id, p_grant_id, p_grant_version)
  then return source;
  end if;
  raise exception 'Remove the prior context source before registering a new connection or grant.'
    using errcode = 'PT409';
end;
$$;

create function public.claim_factory_context_source_sync(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_source_id uuid
) returns table (
  status text, lease_id uuid, installation_id bigint, repository_id bigint, repository_full_name text, file_path text
)
language plpgsql security definer set search_path = '' as $$
declare
  source public.factory_context_sources;
  connection record;
  attempt_at timestamptz;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into source from public.factory_context_sources target
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_source_id)
  for update;
  if not found then raise exception 'Context source not found.' using errcode = 'P0002'; end if;
  if source.deleted_at is not null then
    return query select 'deleted'::text, null::uuid, null::bigint, null::bigint, null::text, null::text;
    return;
  end if;
  attempt_at := clock_timestamp();
  begin
    select * into connection from internal.require_factory_context_connection(
      p_workspace_id, p_factory_id, source.grant_id, source.grant_version, source.repository_id,
      source.github_installation_id, source.upstream_repository_id
    );
  exception when insufficient_privilege then
    update public.factory_context_sources target set
      status = 'access_revoked', current_revision_id = null,
      sync_lease_id = null, sync_lease_expires_at = null, last_sync_attempt_at = attempt_at
    where target.id = source.id;
    return query select 'access_revoked'::text, null::uuid, null::bigint, null::bigint, null::text, null::text;
    return;
  end;
  if source.sync_lease_expires_at > attempt_at then
    raise exception 'A context sync is already running.' using errcode = 'PT409';
  end if;
  update public.factory_context_sources target set
    sync_lease_id = gen_random_uuid(),
    sync_lease_expires_at = attempt_at + interval '1 minute',
    last_sync_attempt_at = attempt_at
  where target.id = source.id returning target.sync_lease_id into lease_id;
  return query select
    'syncing'::text, lease_id, connection.installation_id, connection.repository_id,
    connection.repository_full_name, source.file_path;
end;
$$;

create function public.settle_factory_context_source_sync(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_source_id uuid, p_lease_id uuid,
  p_status text, p_content text default null, p_upstream_revision text default null,
  p_upstream_updated_at timestamptz default null
) returns public.factory_context_sources
language plpgsql security definer set search_path = '' as $$
declare
  source public.factory_context_sources;
  revision_id uuid;
  existing_content text;
  outcome text := p_status;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into source from public.factory_context_sources target
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_source_id)
  for update;
  if not found then raise exception 'Context source not found.' using errcode = 'P0002'; end if;
  if p_lease_id is null or source.sync_lease_id is distinct from p_lease_id
    or source.sync_lease_expires_at <= clock_timestamp() then
    raise exception 'The context sync lease changed or expired.' using errcode = 'PT409';
  end if;

  if p_status is null or p_status not in ('synced', 'unavailable', 'access_revoked', 'upstream_deleted')
    or (p_status = 'synced' and (p_content is null or octet_length(p_content) > 131072
      or p_upstream_revision is null or p_upstream_revision !~ '^[0-9a-f]{40}$'
      or p_upstream_updated_at is null or not isfinite(p_upstream_updated_at)))
    or (p_status <> 'synced' and
      (p_content is not null or p_upstream_revision is not null or p_upstream_updated_at is not null))
  then
    raise exception 'Invalid context sync outcome.' using errcode = '22023';
  end if;

  begin
    perform internal.require_factory_context_connection(
      p_workspace_id, p_factory_id, source.grant_id, source.grant_version, source.repository_id,
      source.github_installation_id, source.upstream_repository_id
    );
  exception when insufficient_privilege then
    outcome := 'access_revoked';
  end;
  if source.sync_lease_expires_at <= clock_timestamp() then
    raise exception 'The context sync lease expired.' using errcode = 'PT409';
  end if;

  if outcome = 'synced' then
    insert into public.factory_context_source_revisions(
      workspace_id, factory_id, source_id, upstream_revision, upstream_updated_at, media_type, content
    ) values (
      p_workspace_id, p_factory_id, source.id, p_upstream_revision, p_upstream_updated_at,
      case when source.file_path ~* '[.]txt$' then 'text/plain' else 'text/markdown' end,
      p_content
    ) on conflict (workspace_id, factory_id, source_id, content_sha256) do nothing
    returning id into revision_id;
    if not found then
      select revision.id, revision.content into strict revision_id, existing_content
      from public.factory_context_source_revisions revision
      where (revision.workspace_id, revision.factory_id, revision.source_id) =
        (p_workspace_id, p_factory_id, source.id)
        and revision.content_sha256 = encode(extensions.digest(p_content, 'sha256'), 'hex');
      if existing_content is distinct from p_content then
        raise exception 'Context revision digest collision.' using errcode = 'PT409';
      end if;
    end if;
  elsif outcome = 'unavailable' and source.current_revision_id is not null then
    outcome := 'stale';
  end if;

  update public.factory_context_sources target set
    status = outcome,
    current_revision_id = case when outcome = 'stale' then source.current_revision_id else revision_id end,
    upstream_revision = case when revision_id is not null then p_upstream_revision else source.upstream_revision end,
    upstream_updated_at = case when revision_id is not null then p_upstream_updated_at else source.upstream_updated_at end,
    last_successful_sync_at = case when revision_id is not null then clock_timestamp() else source.last_successful_sync_at end,
    sync_lease_id = null,
    sync_lease_expires_at = null
  where target.id = source.id returning * into source;
  return source;
end;
$$;

create function public.delete_factory_context_source(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_source_id uuid
) returns public.factory_context_sources
language plpgsql security definer set search_path = '' as $$
declare source public.factory_context_sources;
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  update public.factory_context_sources target set
    status = 'deleted', deleted_at = coalesce(target.deleted_at, clock_timestamp()), current_revision_id = null,
    sync_lease_id = null, sync_lease_expires_at = null
  where (target.workspace_id, target.factory_id, target.id) = (p_workspace_id, p_factory_id, p_source_id)
  returning * into source;
  if not found then raise exception 'Context source not found.' using errcode = 'P0002'; end if;
  return source;
end;
$$;

revoke all on function public.register_factory_context_source(uuid, uuid, uuid, uuid, uuid, bigint, text),
  public.claim_factory_context_source_sync(uuid, uuid, uuid, uuid),
  public.settle_factory_context_source_sync(uuid, uuid, uuid, uuid, uuid, text, text, text, timestamptz),
  public.delete_factory_context_source(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.register_factory_context_source(uuid, uuid, uuid, uuid, uuid, bigint, text),
  public.claim_factory_context_source_sync(uuid, uuid, uuid, uuid),
  public.settle_factory_context_source_sync(uuid, uuid, uuid, uuid, uuid, text, text, text, timestamptz),
  public.delete_factory_context_source(uuid, uuid, uuid, uuid)
  to service_role;
