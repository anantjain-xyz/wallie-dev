begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';

create temp table transcript_owner as
with s as (
  insert into public.sessions(workspace_id, number, title, prompt_md, pipeline_id, current_stage_id)
  select stage.workspace_id, 99005350, 'Bounded transcript', 'Fixture prompt', stage.pipeline_id, stage.id
  from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id = stage.pipeline_id
  where stage.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug = 'plan'
  returning id, workspace_id
), r as (
  insert into public.agent_runs(workspace_id, session_id, run_type, model_provider, model_name, status)
  select workspace_id, id, 'project', 'codex', 'fixture-model', 'error' from s returning id, workspace_id
) select * from r;
grant select on transcript_owner to authenticated;

insert into public.agent_run_messages(id, workspace_id, agent_run_id, kind, message_md, created_at)
select ('53500000-0006-4000-8000-' || lpad(n::text, 12, '0'))::uuid, r.workspace_id, r.id,
  case when n = 60 then repeat('k', 100) else 'progress' end,
  case when n = 60 then repeat('界', 20000) else 'message ' || n end,
  '2026-11-15T00:00:00.123456Z' from transcript_owner r cross join generate_series(1, 60) n;

select ok((select not prosecdef and proconfig @> array['search_path=""', 'plan_cache_mode=force_custom_plan']
  from pg_proc where oid = 'public.list_run_legacy_transcript(uuid,uuid,timestamptz,uuid,text,integer)'::regprocedure),
  'legacy transcript retains invoker RLS and custom tuple planning');
select ok(not has_function_privilege(role_name,
  'public.list_run_legacy_transcript(uuid,uuid,timestamptz,uuid,text,integer)', 'EXECUTE'),
  role_name || ' cannot invoke legacy history') from (values ('anon'), ('service_role')) roles(role_name);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is((select count(*) from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id, p_limit => 999999)),
  51::bigint, 'legacy page size is capped');
select is((select count(*) from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id, p_limit => 0)),
  1::bigint, 'legacy page size has a positive lower bound');
select is((select count(*) from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id, p_limit => null)),
  31::bigint, 'null page size uses the bounded default');
select is((select array_agg(m.id order by m.created_at desc, m.id desc)
  from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id, p_limit => 2) m),
  array['53500000-0006-4000-8000-000000000060','53500000-0006-4000-8000-000000000059']::uuid[],
  'initial page uses the full timestamp/id ordering');
select ok((select message_truncated and char_length(message_excerpt) = 8192 and octet_length(message_excerpt) = 24576 and char_length(m.kind) = 64
  from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id, p_limit => 1) m),
  'oversized Unicode messages and labels are capped before leaving Postgres');
select is((select array_agg(m.id order by m.created_at desc, m.id desc)
  from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id,
    '2026-11-15T00:00:00.123456Z', '53500000-0006-4000-8000-000000000059', 'older', 2) m),
  array['53500000-0006-4000-8000-000000000058','53500000-0006-4000-8000-000000000057']::uuid[],
  'older paging strictly excludes the boundary without losing timestamp ties');
select is((select array_agg(m.id order by m.created_at, m.id)
  from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id,
    '2026-11-15T00:00:00.123456Z', '53500000-0006-4000-8000-000000000057', 'newer', 2) m),
  array['53500000-0006-4000-8000-000000000058','53500000-0006-4000-8000-000000000059']::uuid[],
  'forward catchup uses ascending bounded keysets');
select ok((select bool_and(not message_truncated) from transcript_owner r
  cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id,
    '2026-11-15T00:00:00.123456Z', '53500000-0006-4000-8000-000000000059', 'older', 2) m),
  'short messages retain an explicit untruncated marker');
select is((select count(*) from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, gen_random_uuid())),
  0::bigint, 'unknown run ids reveal no messages');
select throws_ok($$select m.* from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id, p_cursor_created_at => now()) m$$,
  '22023', 'Invalid legacy transcript cursor.', 'partial cursors fail closed');
select throws_ok($$select m.* from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id, p_direction => 'newer') m$$,
  '22023', 'Invalid legacy transcript cursor.', 'forward pages require a boundary');
select throws_ok($$select m.* from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id, p_direction => 'sideways') m$$,
  '22023', 'Invalid legacy transcript cursor.', 'invalid direction fails closed');

-- Another user has no membership in the fixture's workspace.
set local request.jwt.claim.sub = 'a1b2c3d4-0099-4000-8000-000000000099';
select throws_ok($$select m.* from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id) m$$,
  'P0002', 'Run transcript workspace is unavailable.', 'foreign members cannot read legacy transcripts');
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';

reset role;
set local request.jwt.claim.role = 'service_role';
insert into public.agent_run_messages(id, workspace_id, agent_run_id, kind, message_md, created_at)
select '53500000-0006-4000-8000-000000000061', workspace_id, id, 'progress', 'new append', '2026-11-15T00:00:00.123456Z'
from transcript_owner;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is((select count(*) from transcript_owner r cross join lateral public.list_run_legacy_transcript(r.workspace_id, r.id,
  '2026-11-15T00:00:00.123456Z', '53500000-0006-4000-8000-000000000060', 'newer', 2)),
  1::bigint, 'forward catchup sees an appended tie exactly once');

select * from finish();
rollback;
