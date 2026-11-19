begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into public.sessions(id, workspace_id, number, title, prompt_md, creator_member_id, pipeline_id, current_stage_id)
select 'af100000-0000-4000-8000-000000000001', stage.workspace_id, 99005000, 'Conversation fixture', 'The initial prompt.',
  'c1b2c3d4-0001-4000-8000-000000000001', stage.pipeline_id, stage.id
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id = stage.pipeline_id
where stage.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug = 'plan';
insert into public.sessions(id, workspace_id, number, title, prompt_md, pipeline_id, current_stage_id)
select 'af100000-0000-4000-8000-000000000002', workspace_id, 99005001, 'System conversation fixture',
  repeat('a', 4100), pipeline_id, current_stage_id
from public.sessions where id = 'af100000-0000-4000-8000-000000000001';

select ok(exists (select 1 from public.session_conversation_messages
  where session_id = 'af100000-0000-4000-8000-000000000001' and sequence = 1
    and kind = 'initial_prompt' and author_kind = 'user' and body_md = 'The initial prompt.'
    and originating_member_id = 'c1b2c3d4-0001-4000-8000-000000000001'),
  'the initial prompt is committed as the originating human’s first message');
select ok(exists (select 1 from public.session_conversation_messages
  where session_id = 'af100000-0000-4000-8000-000000000002' and sequence = 1 and author_kind = 'system'
    and author_label = 'Wallie' and length(body_md) = 4000 and body_truncated and originating_member_id is null),
  'system-originated input is attributable and bounded');
select ok(not has_table_privilege('service_role', 'public.session_conversation_messages', 'INSERT')
  and not has_table_privilege('authenticated', 'public.session_conversation_sources', 'UPDATE'),
  'ordinary and service callers write conversation history only through scoped operations');

create function pg_temp.bind_conversation_source(
  target_session uuid, p_url text default 'https://example.test/thread/123', p_thread text default 'thread:123'
) returns setof public.session_conversation_sources language sql as $$
  select source.* from public.sessions owner cross join lateral public.bind_session_conversation_source_once(
    owner.workspace_id, owner.factory_id, owner.id, 'c1b2c3d4-0001-4000-8000-000000000001',
    'integration', 'tenant:container', p_thread, 'Safe label', p_url) source
  where owner.id = target_session;
$$;
create temp table thread_link as
select * from pg_temp.bind_conversation_source('af100000-0000-4000-8000-000000000001');
select results_eq($q$select * from pg_temp.bind_conversation_source('af100000-0000-4000-8000-000000000001')$q$,
  'select * from thread_link', 'an equivalent source binding returns the canonical link');
select throws_ok($q$select * from pg_temp.bind_conversation_source('af100000-0000-4000-8000-000000000002')$q$,
  'P0005', 'This source thread association is unavailable.', 'a source thread cannot be retargeted to another session');
select throws_ok($q$select * from pg_temp.bind_conversation_source('af100000-0000-4000-8000-000000000001',
  'https://user:pass@example.test/thread', 'invalid-url')$q$,
  '23514', null, 'source urls cannot carry user credentials');

create function pg_temp.conversation_message(
  p_request uuid, p_body text, p_source uuid default null, p_external_message text default null,
  p_external_actor text default null, p_actor uuid default 'c1b2c3d4-0001-4000-8000-000000000001'
) returns table(sequence integer, replayed boolean) language sql as $$
  select written.* from public.sessions owner cross join lateral public.append_session_conversation_message_once(
    owner.workspace_id, owner.factory_id, owner.id, p_actor, p_request, p_body,
    p_source, p_external_message, p_external_actor) written
  where owner.id = 'af100000-0000-4000-8000-000000000001';
$$;
select results_eq($q$select * from pg_temp.conversation_message('af100000-0000-4000-8000-000000000003', 'Native message')$q$,
  'values (2, false)', 'a second surface appends to the initial conversation');
select results_eq($q$select * from pg_temp.conversation_message('af100000-0000-4000-8000-000000000003', ' Native message ')$q$,
  'values (2, true)', 'an equivalent native request reuses the committed sequence');
