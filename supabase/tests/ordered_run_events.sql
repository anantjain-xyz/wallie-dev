begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.event_fixture(fixture integer, owner_workspace uuid default 'b1b2c3d4-0001-4000-8000-000000000001')
returns table(session_id uuid, job_id uuid, run_id uuid) language plpgsql as $$
declare owner public.sessions; work public.agent_jobs; execution public.agent_runs;
begin
  insert into public.sessions(workspace_id, number, title, prompt_md, pipeline_id, current_stage_id)
  select stage.workspace_id, 99005310 + fixture, 'Run event proof ' || fixture, 'Exercise ordered run capture',
    stage.pipeline_id, stage.id
  from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id = stage.pipeline_id
  where stage.workspace_id = owner_workspace and pipeline.is_default and stage.slug = 'plan'
  returning * into strict owner;
  insert into public.agent_jobs(workspace_id, session_id, stage_id, stage_slug, stage_name, trigger_type, status, attempt_count)
  select owner.workspace_id, owner.id, stage.id, stage.slug, stage.name, 'assignment', 'running', 1
  from public.pipeline_stages stage where stage.id = owner.current_stage_id returning * into strict work;
  insert into public.agent_runs(workspace_id, session_id, agent_job_id, stage_id, stage_slug, stage_name,
    model_provider, model_name, run_type, status, attempt_count, started_at, last_activity_at)
  values (owner.workspace_id, owner.id, work.id, work.stage_id, work.stage_slug, work.stage_name,
    'codex', 'gpt-5.5', 'project', 'running', 1, now(), '2026-01-01T00:00:00Z')
  returning * into strict execution;
  return query select owner.id, work.id, execution.id;
end;
$$;

create temp table event_owner as select * from pg_temp.event_fixture(1);
create temp table other_owner as select * from pg_temp.event_fixture(2);
create temp table cursor_owner as select * from pg_temp.event_fixture(4);
create temp table paused_capture_owner as select * from pg_temp.event_fixture(5);
create temp table foreign_workspace as
with inserted as (
  insert into public.workspaces(slug, name) values ('ordered-run-event-proof', 'Other event workspace') returning id
) select id from inserted;
create temp table foreign_pipeline as
with inserted as (
  insert into public.pipelines(workspace_id, name, is_default)
  select id, 'Event proof', true from foreign_workspace returning id, workspace_id
) select * from inserted;
insert into public.pipeline_stages(workspace_id, pipeline_id, slug, name, position, prompt_template_md)
select workspace_id, id, 'plan', 'Plan', 1, 'Plan the task' from foreign_pipeline;
insert into public.workspace_members(workspace_id, user_id, kind, role)
select id, 'a1b2c3d4-0002-4000-8000-000000000002', 'human', 'member' from foreign_workspace;
create temp table foreign_owner as select * from pg_temp.event_fixture(3, (select id from foreign_workspace));
grant select on event_owner, other_owner, cursor_owner, paused_capture_owner, foreign_owner, foreign_workspace
  to authenticated, service_role;

select ok((select relrowsecurity from pg_class where oid = 'public.agent_run_events'::regclass),
  'event history enables row level security');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc
  where oid = 'public.append_agent_run_event(uuid,uuid,integer,integer,text,jsonb,boolean,integer)'::regprocedure),
  'append uses a guarded definer with an empty search path');
select ok(has_function_privilege('service_role',
  'public.append_agent_run_event(uuid,uuid,integer,integer,text,jsonb,boolean,integer)', 'EXECUTE'),
  'service role can append through the RPC');
select ok(not has_function_privilege(role_name,
  'public.append_agent_run_event(uuid,uuid,integer,integer,text,jsonb,boolean,integer)', 'EXECUTE'),
  role_name || ' cannot append through the RPC') from (values ('anon'), ('authenticated')) roles(role_name);
select ok(not has_table_privilege(role_name, 'public.agent_run_events', privilege),
  role_name || ' cannot directly ' || privilege || ' event history')
