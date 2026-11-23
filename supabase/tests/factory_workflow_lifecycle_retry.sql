begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set workflow_fixture_namespace 65050000
\ir fixtures/factory_workflow_lifecycle.psql

create temp table prior_outputs as
select child.scenario, child.child_session_id, publication.run_id, publication.claim_id
from lifecycle_children child
cross join lateral pg_temp.prepare_child_publication(child.scenario) publication;
select ok(public.adopt_session_checkpoint_publication(run_id, claim_id, null, null),
  'adopts the child output before scheduling a follow-up: ' || scenario)
from prior_outputs;

create function pg_temp.control_retry_workflow(p_scenario text, p_generation bigint, p_action text)
returns jsonb language sql as $$
  select public.control_factory_workflow_lifecycle(root."sessionId", root.workspace_id,
    root.factory_id, p_generation, gen_random_uuid(), p_action)
  from lifecycle_roots root where root.scenario = p_scenario
$$;

create temp table feedback_revision as
select receipt.job_id, receipt.feedback_batch_id
from prior_outputs output join public.sessions session on session.id = output.child_session_id
cross join lateral public.submit_session_follow_up_once(
  p_session_id => session.id, p_workspace_id => session.workspace_id, p_factory_id => session.factory_id,
  p_artifact_version => session.current_artifact_version, p_expected_stage_id => session.current_stage_id,
  p_expected_artifact_id => session.current_artifact_id, p_expected_review_revision => session.artifact_review_revision,
  p_request_id => gen_random_uuid(), p_selected_thread_ids => '{}'::uuid[],
  p_feedback_text => 'Keep this exact original feedback.', p_agent_model_provider => 'codex',
  p_agent_model_name => 'gpt-5.5', p_run_type => 'code', p_requested_by_member_id => pg_temp.workflow_fixture_id(21)
) receipt where output.scenario = 'running-child';

create function pg_temp.claim_lifecycle_job(target_job_id uuid)
returns integer language plpgsql as $$
declare claimed public.agent_jobs;
begin
  update public.agent_jobs set created_at = '1900-01-01' where id = target_job_id;
  select * into strict claimed from public.claim_next_agent_job(false, 1000, 'node');
  if claimed.id is distinct from target_job_id then raise exception 'Claimed a different lifecycle job.'; end if;
  return claimed.attempt_count;
end;
$$;

select is(pg_temp.claim_lifecycle_job(job_id), 1, 'the scheduler claims the exact feedback revision') from feedback_revision;
create temp table retired_feedback as
select public.start_session_job_attempt(job_id, 1, pg_temp.workflow_fixture_id(32), 1,
  'codex', 'gpt-5.5', 'code', 'wallie/op650-feedback-first') as run_id from feedback_revision;
select ok(run_id is not null, 'the feedback attempt starts before the pause') from retired_feedback;
select is(pg_temp.control_retry_workflow('running-child', 1, 'pause')->>'lifecycleStatus', 'paused',
  'the workflow pauses the live feedback revision');
select is(pg_temp.control_retry_workflow('running-child', 2, 'resume')#>>'{resumed,0,jobId}',
  (select job_id::text from feedback_revision), 'resume keeps the exact job linked to the submitted feedback');
select is(pg_temp.claim_lifecycle_job(job_id), 2, 'the scheduler gives the resumed feedback job a fresh attempt')
from feedback_revision;
create temp table resumed_feedback as
select public.start_session_job_attempt(job_id, 2, pg_temp.workflow_fixture_id(32), 1,
  'codex', 'gpt-5.5', 'code', 'wallie/op650-feedback-resumed') as run_id from feedback_revision;
select ok((select fresh.run_id is not null and fresh.run_id <> old.run_id and run.status = 'canceled'
  from resumed_feedback fresh cross join retired_feedback old join public.agent_runs run on run.id = old.run_id),
  'resume allocates a different run and the paused run stays canceled');
select ok((select link.batch_id = revision.feedback_batch_id and batch.rendered_feedback_text like '%exact original feedback%'
  from feedback_revision revision
  join public.artifact_feedback_batch_jobs link on link.job_id = revision.job_id
  join public.artifact_feedback_batches batch on batch.id = link.batch_id),
  'the resumed attempt reads the same immutable batch and rendered feedback');
select input.input_sha from feedback_revision revision cross join resumed_feedback fresh
cross join lateral public.pin_session_job_git_input(revision.job_id, 2, fresh.run_id,
  pg_temp.workflow_fixture_id(34), 'main', repeat('a', 40)) input;
select public.prepare_session_source_and_checkpoint_publication(fresh.run_id, pg_temp.workflow_fixture_id(34),
  'main', repeat('a', 40), repeat('a', 40), 'Resumed feedback', 'The revised output', '', '', '', 1, 'Exact feedback revision.')
from resumed_feedback fresh;
create temp table resumed_publication as
select fresh.run_id, public.claim_session_checkpoint_publication(fresh.run_id) as claim_id from resumed_feedback fresh;
select ok(public.adopt_session_checkpoint_publication(run_id, claim_id, null, null),
  'the fresh attempt adopts the reviewed feedback revision') from resumed_publication;
select ok((select output.batch_id = revision.feedback_batch_id and output.artifact_version = 2
  from public.artifact_feedback_outputs output
  join feedback_revision revision on revision.job_id = output.job_id
  join resumed_feedback fresh on fresh.run_id = output.run_id),
  'the new artifact remains attributable to the original feedback batch');

create temp table manual_retry as
select queued.*, output.run_id as requested_run_id, session.id as session_id
from prior_outputs output join public.sessions session on session.id = output.child_session_id
cross join lateral public.enqueue_session_retry_with_checkpoint(session.id, session.workspace_id,
  session.current_stage_id, pg_temp.workflow_fixture_id(21), output.run_id, 'codex', 'gpt-5.5', 'code') queued
where output.scenario = 'queued-child';
select is(pg_temp.claim_lifecycle_job(job_id), 1, 'the scheduler claims the explicit retry before its worker starts')
from manual_retry;
select ok((select session.phase_status = 'awaiting_review' and run.status = 'queued'
  from manual_retry retry join public.sessions session on session.id = retry.session_id
  join public.agent_runs run on run.id = retry.run_id),
  'a claimed-but-unstarted retry still displays the previous review');
select is(pg_temp.control_retry_workflow('queued-child', 1, 'pause')#>>'{retired,0,restartRequired}', 'true',
  'pausing records the claimed review-phase retry as unfinished');
select is(pg_temp.control_retry_workflow('queued-child', 2, 'resume')#>>'{resumed,0,jobId}',
  (select job_id::text from manual_retry), 'resume restores the admitted explicit retry');
select ok((select origin.requested_run_id = retry.requested_run_id and job.trigger_type = 'manual_retry'
  from manual_retry retry join public.agent_jobs job on job.id = retry.job_id
  join internal.session_context_manual_retry_origins origin on origin.job_id = job.id),
  'the resumed retry keeps its original trigger and requested run provenance');
select is(pg_temp.claim_lifecycle_job(job_id), 2, 'the scheduler allocates a fresh claim for the explicit retry')
from manual_retry;
select ok(public.start_session_job_attempt(job_id, 2, pg_temp.workflow_fixture_id(32), 1,
  'codex', 'gpt-5.5', 'code', 'wallie/op650-manual-resumed') is not null,
  'the resumed explicit retry starts through the canonical worker command')
from manual_retry;

select * from finish();
rollback;
