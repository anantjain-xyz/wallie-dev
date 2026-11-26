create or replace function internal.list_factory_failure_cohorts(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer, p_after_cohort_id uuid,
  p_symptom_kind text, p_definition_revision_id uuid, p_disposition text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  can_review boolean;
  result jsonb;
begin
  perform internal.assert_factory_failure_cohort_read(p_workspace_id, p_factory_id, p_limit);
  if (p_symptom_kind is not null and p_symptom_kind not in ('scorer', 'validation'))
    or (p_disposition is not null and p_disposition not in ('open', 'dismissed', 'split')) then
    raise exception 'Invalid failure cohort filter.' using errcode = '22023';
  end if;

  select factory.status = 'active' and internal.can_manage_factory(factory.workspace_id, factory.id)
  into can_review from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id);

  with ranked as materialized (
    select target.id, target as item, review as decision, impact.failed_runs
    from internal.factory_failure_cohort_targets target
    left join lateral internal.latest_factory_failure_cohort_review(target.source) review on target.partition is null
    cross join lateral (
      select count(distinct member.run_id) as failed_runs
      from internal.visible_factory_failure_cohort_members(target.source,
        case when target.partition is not null then target.id end, p_definition_revision_id) member
    ) impact
    where (target.workspace_id, target.factory_id) = (p_workspace_id, p_factory_id)
      and (p_symptom_kind is null or (target.source).symptom_kind = p_symptom_kind)
      and (p_disposition is null or
        case when target.partition is not null then 'split' else coalesce(review.disposition, 'open') end = p_disposition)
      and impact.failed_runs > 0
  ),
  anchor as (
    select id, failed_runs from ranked where id = p_after_cohort_id
  ),
  page as materialized (
    select * from ranked candidate
    where p_after_cohort_id is null or exists (
      select 1 from anchor
      where candidate.failed_runs < anchor.failed_runs
        or (candidate.failed_runs = anchor.failed_runs and candidate.id > anchor.id)
    )
    order by failed_runs desc, id limit p_limit + 1
  ),
  visible as (
    select * from page order by failed_runs desc, id limit p_limit
  )
  select jsonb_build_object(
    'cohorts', coalesce(jsonb_agg(
      internal.summarize_factory_failure_cohort(item, decision, p_definition_revision_id, can_review)
        order by failed_runs desc, id
    ), '[]'),
    'cursor_unavailable', p_after_cohort_id is not null and not exists (select 1 from anchor),
    'next_cohort_id', case when (select count(*) from page) > p_limit then
      (select id from visible order by failed_runs, id desc limit 1) end
  ) into result from visible;
  return result;
end;
$$;

drop function public.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid);
drop function internal.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid);

create function internal.get_factory_failure_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_cohort_id uuid, p_limit integer,
  p_after_member_id uuid, p_definition_revision_id uuid, p_run_search text,
  p_observed_on date, p_member_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  target internal.factory_failure_cohort_targets;
  review internal.factory_failure_cohort_reviews;
  can_review boolean;
  partition_id uuid;
  summary jsonb;
  membership_digest text;
  result jsonb;
begin
  perform internal.assert_factory_failure_cohort_read(p_workspace_id, p_factory_id, p_limit);
  if char_length(p_run_search) > 120 then
    raise exception 'Invalid failure cohort search.' using errcode = '22023';
  end if;

  select * into target from internal.factory_failure_cohort_targets candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_cohort_id);
  if not found then raise exception 'Failure cohort is unavailable.' using errcode = 'P0002'; end if;

  select factory.status = 'active' and internal.can_manage_factory(factory.workspace_id, factory.id)
  into can_review from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id);
  if target.partition is null then
    review := internal.latest_factory_failure_cohort_review(target.source);
  else
    partition_id := target.id;
  end if;
  summary := internal.summarize_factory_failure_cohort(target, review, p_definition_revision_id, can_review);
  if summary is null then raise exception 'Failure cohort is unavailable.' using errcode = 'P0002'; end if;

  if p_member_id is null then
    select internal.factory_failure_cohort_membership_digest(array_agg(member.id order by member.id))
    into membership_digest
    from internal.visible_factory_failure_cohort_members(target.source, partition_id, null) member;
  end if;

  with page as materialized (
    select member.id, member as item, left(session.title, 200) as session_title,
      session.number as session_number, left(run.stage_name, 128) as stage_name
    from internal.visible_factory_failure_cohort_members(target.source, partition_id, p_definition_revision_id) member
    left join public.sessions session
      on (session.workspace_id, session.factory_id, session.id) =
        (member.workspace_id, member.factory_id, member.session_id)
      and internal.can_access_session(session.id)
    left join public.agent_runs run
      on (run.workspace_id, run.session_id, run.id) = (session.workspace_id, session.id, member.run_id)
    where (p_member_id is null or member.id = p_member_id)
      and (p_after_member_id is null or member.id > p_after_member_id)
      and (p_observed_on is null or (member.observed_at at time zone 'UTC')::date = p_observed_on)
      and (p_run_search is null or
        strpos(lower(concat_ws(' ', session.title, session.number, '#' || session.number, run.stage_name)),
          lower(p_run_search)) > 0)
    order by member.id limit p_limit + 1
  ),
  visible as (
    select * from page order by id limit p_limit
  )
  select jsonb_build_object(
    'cohort', summary,
    'members', coalesce(jsonb_agg(
      internal.project_factory_failure_cohort_member((target.source).agent_id, item)
        || jsonb_build_object('session_title', session_title, 'session_number', session_number, 'stage_name', stage_name)
      order by id
    ), '[]'),
    'membership_digest', membership_digest,
    'split_groups', coalesce((
      select jsonb_agg(jsonb_build_object('id', partition.id, 'side', partition.side) order by partition.side desc)
      from internal.factory_failure_cohort_partitions partition
      where (partition.workspace_id, partition.factory_id, partition.cohort_id) =
        (p_workspace_id, p_factory_id, p_cohort_id)
        and (summary->'split_cohort_ids') ? partition.id::text
    ), '[]'),
    'next_member_id', case when (select count(*) from page) > p_limit then
      (select id from visible order by id desc limit 1) end
  ) into result from visible;
  return result;
end;
$$;

create function public.get_factory_failure_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_cohort_id uuid, p_limit integer default 25,
  p_after_member_id uuid default null, p_definition_revision_id uuid default null,
  p_run_search text default null, p_observed_on date default null, p_member_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_factory_failure_cohort(p_workspace_id, p_factory_id, p_cohort_id, p_limit,
    p_after_member_id, p_definition_revision_id, p_run_search, p_observed_on, p_member_id)
$$;

revoke all on function internal.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid, text, date, uuid),
  public.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid, text, date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function internal.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid, text, date, uuid),
  public.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid, uuid, text, date, uuid)
  to authenticated;
