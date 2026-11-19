create table internal.factory_flow_projection_controls (
  workspace_id uuid not null,
  factory_id uuid not null,
  paused_at timestamptz,
  failed_at timestamptz,
  retry_after timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 30),
  rebuild_requested_at timestamptz,
  rebuild_after_session_id uuid,
  rebuild_enumerated_at timestamptz,
  rebuild_completed_at timestamptz,
  primary key (workspace_id, factory_id),
  foreign key (workspace_id, factory_id) references public.factories (workspace_id, id) on delete cascade,
  check ((failed_at is null) = (failed_attempts = 0)),
  check (retry_after is null or retry_after > failed_at),
  check (rebuild_requested_at is not null or num_nonnulls(
    rebuild_after_session_id, rebuild_enumerated_at, rebuild_completed_at) = 0),
  check (rebuild_completed_at is null or rebuild_completed_at >= rebuild_enumerated_at)
);
create index factory_flow_projection_rebuild_ready_idx
  on internal.factory_flow_projection_controls (rebuild_requested_at, workspace_id, factory_id)
  where rebuild_completed_at is null and rebuild_requested_at is not null and paused_at is null;
create index factory_flow_projection_retry_ready_idx
  on internal.factory_flow_projection_controls (retry_after, workspace_id, factory_id)
  where retry_after is not null and paused_at is null;
alter table internal.factory_flow_projection_controls enable row level security;
revoke all on internal.factory_flow_projection_controls from public, anon, authenticated, service_role;

create function internal.factory_flow_projection_lock_key(p_workspace_id uuid, p_factory_id uuid)
returns bigint language sql immutable set search_path = '' as $$
  select hashtextextended('factory-flow:' || p_workspace_id::text || ':' || p_factory_id::text, 0)
