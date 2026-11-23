begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 66310000
\ir fixtures/factory_automation_dry_run.psql

create temp table issue_automation_rule as
select scope.*, (draft.value->>'automationId')::uuid as automation_id, (draft.value->>'draftRevisionId')::uuid as revision_id
from op651_scope scope
cross join lateral (select pg_temp.create_dry_run_automation(101, pg_temp.dry_run_definition('issue-state')) as value) draft;
select public.publish_factory_automation(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id)
from issue_automation_rule;

insert into public.sessions(id, workspace_id, pipeline_id, current_stage_id, number, title, linear_issue_id, phase_status)
select pg_temp.op651_id(1000 + linked.position), pg_temp.op651_id(11), pg_temp.op651_id(31), pg_temp.op651_id(32),
  2000 + linked.position, 'Linked issue ' || linked.position, case linked.position
    when 1 then 'TEST-1'
    when 2 then pg_temp.op651_id(501)::text
    when 3 then 'TEST-2'
    when 51 then 'RENAMED-1'
    else 'OTHER-' || linked.position end, 'in_progress'
from generate_series(1, 52) linked(position);

create function pg_temp.issue_page(p_first integer, p_last integer) returns uuid[] language sql as $$
  select array_agg(pg_temp.op651_id(1000 + item) order by item) from generate_series(p_first, p_last) item
$$;
create function pg_temp.issue_span(
  p_link integer, p_issue integer, p_span text, p_state text, p_started_at text, p_updated_at text, p_project text default null
) returns jsonb language sql as $$
  select jsonb_build_object('sessionId', session.id, 'linkedIssueId', session.linear_issue_id,
    'issueId', pg_temp.op651_id(p_issue), 'spanId', p_span, 'stateId', p_state, 'teamId', 'platform',
    'projectId', p_project, 'startedAt', p_started_at, 'issueUpdatedAt', p_updated_at)
  from public.sessions session where session.id = pg_temp.op651_id(1000 + p_link)
$$;

select ok(has_function_privilege('service_role', 'public.commit_linear_automation_span_page(bigint,uuid[],jsonb,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.commit_linear_automation_span_page(bigint,uuid[],jsonb,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.read_linear_automation_span_cursor(uuid)', 'execute'),
  'only the worker can read or commit Linear automation scans');
select ok(generation = 0 and after_session_id is null, 'a new scoped scan begins at the first linked session')
from public.read_linear_automation_span_cursor(pg_temp.op651_id(11));

select ok(generation = 1 and after_session_id = pg_temp.op651_id(1050) and occurrence_count = 0,
  'the first linked page commits and keeps current spans as a baseline')
from public.commit_linear_automation_span_page(0, pg_temp.issue_page(1, 50), jsonb_build_array(
  pg_temp.issue_span(1, 501, 'initial-a', 'in-progress', '2026-11-22T10:00:00Z', '2026-11-22T10:30:00Z'),
  pg_temp.issue_span(2, 501, 'initial-a', 'in-progress', '2026-11-22T10:00:00Z', '2026-11-22T10:30:00Z'),
  pg_temp.issue_span(3, 502, 'initial-b', 'in-progress', '2026-11-22T10:00:00Z', '2026-11-22T10:30:00Z')
), pg_temp.op651_id(11));
select is((select count(*) from internal.issue_automation_state_spans where workspace_id = pg_temp.op651_id(11) and baseline),
  2::bigint, 'an identifier and canonical UUID for one issue freeze a single baseline');
select throws_ok($$
  select public.commit_linear_automation_span_page(1, pg_temp.issue_page(51, 52), jsonb_build_array(
    jsonb_set(pg_temp.issue_span(51, 501, 'left-a', 'todo', '2026-11-22T11:00:00Z', '2026-11-22T11:00:00Z'),
      '{linkedIssueId}', '"not-the-linked-issue"')
  ), pg_temp.op651_id(11))
$$, 'PT409', null, 'a mismatched provider reconciliation cannot consume the page');
select ok(generation = 1 and after_session_id = pg_temp.op651_id(1050),
  'failure preserves the exact durable continuation for the next worker')
