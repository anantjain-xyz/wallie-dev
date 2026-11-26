create function public.list_factory_benchmark_suites(
  p_workspace_id uuid, p_factory_id uuid, p_name text default null,
  p_purpose text default null, p_after uuid default null
) returns table (
  suite_id uuid, name text, purpose text, revision_number integer,
  created_at timestamptz, task_count bigint
)
language sql stable security invoker set search_path = '' as $$
  with latest as materialized (
    select suite.id as suite_id, revision.id, revision.name, revision.purpose,
      revision.revision_number, revision.created_at, lower(revision.name) as sort_name
    from public.factory_benchmark_suites suite
    cross join lateral (
      select r.id, r.name, r.purpose, r.revision_number, r.created_at
      from public.factory_benchmark_suite_revisions r
      where (r.workspace_id, r.factory_id, r.suite_id) = (suite.workspace_id, suite.factory_id, suite.id)
      order by r.revision_number desc limit 1
    ) revision
    where (suite.workspace_id, suite.factory_id) = (p_workspace_id, p_factory_id)
      and (p_purpose is null or revision.purpose = p_purpose)
      and (p_name is null or strpos(lower(revision.name), lower(p_name)) > 0)
  ), page as materialized (
    select entry.* from latest entry
    where p_after is null or (entry.sort_name, entry.suite_id) > (
      select cursor_row.sort_name, cursor_row.suite_id from latest cursor_row
      where cursor_row.suite_id = p_after
    )
    order by entry.sort_name, entry.suite_id limit 31
  )
  select page.suite_id, page.name, page.purpose, page.revision_number, page.created_at,
    (select count(*) from public.factory_benchmark_suite_members member
      where (member.workspace_id, member.factory_id, member.suite_revision_id)
        = (p_workspace_id, p_factory_id, page.id))
  from page order by page.sort_name, page.suite_id;
$$;

revoke all on function public.list_factory_benchmark_suites(uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_benchmark_suites(uuid, uuid, text, text, uuid)
  to authenticated;

create function public.curate_factory_benchmark_suite(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_name text, p_purpose text,
  p_suite_id uuid default null, p_expected_revision_id uuid default null,
  p_task_revision_ids uuid[] default null, p_selection_tags text[] default null,
  p_preview_task_revision_ids uuid[] default null, p_allow_empty boolean default false,
  p_preserve_selection boolean default false
) returns public.factory_benchmark_suite_revisions
language plpgsql security definer set search_path = '' as $$
declare
  current_revision public.factory_benchmark_suite_revisions;
  result public.factory_benchmark_suite_revisions;
  matching_ids uuid[];
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  if p_preserve_selection then
    if p_suite_id is null or p_task_revision_ids is not null or p_selection_tags is not null
      or p_preview_task_revision_ids is not null then
      raise exception 'Preserving selection requires an existing suite.' using errcode = '22023';
    end if;

    select * into current_revision from public.factory_benchmark_suite_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.suite_id)
      = (p_workspace_id, p_factory_id, p_suite_id)
    order by revision.revision_number desc limit 1;
    if not found then
      raise exception 'Benchmark suite is unavailable in this factory.' using errcode = 'P0002';
    end if;
    if p_expected_revision_id is distinct from current_revision.id then
      raise exception 'The benchmark suite changed.' using errcode = 'PT409';
    end if;

    insert into public.factory_benchmark_suite_revisions(
      workspace_id, factory_id, suite_id, revision_number, name, purpose, selection_tags, created_by
    ) values (
      p_workspace_id, p_factory_id, p_suite_id, current_revision.revision_number + 1,
      btrim(p_name), p_purpose, current_revision.selection_tags, p_actor_user_id
    ) returning * into result;

    insert into public.factory_benchmark_suite_members(
      workspace_id, factory_id, suite_revision_id, task_id, task_revision_id
    )
    select p_workspace_id, p_factory_id, result.id, member.task_id, member.task_revision_id
    from public.factory_benchmark_suite_members member
    where (member.workspace_id, member.factory_id, member.suite_revision_id)
      = (p_workspace_id, p_factory_id, current_revision.id);
    return result;
  end if;

  if p_selection_tags is not null then
    matching_ids := array(
      select latest.id from public.factory_benchmark_tasks task
      cross join lateral (
        select revision.id, revision.tags from public.factory_benchmark_task_revisions revision
        where revision.task_id = task.id order by revision.revision_number desc limit 1
      ) latest
      where (task.workspace_id, task.factory_id) = (p_workspace_id, p_factory_id)
        and latest.tags @> internal.normalize_factory_benchmark_tags(p_selection_tags)
      order by latest.id
    );
    if p_preview_task_revision_ids is not null and matching_ids is distinct from
      array(select id from unnest(p_preview_task_revision_ids) as preview(id) order by id) then
      raise exception 'The matching task revisions changed.' using errcode = 'PT412';
    end if;
  else
    matching_ids := p_task_revision_ids;
  end if;

  if cardinality(matching_ids) = 0 and p_allow_empty is not true then
    raise exception 'Saving an empty benchmark suite requires confirmation.' using errcode = 'PT428';
  end if;
  return public.save_factory_benchmark_suite_revision(
    p_workspace_id, p_factory_id, p_actor_user_id, p_name, p_purpose,
    p_suite_id, p_expected_revision_id, p_task_revision_ids, p_selection_tags
  );
end;
$$;

revoke all on function public.curate_factory_benchmark_suite(uuid, uuid, uuid, text, text, uuid, uuid, uuid[], text[], uuid[], boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.curate_factory_benchmark_suite(uuid, uuid, uuid, text, text, uuid, uuid, uuid[], text[], uuid[], boolean, boolean)
  to service_role;
