begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';

insert into public.workspaces(id, slug, name) values
  ('53400000-0001-4000-8000-000000000001', 'run-catalog-fixture', 'Run catalog fixture'),
  ('53400000-0001-4000-8000-000000000002', 'run-catalog-foreign', 'Foreign catalog');
insert into public.workspace_members(workspace_id, user_id, kind, role) values
  ('53400000-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001', 'human', 'owner'),
  ('53400000-0001-4000-8000-000000000002', 'a1b2c3d4-0002-4000-8000-000000000002', 'human', 'owner');
insert into public.pipelines(id, workspace_id, name)
select id, id, 'Catalog pipeline' from public.workspaces
where id in ('53400000-0001-4000-8000-000000000001', '53400000-0001-4000-8000-000000000002');
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values
  ('53400000-0002-4000-8000-000000000001', '53400000-0001-4000-8000-000000000001', '53400000-0001-4000-8000-000000000001', 1, 'plan', 'Plan'),
  ('53400000-0002-4000-8000-000000000002', '53400000-0001-4000-8000-000000000001', '53400000-0001-4000-8000-000000000001', 2, 'build', 'Build'),
  ('53400000-0002-4000-8000-000000000003', '53400000-0001-4000-8000-000000000002', '53400000-0001-4000-8000-000000000002', 1, 'plan', 'Plan');
insert into public.sessions(id, workspace_id, number, title, prompt_md, pipeline_id, current_stage_id) values
  ('53400000-0003-4000-8000-000000000001', '53400000-0001-4000-8000-000000000001', 1, repeat('界', 600), 'private-prompt-marker',
   '53400000-0001-4000-8000-000000000001', '53400000-0002-4000-8000-000000000001'),
  ('53400000-0003-4000-8000-000000000002', '53400000-0001-4000-8000-000000000001', 2, 'Second session', 'private-prompt-marker',
   '53400000-0001-4000-8000-000000000001', '53400000-0002-4000-8000-000000000002'),
  ('53400000-0003-4000-8000-000000000003', '53400000-0001-4000-8000-000000000002', 3, 'Private session', 'foreign-prompt-marker',
   '53400000-0001-4000-8000-000000000002', '53400000-0002-4000-8000-000000000003');

insert into public.agent_runs(id, workspace_id, session_id, stage_id, stage_name,
  run_type, model_provider, model_name, status, created_at, attempt_count)
select ('53400000-0004-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '53400000-0001-4000-8000-000000000001',
  case when n % 2 = 0 then '53400000-0003-4000-8000-000000000001' else '53400000-0003-4000-8000-000000000002' end::uuid,
  case when n % 2 = 0 then '53400000-0002-4000-8000-000000000001' else '53400000-0002-4000-8000-000000000002' end::uuid,
  repeat('Stage', 50), 'project', case when n % 2 = 0 then 'codex' else 'opencode' end,
  repeat('Model', 50), (array['queued','started','running','success','error','canceled'])[1 + n % 6]::public.agent_run_status,
  '2026-04-01T00:00:00.123456Z', case when n = 60 then null else 1 end
from generate_series(1, 60) n;
insert into public.agent_runs(id, workspace_id, session_id, run_type, model_provider, model_name, status)
values ('53400000-0004-4000-8000-000000000099', '53400000-0001-4000-8000-000000000002',
  '53400000-0003-4000-8000-000000000003', 'project', 'codex', 'private-model', 'error');

-- The same queue job now owns a later attempt; history must keep the captured
-- attempt on each run instead of relabeling it from the mutable job row.
insert into public.agent_jobs(id, workspace_id, session_id, trigger_type, status, attempt_count)
values ('53400000-0005-4000-8000-000000000001', '53400000-0001-4000-8000-000000000001',
  '53400000-0003-4000-8000-000000000001', 'assignment', 'running', 2);
update public.agent_runs set agent_job_id = '53400000-0005-4000-8000-000000000001', attempt_count = 1
where id = '53400000-0004-4000-8000-000000000058';
update public.agent_runs set agent_job_id = '53400000-0005-4000-8000-000000000001', attempt_count = 2,
  source_recovery_required = true, input_tokens = 17, output_tokens = 3, total_cost_usd = 0
where id = '53400000-0004-4000-8000-000000000056';

insert into public.agent_run_messages(workspace_id, agent_run_id, kind, message_md) values
  ('53400000-0001-4000-8000-000000000001', '53400000-0004-4000-8000-000000000060', 'progress', repeat('private-transcript-marker', 20000)),
  ('53400000-0001-4000-8000-000000000001', '53400000-0004-4000-8000-000000000058', 'run_failure', '{"version":1,"category":"timeout","code":"timeout","extra":"private-failure-marker"}'),
  ('53400000-0001-4000-8000-000000000001', '53400000-0004-4000-8000-000000000057', 'run_failure', '{"version":1,"category":"configuration","code":"timeout"}'),
  ('53400000-0001-4000-8000-000000000001', '53400000-0004-4000-8000-000000000055', 'run_failure', 'private-invalid-receipt'),
  ('53400000-0001-4000-8000-000000000001', '53400000-0004-4000-8000-000000000054', 'run_failure',
   jsonb_build_object('version', 1, 'category', 'timeout', 'code', 'timeout', 'extra', repeat('private-oversized-receipt', 100))::text),
  ('53400000-0001-4000-8000-000000000001', '53400000-0004-4000-8000-000000000053', 'run_failure', '{"version":2,"category":"timeout","code":"timeout"}');
insert into public.agent_run_events(agent_run_id, workspace_id, attempt_count, sequence, kind, payload) values
  ('53400000-0004-4000-8000-000000000056', '53400000-0001-4000-8000-000000000001', 1, 1, 'capture_end', '{"status":"complete"}'),
  ('53400000-0004-4000-8000-000000000056', '53400000-0001-4000-8000-000000000001', 2, 1, 'text', '{"text":"private-event-marker"}'),
  ('53400000-0004-4000-8000-000000000058', '53400000-0001-4000-8000-000000000001', 1, 1, 'capture_end', '{"status":"complete"}'),
  ('53400000-0004-4000-8000-000000000058', '53400000-0001-4000-8000-000000000001', 1, 3, 'capture_end', '{"status":"interrupted"}');

select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc
  where oid = 'public.list_workspace_run_catalog(uuid,timestamptz,uuid,uuid,public.agent_run_status,text,uuid,uuid,integer)'::regprocedure),
  'catalog uses invoker RLS and an empty search path');
