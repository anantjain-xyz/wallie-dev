create or replace function public.list_factory_automation_occurrence_history(
  p_workspace_id uuid, p_factory_id uuid, p_automation_id uuid,
  p_before_recorded_at timestamptz default null, p_before_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not internal.can_manage_factory(p_workspace_id, p_factory_id)
    or not exists (
      select 1 from internal.factory_automations rule
      join public.factories factory
        on (factory.workspace_id, factory.id) = (rule.workspace_id, rule.factory_id)
      where (rule.workspace_id, rule.factory_id, rule.id) = (p_workspace_id, p_factory_id, p_automation_id)
        and factory.status = 'active'
    ) then
    return null;
  end if;
  if (p_before_recorded_at is null) <> (p_before_id is null)
    or (p_before_recorded_at is not null and not isfinite(p_before_recorded_at)) then
    raise exception 'Provide both occurrence history cursor fields.' using errcode = '22023';
  end if;

  return (
    with candidates as materialized (
      select occurrence.id, occurrence.revision_id, occurrence.event->>'kind' as trigger_kind,
        occurrence.status, occurrence.reason, occurrence.attempt_count, occurrence.recorded_at,
        occurrence.settled_at, occurrence.next_attempt_at, occurrence.session_id
      from internal.factory_automation_occurrences occurrence
      where (occurrence.workspace_id, occurrence.factory_id, occurrence.automation_id) =
        (p_workspace_id, p_factory_id, p_automation_id)
        and (occurrence.recorded_at, occurrence.id) <
          (coalesce(p_before_recorded_at, 'infinity'::timestamptz), p_before_id)
      order by occurrence.recorded_at desc, occurrence.id desc
      limit 21
    ), page as materialized (
      select * from candidates order by recorded_at desc, id desc limit 20
    )
    select jsonb_build_object(
      'occurrences', coalesce(jsonb_agg(jsonb_build_object(
        'id', page.id, 'revisionId', page.revision_id,
        'revisionNumber', revision.revision_number, 'triggerKind', page.trigger_kind,
        'status', page.status, 'reason', page.reason, 'attemptCount', page.attempt_count,
        'recordedAt', page.recorded_at, 'settledAt', page.settled_at, 'nextAttemptAt', page.next_attempt_at,
        'sessionNumber', session.number
      ) order by page.recorded_at desc, page.id desc), '[]'::jsonb),
      'nextCursor', case when (select count(*) from candidates) = 21 then (
        select jsonb_build_object('recordedAt', last_item.recorded_at, 'id', last_item.id)
        from page last_item order by last_item.recorded_at, last_item.id limit 1
      ) end
    )
    from page
    join internal.factory_automation_revisions revision
      on (revision.workspace_id, revision.factory_id, revision.automation_id, revision.id) =
        (p_workspace_id, p_factory_id, p_automation_id, page.revision_id)
    left join public.sessions session
      on (session.workspace_id, session.factory_id, session.id) = (p_workspace_id, p_factory_id, page.session_id)
      and internal.can_access_session(session.id)
  );
end;
$$;
