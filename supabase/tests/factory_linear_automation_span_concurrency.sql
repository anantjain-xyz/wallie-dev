begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(8);
set local request.jwt.claim.role = 'service_role';

create function pg_temp.linear_page_id(slot integer) returns uuid language sql immutable as $$
  select ('66320000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email)
values (pg_temp.linear_page_id(6), 'linear-automation-page-owner@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.linear_page_id(1), 'linear-automation-page-race', 'Linear automation page race');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.linear_page_id(7), pg_temp.linear_page_id(1), pg_temp.linear_page_id(6), 'human', 'owner');
insert into public.pipelines(id, workspace_id, name)
values (pg_temp.linear_page_id(2), pg_temp.linear_page_id(1), 'Race pipeline');
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values (pg_temp.linear_page_id(3), pg_temp.linear_page_id(1), pg_temp.linear_page_id(2), 1, 'plan', 'Plan');
insert into public.sessions(id, workspace_id, pipeline_id, current_stage_id, creator_member_id,
  number, title, linear_issue_id, phase_status)
values (pg_temp.linear_page_id(4), pg_temp.linear_page_id(1), pg_temp.linear_page_id(2), pg_temp.linear_page_id(3),
  pg_temp.linear_page_id(7), 1, 'Race session', 'RACE-1', 'in_progress');

-- Both backends must be able to see the test link and this observation command.
create function public.test_commit_linear_span_race(
  p_workspace_id uuid, p_session_id uuid, p_issue_id uuid, p_span_id text
) returns text language plpgsql set search_path = '' as $$
begin
  perform public.commit_linear_automation_span_page(0, array[p_session_id], jsonb_build_array(
    jsonb_build_object('sessionId', p_session_id, 'linkedIssueId', 'RACE-1',
      'issueId', p_issue_id, 'spanId', p_span_id, 'stateId', 'todo', 'teamId', null,
      'projectId', null, 'startedAt', '2026-11-22T10:00:00Z', 'issueUpdatedAt', '2026-11-22T10:00:00Z')
  ), p_workspace_id);
  return 'committed';
exception when sqlstate 'PT409' then
  return SQLSTATE;
end;
$$;
commit;

set request.jwt.claim.role = 'service_role';

create function pg_temp.test_linear_span_race(p_change text, p_operation text) returns setof text
language plpgsql as $$
declare
  connection_string text := coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres');
  deadline timestamptz;
  waiting boolean := false;
  disposition text;
begin
  perform extensions.dblink_connect('op663_link_writer', connection_string);
  perform extensions.dblink_connect('op663_span_worker', connection_string);
  perform extensions.dblink_exec('op663_link_writer',
    'set statement_timeout = ''10s''; set request.jwt.claim.role = ''service_role''; begin');
  perform extensions.dblink_exec('op663_span_worker',
    'set application_name = ''op663_span_worker''; set statement_timeout = ''10s''; set request.jwt.claim.role = ''service_role''');
  perform extensions.dblink_exec('op663_link_writer', format(
    'update public.sessions set %s where id = %L', p_change, pg_temp.linear_page_id(4)));
  perform extensions.dblink_send_query('op663_span_worker', format(
    'select public.test_commit_linear_span_race(%L, %L, %L, %L)',
    pg_temp.linear_page_id(1), pg_temp.linear_page_id(4), pg_temp.linear_page_id(5), p_operation));

  deadline := clock_timestamp() + interval '3 seconds';
  while extensions.dblink_is_busy('op663_span_worker') = 1 and clock_timestamp() < deadline loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity
      where application_name = 'op663_span_worker' and wait_event_type = 'Lock') then
      waiting := true;
      exit;
    end if;
    perform pg_sleep(0.01);
  end loop;
  return next ok(waiting, 'the automation commit waits for the held session change: ' || p_operation);
  perform extensions.dblink_exec('op663_link_writer', 'commit');
  select response.result into strict disposition
  from extensions.dblink_get_result('op663_span_worker') response(result text);
  return next is(disposition, 'PT409', 'the changed link rejects the exact page: ' || p_operation);
  return next is((select generation from public.read_linear_automation_span_cursor(pg_temp.linear_page_id(1))),
    0::bigint, 'the rejected link leaves its cursor unchanged: ' || p_operation);
  return next is((select count(*) from internal.issue_automation_state_spans
    where workspace_id = pg_temp.linear_page_id(1)), 0::bigint, 'the rejected link leaves no span: ' || p_operation);
end;
$$;

select * from pg_temp.test_linear_span_race($$linear_issue_id = 'RACE-2'$$, 'relink');
select extensions.dblink_disconnect('op663_link_writer');
select extensions.dblink_disconnect('op663_span_worker');
update public.sessions set linear_issue_id = 'RACE-1' where id = pg_temp.linear_page_id(4);

select * from pg_temp.test_linear_span_race('archived_at = clock_timestamp()', 'archive');
select extensions.dblink_disconnect('op663_link_writer');
select extensions.dblink_disconnect('op663_span_worker');

drop function public.test_commit_linear_span_race(uuid, uuid, uuid, text);
delete from public.workspaces where id = pg_temp.linear_page_id(1);
delete from auth.users where id = pg_temp.linear_page_id(6);
select * from finish();