select ok((select proconfig @> array['plan_cache_mode=force_custom_plan'] from pg_proc
  where oid = 'public.list_workspace_run_catalog(uuid,timestamptz,uuid,uuid,public.agent_run_status,text,uuid,uuid,integer)'::regprocedure),
  'bound optional filters and cursor values receive a custom query plan');
select ok(has_function_privilege('authenticated',
  'public.list_workspace_run_catalog(uuid,timestamptz,uuid,uuid,public.agent_run_status,text,uuid,uuid,integer)', 'EXECUTE'),
  'authenticated callers can read the catalog');
select ok(not has_function_privilege(role_name,
  'public.list_workspace_run_catalog(uuid,timestamptz,uuid,uuid,public.agent_run_status,text,uuid,uuid,integer)', 'EXECUTE'),
  role_name || ' has no catalog execute grant') from (values ('anon'), ('service_role')) roles(role_name);
select ok(to_regclass('public.agent_runs_workspace_created_id_idx') is not null
  and to_regclass('public.agent_runs_session_created_id_idx') is not null
  and to_regclass('public.agent_run_events_capture_end_idx') is not null,
  'workspace, session and capture-end lookups have bounded index paths');

set local role anon;
select throws_ok($$select * from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001')$$,
  '42501', 'permission denied for function list_workspace_run_catalog', 'anonymous reads fail');
reset role;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';

create temp table catalog_page_one as
select * from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001', p_limit => 3);
select is((select array_agg(run_id order by created_at desc, run_id desc) from catalog_page_one),
  array['53400000-0004-4000-8000-000000000060','53400000-0004-4000-8000-000000000059','53400000-0004-4000-8000-000000000058']::uuid[],
  'equal timestamps paginate by descending run id');
select is((select created_at from catalog_page_one limit 1), '2026-04-01T00:00:00.123456Z'::timestamptz,
  'cursor timestamps retain microsecond precision');
select throws_ok($$select * from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000002')$$,
  'P0002', 'Run catalog workspace is unavailable.', 'foreign workspace reads fail closed');
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_run_id => '53400000-0004-4000-8000-000000000099')), 0::bigint, 'foreign deep links return no rows');
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_session_id => '53400000-0003-4000-8000-000000000003')), 0::bigint, 'foreign session filters cannot cross tenants');
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001', p_limit => 999999)),
  51::bigint, 'oversized limits are capped at 51 rows');
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001', p_limit => 0)),
  1::bigint, 'nonpositive limits are clamped');
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001', p_limit => null)),
  20::bigint, 'null limits use the default page size');
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_before_created_at => '2026-05-01')), 0::bigint, 'a partial timestamp cursor fails closed');
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_before_id => '53400000-0004-4000-8000-000000000060')), 0::bigint, 'a partial id cursor fails closed');

select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_status => target_status, p_limit => 51)), 10::bigint, 'status filter retains ' || target_status)
from unnest(enum_range(null::public.agent_run_status)) target_status;
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_session_id => '53400000-0003-4000-8000-000000000001', p_provider => 'codex',
  p_stage_id => '53400000-0002-4000-8000-000000000001', p_limit => 51)), 30::bigint,
  'session, provider and stage filters compose before the limit');
