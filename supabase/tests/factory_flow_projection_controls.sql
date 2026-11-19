begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.projection_id(slot integer) returns uuid language sql immutable as $$
  select ('59900000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

do $$
declare batch jsonb;
begin
  for attempt in 1..20 loop
    batch := public.process_factory_flow_projection(50);
    if not (batch->>'hasMore')::boolean then return; end if;
  end loop;
  raise exception 'Could not drain the local seed projections.';
end;
$$;

insert into auth.users(id, email) values
  (pg_temp.projection_id(1), 'projection-owner@example.test'),
  (pg_temp.projection_id(2), 'projection-member@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.projection_id(4), 'projection-controls', 'Projection controls');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.projection_id(11), pg_temp.projection_id(4), pg_temp.projection_id(1), 'human', 'owner'),
  (pg_temp.projection_id(12), pg_temp.projection_id(4), pg_temp.projection_id(2), 'human', 'member');
select public.create_factory(pg_temp.projection_id(4), pg_temp.projection_id(1), 'Managed factory', 'managed-projection');
select public.create_factory(pg_temp.projection_id(4), pg_temp.projection_id(1), 'Sibling factory', 'sibling-projection');
create temp table projection_scopes as
select slug, id from public.factories where workspace_id = pg_temp.projection_id(4) and not is_default;
grant select on projection_scopes to authenticated;

create function pg_temp.projection_factory(p_slug text default 'managed-projection') returns uuid language sql stable as $$
  select id from projection_scopes where slug = p_slug
$$;
select public.grant_factory_membership(pg_temp.projection_id(4), pg_temp.projection_factory(),
  pg_temp.projection_id(1), pg_temp.projection_id(12), 'member');
insert into public.pipelines(id, workspace_id, factory_id, name)
values (pg_temp.projection_id(20), pg_temp.projection_id(4), pg_temp.projection_factory(), 'Managed pipeline'),
  (pg_temp.projection_id(21), pg_temp.projection_id(4), pg_temp.projection_factory('sibling-projection'), 'Sibling pipeline');
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md)
values (pg_temp.projection_id(30), pg_temp.projection_id(20), pg_temp.projection_id(4), 1, 'build', 'Build', 'Build the change.'),
  (pg_temp.projection_id(31), pg_temp.projection_id(21), pg_temp.projection_id(4), 1, 'build', 'Build', 'Build other work.');

create function pg_temp.create_projection_session(slot integer, sibling boolean default false) returns void language sql as $$
  insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id, created_at)
  values (pg_temp.projection_id(slot), pg_temp.projection_id(4),
    pg_temp.projection_factory(case when sibling then 'sibling-projection' else 'managed-projection' end),
    slot, 'Projection fixture ' || slot, pg_temp.projection_id(11),
    pg_temp.projection_id(case when sibling then 21 else 20 end), pg_temp.projection_id(case when sibling then 31 else 30 end),
    transaction_timestamp() - interval '1 hour');
$$;
select pg_temp.create_projection_session(100);
insert into public.agent_runs(id, workspace_id, session_id, stage_id, run_type, model_provider, model_name,
  status, attempt_count, started_at)
values (pg_temp.projection_id(301), pg_temp.projection_id(4), pg_temp.projection_id(100), pg_temp.projection_id(30),
  'code', 'codex', 'gpt-5.5', 'running', 1, transaction_timestamp() - interval '50 minutes');
update public.agent_runs set status = 'success', finished_at = transaction_timestamp() - interval '30 minutes'
where id = pg_temp.projection_id(301);
select public.process_factory_flow_projection(25);
create temp table prior_projection as
select * from internal.factory_flow_projection_segments where session_id = pg_temp.projection_id(100);

create function pg_temp.projection_health(p_slug text default 'managed-projection') returns jsonb language sql stable as $$
  select public.get_factory_flow_projection_health(pg_temp.projection_id(4), pg_temp.projection_factory(p_slug))
$$;
create function pg_temp.control_projection(p_action text) returns jsonb language sql as $$
  select public.control_factory_flow_projection(pg_temp.projection_id(4), pg_temp.projection_factory(), p_action)
$$;

select ok(not has_function_privilege('anon', 'public.get_factory_flow_projection_health(uuid,uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.control_factory_flow_projection(uuid,uuid,text)', 'execute')
  and not has_table_privilege('authenticated', 'internal.factory_flow_projection_controls', 'select,insert,update,delete'),
  'health is signed-in and controls cannot bypass current manager authorization through direct writes');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '59900000-0000-4000-8000-000000000002';
select ok((select result->>'status' = 'ready' and result->'canManage' = 'false'::jsonb
  and result->'oldestPendingAt' = 'null'::jsonb from (select pg_temp.projection_health() result) health),
  'an ordinary delegated member can read current health without management rights');