from (values ('anon'), ('authenticated'), ('service_role')) roles(role_name)
cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) privileges(privilege);

select ok(has_function_privilege('service_role',
  'public.touch_agent_run_activity(uuid,uuid,integer)', 'EXECUTE'),
  'service role can refresh exact run activity while capture is paused');
select ok(not has_function_privilege(role_name,
  'public.touch_agent_run_activity(uuid,uuid,integer)', 'EXECUTE'),
  role_name || ' cannot refresh run activity')
from (values ('anon'), ('authenticated')) roles(role_name);

set local role service_role;
select ok(public.append_agent_run_event(job_id, run_id, 1, 2, 'progress', '{"text":"second"}', false, 1),
  'a later event can arrive before its causal predecessor') from event_owner;
select ok(public.append_agent_run_event(job_id, run_id, 1, 1, 'text', '{"text":"first"}', false),
  'an earlier sequence can arrive later') from event_owner;
select is((select array_agg(sequence order by sequence) from public.agent_run_events
  where agent_run_id = (select run_id from event_owner)), array[1,2], 'sequence restores source order');
select is((select causation_sequence from public.agent_run_events
  where agent_run_id = (select run_id from event_owner) and sequence = 2), 1, 'causation is retained without arrival-order constraints');
select is((select schema_version::integer from public.agent_run_events
  where agent_run_id = (select run_id from event_owner) and sequence = 1), 1, 'events carry envelope version one');
select ok((select last_activity_at > '2026-01-01T00:00:00Z' from public.agent_runs
  where id = (select run_id from event_owner)), 'an accepted event refreshes run activity');

select ok(public.append_agent_run_event(job_id, run_id, 1, 1, 'text', '{"text":"first"}', false),
  'identical delivery succeeds idempotently') from event_owner;
select is((select count(*) from public.agent_run_events where agent_run_id = (select run_id from event_owner)),
  2::bigint, 'replay does not duplicate an envelope');
select ok(not public.append_agent_run_event(job_id, run_id, 1, 1, 'text', '{"text":"changed"}', false),
  'conflicting payload fails closed') from event_owner;
select ok(not public.append_agent_run_event(job_id, run_id, 1, 1, 'progress', '{"text":"first"}', false),
  'conflicting kind fails closed') from event_owner;
select ok(not public.append_agent_run_event(job_id, run_id, 1, 1, 'text', '{"text":"first"}', true),
  'conflicting truncation fails closed') from event_owner;
select ok(not public.append_agent_run_event(job_id, run_id, 1, 2, 'progress', '{"text":"second"}', false),
  'conflicting causation fails closed') from event_owner;
select is((select payload->>'text' from public.agent_run_events
  where agent_run_id = (select run_id from event_owner) and sequence = 1),
  'first', 'conflicts leave the original event intact');

select ok(public.append_agent_run_event(job_id, run_id, 1, 3, 'tool_call', '{"tool":"read_file","input":"README.md"}', false, 1),
  'ordered tool calls retain their input') from event_owner;
select ok(public.append_agent_run_event(job_id, run_id, 1, event_sequence, 'terminal', jsonb_build_object('status', terminal_status),
  false), 'terminal event accepts ' || terminal_status)
from event_owner cross join (values (4,'completed'), (5,'incomplete'), (6,'failed')) terminals(event_sequence, terminal_status);
select ok(public.append_agent_run_event(job_id, run_id, 1, 7, 'capture_gap', '{"reason":"unsupported_event"}', true),
  'capture gaps retain truncation') from event_owner;
select ok(public.append_agent_run_event(job_id, run_id, 1, 8, 'capture_end', '{"status":"complete"}', false),
  'capture completion is a distinct event') from event_owner;
select ok(public.append_agent_run_event(job_id, run_id, 1, 8, 'capture_end', '{"status":"complete"}', false),
  'capture completion replays idempotently') from event_owner;
select throws_ok(format('select public.append_agent_run_event(%L,%L,1,9,%L,%L,false)',
  job_id, run_id, 'text', jsonb_build_object('text', repeat('x', 16384))), '23514', 'Invalid run event envelope.',
  'oversized payloads are rejected before persistence') from event_owner;