$$;
revoke all on function internal.factory_flow_projection_lock_key(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.get_factory_flow_projection_health(p_workspace_id uuid, p_factory_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare as_of timestamptz := statement_timestamp(); result jsonb;
begin
  if not internal.can_access_factory(p_workspace_id, p_factory_id) then
    raise exception 'Factory flow projection is unavailable.' using errcode = 'PT404';
  end if;
  select jsonb_build_object(
    'status', case when control.paused_at is not null then 'paused'
      when control.failed_at is not null or watermark.status = 'failed' then 'failed'
      when pending.queued_at is not null or (control.rebuild_requested_at is not null and control.rebuild_completed_at is null)
        then 'building'
      else coalesce(watermark.status, 'unavailable') end,
    'canManage', internal.can_manage_factory(p_workspace_id, p_factory_id),
    'paused', control.paused_at is not null, 'pausedAt', control.paused_at,
    'oldestPendingAt', pending.queued_at,
    'lagSeconds', case when pending.queued_at is not null
      then greatest(0, extract(epoch from as_of - pending.queued_at)) end,
    'lastAttemptAt', watermark.last_attempt_at, 'lastSuccessAt', watermark.last_success_at,
    'sourceSnapshotAt', watermark.source_snapshot_at,
    'failedAt', control.failed_at, 'retryAfter', control.retry_after,
    'failedAttempts', coalesce(control.failed_attempts, 0),
    'rebuild', jsonb_build_object(
      'state', case when control.rebuild_requested_at is null then 'idle'
        when control.rebuild_completed_at is not null then 'completed'
        when num_nonnulls(control.rebuild_after_session_id, control.rebuild_enumerated_at) > 0 then 'building'
        else 'queued' end,
      'requestedAt', control.rebuild_requested_at, 'completedAt', control.rebuild_completed_at),
    'evaluatedAt', as_of
  ) into result
  from public.factories factory
  join public.workspaces workspace on workspace.id = factory.workspace_id
  left join internal.factory_flow_projection_controls control
    on (control.workspace_id, control.factory_id) = (factory.workspace_id, factory.id)
  left join internal.factory_outcome_projection_watermarks watermark
    on (watermark.workspace_id, watermark.factory_id, watermark.metric_key, watermark.metric_revision) =
      (factory.workspace_id, factory.id, 'workflow_flow', 1)
  left join lateral (
    select dirty.queued_at from internal.factory_flow_projection_dirty_sessions dirty
    where (dirty.workspace_id, dirty.factory_id) = (factory.workspace_id, factory.id)
    order by dirty.queued_at, dirty.session_id limit 1
  ) pending on true
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id)
    and workspace.deletion_requested_at is null;
  if result is null then raise exception 'Factory flow projection is unavailable.' using errcode = 'PT404'; end if;
  return result;
end;
$$;
revoke all on function public.get_factory_flow_projection_health(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_flow_projection_health(uuid, uuid) to authenticated;

create function public.control_factory_flow_projection(p_workspace_id uuid, p_factory_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_action is null or p_action not in ('pause', 'resume', 'rebuild') then
    raise exception 'Invalid factory flow projection action.' using errcode = '22023';
  end if;
  if not internal.can_manage_factory(p_workspace_id, p_factory_id) then
    raise exception 'Factory flow projection is unavailable.' using errcode = 'PT404';
  end if;
  perform pg_advisory_xact_lock(internal.factory_flow_projection_lock_key(p_workspace_id, p_factory_id));
  begin
    -- Verify the current authorization again after waiting for a worker batch.
    perform internal.assert_factory_manager(p_workspace_id, p_factory_id, auth.uid());
  exception when insufficient_privilege or no_data_found then
    raise exception 'Factory flow projection is unavailable.' using errcode = 'PT404';
  end;

  case p_action
  when 'pause' then
    insert into internal.factory_flow_projection_controls as control (workspace_id, factory_id, paused_at)
    values (p_workspace_id, p_factory_id, clock_timestamp())
    on conflict (workspace_id, factory_id) do update set paused_at = excluded.paused_at
    where control.paused_at is null;
  when 'resume' then
    update internal.factory_flow_projection_controls control set paused_at = null
    where (control.workspace_id, control.factory_id) = (p_workspace_id, p_factory_id) and control.paused_at is not null;
  when 'rebuild' then
    insert into internal.factory_flow_projection_controls as control (workspace_id, factory_id, rebuild_requested_at)
    values (p_workspace_id, p_factory_id, clock_timestamp())
    on conflict (workspace_id, factory_id) do update set
      rebuild_requested_at = excluded.rebuild_requested_at, rebuild_after_session_id = null,
      rebuild_enumerated_at = null, rebuild_completed_at = null, retry_after = null
    where control.rebuild_requested_at is null or control.rebuild_completed_at is not null;
  end case;
  return public.get_factory_flow_projection_health(p_workspace_id, p_factory_id);
end;
$$;
revoke all on function public.control_factory_flow_projection(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.control_factory_flow_projection(uuid, uuid, text) to authenticated;

create function internal.next_factory_flow_projection_scope(p_available_at timestamptz)
returns table (workspace_id uuid, factory_id uuid) language sql stable set search_path = '' as $$
  with next_dirty as (
    select dirty.workspace_id, dirty.factory_id, dirty.queued_at as available_since
    from internal.factory_flow_projection_dirty_sessions dirty
    join public.workspaces workspace on workspace.id = dirty.workspace_id
    left join internal.factory_flow_projection_controls control
      on (control.workspace_id, control.factory_id) = (dirty.workspace_id, dirty.factory_id)
    where workspace.deletion_requested_at is null and control.paused_at is null and control.retry_after is null
    order by dirty.queued_at, dirty.session_id limit 1
  ), next_rebuild as (
    select control.workspace_id, control.factory_id,
      greatest(control.rebuild_requested_at, watermark.last_attempt_at) as available_since
    from internal.factory_flow_projection_controls control
    join public.workspaces workspace on workspace.id = control.workspace_id
    left join internal.factory_outcome_projection_watermarks watermark
      on (watermark.workspace_id, watermark.factory_id, watermark.metric_key, watermark.metric_revision) =
        (control.workspace_id, control.factory_id, 'workflow_flow', 1)
    where workspace.deletion_requested_at is null and control.rebuild_completed_at is null
      and control.rebuild_requested_at is not null and control.paused_at is null
      and control.retry_after is null
    order by available_since, control.workspace_id, control.factory_id limit 1
  ), next_retry as (
    -- Retry eligibility can expire between worker ticks. Order retry work by
    -- when it became eligible again so older healthy work still progresses.
    select control.workspace_id, control.factory_id, control.retry_after as available_since
    from internal.factory_flow_projection_controls control
    join public.workspaces workspace on workspace.id = control.workspace_id
    where workspace.deletion_requested_at is null and control.paused_at is null and control.retry_after <= p_available_at
      and ((control.rebuild_requested_at is not null and control.rebuild_completed_at is null) or exists (
        select 1 from internal.factory_flow_projection_dirty_sessions dirty
        where (dirty.workspace_id, dirty.factory_id) = (control.workspace_id, control.factory_id)
      ))
    order by control.retry_after, control.workspace_id, control.factory_id limit 1
  )
  select candidate.workspace_id, candidate.factory_id
  from (select * from next_dirty union all select * from next_rebuild union all select * from next_retry) candidate
  order by candidate.available_since, candidate.workspace_id, candidate.factory_id limit 1
$$;
revoke all on function internal.next_factory_flow_projection_scope(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.process_factory_flow_projection(p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner record;
  work record;
  operation internal.factory_flow_projection_controls;
  snapshot_at timestamptz := clock_timestamp();
  finish_at timestamptz;
  processed integer := 0;
  enqueued integer;
  last_enqueued uuid;
  rebuilding boolean;
  complete boolean := false;
  outcome text := 'building';
begin
  perform internal.assert_checkpoint_publication_service();
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Invalid factory flow projection batch size.' using errcode = '22023';
  end if;
  select * into owner from internal.next_factory_flow_projection_scope(snapshot_at);
  if not found then return jsonb_build_object('processed', 0, 'hasMore', false); end if;
  if not pg_try_advisory_xact_lock(internal.factory_flow_projection_lock_key(owner.workspace_id, owner.factory_id)) then
    return jsonb_build_object('processed', 0, 'hasMore', true);
  end if;
  perform 1 from public.workspaces workspace
  where workspace.id = owner.workspace_id and workspace.deletion_requested_at is null for share;
  if not found then return jsonb_build_object('processed', 0, 'hasMore', true); end if;

  -- A concurrent pause or failure can land between candidate selection and the lock.
  select control.* into operation from internal.factory_flow_projection_controls control
  where (control.workspace_id, control.factory_id) = (owner.workspace_id, owner.factory_id);
  if operation.paused_at is not null or operation.retry_after > snapshot_at then
    return jsonb_build_object('processed', 0, 'hasMore',
      exists (select 1 from internal.next_factory_flow_projection_scope(clock_timestamp())));
  end if;
  rebuilding := operation.rebuild_requested_at is not null and operation.rebuild_completed_at is null;

  -- Failure rolls back only this batch. The durable cursor, prior coherent
  -- snapshot and dirty source keys remain intact for a later retry.
  begin
    if rebuilding and operation.rebuild_enumerated_at is null then
      with batch as materialized (
        select session.id from public.sessions session
        where (session.workspace_id, session.factory_id) = (owner.workspace_id, owner.factory_id)
          and (operation.rebuild_after_session_id is null or session.id > operation.rebuild_after_session_id)
        order by session.id limit p_limit
      ), queued as (
        insert into internal.factory_flow_projection_dirty_sessions as dirty (session_id, workspace_id, factory_id, queued_at)
        select batch.id, owner.workspace_id, owner.factory_id, snapshot_at from batch
        on conflict (session_id) do update set queued_at = least(dirty.queued_at, excluded.queued_at)
        returning session_id
      )
      select count(*)::integer, (array_agg(session_id order by session_id desc))[1]
        into enqueued, last_enqueued from queued;
      update internal.factory_flow_projection_controls control set
        rebuild_after_session_id = coalesce(last_enqueued, operation.rebuild_after_session_id),
        rebuild_enumerated_at = case when enqueued < p_limit then clock_timestamp() end
      where (control.workspace_id, control.factory_id) = (owner.workspace_id, owner.factory_id)
      returning control.* into operation;
    end if;

    for work in
      select dirty.session_id from internal.factory_flow_projection_dirty_sessions dirty
      where (dirty.workspace_id, dirty.factory_id) = (owner.workspace_id, owner.factory_id)
      order by dirty.queued_at, dirty.session_id limit p_limit for update skip locked
    loop
      perform internal.rebuild_factory_flow_session(owner.workspace_id, owner.factory_id, work.session_id, snapshot_at);
      delete from internal.factory_flow_projection_dirty_sessions where session_id = work.session_id;
      processed := processed + 1;
    end loop;

    complete := (not rebuilding or operation.rebuild_enumerated_at is not null) and not exists (
      select 1 from internal.factory_flow_projection_dirty_sessions dirty
      where (dirty.workspace_id, dirty.factory_id) = (owner.workspace_id, owner.factory_id)
    );
    finish_at := clock_timestamp();
    outcome := case when complete then 'ready' else 'building' end;
    update internal.factory_flow_projection_controls control set
      failed_at = null, retry_after = null, failed_attempts = 0,
      rebuild_completed_at = case when rebuilding and complete then finish_at else control.rebuild_completed_at end
    where (control.workspace_id, control.factory_id) = (owner.workspace_id, owner.factory_id)
      and (control.failed_at is not null or (rebuilding and complete));
  exception when others then
    processed := 0;
    complete := false;
    outcome := 'failed';
    finish_at := clock_timestamp();
    insert into internal.factory_flow_projection_controls as control
      (workspace_id, factory_id, failed_at, retry_after, failed_attempts)
    values (owner.workspace_id, owner.factory_id, finish_at, finish_at + interval '5 seconds', 1)
    on conflict (workspace_id, factory_id) do update set
      failed_at = excluded.failed_at,
      retry_after = excluded.failed_at + make_interval(secs => least(900, 5 * (2 ^ least(control.failed_attempts, 8)))),
      failed_attempts = least(30, control.failed_attempts + 1);
    raise log 'Factory flow projection batch failed with SQLSTATE %.', sqlstate;
  end;

  if processed > 0 or rebuilding or outcome = 'failed' then
    insert into internal.factory_outcome_projection_watermarks as watermark (
      workspace_id, factory_id, metric_key, metric_revision, last_attempt_at, last_success_at, source_snapshot_at, status
    ) select owner.workspace_id, owner.factory_id, key, 1, snapshot_at,
      case when complete then finish_at end, case when complete then snapshot_at end, outcome
    from unnest(array['request_to_deployment', 'request_to_merge', 'workflow_flow']) key
    on conflict (workspace_id, factory_id, metric_key, metric_revision) do update set
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = coalesce(excluded.last_success_at, watermark.last_success_at),
      source_snapshot_at = coalesce(excluded.source_snapshot_at, watermark.source_snapshot_at),
      status = excluded.status;
  end if;
  return jsonb_build_object('processed', processed, 'hasMore',
    exists (select 1 from internal.next_factory_flow_projection_scope(clock_timestamp())));
end;
$$;

alter function public.get_factory_flow_summary(uuid, uuid, timestamptz, timestamptz, text) set schema internal;
revoke all on function internal.get_factory_flow_summary(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

create function public.get_factory_flow_summary(
  p_workspace_id uuid, p_factory_id uuid, p_from timestamptz, p_to timestamptz, p_environment text default null
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_set(
    internal.get_factory_flow_summary(p_workspace_id, p_factory_id, p_from, p_to, p_environment),
    '{freshness,status}', public.get_factory_flow_projection_health(p_workspace_id, p_factory_id)->'status'
  )
$$;
revoke all on function public.get_factory_flow_summary(uuid, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_flow_summary(uuid, uuid, timestamptz, timestamptz, text) to authenticated;
