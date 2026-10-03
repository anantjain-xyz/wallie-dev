begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';
-- Resolve the fixture's current review token; stale-token cases live in atomic_approval_handoff.sql.
create function pg_temp.approve_current_review(target uuid, workspace uuid, version integer, reviewer uuid)
returns table (id uuid, pipeline_id uuid, current_stage_id uuid, current_stage_slug text,
  phase_status public.pipeline_phase_status, workspace_id uuid, linear_issue_url text,
  archived_at timestamptz, current_artifact_version integer, rejection_count integer,
  job_id uuid, run_id uuid, job_created boolean) language sql as $$
  select result.* from public.sessions session
  cross join lateral public.approve_session_stage(target, workspace, session.current_stage_id,
    (select artifact.id from public.session_artifacts artifact where artifact.session_id = target
      and artifact.stage_id = session.current_stage_id and artifact.version = version),
    version, reviewer, 'codex', 'gpt-5.5', 'project') result
  where session.id = target;
$$;


-- Earlier suites may commit explicitly numbered sessions without advancing the
-- allocator. Align this transaction's fixtures above both existing rows and the
-- current counter; the final rollback restores the original counter value.
insert into internal.workspace_issue_counters as counters(workspace_id, last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, coalesce(max(number), 0)
from public.sessions where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
on conflict (workspace_id) do update
set last_issue_number = greatest(counters.last_issue_number, excluded.last_issue_number);

create temp table ownership_pipeline as
with inserted as (
  insert into public.pipelines(workspace_id, name)
  values ('b1b2c3d4-0001-4000-8000-000000000001', 'Execution ownership proof') returning id
) select id from inserted;
insert into public.pipeline_stages(pipeline_id, workspace_id, position, slug, name, prompt_template_md)
select id, 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, 1, 'plan', 'Plan', 'Plan the task' from ownership_pipeline
union all
select id, 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, 2, 'build', 'Build', 'Build the plan' from ownership_pipeline;

create function pg_temp.ownership_fixture(fixture_name text)
returns table(session_id uuid, job_id uuid, run_id uuid)
language sql as $$
  select session_id, job_id, run_id from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
    fixture_name, 'Exercise the execution owner contract', 'codex', 'gpt-5.5', null, null, null,
    (select id from ownership_pipeline)
  );
$$;

-- Additive rollout: existing writers can still insert runs without ownership.
create temp table attempt_fixture as select * from pg_temp.ownership_fixture('Attempt ownership');
select is((select attempt_count from public.agent_runs where id = (select run_id from attempt_fixture)), null::integer,
  'legacy creation leaves run attempt ownership unset');

-- Each new primitive is internal, even though it lives in the public schema.
select ok(has_function_privilege('service_role', signature, 'EXECUTE'), signature || ' permits service role')
from (values
  ('public.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text)'),
  ('public.publish_session_job_attempt(uuid,integer,uuid,integer,text)'),
  ('public.complete_session_job_attempt(uuid,integer,uuid)'),
  ('public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid)'),
  ('public.cancel_session_job_attempts(uuid,uuid,text,uuid,boolean)'),
  ('public.archive_session_job_attempts(uuid,uuid,text,boolean)')
) api(signature);
select ok(not has_function_privilege(role_name, signature, 'EXECUTE'), role_name || ' cannot execute ' || signature)
from (values ('anon'), ('authenticated')) roles(role_name)
cross join (values
  ('public.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text)'),
  ('public.publish_session_job_attempt(uuid,integer,uuid,integer,text)'),
  ('public.complete_session_job_attempt(uuid,integer,uuid)'),
  ('public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid)'),
  ('public.cancel_session_job_attempts(uuid,uuid,text,uuid,boolean)'),
  ('public.archive_session_job_attempts(uuid,uuid,text,boolean)')
) api(signature);
select ok(not procedure.prosecdef and procedure.proconfig @> array['search_path=""'],
  procedure.proname || ' uses invoker privileges and an empty search path')