from public.read_linear_automation_span_cursor(pg_temp.op651_id(11));
select ok(generation = 0 and after_session_id is null, 'the global scan has its own durable cursor')
from public.read_linear_automation_span_cursor();
select ok(generation = 2 and after_session_id is null and occurrence_count = 0,
  'restart resumes at the saved next page and wraps after the nonmatching leave span')
from public.commit_linear_automation_span_page(1, pg_temp.issue_page(51, 52), jsonb_build_array(
  pg_temp.issue_span(51, 501, 'left-a', 'todo', '2026-11-22T11:00:00Z', '2026-11-22T11:00:00Z')
), pg_temp.op651_id(11));

select throws_ok($$
  select public.commit_linear_automation_span_page(2, pg_temp.issue_page(1, 50), jsonb_build_array(
    pg_temp.issue_span(1, 501, 'returned-a', 'in-progress', '2026-11-22T12:00:00Z', '2026-11-22T12:00:00Z'),
    pg_temp.issue_span(3, 502, 'initial-b', 'todo', '2026-11-22T10:00:00Z', '2026-11-22T12:00:00Z')
  ), pg_temp.op651_id(11))
$$, '22023', 'An issue automation state span changed identity.',
  'a later inconsistent span aborts the entire page, including earlier eligible work');
select ok(generation = 2 and after_session_id is null, 'an aborted eligible page does not consume its cursor')
from public.read_linear_automation_span_cursor(pg_temp.op651_id(11));
select is((select count(*) from internal.factory_automation_occurrences where workspace_id = pg_temp.op651_id(11)),
  0::bigint, 'failure rolls back an occurrence staged earlier on the same page');

select ok(generation = 3 and after_session_id = pg_temp.op651_id(1050) and occurrence_count = 1,
  'a true return to the matching state creates one occurrence under its new span ID')
from public.commit_linear_automation_span_page(2, pg_temp.issue_page(1, 50), jsonb_build_array(
  pg_temp.issue_span(1, 501, 'returned-a', 'in-progress', '2026-11-22T12:00:00Z', '2026-11-22T12:00:00Z'),
  pg_temp.issue_span(2, 501, 'returned-a', 'in-progress', '2026-11-22T12:00:00Z', '2026-11-22T12:00:00Z')
), pg_temp.op651_id(11));
select throws_ok($$
  select public.commit_linear_automation_span_page(2, pg_temp.issue_page(1, 50), '[]', pg_temp.op651_id(11))
$$, 'PT409', null, 'an older worker cannot commit under an out-of-date cursor generation');
select ok(generation = 4 and after_session_id is null and occurrence_count = 0,
  'unrelated project edits on the same span do not create or alter an occurrence')
from public.commit_linear_automation_span_page(3, pg_temp.issue_page(51, 52), jsonb_build_array(
  pg_temp.issue_span(51, 501, 'returned-a', 'in-progress', '2026-11-22T12:00:00Z', '2026-11-22T13:00:00Z', 'moved-project')
), pg_temp.op651_id(11));
select is(event->'projectId', 'null'::jsonb, 'the admitted event retains the project context from its first observation')
from internal.factory_automation_occurrences where workspace_id = pg_temp.op651_id(11);
select ok(generation = 5 and occurrence_count = 0, 'a previously unobserved but older provider snapshot cannot re-arm a rule')
from public.commit_linear_automation_span_page(4, pg_temp.issue_page(1, 50), jsonb_build_array(
  pg_temp.issue_span(1, 501, 'stale-a', 'in-progress', '2026-11-22T11:30:00Z', '2026-11-22T11:45:00Z')
), pg_temp.op651_id(11));
select is((select count(*) from internal.issue_automation_state_spans
  where workspace_id = pg_temp.op651_id(11) and source_span_id = 'stale-a'), 0::bigint,
  'the stale snapshot does not replace or extend durable issue history');
select is(public.admit_next_factory_automation_occurrence()->>'status', 'admitted',
  'the return span flows through the common worker command');
select is(public.admit_next_factory_automation_occurrence(), null::jsonb, 'the worker has no duplicate issue occurrence to admit');
select is((select count(*) from internal.factory_automation_occurrences where workspace_id = pg_temp.op651_id(11)), 1::bigint,
  'the complete reconciliation leaves exactly one logical occurrence');

select * from finish();
rollback;