select is((select count(*) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001', p_provider => 'unknown')),
  0::bigint, 'unknown provider filters do not broaden the query');
select is((select attempt_count from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_run_id => '53400000-0004-4000-8000-000000000058')), 1, 'history retains the older exact attempt');
select is((select job_id from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_run_id => '53400000-0004-4000-8000-000000000058')), '53400000-0005-4000-8000-000000000001'::uuid,
  'history retains the original job association');
select ok((select attempt_count is null and not has_events and has_legacy_messages and not capture_ended and not capture_interrupted
  from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
    p_run_id => '53400000-0004-4000-8000-000000000060')), 'legacy history remains readable without invented event coverage');
select ok((select attempt_count = 2 and has_events and not capture_ended and not capture_interrupted and source_recovery_required
    and input_tokens = 17 and output_tokens = 3 and total_cost_usd = 0 and token_provenance = 'measured'
    and cost_provenance = 'measured'
  from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
    p_run_id => '53400000-0004-4000-8000-000000000056')), 'event coverage, recovery and usage belong to the exact attempt');
select ok((select capture_ended and capture_interrupted from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_run_id => '53400000-0004-4000-8000-000000000058')), 'the latest exact-attempt capture receipt supplies interruption state');
select is((select failure_receipt::jsonb from catalog_page_one where run_id = '53400000-0004-4000-8000-000000000058'),
  '{"version":1,"category":"timeout","code":"timeout"}'::jsonb, 'only vetted failure metadata is projected');
select ok((select bool_and(failure_receipt is null) from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001')
  where run_id in ('53400000-0004-4000-8000-000000000057', '53400000-0004-4000-8000-000000000055',
    '53400000-0004-4000-8000-000000000054', '53400000-0004-4000-8000-000000000053')),
  'mismatched, malformed, oversized and unsupported-version failure receipts are unavailable');
select ok((select bool_and(length(session_title) <= 200 and length(stage_name) <= 128
  and length(model_provider) <= 64 and length(model_name) <= 128 and coalesce(length(failure_receipt), 0) <= 512)
  from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001', p_limit => 51)), 'list summary fields are bounded');
select ok((select octet_length(jsonb_agg(to_jsonb(r))::text) < 131072
  and jsonb_agg(to_jsonb(r))::text not like '%private-%'
  from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001', p_limit => 51) r),
  'representative history stays bounded without prompt, event or message bodies');

-- Append between page requests. Existing older cursors must not shift, and a
-- fresh head request discovers the new row rather than pretending a snapshot.
reset role;
set local request.jwt.claim.role = 'service_role';
insert into public.agent_runs(id, workspace_id, session_id, run_type, model_provider, model_name, status, created_at)
values ('53400000-0004-4000-8000-000000000999', '53400000-0001-4000-8000-000000000001',
  '53400000-0003-4000-8000-000000000001', 'project', 'codex', 'fixture-model', 'queued', '2026-04-01T00:00:00.123456Z');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
create temp table catalog_page_two as
select * from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
  p_before_created_at => '2026-04-01T00:00:00.123456Z', p_before_id => '53400000-0004-4000-8000-000000000058', p_limit => 3);
select is((select array_agg(run_id order by created_at desc, run_id desc) from catalog_page_two),
  array['53400000-0004-4000-8000-000000000057','53400000-0004-4000-8000-000000000056','53400000-0004-4000-8000-000000000055']::uuid[],
  'a concurrent append does not shift or duplicate the older page');
select is((select array_agg(run_id order by created_at desc, run_id desc)
  from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001',
    p_before_created_at => '2026-04-01T00:00:00.123456Z', p_before_id => '53400000-0004-4000-8000-000000000058', p_limit => 3)),
  (select array_agg(run_id order by created_at desc, run_id desc) from catalog_page_two), 'replaying a cursor returns the same older identities');
select is((select run_id from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001', p_limit => 1)),
  '53400000-0004-4000-8000-000000000999'::uuid, 'head refresh exposes the appended run');

reset role;
set local request.jwt.claim.role = 'service_role';
update public.workspace_members set is_active = false
where workspace_id = '53400000-0001-4000-8000-000000000001'
  and user_id = 'a1b2c3d4-0001-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select throws_ok($$select * from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001')$$,
  'P0002', 'Run catalog workspace is unavailable.', 'membership revoked after a prior page fails closed');
reset role;
set local request.jwt.claim.role = 'service_role';
update public.workspace_members set is_active = true
where workspace_id = '53400000-0001-4000-8000-000000000001'
  and user_id = 'a1b2c3d4-0001-4000-8000-000000000001';
update public.workspaces set deletion_requested_at = clock_timestamp()
where id = '53400000-0001-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select throws_ok($$select * from public.list_workspace_run_catalog('53400000-0001-4000-8000-000000000001')$$,
  'P0002', 'Run catalog workspace is unavailable.', 'deleting workspaces fail closed');

select * from finish();
rollback;