from pg_catalog.pg_proc procedure
where procedure.oid in (
  'public.start_session_job_attempt(uuid,integer,uuid,integer,text,text,text,text)'::regprocedure,
  'public.publish_session_job_attempt(uuid,integer,uuid,integer,text)'::regprocedure,
  'public.complete_session_job_attempt(uuid,integer,uuid)'::regprocedure,
  'public.fail_session_job_attempt(uuid,integer,text,boolean,integer,uuid)'::regprocedure,
  'public.cancel_session_job_attempts(uuid,uuid,text,uuid,boolean)'::regprocedure,
  'public.archive_session_job_attempts(uuid,uuid,text,boolean)'::regprocedure
);

create function pg_temp.start_owned(target_job uuid, observed_attempt integer, branch text default null)
returns uuid language sql as $$
  select public.start_session_job_attempt(target_job, observed_attempt, session.current_stage_id,
    session.current_artifact_version, 'codex', 'gpt-5.5', 'project', branch)
  from public.agent_jobs job join public.sessions session on session.id = job.session_id
  where job.id = target_job;
$$;

select is(pg_temp.start_owned((select job_id from attempt_fixture), 0), null::uuid,
  'a queued job cannot start before the queue claims it');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from attempt_fixture);
select is(pg_temp.start_owned((select job_id from attempt_fixture), null), null::uuid, 'missing attempt cannot start');
select is(pg_temp.start_owned((select job_id from attempt_fixture), 0), null::uuid, 'old attempt cannot start');
select is(pg_temp.start_owned((select job_id from attempt_fixture), 2), null::uuid, 'future attempt cannot start');
select is(public.start_session_job_attempt((select job_id from attempt_fixture), 1,
  (select id from public.pipeline_stages where pipeline_id = (select id from ownership_pipeline) and slug = 'build'),
  0, 'codex', 'gpt-5.5', 'project'), null::uuid, 'stale expected stage cannot start');
select is(public.start_session_job_attempt((select job_id from attempt_fixture), 1,
  (select current_stage_id from public.sessions where id = (select session_id from attempt_fixture)),
  1, 'codex', 'gpt-5.5', 'project'), null::uuid, 'stale expected artifact version cannot start');
select is((select status::text from public.agent_runs where id = (select run_id from attempt_fixture)), 'queued',
  'refused starts leave the queued run untouched');
select is(pg_temp.start_owned((select job_id from attempt_fixture), 1, 'wallie/first-attempt'),
  (select run_id from attempt_fixture), 'first owner atomically adopts the legacy queued run');
select is((select attempt_count from public.agent_runs where id = (select run_id from attempt_fixture)), 1,
  'started run records its exact job attempt');
select is((select branch_name from public.agent_runs where id = (select run_id from attempt_fixture)), 'wallie/first-attempt',
  'started run records its execution branch');
select is((select status::text from public.agent_runs where id = (select run_id from attempt_fixture)), 'running',
  'ownership is committed with the running state');
select is(pg_temp.start_owned((select job_id from attempt_fixture), 1, 'wallie/duplicate'), null::uuid,
  'a repeated start cannot authorize another executor for the same attempt');
select ok(not public.complete_session_job_attempt((select job_id from attempt_fixture), 1, (select run_id from attempt_fixture)),
  'completion cannot mark unpublished work successful');

select is(public.fail_session_job_attempt((select job_id from attempt_fixture), 1, 'retry this attempt', true, 3,
  (select run_id from attempt_fixture)), 'queued', 'owned failure schedules a retry');
select is((select status::text from public.agent_runs where id = (select run_id from attempt_fixture)), 'error',
  'retry terminalizes its exact prior run');
select is((select status::text from public.agent_jobs where id = (select job_id from attempt_fixture)), 'queued',
  'retry leaves a queued job');
select is((select phase_status::text from public.sessions where id = (select session_id from attempt_fixture)), 'rejected',
  'retry parks the failed execution until the next claim');
