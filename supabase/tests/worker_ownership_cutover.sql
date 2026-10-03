begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

select hasnt_function('public', 'publish_session_stage_artifact',
  array['uuid', 'uuid', 'uuid', 'text', 'integer', 'integer', 'text'],
  'ownerless artifact publication API is removed');
select hasnt_function('public', 'schedule_job_retry', array['uuid', 'integer', 'integer'],
  'ownerless retry API is removed');

insert into internal.workspace_issue_counters as counters(workspace_id, last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, coalesce(max(number), 0)
from public.sessions where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
on conflict (workspace_id) do update
set last_issue_number = greatest(counters.last_issue_number, excluded.last_issue_number);

create temp table publication as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
  'Publish canonical markdown', 'Publish only with an execution owner.', 'codex', 'gpt-5.5',
  null, null, '12b2c3d4-0001-4000-8000-000000000001', null);
update public.agent_jobs set status = 'running', attempt_count = 1
where id = (select job_id from publication);
select is(public.start_session_job_attempt((select job_id from publication), 1,
  (select current_stage_id from public.sessions where id = (select session_id from publication)),
  0, 'codex', 'gpt-5.5', 'project'), (select run_id from publication),
  'start binds the queued run to the captured attempt');

select ok(public.publish_session_job_attempt((select job_id from publication), 1,
  (select run_id from publication), 0, 'canonical markdown'), 'owned attempt publishes');
select is((select phase_status::text from public.sessions where id = (select session_id from publication)),
  'awaiting_review', 'review pointer advances with publication');
select is((select artifact_json from public.session_artifacts where session_id = (select session_id from publication)),
  to_jsonb('canonical markdown'::text), 'reviewers see canonical markdown');
select is((select status::text from public.agent_runs where id = (select run_id from publication)),
  'success', 'publication durably marks its run successful');
select ok(not public.publish_session_job_attempt((select job_id from publication), 1,
  (select run_id from publication), 0, 'loser markdown'), 'duplicate publisher cannot republish');
select is((select artifact_json from public.session_artifacts where session_id = (select session_id from publication)),
  to_jsonb('canonical markdown'::text), 'duplicate publication preserves markdown');
select ok(public.complete_session_job_attempt((select job_id from publication), 1,
  (select run_id from publication)), 'exact published job completes');
select is((select status::text from public.agent_jobs where id = (select job_id from publication)),
  'success', 'completion releases the active queue key');

select * from finish();
rollback;