select throws_ok($$select pg_temp.control_projection('pause')$$, 'PT404', null,
  'an ordinary member cannot pause the projection');
select throws_ok($$select pg_temp.projection_health('sibling-projection')$$, 'PT404', null,
  'an ungranted sibling factory has no visible projection status');

set local request.jwt.claim.sub = '59900000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.control_projection('pause-execution')$$, '22023', null,
  'the analytics control accepts only its three projection actions');
create temp table pause_receipt as select pg_temp.control_projection('pause') result;
select ok((select result->>'status' = 'paused' and result->'canManage' = 'true'::jsonb
  and result->>'pausedAt' is not null from pause_receipt), 'a manager can pause analysis without pausing the factory');
select is(pg_temp.control_projection('pause')->>'pausedAt', (select result->>'pausedAt' from pause_receipt),
  'replaying pause preserves the first pause timestamp');

reset role;
set local request.jwt.claim.role = 'service_role';
select pg_temp.create_projection_session(101);
select pg_temp.create_projection_session(201, true);
create temp table authoritative_before as
select 'session'::text kind, session.id, to_jsonb(session) payload from public.sessions session
where (session.workspace_id, session.factory_id) = (pg_temp.projection_id(4), pg_temp.projection_factory())
union all select 'run', run.id, to_jsonb(run) from public.agent_runs run where run.id = pg_temp.projection_id(301)
union all select 'observation', fact.id, to_jsonb(fact) from internal.factory_outcome_observations fact
where (fact.workspace_id, fact.factory_id) = (pg_temp.projection_id(4), pg_temp.projection_factory());

select ok((select (result->>'processed')::integer = 1 and result->'hasMore' = 'false'::jsonb
  from (select public.process_factory_flow_projection(25) result) batch),
  'work in the paused factory does not hide another eligible factory');
select ok(exists (select 1 from internal.factory_flow_projection_dirty_sessions where session_id = pg_temp.projection_id(101))
  and exists (select 1 from internal.factory_flow_projection_sessions where session_id = pg_temp.projection_id(201)),
  'new source observations remain queued during pause while the sibling advances');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '59900000-0000-4000-8000-000000000001';
select ok((select health->>'status' = 'paused' and health->>'oldestPendingAt' is not null
  and (health->>'lagSeconds')::numeric >= 0
  from (select pg_temp.projection_health() health) state),
  'health identifies the exact pending input and its delay during pause');
select is(public.get_factory_flow_summary(pg_temp.projection_id(4), pg_temp.projection_factory(),
  transaction_timestamp() - interval '2 hours', transaction_timestamp()) #>> '{freshness,status}', 'paused',
  'the same pause status is visible through the shared Analytics summary');
create temp table rebuild_receipt as select pg_temp.control_projection('rebuild') result;
select ok((select result->>'status' = 'paused' and result #>> '{rebuild,state}' = 'queued'
  from rebuild_receipt), 'a durable rebuild can be requested while paused without resuming the projection');