update public.agent_jobs set status = 'running', attempt_count = 2 where id = (select job_id from attempt_fixture);
create temp table second_attempt as select pg_temp.start_owned((select job_id from attempt_fixture), 2, 'wallie/second-attempt') as run_id;
select isnt((select run_id from second_attempt), (select run_id from attempt_fixture), 'retry receives a distinct run');
select is((select attempt_count from public.agent_runs where id = (select run_id from second_attempt)), 2, 'retry records attempt two');
select is((select branch_name from public.agent_runs where id = (select run_id from attempt_fixture)), 'wallie/first-attempt',
  'retry does not relabel the old run branch');
select ok(not public.publish_session_job_attempt((select job_id from attempt_fixture), 1, (select run_id from attempt_fixture), 0, 'old output'),
  'old attempt cannot publish into the same stage and version');
select ok(not public.complete_session_job_attempt((select job_id from attempt_fixture), 1, (select run_id from attempt_fixture)),
  'old attempt cannot complete the retried job');
select is(public.fail_session_job_attempt((select job_id from attempt_fixture), 1, 'late old failure', true, 3), 'stale',
  'old attempt failure cannot requeue the current attempt');
select is(public.fail_session_job_attempt((select job_id from attempt_fixture), 2, 'old run with fresh job snapshot', true, 3,
  (select run_id from attempt_fixture)), 'stale', 'a fresh attempt number cannot authorize cleanup of an old run');
create temp table stale_cancel as select * from public.cancel_session_job_attempts(
  (select session_id from attempt_fixture), 'b1b2c3d4-0001-4000-8000-000000000001', 'old run cancellation', (select run_id from attempt_fixture));
select is((select job_ids from stale_cancel), '{}'::uuid[], 'stale run cancellation cannot cancel the retried job');
select is((select run_ids from stale_cancel), '{}'::uuid[], 'stale cancellation returns no replacement sandbox for cleanup');
select is((select status::text from public.agent_runs where id = (select run_id from second_attempt)), 'running', 'stale operations preserve the current run');
select is((select phase_status::text from public.sessions where id = (select session_id from attempt_fixture)), 'in_progress', 'stale operations cannot park the current session');

-- Cancellation makes the old job inert; a replacement can reuse the same stage/version.
create temp table current_cancel as select * from public.cancel_session_job_attempts(
  (select session_id from attempt_fixture), 'b1b2c3d4-0001-4000-8000-000000000001', 'cancel current', (select run_id from second_attempt));
select is((select job_ids from current_cancel), array[(select job_id from attempt_fixture)], 'current cancellation returns exactly the owned job');
select is((select run_ids from current_cancel), array[(select run_id from second_attempt)], 'current cancellation returns exactly the owned run');
select is(pg_temp.start_owned((select job_id from attempt_fixture), 2), null::uuid, 'canceled job cannot restart');
select ok(not public.publish_session_job_attempt((select job_id from attempt_fixture), 2, (select run_id from second_attempt), 0, 'canceled output'), 'canceled job cannot publish');
select is(public.fail_session_job_attempt((select job_id from attempt_fixture), 2, 'canceled failure', true, 3), 'stale', 'canceled job cannot be retried by a late callback');
create temp table replacement as select * from public.enqueue_session_job_with_run(
  (select session_id from attempt_fixture), 'b1b2c3d4-0001-4000-8000-000000000001',
  (select current_stage_id from public.sessions where id = (select session_id from attempt_fixture)),
  null, 'manual_retry', 'codex', 'gpt-5.5', 'project');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from replacement);
select is(pg_temp.start_owned((select job_id from replacement), 1), (select run_id from replacement), 'replacement job starts at the unchanged stage and version');
select ok(not public.publish_session_job_attempt((select job_id from attempt_fixture), 2, (select run_id from second_attempt), 0, 'replaced output'), 'replacement job identity fences old publication despite matching stage/version');
select is(public.fail_session_job_attempt((select job_id from attempt_fixture), 2, 'replaced failure', true, 3), 'stale', 'replacement job identity fences old failure');
select is((select status::text from public.agent_jobs where id = (select job_id from replacement)), 'running', 'old callbacks preserve the replacement job');

