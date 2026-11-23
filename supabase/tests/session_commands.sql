begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

select ok(
  not has_function_privilege('anon', 'public.find_session_creation_command(uuid,uuid,uuid,text,uuid,uuid,boolean,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.find_session_creation_command(uuid,uuid,uuid,text,uuid,uuid,boolean,jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.find_session_creation_command(uuid,uuid,uuid,text,uuid,uuid,boolean,jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.cancel_session_command_once(uuid,uuid,uuid,uuid,uuid,text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.submit_session_follow_up_once(uuid,uuid,uuid,integer,uuid,uuid,text,bigint,uuid,uuid[],text,text,text,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.cancel_session_command_once(uuid,uuid,uuid,uuid,uuid,text,uuid)', 'EXECUTE')
  and not has_table_privilege('service_role', 'internal.session_cancellation_requests', 'SELECT'),
  'command entry points require the trusted service and cancellation receipts stay private');

create temp table command_scope as
select factory.workspace_id, factory.id as factory_id,
  'c1b2c3d4-0001-4000-8000-000000000001'::uuid as actor_member_id
from public.factories factory
where factory.is_default and factory.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

create temp table command_creation as
select creation.* from command_scope scope
cross join lateral public.create_session_once_with_first_job(scope.workspace_id, scope.actor_member_id,
  'af000000-0000-4000-8000-000000000001', repeat('a', 64), 'Command fixture', 'One queued job.',
  'codex', 'gpt-5.5', '{}'::uuid[]) creation;

select results_eq($$
  select replay.* from command_scope scope
  cross join lateral public.find_session_creation_command(scope.workspace_id, scope.actor_member_id,
    'af000000-0000-4000-8000-000000000001', repeat('a', 64), scope.factory_id) replay
$$, 'select * from command_creation', 'scoped preflight replays an existing creation receipt');
select results_eq($$
  select replay.* from command_scope scope
  cross join lateral public.create_session_command_once(scope.workspace_id, scope.actor_member_id,
    'af000000-0000-4000-8000-000000000001', repeat('a', 64), repeat('f', 64), 'Regenerated title',
    'A replay must precede mutable factory preflight.', 'codex', 'gpt-5.5', '{}'::uuid[],
    target_factory_id => scope.factory_id) replay
$$, 'select * from command_creation', 'scoped create preserves the original receipt despite mutable configuration');
select throws_ok($$
  select * from command_scope scope
  cross join lateral public.find_session_creation_command(scope.workspace_id, scope.actor_member_id,
    'af000000-0000-4000-8000-000000000001', repeat('a', 64), 'af000000-0000-4000-8000-000000000002')
$$, 'P0005', 'This creation request was already used for different session input',
  'the legacy creation key cannot target a different factory');
select throws_ok($$
  select * from command_scope scope
  cross join lateral public.find_session_creation_command(scope.workspace_id, scope.actor_member_id,
    'af000000-0000-4000-8000-000000000001', repeat('a', 64), scope.factory_id,
    (select session_id from command_creation))
$$, 'P0005', 'This creation request was already used for different session input',
  'the same creation key cannot become an explicit restart');
select throws_ok($$
  select * from command_scope scope
  cross join lateral public.create_session_command_once(scope.workspace_id, scope.actor_member_id,
    'af000000-0000-4000-8000-000000000003', repeat('a', 64), '', 'Wrong factory',
    'This command must not create work.', 'codex', 'gpt-5.5', '{}'::uuid[],
    target_factory_id => 'af000000-0000-4000-8000-000000000002')
$$, 'P0003', 'The active factory changed.', 'explicit scope mismatch rejects default admission');
select is((select count(*) from public.sessions where title = 'Wrong factory'), 0::bigint,
  'factory mismatch commits neither a session nor its queued execution');

create function pg_temp.cancel_command(
  request_hash text, expected_run_id uuid, prospective_actor uuid default null
) returns table(job_ids uuid[], run_ids uuid[], replayed boolean) language sql as $$
  select cancellation.* from command_creation creation cross join command_scope scope
  cross join lateral public.cancel_session_command_once(scope.workspace_id, scope.factory_id,
    coalesce(prospective_actor, scope.actor_member_id), creation.session_id,
    'af000000-0000-4000-8000-000000000001', request_hash, expected_run_id) cancellation;
$$;
select throws_ok($$
  select * from pg_temp.cancel_command(repeat('b', 64), (select run_id from command_creation),
    'af000000-0000-4000-8000-000000000099')
$$, '42501', 'The service execution invoker no longer has factory access.',
  'an unauthorized actor cannot cancel a generation');
select throws_ok($$
  select * from pg_temp.cancel_command(repeat('b', 64), 'af000000-0000-4000-8000-000000000099')
$$, 'P0003', 'Session generation changed.', 'another generation cannot cancel the current run');
select is((select status::text from public.agent_jobs where id = (select job_id from command_creation)),
  'queued', 'a stale cancellation leaves the job eligible');
create temp table canceled as
select * from pg_temp.cancel_command(repeat('b', 64), (select run_id from command_creation));
select results_eq('select job_ids, run_ids, replayed from canceled',
  'select array[job_id], array[run_id], false from command_creation',
  'the receipt contains exactly the committed job and run');
select results_eq($$
  select * from pg_temp.cancel_command(repeat('b', 64), (select run_id from command_creation))
$$, 'select job_ids, run_ids, true from canceled', 'cancellation replays after the generation leaves in_progress');
select throws_ok($$
  select * from pg_temp.cancel_command(repeat('c', 64), (select run_id from command_creation))
$$, 'P0005', 'This cancellation request was already used for different input.', 'cancellation cannot change a committed digest');
select throws_ok($$
  select * from pg_temp.cancel_command(repeat('b', 64), 'af000000-0000-4000-8000-000000000099')
$$, 'P0005', 'This cancellation request was already used for different input.', 'cancellation cannot change its committed generation');

select * from finish();
rollback;