select is(pg_temp.control_projection('rebuild') #>> '{rebuild,requestedAt}',
  (select result #>> '{rebuild,requestedAt}' from rebuild_receipt), 'an already active rebuild remains a single request');
select is((public.enqueue_factory_flow_rebuild(pg_temp.projection_id(4), pg_temp.projection_factory(), p_limit => 1)->>'enqueued')::integer,
  1, 'the existing bounded manual rebuild command remains available');
select is(pg_temp.control_projection('resume')->>'status', 'building',
  'resuming a factory picks up retained observations and scheduled rebuild work');

reset role;
set local request.jwt.claim.role = 'service_role';
select is((public.process_factory_flow_projection(1)->>'processed')::integer, 1,
  'the durable worker uses a bounded batch instead of rebuilding all sessions at once');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is(pg_temp.projection_health() #>> '{rebuild,state}', 'building', 'the next batch can recover the durable cursor');
reset role;
set local request.jwt.claim.role = 'service_role';
do $$
declare batch jsonb;
begin
  for attempt in 1..10 loop
    batch := public.process_factory_flow_projection(1);
    if not (batch->>'hasMore')::boolean then return; end if;
  end loop;
  raise exception 'Could not finish the bounded fixture rebuild.';
end;
$$;
select results_eq($$select * from internal.factory_flow_projection_segments
  where session_id = pg_temp.projection_id(100) order by started_at$$,
  $$select * from prior_projection order by started_at$$, 'bounded rebuild reproduces exact source intervals and observation IDs');
select results_eq($$select * from authoritative_before order by kind, id$$, $$
  select * from (
    select 'session'::text kind, session.id, to_jsonb(session) payload from public.sessions session
    where (session.workspace_id, session.factory_id) = (pg_temp.projection_id(4), pg_temp.projection_factory())
    union all select 'run', run.id, to_jsonb(run) from public.agent_runs run where run.id = pg_temp.projection_id(301)
    union all select 'observation', fact.id, to_jsonb(fact) from internal.factory_outcome_observations fact
    where (fact.workspace_id, fact.factory_id) = (pg_temp.projection_id(4), pg_temp.projection_factory())
  ) source order by kind, id$$,
  'pause, resume and rebuild leave authoritative sessions, runs and observation rows exactly unchanged');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
create temp table ready_receipt as select pg_temp.projection_health() result;
select ok((select result->>'status' = 'ready' and result #>> '{rebuild,state}' = 'completed'
  and (result #>> '{rebuild,completedAt}')::timestamptz >= (result #>> '{rebuild,requestedAt}')::timestamptz
  and result->>'sourceSnapshotAt' is not null from ready_receipt),
  'a rebuild completes only after its entire cohort is projected and a coherent snapshot is recorded');
select pg_temp.control_projection('rebuild');

reset role;
set local request.jwt.claim.role = 'service_role';
select pg_temp.create_projection_session(102);
select pg_temp.create_projection_session(202, true);
create function pg_temp.fail_projection_once() returns trigger language plpgsql as $$
begin
  if new.session_id = pg_temp.projection_id(100) then
    raise exception 'Injected disposable projection failure';
  end if;
  return new;
end;
$$;
create trigger fail_projection_fixture before insert or update on internal.factory_flow_projection_sessions
  for each row execute function pg_temp.fail_projection_once();
select ok((select (result->>'processed')::integer = 0 and result->'hasMore' = 'true'::jsonb
  from (select public.process_factory_flow_projection(25) result) batch),
  'a failed batch rolls back its projection mutations and leaves independent work runnable');
select ok(exists (select 1 from internal.factory_flow_projection_dirty_sessions where session_id = pg_temp.projection_id(102))
  and not exists (select 1 from internal.factory_flow_projection_sessions where session_id = pg_temp.projection_id(102)),
  'a failed batch does not lose pending source observations or expose a partial snapshot');
select is((public.process_factory_flow_projection(25)->>'processed')::integer, 1,
  'failure backoff allows the healthy sibling to continue');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok((select health->>'status' = 'failed' and (health->>'failedAttempts')::integer = 1
  and (health->>'retryAfter')::timestamptz > (health->>'failedAt')::timestamptz
  and health #>> '{rebuild,state}' = 'queued' and health->>'sourceSnapshotAt' = ready.result->>'sourceSnapshotAt'
  from ready_receipt ready cross join (select pg_temp.projection_health() health) state),
  'failure and pending rebuild remain honest while the last coherent snapshot is retained');
select is(public.get_factory_flow_summary(pg_temp.projection_id(4), pg_temp.projection_factory(),
  transaction_timestamp() - interval '2 hours', transaction_timestamp()) #>> '{freshness,status}', 'failed',
  'failed projection health also reaches the shared Analytics summary');

reset role;
set local request.jwt.claim.role = 'service_role';
select pg_temp.create_projection_session(203, true);
update internal.factory_flow_projection_dirty_sessions set queued_at = clock_timestamp() - interval '3 seconds'
where session_id = pg_temp.projection_id(203);
update internal.factory_flow_projection_controls set
  failed_at = clock_timestamp() - interval '2 seconds', retry_after = clock_timestamp() - interval '1 second'
where (workspace_id, factory_id) = (pg_temp.projection_id(4), pg_temp.projection_factory());
select is((public.process_factory_flow_projection(25)->>'processed')::integer, 1,
  'when the backoff expired between ticks, older healthy work still runs before the retry');
drop trigger fail_projection_fixture on internal.factory_flow_projection_sessions;
select is((public.process_factory_flow_projection(25)->>'processed')::integer, 3,
  'after backoff the same durable rebuild retries from its original cursor and includes late source work');
select ok(exists (select 1 from internal.factory_flow_projection_sessions where session_id = pg_temp.projection_id(102))
  and (select count(*) from internal.factory_flow_projection_sessions
    where session_id in (pg_temp.projection_id(202), pg_temp.projection_id(203))) = 2,
  'both the recovered and independently healthy factory retain their new data');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok((select result->>'status' = 'ready' and (result->>'failedAttempts')::integer = 0
  and result->'retryAfter' = 'null'::jsonb and result #>> '{rebuild,state}' = 'completed'
  from (select pg_temp.projection_health() result) recovered), 'recovery replaces failure and backoff with a coherent ready snapshot');

reset role;
select * from finish();
rollback;