select throws_ok(format('select public.append_agent_run_event(%L,%L,1,9,%L,%L,false)',
  job_id, run_id, 'unknown', '{}'), '23514', 'Invalid run event envelope.', 'unknown event kinds are rejected') from event_owner;
select throws_ok(format('select public.append_agent_run_event(%L,%L,1,9,%L,%L,false,9)',
  job_id, run_id, 'text', '{}'), '23514', 'Invalid run event envelope.', 'self or forward causation is rejected') from event_owner;
select throws_ok(format('select public.append_agent_run_event(%L,%L,1,9,%L,%L,false)',
  job_id, run_id, 'text', '[]'), '23514', 'Invalid run event envelope.', 'payloads must be objects') from event_owner;
select is((select count(*) from public.agent_run_events where agent_run_id = (select run_id from event_owner)),
  8::bigint, 'invalid envelopes leave the event log unchanged');
select ok(public.append_agent_run_event(job_id, run_id, 1, 9, 'tool_result', '{"text":"file contents"}', false, 3),
  'tool results retain their originating call') from event_owner;
select ok(public.append_agent_run_event(job_id, run_id, 1, 10, 'usage', '{"inputTokens":2,"outputTokens":1}', false, 4),
  'usage retains its originating terminal event') from event_owner;

select ok(public.append_agent_run_event(job_id, run_id, 1, 1, 'tool_call',
  '{"tool":"shell","input":"pwd"}', false),
  'a Cursor tool call appends its envelope') from cursor_owner;
select ok(public.append_agent_run_event(job_id, run_id, 1, 2, 'tool_result',
  '{"tool":"shell","output":"/workspace","status":"success","exitCode":0}', false, 1),
  'a Cursor tool result appends its envelope') from cursor_owner;
select ok((select causation_sequence = 1 and attempt_count = 1 from public.agent_run_events
  where agent_run_id = (select run_id from cursor_owner) and sequence = 2),
  'the tool result is attached to its exact run, attempt, and originating call');
select ok(public.append_agent_run_event(job_id, run_id, 1, 2, 'tool_result',
  '{"tool":"shell","output":"/workspace","status":"success","exitCode":0}', false, 1),
  'a tool result replays idempotently') from cursor_owner;
select is((select count(*) from public.agent_run_events where agent_run_id = (select run_id from cursor_owner)),
  2::bigint, 'replaying a tool result does not duplicate an envelope');
select ok(not public.append_agent_run_event(job_id, run_id, 1, 2, 'tool_result',
  '{"tool":"shell","output":"changed","status":"success","exitCode":0}', false, 1),
  'a tool result cannot overwrite its retained output') from cursor_owner;
select ok(not public.append_agent_run_event(job_id, run_id, 2, 1, 'text', '{"text":"future"}', false),
  'an unclaimed future attempt is refused') from event_owner;
select ok(not public.append_agent_run_event((select job_id from other_owner), run_id, 1, 1, 'text', '{"text":"wrong job"}', false),
  'another job cannot attach events to this run') from event_owner;
select ok(public.append_agent_run_event(job_id, run_id, 1, 1, 'text', '{"text":"other workspace"}', false),
  'service role records a separately owned workspace event') from foreign_owner;
select ok(public.touch_agent_run_activity(job_id, run_id, 1),
  'paused capture still refreshes activity under the exact claim') from paused_capture_owner;
select is((select count(*) from public.agent_run_events where agent_run_id = (select run_id from paused_capture_owner)),
  0::bigint, 'an activity refresh writes no ordered events');
select is((select count(*) from public.agent_run_messages where agent_run_id = (select run_id from paused_capture_owner)),
  0::bigint, 'an activity refresh writes no compatibility messages');
select ok((select last_activity_at > '2026-01-01T00:00:00Z' from public.agent_runs
  where id = (select run_id from paused_capture_owner)), 'paused capture maintains activity');
reset role;

