begin;
create extension if not exists pgtap with schema extensions;
select plan(12);
set local "request.jwt.claim.role" = 'service_role';
set local "request.jwt.claim.sub" = 'a1b2c3d4-0001-4000-8000-000000000001';

create temp table status_test_sessions as
select i, created.session_id
from generate_series(1, 3) i
cross join lateral public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Status consistency fixture ' || i,
  'status-consistency-rpc-proof', 'codex', 'gpt-5.5', null, null,
  null, 'd1b2c3d4-0001-4000-8000-000000000001'
) created;

-- Creation seeds a queued run; remove only this transaction's generated runs.
delete from public.agent_runs where session_id in (select session_id from status_test_sessions);

insert into public.workspaces (id, slug, name)
values ('f0b2c3d4-0001-4000-8000-000000000001', 'status-other-workspace', 'Other workspace');

insert into public.agent_runs (id, workspace_id, session_id, run_type, model_provider, model_name, status, created_at)
select run.id::uuid, run.workspace_id::uuid, s.session_id, 'stage', 'codex', 'gpt-5.5', run.status::public.agent_run_status, run.created_at::timestamptz
from (values
  ('10000000-0000-4000-8000-000000000001', 'b1b2c3d4-0001-4000-8000-000000000001', 2, 'error', '2026-09-07 10:00:00+00'),
  ('10000000-0000-4000-8000-000000000002', 'b1b2c3d4-0001-4000-8000-000000000001', 2, 'running', '2026-09-07 11:00:00+00'),
  ('10000000-0000-4000-8000-000000000003', 'b1b2c3d4-0001-4000-8000-000000000001', 3, 'success', '2026-09-07 11:00:00+00'),
  ('10000000-0000-4000-8000-000000000004', 'b1b2c3d4-0001-4000-8000-000000000001', 3, 'error', '2026-09-07 11:00:00+00')
) run(id, workspace_id, i, status, created_at)
join status_test_sessions s on s.i = run.i;

-- A separate workspace has matching search text and a later failed run.
insert into public.pipelines (id, workspace_id, name)
values ('f0b2c3d4-0002-4000-8000-000000000001', 'f0b2c3d4-0001-4000-8000-000000000001', 'Other pipeline');
insert into public.pipeline_stages (id, pipeline_id, workspace_id, position, slug, name)
values ('f0b2c3d4-0003-4000-8000-000000000001', 'f0b2c3d4-0002-4000-8000-000000000001', 'f0b2c3d4-0001-4000-8000-000000000001', 1, 'plan', 'Plan');
insert into public.sessions (id, workspace_id, number, title, prompt_md, pipeline_id, current_stage_id)
values ('f0b2c3d4-0004-4000-8000-000000000001', 'f0b2c3d4-0001-4000-8000-000000000001', 1, 'Foreign session', 'status-consistency-rpc-proof', 'f0b2c3d4-0002-4000-8000-000000000001', 'f0b2c3d4-0003-4000-8000-000000000001');
insert into public.agent_runs (workspace_id, session_id, run_type, model_provider, model_name, status, created_at)
values ('f0b2c3d4-0001-4000-8000-000000000001', 'f0b2c3d4-0004-4000-8000-000000000001', 'stage', 'codex', 'gpt-5.5', 'error', '2026-09-07 12:00:00+00');

create temp table status_list as
select public.get_session_list_page('acme-corp', search_query => 'status-consistency-rpc-proof', sort_key => 'number') as payload;

select is(jsonb_array_length(payload->'sessions'), 3, 'all three matching sessions returned') from status_list;
select is(payload->'sessions'->0->>'latestRunStatus', 'error', 'timestamp ties use descending run ID') from status_list;
select is(payload->'sessions'->1->>'latestRunStatus', 'running', 'new retry replaces older error') from status_list;
select is(payload->'sessions'->2->'latestRunStatus', 'null'::jsonb, 'no own runs returns null and ignores foreign workspace runs') from status_list;
select is(payload->>'hasMore', 'false', 'complete page reports no more results') from status_list;
select ok(public.get_session_list_page('status-other-workspace') is null, 'workspace without membership is inaccessible');

create temp table first_status_page as
select public.get_session_list_page('acme-corp', search_query => 'status-consistency-rpc-proof', sort_key => 'number', page_limit => 1) as payload;
select is(payload->>'hasMore', 'true', 'limited page preserves hasMore') from first_status_page;
select is(jsonb_array_length(payload->'sessions'), 1, 'limit is preserved') from first_status_page;
select is(
  (public.get_session_list_page('acme-corp', search_query => 'status-consistency-rpc-proof', sort_key => 'number', page_limit => 1,
    cursor_id => (payload->'sessions'->0->>'id')::uuid,
    cursor_number => (payload->'sessions'->0->>'number')::integer)->'sessions'->0->>'id'),
  (select session_id::text from status_test_sessions where i = 2),
  'number cursor returns next session without duplication'
) from first_status_page;

select results_eq(
  $$ select (row->>'id')::uuid from jsonb_array_elements(public.get_session_list_page('acme-corp', search_query => 'status-consistency-rpc-proof', sort_key => 'oldest')->'sessions') row $$,
  $$ select s.id from sessions s join status_test_sessions t on t.session_id = s.id order by s.updated_at, s.id $$,
  'oldest sort is preserved'
);
select results_eq(
  $$ select (row->>'id')::uuid from jsonb_array_elements(public.get_session_list_page('acme-corp', search_query => 'status-consistency-rpc-proof')->'sessions') row $$,
  $$ select s.id from sessions s join status_test_sessions t on t.session_id = s.id order by s.updated_at desc, s.id desc $$,
  'updated sort is preserved'
);
select ok(not has_function_privilege('anon', 'public.get_session_list_page(text,text,text,text,integer,timestamptz,uuid,text,integer)', 'EXECUTE'), 'anonymous callers remain denied');
select * from finish();
rollback;