-- Legacy runless work binds its stage once; explicit historical stage evidence wins.
create temp table legacy as select * from pg_temp.ownership_fixture('Legacy runless binding');
delete from public.agent_runs where id = (select run_id from legacy);
update public.agent_jobs set status = 'running', attempt_count = 1, stage_id = null, stage_slug = null, stage_name = null where id = (select job_id from legacy);
create temp table legacy_started as select pg_temp.start_owned((select job_id from legacy), 1) as run_id;
select ok((select run_id is not null from legacy_started), 'legacy runless job can bind its first execution');
select is((select stage_id from public.agent_jobs where id = (select job_id from legacy)),
  (select current_stage_id from public.sessions where id = (select session_id from legacy)), 'legacy job receives durable stage identity');
select is((select stage_id from public.agent_runs where id = (select run_id from legacy_started)),
  (select current_stage_id from public.sessions where id = (select session_id from legacy)), 'legacy run receives the same durable stage identity');
create temp table wrong_stage as select * from pg_temp.ownership_fixture('Legacy historical stage guard');
update public.agent_jobs set status = 'running', attempt_count = 1, stage_id = null, stage_slug = null, stage_name = null where id = (select job_id from wrong_stage);
update public.agent_runs set status = 'error' where id = (select run_id from wrong_stage);
update public.sessions set current_stage_id = (select id from public.pipeline_stages where pipeline_id = (select id from ownership_pipeline) and slug = 'build') where id = (select session_id from wrong_stage);
select is(pg_temp.start_owned((select job_id from wrong_stage), 1), null::uuid, 'NULL job stage cannot hide an old-stage historical run');
select is((select count(*) from public.agent_runs where agent_job_id = (select job_id from wrong_stage)), 1::bigint, 'rejected legacy binding creates no new run');

-- A malformed pinned job still cannot claim the phase using older-stage history.
create temp table malformed_stage as select * from pg_temp.ownership_fixture('Pinned job historical mismatch');
update public.agent_runs set status = 'error' where id = (select run_id from malformed_stage);
update public.sessions set current_stage_id = (select id from public.pipeline_stages
  where pipeline_id = (select id from ownership_pipeline) and slug = 'build')
  where id = (select session_id from malformed_stage);
update public.agent_jobs set status = 'running', attempt_count = 1, stage_id = (select current_stage_id from public.sessions
  where id = (select session_id from malformed_stage)) where id = (select job_id from malformed_stage);
select is(pg_temp.start_owned((select job_id from malformed_stage), 1), null::uuid,
  'matching job stage cannot bypass mismatched historical run evidence');
select is(public.fail_session_job_attempt((select job_id from malformed_stage), 1,
  'refused historical owner', true, 3), 'error', 'refused historical owner is retired without retry');
select is((select phase_status::text from public.sessions where id = (select session_id from malformed_stage)),
  'in_progress', 'historical mismatch failure cannot park the current stage');

-- Failure at run creation rolls back phase changes and legacy stage binding.
create temp table atomic_start as select * from pg_temp.ownership_fixture('Atomic start rollback');
delete from public.agent_runs where id = (select run_id from atomic_start);
update public.agent_jobs set status = 'running', attempt_count = 1, stage_id = null, stage_slug = null, stage_name = null where id = (select job_id from atomic_start);
update public.sessions set phase_status = 'awaiting_review' where id = (select session_id from atomic_start);
create function pg_temp.reject_owned_run() returns trigger language plpgsql as $$
begin
  if new.session_id = (select session_id from atomic_start) then
    raise exception 'Injected ownership run failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger ownership_start_failure before insert on public.agent_runs for each row execute function pg_temp.reject_owned_run();