update public.agent_runs set status = 'error' where id = (select run_id from event_owner);
update public.agent_jobs set attempt_count = 2 where id = (select job_id from event_owner);
create temp table replacement_run as
with inserted as (
  insert into public.agent_runs(workspace_id, session_id, agent_job_id, stage_id, stage_slug, stage_name,
    model_provider, model_name, run_type, status, attempt_count)
  select workspace_id, session_id, id, stage_id, stage_slug, stage_name, 'codex', 'gpt-5.5', 'project', 'running', 2
  from public.agent_jobs where id = (select job_id from event_owner) returning id
) select id from inserted;
grant select on replacement_run to service_role;
set local role service_role;
select ok(not public.append_agent_run_event(job_id, run_id, 1, 11, 'text', '{"text":"late"}', false),
  'the superseded attempt cannot append') from event_owner;
select ok(not public.append_agent_run_event(job_id, (select id from replacement_run), 1, 1, 'text', '{"text":"late"}', false),
  'an old claim cannot cross-attach to the replacement run') from event_owner;
select ok(not public.append_agent_run_event(job_id, run_id, 2, 1, 'text', '{"text":"wrong run"}', false),
  'a new claim cannot reuse the old run') from event_owner;
select ok(public.append_agent_run_event(job_id, (select id from replacement_run), 2, 1, 'text', '{"text":"new attempt"}', false),
  'the exact replacement attempt starts its own sequence') from event_owner;
reset role;
update public.agent_runs set status = 'error' where id = (select id from replacement_run);
set local role service_role;
select ok(not public.append_agent_run_event(job_id, (select id from replacement_run), 2, 2, 'text', '{"text":"terminal"}', false),
  'a terminal run refuses new producer events') from event_owner;
reset role;
update public.agent_jobs set status = 'error' where id = (select job_id from other_owner);
set local role service_role;
select ok(not public.append_agent_run_event(job_id, run_id, 1, 1, 'text', '{"text":"terminal job"}', false),
  'a terminal job refuses producer events even if its run remains active') from other_owner;
reset role;

update public.agent_runs set status = 'canceled' where id = (select run_id from paused_capture_owner);
update public.agent_jobs set attempt_count = 2 where id = (select job_id from paused_capture_owner);
set local role service_role;
select ok(not public.touch_agent_run_activity(job_id, run_id, 1),
  'the canceled attempt cannot refresh its activity') from paused_capture_owner;
select ok(not public.touch_agent_run_activity(job_id, run_id, 2),
  'a replacement claim cannot refresh the canceled run') from paused_capture_owner;
reset role;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.agent_run_events where agent_run_id = (select run_id from event_owner)),
  10::bigint, 'a workspace member reads retained event history');
select is((select count(*) from public.agent_run_events where agent_run_id = (select run_id from foreign_owner)),
  0::bigint, 'membership in one workspace does not expose another workspace');
select throws_ok(format('select public.append_agent_run_event(%L,%L,1,1,%L,%L,false)',
  job_id, run_id, 'text', '{}'), '42501', 'permission denied for function append_agent_run_event',
  'browser callers cannot invoke the privileged append function') from event_owner;
set local request.jwt.claim.sub = 'a1b2c3d4-0002-4000-8000-000000000002';
select is((select count(*) from public.agent_run_events where agent_run_id = (select run_id from foreign_owner)),
  1::bigint, 'the other workspace member reads its own event');
set local request.jwt.claim.sub = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
select is((select count(*) from public.agent_run_events), 0::bigint, 'a user with no membership reads no events');
reset role;
set local role anon;
select throws_ok('select * from public.agent_run_events', '42501', 'permission denied for table agent_run_events',
  'anonymous callers cannot read event history');
reset role;
set local request.jwt.claim.role = 'service_role';

delete from public.agent_runs where id = (select run_id from foreign_owner);
select is((select count(*) from public.agent_run_events where agent_run_id = (select run_id from foreign_owner)),
  0::bigint, 'run deletion cascades to captured events');

select * from finish();
rollback;
