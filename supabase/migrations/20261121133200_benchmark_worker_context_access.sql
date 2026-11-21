create function internal.list_authorized_factory_context_source_access(
  target_workspace_id uuid, target_factory_id uuid, target_source_ids uuid[]
)
returns table(source_id uuid, status text)
language plpgsql set search_path = '' as $$
declare source public.factory_context_sources;
begin
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
revoke all on function internal.list_authorized_factory_context_source_access(uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;

create or replace function public.list_factory_context_source_access(
  target_workspace_id uuid, target_factory_id uuid, target_source_ids uuid[]
)
returns table(source_id uuid, status text)
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_factory_manager(target_workspace_id, target_factory_id, auth.uid());
  return query select * from internal.list_authorized_factory_context_source_access(
    target_workspace_id, target_factory_id, target_source_ids
  );
end;
$$;

create function public.benchmark_list_factory_context_source_access(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_task_revision_id uuid,
  p_source_ids uuid[]
)
returns table(source_id uuid, status text)
language plpgsql security definer set search_path = '' as $$
declare captured_documents jsonb;
begin
  perform public.assert_factory_benchmark_replay_access(
    p_workspace_id, p_factory_id, p_actor_user_id, p_task_revision_id
  );
  select context.manifest -> 'documents' into captured_documents
  from public.factory_benchmark_task_revisions revision
  join public.factory_benchmark_task_inputs input
    on (input.workspace_id, input.factory_id, input.task_id) =
       (revision.workspace_id, revision.factory_id, revision.task_id)
  join public.session_run_context_manifests context
    on (context.workspace_id, context.session_id, context.run_id, context.job_id, context.attempt_count) =
       (input.workspace_id, input.source_session_id, input.source_run_id, input.source_job_id, input.source_attempt_count)
    and context.manifest_sha256 = input.context_manifest_sha256
    and context.origin_run_id is not distinct from input.context_origin_run_id
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (p_workspace_id, p_factory_id, p_task_revision_id);

  if jsonb_typeof(captured_documents) is distinct from 'array'
    or exists (select 1 from unnest(p_source_ids) requested(id)
      where not exists (
        select 1 from jsonb_array_elements(
          case when jsonb_typeof(captured_documents) = 'array' then captured_documents else '[]'::jsonb end
        ) document
        where document ->> 'status' = 'selected' and document ->> 'sourceId' = requested.id::text
      )
    )
  then
    raise exception 'The context source was not retained for this benchmark task.' using errcode = '42501';
  end if;

  return query select * from internal.list_authorized_factory_context_source_access(
    p_workspace_id, p_factory_id, p_source_ids
  );
end;
$$;
revoke all on function public.benchmark_list_factory_context_source_access(uuid, uuid, uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.benchmark_list_factory_context_source_access(uuid, uuid, uuid, uuid, uuid[])
  to service_role;