select throws_ok($q$select pg_temp.start_owned((select job_id from atomic_start), 1)$q$, 'P0001', 'Injected ownership run failure', 'run insertion failure aborts the whole start');
select is((select phase_status::text from public.sessions where id = (select session_id from atomic_start)), 'awaiting_review', 'failed start preserves the review state');
select is((select stage_id from public.agent_jobs where id = (select job_id from atomic_start)), null::uuid, 'failed start rolls back legacy job binding');
select is((select count(*) from public.agent_runs where agent_job_id = (select job_id from atomic_start)), 0::bigint, 'failed start leaves no run');
drop trigger ownership_start_failure on public.agent_runs;

-- Publication owns the artifact row as well as the session pointer and run.
create temp table publishing as select * from pg_temp.ownership_fixture('Publication atomicity');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from publishing);
select pg_temp.start_owned((select job_id from publishing), 1);
insert into public.session_artifacts(workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
select workspace_id, id, current_stage_id, 'plan', 1, to_jsonb('pre-existing artifact'::text)
from public.sessions where id = (select session_id from publishing);
select throws_ok($q$select public.publish_session_job_attempt((select job_id from publishing), 1, (select run_id from publishing), 0, 'must not overwrite')$q$,
  '23505', null, 'artifact collision rejects publication instead of overwriting history');
select is((select phase_status::text from public.sessions where id = (select session_id from publishing)), 'in_progress', 'artifact collision rolls back the review transition');
select is((select current_artifact_version from public.sessions where id = (select session_id from publishing)), 0, 'artifact collision rolls back the version pointer');
select is((select status::text from public.agent_runs where id = (select run_id from publishing)), 'running', 'artifact collision leaves the run unpublished');
select is((select artifact_json from public.session_artifacts where session_id = (select session_id from publishing)), to_jsonb('pre-existing artifact'::text), 'artifact collision preserves existing markdown');
delete from public.session_artifacts where session_id = (select session_id from publishing);
select ok(public.publish_session_job_attempt((select job_id from publishing), 1, (select run_id from publishing), 0, 'durable output'), 'owner publishes its artifact');
select is((select status::text from public.agent_runs where id = (select run_id from publishing)), 'success', 'publication marks exactly its run successful');
select ok(not public.publish_session_job_attempt((select job_id from publishing), 1, (select run_id from publishing), 1, 'publish twice'), 'same attempt cannot publish again');
select is(public.fail_session_job_attempt((select job_id from publishing), 1, 'delivery failed after publish', true, 3, (select run_id from publishing)), 'success', 'postpublication failure acknowledges durable output');
select is((select phase_status::text from public.sessions where id = (select session_id from publishing)), 'awaiting_review', 'postpublication failure preserves review state');
select is((select current_artifact_version from public.sessions where id = (select session_id from publishing)), 1, 'postpublication failure preserves the artifact version');
select is((select artifact_json from public.session_artifacts where session_id = (select session_id from publishing)), to_jsonb('durable output'::text), 'postpublication failure preserves markdown');

-- A genuinely new manual retry may replace review with a new attempt/version.
create temp table review_retry as select * from public.enqueue_session_job_with_run(
  (select session_id from publishing), 'b1b2c3d4-0001-4000-8000-000000000001',
  (select current_stage_id from public.sessions where id = (select session_id from publishing)),
  null, 'manual_retry', 'codex', 'gpt-5.5', 'project');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from review_retry);
select is(pg_temp.start_owned((select job_id from review_retry), 1), (select run_id from review_retry), 'new retry can start while the session awaits review');
select is((select phase_status::text from public.sessions where id = (select session_id from publishing)), 'in_progress', 'new retry atomically leaves review');
select ok(public.publish_session_job_attempt((select job_id from review_retry), 1, (select run_id from review_retry), 1, 'revised output'), 'new retry publishes the next version');
select is((select artifact_json from public.session_artifacts where session_id = (select session_id from publishing) and version = 1), to_jsonb('durable output'::text), 'retry keeps earlier artifact history immutable');

