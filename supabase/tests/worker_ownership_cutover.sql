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

-- An explicit external completion still takes effect when reversible archival
-- won the session lock first. The original archive marker remains stable.
update public.sessions set archived_at = '2026-09-01 12:00:00+00'
where id = (select session_id from publication);
select * from public.archive_session_job_attempts((select session_id from publication),
  'b1b2c3d4-0001-4000-8000-000000000001', 'repeat ordinary archive');
select is((select phase_status::text from public.sessions where id = (select session_id from publication)),
  'awaiting_review', 'ordinary repeat archive preserves pending review');
select is((select archived_at from public.sessions where id = (select session_id from publication)),
  '2026-09-01 12:00:00+00'::timestamptz, 'ordinary repeat archive preserves its original marker');

create temp table completed_archive as select * from public.archive_session_job_attempts(
  (select session_id from publication), 'b1b2c3d4-0001-4000-8000-000000000001',
  'Linear Done observed before manual archive', true);
select is((select phase_status::text from public.sessions where id = (select session_id from publication)),
  'approved', 'explicit completion promotes an already archived review');
select is((select archived_at from public.sessions where id = (select session_id from publication)),
  '2026-09-01 12:00:00+00'::timestamptz, 'completion preserves the original archive marker');
select is((select current_artifact_version from public.sessions where id = (select session_id from publication)),
  1, 'completion retains the published artifact pointer');
select is((select artifact_json from public.session_artifacts where session_id = (select session_id from publication)),
  to_jsonb('canonical markdown'::text), 'completion retains canonical markdown');
select is((select status::text from public.agent_runs where id = (select run_id from publication)),
  'success', 'completion retains the published execution outcome');
select is((select job_ids from completed_archive), '{}'::uuid[],
  'completed work requires no repeated job cancellation');
select is((select run_ids from completed_archive), '{}'::uuid[],
  'completed work requires no repeated run cleanup');

create temp table archived_rejected as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
  'Complete archived rejected work', 'Preserve archival while accepting completion.', 'codex', 'gpt-5.5',
  null, null, '12b2c3d4-0001-4000-8000-000000000001', null);
update public.sessions set archived_at = '2026-09-02 12:00:00+00', phase_status = 'rejected'
where id = (select session_id from archived_rejected);
-- An archived row can still contain a job from a legacy producer that raced the
-- earlier archive. Completion must keep the cancellation receipt for that job.
create temp table rejected_completion as select * from public.archive_session_job_attempts(
  (select session_id from archived_rejected), 'b1b2c3d4-0001-4000-8000-000000000001',
  'Linear Done', true);
select is((select phase_status::text from public.sessions where id = (select session_id from archived_rejected)),
  'approved', 'explicit completion promotes an already archived rejection');
select is((select archived_at from public.sessions where id = (select session_id from archived_rejected)),
  '2026-09-02 12:00:00+00'::timestamptz, 'rejected completion preserves its archive marker');
select is((select job_ids from rejected_completion), array[(select job_id from archived_rejected)],
  'archived completion returns the exact active job it cancels');
select is((select run_ids from rejected_completion), array[(select run_id from archived_rejected)],
  'archived completion returns the exact active run for sandbox cleanup');
select is((select status::text from public.agent_jobs where id = (select job_id from archived_rejected)),
  'canceled', 'archived completion retires active queued work');
select is((select status::text from public.agent_runs where id = (select run_id from archived_rejected)),
  'canceled', 'archived completion retires the corresponding run');
select * from public.archive_session_job_attempts((select session_id from archived_rejected),
  'b1b2c3d4-0001-4000-8000-000000000001', 'repeat ordinary archive');
select is((select phase_status::text from public.sessions where id = (select session_id from archived_rejected)),
  'approved', 'ordinary archive cannot undo explicit completion');

select * from finish();
rollback;
