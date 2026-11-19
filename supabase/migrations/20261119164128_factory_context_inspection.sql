-- Revision timelines expose identity and synchronization metadata. Content
-- remains available only to the worker after the existing exact live recheck.
grant select (
  id, workspace_id, factory_id, source_id, upstream_revision, upstream_updated_at,
  media_type, content_bytes, content_sha256, created_at
) on public.factory_context_source_revisions to authenticated;
create policy factory_context_source_revisions_manager_read on public.factory_context_source_revisions
  for select to authenticated using (internal.can_manage_factory(workspace_id, factory_id));
create index factory_context_source_revision_history_idx on public.factory_context_source_revisions(
  workspace_id, factory_id, source_id, created_at desc, id desc
);

create function public.list_factory_context_source_access(
  target_workspace_id uuid, target_factory_id uuid, target_source_ids uuid[]
)
returns table(source_id uuid, status text)
language plpgsql security definer set search_path = '' as $$
declare source public.factory_context_sources;
begin
  perform internal.assert_factory_manager(target_workspace_id, target_factory_id, auth.uid());
  if target_source_ids is null or cardinality(target_source_ids) > 100
    or exists (select 1 from unnest(target_source_ids) requested(id)
      group by requested.id having requested.id is null or count(*) > 1)
  then
    raise exception 'Provide up to 100 distinct context source IDs.' using errcode = '22023';
  end if;

  for source in
    select registered.* from unnest(target_source_ids) with ordinality requested(id, position)
    join public.factory_context_sources registered
      on (registered.workspace_id, registered.factory_id, registered.id) =
        (target_workspace_id, target_factory_id, requested.id)
    order by requested.position
  loop
    source_id := source.id;
    if source.deleted_at is not null then
      status := 'deleted';
    else
      begin
        perform 1 from internal.require_factory_context_connection(
          source.workspace_id, source.factory_id, source.grant_id, source.grant_version,
          source.repository_id, source.github_installation_id, source.upstream_repository_id
        );
        status := case when source.status in ('synced', 'stale') then 'available' else 'unavailable' end;
      exception when insufficient_privilege then
        status := 'access_revoked';
      when sqlstate 'PT409' or sqlstate 'P0011' then
        status := 'unavailable';
      end;
    end if;
    return next;
  end loop;
end;
$$;
revoke all on function public.list_factory_context_source_access(uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_context_source_access(uuid, uuid, uuid[]) to authenticated;

create function public.list_factory_context_repository_options(
  target_workspace_id uuid, target_factory_id uuid,
  target_after_grant_id uuid default null, target_after_repository_id uuid default null,
  target_limit integer default 100
)
returns table(grant_id uuid, grant_version bigint, repository_id uuid, repository_full_name text)
language plpgsql security definer set search_path = '' as $$
declare option_row record;
declare page_size integer := least(greatest(coalesce(target_limit, 100), 1), 100);
declare emitted integer := 0;
begin
  perform internal.assert_factory_manager(target_workspace_id, target_factory_id, auth.uid());
  if (target_after_grant_id is null) <> (target_after_repository_id is null) then
    raise exception 'Provide both context repository cursor IDs.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.factories factory
    where (factory.workspace_id, factory.id) = (target_workspace_id, target_factory_id) and factory.status = 'active')
  then return; end if;

  for option_row in
    select execution.id, execution.version, repo.id as repo_id
    from public.factory_execution_grants execution
    cross join lateral unnest(execution.read_context_repository_ids) granted(id)
    join public.github_repositories repo on (repo.workspace_id, repo.factory_id, repo.id) =
      (execution.workspace_id, execution.factory_id, granted.id)
    where (execution.workspace_id, execution.factory_id) = (target_workspace_id, target_factory_id)
      and execution.revoked_at is null and execution.expires_at > clock_timestamp()
      and (target_after_grant_id is null or (execution.id, repo.id) > (target_after_grant_id, target_after_repository_id))
    order by execution.id, repo.id
  loop
    begin
      select connection.repository_full_name into strict repository_full_name
      from internal.require_factory_context_connection(
        target_workspace_id, target_factory_id, option_row.id, option_row.version, option_row.repo_id
      ) connection;
    exception when insufficient_privilege or sqlstate 'PT409' or sqlstate 'P0011' then
      continue;
    end;
    grant_id := option_row.id;
    grant_version := option_row.version;
    repository_id := option_row.repo_id;
    return next;
    emitted := emitted + 1;
    exit when emitted >= page_size;
  end loop;
end;
$$;
revoke all on function public.list_factory_context_repository_options(uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_context_repository_options(uuid, uuid, uuid, uuid, integer)
  to authenticated;

create function public.get_run_context_inputs(
  target_workspace_id uuid, target_run_id uuid, target_attempt_count integer
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare exact_run record;
declare projected jsonb;
begin
  select frozen.origin_run_id, frozen.manifest_sha256, frozen.created_at, frozen.manifest,
    owner.factory_id, internal.can_manage_factory(owner.workspace_id, owner.factory_id) as can_manage
  into exact_run
  from public.session_run_context_manifests frozen
  join public.agent_runs run
    on (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
       (frozen.run_id, frozen.workspace_id, frozen.session_id, frozen.job_id, frozen.attempt_count)
  join public.sessions owner on (owner.id, owner.workspace_id) = (run.session_id, run.workspace_id)
  where (frozen.workspace_id, frozen.run_id, frozen.attempt_count) =
    (target_workspace_id, target_run_id, target_attempt_count)
    and auth.uid() is not null
    and internal.can_access_session(owner.id);
  if not found or internal.is_factory_memory_run_context_manifest(exact_run.manifest) is not true then
    return null;
  end if;

  projected := exact_run.manifest;
  if not exact_run.can_manage then
    projected := jsonb_set(projected, '{documents}', (
      select coalesce(jsonb_agg(document.value - 'filePath' order by document.position), '[]'::jsonb)
      from jsonb_array_elements(projected->'documents') with ordinality document(value, position)
    ));
  end if;
  return jsonb_build_object(
    'factoryId', exact_run.factory_id, 'canManage', exact_run.can_manage,
    'originRunId', exact_run.origin_run_id, 'manifestSha256', exact_run.manifest_sha256,
    'createdAt', exact_run.created_at, 'manifest', projected
  );
end;
$$;
revoke all on function public.get_run_context_inputs(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_run_context_inputs(uuid, uuid, integer) to authenticated;