-- Approval may advance the session before the publishing worker finishes cleanup.
create temp table advancing as select * from pg_temp.ownership_fixture('Post-approval completion');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from advancing);
select pg_temp.start_owned((select job_id from advancing), 1);
select public.publish_session_job_attempt((select job_id from advancing), 1, (select run_id from advancing), 0, 'approved plan');
create temp table advanced as select * from pg_temp.approve_current_review(
  (select session_id from advancing), 'b1b2c3d4-0001-4000-8000-000000000001', 1, 'c1b2c3d4-0001-4000-8000-000000000001');
select is((select current_stage_slug from advanced), 'build', 'approval advances to the next selected stage');
select ok(public.complete_session_job_attempt((select job_id from advancing), 1, (select run_id from advancing)), 'exact published job can complete after stage advancement');
select is((select status::text from public.agent_jobs where id = (select job_id from advancing)), 'success', 'completion closes only the old publishing job');
select is((select phase_status::text from public.sessions where id = (select session_id from advancing)), 'in_progress', 'completion leaves the new stage running');
select is((select current_artifact_version from public.sessions where id = (select session_id from advancing)), 0, 'completion leaves the new stage artifact pointer alone');
create temp table next_stage as select * from public.enqueue_session_job_with_run(
  (select session_id from advancing), 'b1b2c3d4-0001-4000-8000-000000000001', (select current_stage_id from advanced),
  null, 'assignment', 'codex', 'gpt-5.5', 'project');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from next_stage);
select pg_temp.start_owned((select job_id from next_stage), 1);
select is(public.fail_session_job_attempt((select job_id from advancing), 1, 'late old-stage cleanup', true, 3, (select run_id from advancing)), 'success', 'published old job failure remains idempotent after a replacement starts');
select ok(not public.complete_session_job_attempt((select job_id from next_stage), 1, (select run_id from advancing)), 'new job cannot complete using an old successful run');
select is((select status::text from public.agent_jobs where id = (select job_id from next_stage)), 'running', 'old cleanup leaves replacement job running');
select is((select status::text from public.agent_runs where id = (select run_id from next_stage)), 'running', 'old cleanup leaves replacement run running');
select is((select current_stage_id from public.sessions where id = (select session_id from advancing)), (select current_stage_id from advanced), 'old cleanup cannot move the new stage');

-- A delayed failure before completion must also respect a human's approval.
create temp table advanced_failure as select * from pg_temp.ownership_fixture('Post-approval failure');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from advanced_failure);
select pg_temp.start_owned((select job_id from advanced_failure), 1);
select public.publish_session_job_attempt((select job_id from advanced_failure), 1, (select run_id from advanced_failure), 0, 'approved before failure');
select * from pg_temp.approve_current_review((select session_id from advanced_failure), 'b1b2c3d4-0001-4000-8000-000000000001', 1, 'c1b2c3d4-0001-4000-8000-000000000001');
select is(public.fail_session_job_attempt((select job_id from advanced_failure), 1, 'shutdown failed', true, 3, (select run_id from advanced_failure)), 'success', 'published run failure closes its job even after approval');
select is((select phase_status::text from public.sessions where id = (select session_id from advanced_failure)), 'in_progress', 'postapproval failure preserves the next stage phase');
select is((select current_artifact_version from public.sessions where id = (select session_id from advanced_failure)), 0, 'postapproval failure preserves the next stage version');

-- Workspace/run identity and archive state are checked inside the transaction.
create temp table wrong_workspace_cancel as select * from public.cancel_session_job_attempts(
  (select session_id from legacy), 'b1b2c3d4-0001-4000-8000-000000000002', 'wrong workspace');
select is((select job_ids from wrong_workspace_cancel), '{}'::uuid[], 'wrong workspace cannot cancel a job');
create temp table unrelated_cancel as select * from public.cancel_session_job_attempts(
  (select session_id from legacy), 'b1b2c3d4-0001-4000-8000-000000000001', 'unrelated run', (select run_id from next_stage));