select throws_ok($q$select * from pg_temp.conversation_message('af100000-0000-4000-8000-000000000003','Changed')$q$,
  'P0005', 'This message receipt was already used for different input.', 'a receipt cannot silently change its body');
select results_eq($q$select * from pg_temp.conversation_message('af100000-0000-4000-8000-000000000004',
  'Message from an associated surface', (select id from thread_link), 'external:message:1', 'external:actor:1')$q$,
  'values (3, false)', 'an associated source appends using the same sequence');
select results_eq($q$select * from pg_temp.conversation_message('af100000-0000-4000-8000-000000000005',
  'Message from an associated surface', (select id from thread_link), 'external:message:1', 'external:actor:1')$q$,
  'values (3, true)', 'the external identity deduplicates independent delivery requests');
select throws_ok($q$select * from pg_temp.conversation_message('af100000-0000-4000-8000-000000000004',
  'Message from an associated surface', (select id from thread_link), 'external:message:2', 'external:actor:1')$q$,
  'P0005', 'This message receipt was already used for different input.', 'a receipt cannot be reused for a different external message');
select is((select last_sequence from public.session_conversations where session_id = 'af100000-0000-4000-8000-000000000001'),
  3, 'replay and conflict do not increment the sequence');
select is((select count(*) from public.agent_jobs where session_id = 'af100000-0000-4000-8000-000000000001'),
  0::bigint, 'appending and replaying conversation messages does not enqueue agent turns');
select throws_ok($q$update public.session_conversation_messages set body_md = 'Edited'
  where session_id = 'af100000-0000-4000-8000-000000000001' and sequence = 1$q$,
  '23514', 'Session conversation history is append-only.', 'message history cannot be edited in place');
update public.sessions set archived_at = clock_timestamp() where id = 'af100000-0000-4000-8000-000000000001';
select results_eq($q$select * from pg_temp.bind_conversation_source('af100000-0000-4000-8000-000000000001')$q$,
  'select * from thread_link', 'a committed source binding still replays after the session is archived');
select throws_ok($q$select * from pg_temp.bind_conversation_source('af100000-0000-4000-8000-000000000001',
  p_thread => 'new-archived-bind')$q$, 'P0003', 'Session is archived.', 'an archived session cannot acquire a new source binding');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0002-4000-8000-000000000002';
select is((select session_id from public.resolve_session_conversation_source(
  'b1b2c3d4-0001-4000-8000-000000000001', 'integration', 'tenant:container', 'thread:123')),
  'af100000-0000-4000-8000-000000000001'::uuid,
  'an authorized member resolves the shared external thread to the canonical session');
select is((select count(*) from public.session_conversation_messages where session_id = 'af100000-0000-4000-8000-000000000001'),
  3::bigint, 'the same actor can read the associated conversation');
reset role;
set local request.jwt.claim.role = 'service_role';
select public.revoke_factory_membership(
  'b1b2c3d4-0001-4000-8000-000000000001', (select factory_id from thread_link),
  'a1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0002-4000-8000-000000000002');
select throws_ok($q$select * from pg_temp.conversation_message(gen_random_uuid(), 'Denied message', null, null, null,
  'c1b2c3d4-0002-4000-8000-000000000002')$q$,
  '42501', 'The service execution invoker no longer has factory access.', 'a revoked actor cannot append through the privileged route');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is((select count(*) from public.resolve_session_conversation_source(
  'b1b2c3d4-0001-4000-8000-000000000001', 'integration', 'tenant:container', 'thread:123')),
  0::bigint, 'removing factory access hides source associations and their previews');
select is((select count(*) from public.session_conversation_messages where session_id = 'af100000-0000-4000-8000-000000000001'),
  0::bigint, 'removing factory access hides all conversation messages');
reset role;
set local request.jwt.claim.role = 'service_role';
delete from public.sessions where id = 'af100000-0000-4000-8000-000000000001';
select ok(not exists (select 1 from public.session_conversation_sources where session_id = 'af100000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.session_conversation_messages where session_id = 'af100000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.session_conversations where session_id = 'af100000-0000-4000-8000-000000000001'),
  'deleting a session removes its conversation, messages and source links together');
select * from finish();
rollback;
