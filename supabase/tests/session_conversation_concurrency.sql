begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into public.sessions(id, workspace_id, number, title, prompt_md, creator_member_id, pipeline_id, current_stage_id)
select 'af110000-0000-4000-8000-000000000001', stage.workspace_id, 99005100, 'Concurrent conversation fixture',
  'The committed first message.', 'c1b2c3d4-0001-4000-8000-000000000001', stage.pipeline_id, stage.id
from public.pipeline_stages stage join public.pipelines pipeline on pipeline.id = stage.pipeline_id
where stage.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001' and pipeline.is_default and stage.slug = 'plan';
commit;
begin;

select extensions.dblink_connect('conversation_first', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('conversation_second', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('conversation_second',
  'set application_name = ''conversation_reconnect_contender''; set statement_timeout = ''15s''');
select extensions.dblink_exec('conversation_first', 'begin');
select is((select sequence from extensions.dblink('conversation_first', $query$
  select appended.* from public.sessions owner cross join lateral public.append_session_conversation_message_once(
    owner.workspace_id, owner.factory_id, owner.id, 'c1b2c3d4-0001-4000-8000-000000000001',
    'af110000-0000-4000-8000-000000000002', 'First concurrent write.') appended
  where owner.id = 'af110000-0000-4000-8000-000000000001'
$query$) as result(sequence integer, replayed boolean)), 2, 'the held writer allocates the next sequence');
select extensions.dblink_send_query('conversation_second', $query$
  select appended.* from public.sessions owner cross join lateral public.append_session_conversation_message_once(
    owner.workspace_id, owner.factory_id, owner.id, 'c1b2c3d4-0001-4000-8000-000000000001',
    'af110000-0000-4000-8000-000000000003', 'Second concurrent write.') appended
  where owner.id = 'af110000-0000-4000-8000-000000000001'
$query$);
create function pg_temp.wait_conversation_writer() returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists(select 1 from pg_stat_activity where application_name = 'conversation_reconnect_contender'
      and wait_event_type = 'Lock') then return true; end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
select ok(pg_temp.wait_conversation_writer(), 'a second writer cannot commit ahead of the held writer');
select is((select count(*) from public.session_conversation_messages
  where session_id = 'af110000-0000-4000-8000-000000000001' and sequence > 1), 0::bigint,
  'a reconnect while the first append is held cannot advance past unseen rows');
select extensions.dblink_exec('conversation_first', 'commit');
select is((select sequence from extensions.dblink_get_result('conversation_second') as result(sequence integer, replayed boolean)),
  3, 'the second writer appends after the first commit');
select results_eq($q$select sequence, body_md from public.session_conversation_messages
  where session_id = 'af110000-0000-4000-8000-000000000001' and sequence > 1 order by sequence$q$,
  $v$values (2, 'First concurrent write.'::text), (3, 'Second concurrent write.')$v$,
  'reconnecting from the original cursor yields all committed rows in order');
select extensions.dblink_disconnect('conversation_second');
select extensions.dblink_disconnect('conversation_first');
delete from public.sessions where id = 'af110000-0000-4000-8000-000000000001';
select * from finish();
commit;