select is((select run_ids from unrelated_cancel), '{}'::uuid[], 'unrelated run cannot authorize sandbox cleanup');
create temp table archived as select * from public.archive_session_job_attempts(
  (select session_id from legacy), 'b1b2c3d4-0001-4000-8000-000000000001', 'archive owned work');
select is((select job_ids from archived), array[(select job_id from legacy)], 'archive returns its canceled job');
select is((select run_ids from archived), array[(select run_id from legacy_started)], 'archive returns only its canceled run');
select ok((select archived_at is not null from public.sessions where id = (select session_id from legacy)), 'archive persists session archival with cancellation');
select is((select status::text from public.agent_jobs where id = (select job_id from legacy)), 'canceled', 'archive terminalizes its job');
select is(pg_temp.start_owned((select job_id from legacy), 1), null::uuid, 'archived job cannot start again');
select ok(not public.publish_session_job_attempt((select job_id from legacy), 1, (select run_id from legacy_started), 0, 'late archived output'), 'archived session rejects publication');
select is(public.fail_session_job_attempt((select job_id from legacy), 1, 'late archived failure', true, 3), 'stale', 'archive cannot be undone by retry');


-- Refused starts still have an exact cleanup path, without disturbing session decisions.
create temp table unbound_active as select * from pg_temp.ownership_fixture('Legacy worker already running');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from unbound_active);
update public.agent_runs set status = 'running' where id = (select run_id from unbound_active);
select is(pg_temp.start_owned((select job_id from unbound_active), 1), null::uuid, 'unbound running legacy worker is never adopted by another executor');
select is((select attempt_count from public.agent_runs where id = (select run_id from unbound_active)), null::integer, 'refused legacy adoption does not manufacture ownership');
select is((select status::text from public.agent_runs where id = (select run_id from unbound_active)), 'running', 'refused legacy adoption preserves the running legacy worker');

create temp table refused_archive as select * from pg_temp.ownership_fixture('Archived pre-start cleanup');
delete from public.agent_runs where id = (select run_id from refused_archive);
update public.sessions set archived_at = now(), phase_status = 'awaiting_review' where id = (select session_id from refused_archive);
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from refused_archive);
select is(pg_temp.start_owned((select job_id from refused_archive), 1), null::uuid, 'archived runless work cannot acquire execution authority');
select is(public.fail_session_job_attempt((select job_id from refused_archive), 1, 'archived before start', true, 3), 'error', 'exact claimed runless job can be retired after refused archived start');
select is((select phase_status::text from public.sessions where id = (select session_id from refused_archive)), 'awaiting_review', 'refused-start cleanup does not alter archived review state');
select is((select status::text from public.agent_jobs where id = (select job_id from refused_archive)), 'error', 'refused-start cleanup releases the active-job identity');

create temp table prestart_retry as select * from pg_temp.ownership_fixture('Review pre-start retry');
update public.sessions set phase_status = 'awaiting_review' where id = (select session_id from prestart_retry);
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from prestart_retry);
select is(public.fail_session_job_attempt((select job_id from prestart_retry), 1, 'setup unavailable', true, 3), 'queued', 'fresh pre-start request is retryable while awaiting review');
select is((select phase_status::text from public.sessions where id = (select session_id from prestart_retry)), 'awaiting_review', 'pre-start retry preserves the existing review');
select is((select status::text from public.agent_runs where id = (select run_id from prestart_retry)), 'error', 'pre-start failure retires the unbound placeholder');

select is(public.fail_session_job_attempt((select job_id from next_stage), 1, 'missing run identity', true, 3), 'stale', 'once a run is bound, failure must name that exact run');
select is((select status::text from public.agent_jobs where id = (select job_id from next_stage)), 'running', 'missing run identity cannot park a live bound execution');
select ok(not public.publish_session_job_attempt((select job_id from next_stage), 1, (select run_id from advancing), 0, 'wrong run'), 'publication rejects a successful run from a different job');

create temp table moved_before_publish as select * from pg_temp.ownership_fixture('Stage moved before publication');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from moved_before_publish);
select pg_temp.start_owned((select job_id from moved_before_publish), 1);
update public.sessions set current_stage_id = (select id from public.pipeline_stages where pipeline_id = (select id from ownership_pipeline) and slug = 'build'),
  phase_status = 'in_progress' where id = (select session_id from moved_before_publish);
select is(public.fail_session_job_attempt((select job_id from moved_before_publish), 1, 'stage moved', true, 3, (select run_id from moved_before_publish)), 'error', 'prepublication old-stage failure retires its exact job without retry');
select is((select phase_status::text from public.sessions where id = (select session_id from moved_before_publish)), 'in_progress', 'prepublication old-stage failure cannot park the new stage');
select is((select status::text from public.agent_runs where id = (select run_id from moved_before_publish)), 'error', 'prepublication old-stage failure closes only its old run');


-- Cancellation remains available between the queue claim and owned start.
create temp table claimed_cancel as select * from pg_temp.ownership_fixture('Cancel claim before start');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from claimed_cancel);
create temp table claim_gap_cancel as select * from public.cancel_session_job_attempts(
  (select session_id from claimed_cancel), 'b1b2c3d4-0001-4000-8000-000000000001', 'cancel before start', (select run_id from claimed_cancel));
select is((select job_ids from claim_gap_cancel), array[(select job_id from claimed_cancel)], 'queued run can cancel a job already claimed but not started');
select is((select run_ids from claim_gap_cancel), array[(select run_id from claimed_cancel)], 'claim-gap cancellation returns its unbound queued run');
select is(pg_temp.start_owned((select job_id from claimed_cancel), 1), null::uuid, 'canceled claim cannot subsequently start');

-- Default archive is reversible and must preserve already completed decisions.
create temp table review_archive as select * from public.archive_session_job_attempts(
  (select session_id from publishing), 'b1b2c3d4-0001-4000-8000-000000000001', 'archive review');
select is((select run_ids from review_archive), array[(select run_id from review_retry)], 'archive returns the published run whose active job still owns sandbox cleanup');
select is((select status::text from public.agent_runs where id = (select run_id from review_retry)), 'success', 'archive preserves published run success while returning its cleanup identity');
select is((select artifact_json from public.session_artifacts where session_id = (select session_id from publishing) and version = 2), to_jsonb('revised output'::text), 'archive cleanup preserves the published artifact');
select is((select phase_status::text from public.sessions where id = (select session_id from publishing)), 'awaiting_review', 'default archive preserves awaiting review');
update public.sessions set archived_at = null where id = (select session_id from publishing);
select is((select phase_status::text from public.sessions where id = (select session_id from publishing)), 'awaiting_review', 'unarchive restores the same review decision');
select is((select current_artifact_version from public.sessions where id = (select session_id from publishing)), 2, 'archive and unarchive preserve the reviewed artifact pointer');
create temp table approved_archive as select * from pg_temp.ownership_fixture('Archive already approved');
update public.sessions set phase_status = 'approved' where id = (select session_id from approved_archive);
select * from public.archive_session_job_attempts((select session_id from approved_archive), 'b1b2c3d4-0001-4000-8000-000000000001', 'archive approved');
select is((select phase_status::text from public.sessions where id = (select session_id from approved_archive)), 'approved', 'default archive preserves approval');

select is(public.fail_session_job_attempt((select job_id from wrong_stage), 1, 'refused historical stage', true, 3), 'error', 'NULL-stage historical mismatch is retired instead of retried');
select is((select phase_status::text from public.sessions where id = (select session_id from wrong_stage)), 'in_progress', 'historical mismatch cleanup does not park the current stage');
select is(public.fail_session_job_attempt((select job_id from unbound_active), 1, 'legacy execution failed', false, 3), 'error', 'captured attempt can retire an unbound legacy run when no bound owner exists');
select is((select status::text from public.agent_runs where id = (select run_id from unbound_active)), 'error', 'runless legacy failure retires its unbound run');

select * from finish();
rollback;
