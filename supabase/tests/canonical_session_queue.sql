begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role" = 'service_role';

create temp table queue_test_pipeline as
with inserted as (
  insert into public.pipelines(workspace_id, name)
  values ('b1b2c3d4-0001-4000-8000-000000000001', 'Canonical queue proof') returning id
) select id from inserted;
insert into public.pipeline_stages(pipeline_id, workspace_id, position, slug, name, prompt_template_md)
select id, 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, 1, 'plan', 'Plan', 'Plan the task' from queue_test_pipeline
union all
select id, 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, 2, 'build', 'Build', 'Build the task' from queue_test_pipeline;
create temp table queue_test_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
  'Canonical queue proof', 'Queue this task', 'codex', 'gpt-5.5', 'QUEUE-SHARED', null, null,
  (select id from queue_test_pipeline)
);
create function pg_temp.enqueue_fixture(target_session_id uuid)
returns table(job_id uuid, run_id uuid, created boolean)
language sql as $$
  select * from public.enqueue_session_job_with_run(
    target_session_id, 'b1b2c3d4-0001-4000-8000-000000000001',
    (select current_stage_id from public.sessions where id = target_session_id),
    'c1b2c3d4-0001-4000-8000-000000000001', 'manual_retry', 'codex', 'gpt-5.5', 'project'
  );
$$;

select ok(has_function_privilege('service_role', 'public.enqueue_session_job_with_run(uuid,uuid,uuid,uuid,public.agent_trigger_type,text,text,text)', 'EXECUTE'), 'service role can enqueue');
select ok(not has_function_privilege('authenticated', 'public.enqueue_session_job_with_run(uuid,uuid,uuid,uuid,public.agent_trigger_type,text,text,text)', 'EXECUTE'), 'authenticated users cannot call privileged enqueue');
select ok(not has_function_privilege('anon', 'public.enqueue_session_job_with_run(uuid,uuid,uuid,uuid,public.agent_trigger_type,text,text,text)', 'EXECUTE'), 'anonymous users cannot call privileged enqueue');
select ok(not (select prosecdef from pg_proc where oid = 'public.enqueue_session_job_with_run(uuid,uuid,uuid,uuid,public.agent_trigger_type,text,text,text)'::regprocedure), 'enqueue runs with invoker privileges');

-- Model real pre-existing producers: preserve their key, job, run, and phase.
update public.agent_jobs set dedupe_key = 'pipeline:QUEUE-SHARED:active' where id = (select job_id from queue_test_session);
update public.sessions set phase_status = 'awaiting_review' where id = (select session_id from queue_test_session);
create temp table adopted_legacy as select * from pg_temp.enqueue_fixture((select session_id from queue_test_session));
select is((select job_id from adopted_legacy), (select job_id from queue_test_session), 'legacy namespace adopts the existing session job');
select is((select run_id from adopted_legacy), (select run_id from queue_test_session), 'existing run is returned unchanged');
select ok(not (select created from adopted_legacy), 'adoption reports no new work');
select is((select phase_status::text from public.sessions where id = (select session_id from queue_test_session)), 'awaiting_review', 'enqueue does not change review phase');
select is((select status::text from public.agent_jobs where id = (select job_id from queue_test_session)), 'queued', 'adoption does not retire the existing job');
select is((select dedupe_key from public.agent_jobs where id = (select job_id from queue_test_session)), 'pipeline:QUEUE-SHARED:active', 'adoption preserves the legacy job snapshot');
select throws_ok($q$
  insert into public.agent_jobs(workspace_id, session_id, trigger_type, dedupe_key)
  select 'b1b2c3d4-0001-4000-8000-000000000001', session_id, 'assignment', 'different-namespace'
  from queue_test_session
$q$, '23505', null, 'another namespace cannot create a second active session job');

-- New work commits the pair, and repeated intents adopt exactly that pair.
update public.agent_jobs set status = 'success', finished_at = now() where id = (select job_id from queue_test_session);
update public.agent_runs set status = 'success', finished_at = now() where id = (select run_id from queue_test_session);
create temp table new_queue_pair as select * from pg_temp.enqueue_fixture((select session_id from queue_test_session));
select ok((select created from new_queue_pair), 'new enqueue reports creation');
select isnt((select job_id from new_queue_pair), (select job_id from queue_test_session), 'new work gets a distinct job');
select ok(exists(select 1 from public.agent_runs r join new_queue_pair pair on r.id = pair.run_id and r.agent_job_id = pair.job_id where r.status = 'queued' and r.model_provider = 'codex' and r.model_name = 'gpt-5.5'), 'new job and configured queued run are visible together');
select is((select dedupe_key from public.agent_jobs where id = (select job_id from new_queue_pair)), 'session:' || (select session_id::text from queue_test_session) || ':active', 'new work uses the canonical key');
create temp table repeated_pair as select * from pg_temp.enqueue_fixture((select session_id from queue_test_session));
select is((select job_id from repeated_pair), (select job_id from new_queue_pair), 'repeated enqueue adopts the same job');
select is((select run_id from repeated_pair), (select run_id from new_queue_pair), 'repeated enqueue adopts the same run');
select is((select count(*) from public.agent_runs where agent_job_id = (select job_id from new_queue_pair)), 1::bigint, 'dedupe never adds a second run');
select is((select phase_status::text from public.sessions where id = (select session_id from queue_test_session)), 'awaiting_review', 'new enqueue also preserves review state');

-- A rescheduled legacy job is accepted without returning its terminal attempt.
update public.agent_jobs set dedupe_key = 'pipeline:legacy-rescheduled:active' where id = (select job_id from new_queue_pair);
update public.agent_runs set status = 'error' where id = (select run_id from new_queue_pair);
create temp table errored_prior_attempt as select * from pg_temp.enqueue_fixture((select session_id from queue_test_session));
select ok((select run_id is null and not created and job_id = (select job_id from new_queue_pair) from errored_prior_attempt), 'queued legacy job with errored prior attempt returns accepted runless work');
update public.agent_runs set status = 'success' where id = (select run_id from new_queue_pair);
create temp table successful_prior_attempt as select * from pg_temp.enqueue_fixture((select session_id from queue_test_session));
select ok((select run_id is null and not created from successful_prior_attempt), 'successful prior attempt is not represented as active work');
update public.agent_runs set status = 'canceled' where id = (select run_id from new_queue_pair);
create temp table canceled_prior_attempt as select * from pg_temp.enqueue_fixture((select session_id from queue_test_session));
select ok((select run_id is null and not created from canceled_prior_attempt), 'canceled prior attempt is not represented as active work');
select is((select status::text from public.agent_runs where id = (select run_id from new_queue_pair)), 'canceled', 'adoption leaves terminal history unchanged');
select is((select count(*) from public.agent_runs where agent_job_id = (select job_id from new_queue_pair)), 1::bigint, 'runless acceptance does not synthesize a replacement run');
select is((select status::text from public.agent_jobs where id = (select job_id from new_queue_pair)), 'queued', 'runless acceptance preserves the queued job');

-- A bare legacy job may race the worker's separate run INSERT. Do not repair it.
delete from public.agent_runs where id = (select run_id from new_queue_pair);
update public.agent_jobs set stage_id = null, stage_slug = null, stage_name = null where id = (select job_id from new_queue_pair);
create temp table queued_without_run as select * from pg_temp.enqueue_fixture((select session_id from queue_test_session));
select ok((select run_id is null and not created from queued_without_run), 'queued legacy runless job returns an explicit missing-run receipt');
update public.agent_jobs set status = 'running', attempt_count = 1 where id = (select job_id from new_queue_pair);
create temp table claimed_without_run as select * from pg_temp.enqueue_fixture((select session_id from queue_test_session));
select ok((select run_id is null and not created from claimed_without_run), 'claimed legacy runless job is adopted without run synthesis');
select is((select count(*) from public.agent_runs where agent_job_id = (select job_id from new_queue_pair)), 0::bigint, 'neither runless adoption creates a competing run');

-- Explicit stage evidence must never be relabeled as next-stage work.
insert into public.agent_runs(workspace_id, session_id, agent_job_id, stage_id, stage_slug, stage_name, model_provider, model_name, run_type, status)
select 'b1b2c3d4-0001-4000-8000-000000000001', session_id, (select job_id from new_queue_pair),
  (select id from public.pipeline_stages where pipeline_id = (select id from queue_test_pipeline) and slug = 'plan'), 'plan', 'Plan', 'codex', 'gpt-5.5', 'project', 'running'
from queue_test_session;
update public.sessions set current_stage_id = (select id from public.pipeline_stages where pipeline_id = (select id from queue_test_pipeline) and slug = 'build')
where id = (select session_id from queue_test_session);
select throws_ok($q$select * from pg_temp.enqueue_fixture((select session_id from queue_test_session))$q$, '55000', 'Session has an active job for a different stage.', 'a NULL job stage cannot hide its old-stage run snapshot');
update public.agent_runs set status = 'error' where agent_job_id = (select job_id from new_queue_pair);
select throws_ok($q$select * from pg_temp.enqueue_fixture((select session_id from queue_test_session))$q$, '55000', 'Session has an active job for a different stage.', 'terminal historical stage evidence still prevents adopting a prior-stage job');
update public.agent_runs set status = 'running' where agent_job_id = (select job_id from new_queue_pair);
insert into public.agent_runs(workspace_id, session_id, agent_job_id, stage_id, stage_slug, stage_name, model_provider, model_name, run_type, status, created_at)
select 'b1b2c3d4-0001-4000-8000-000000000001', session_id, (select job_id from new_queue_pair),
  (select id from public.pipeline_stages where pipeline_id = (select id from queue_test_pipeline) and slug = 'build'), 'build', 'Build', 'codex', 'gpt-5.5', 'project', 'success', now() + interval '1 second'
from queue_test_session;
select throws_ok($q$select * from pg_temp.enqueue_fixture((select session_id from queue_test_session))$q$, '55000', 'Session has an active job for a different stage.', 'newer terminal history cannot hide the selected active run stage');
update public.agent_jobs set stage_id = (select id from public.pipeline_stages where pipeline_id = (select id from queue_test_pipeline) and slug = 'plan') where id = (select job_id from new_queue_pair);
select throws_ok($q$select * from pg_temp.enqueue_fixture((select session_id from queue_test_session))$q$, '55000', 'Session has an active job for a different stage.', 'explicit old-stage jobs are not adopted or retired');
select is((select status::text from public.agent_jobs where id = (select job_id from new_queue_pair)), 'running', 'stage mismatch preserves the running worker');

-- Independent sessions keep distinct queue identities.
create temp table second_queue_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
  'Second session', 'Independent session', 'codex', 'gpt-5.5', 'QUEUE-SECOND', null, null,
  (select id from queue_test_pipeline)
);
select isnt((select job_id from second_queue_session), (select job_id from new_queue_pair), 'independent sessions keep distinct active jobs');

-- Failure in the second INSERT must roll the first INSERT back too.
update public.agent_jobs set status = 'success' where id = (select job_id from second_queue_session);
update public.agent_runs set status = 'success' where id = (select run_id from second_queue_session);
create function pg_temp.reject_queue_run_insert() returns trigger language plpgsql as $$
begin
  if new.session_id = (select session_id from second_queue_session) then
    raise exception 'Injected run insert failure' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger queue_test_run_failure before insert on public.agent_runs for each row execute function pg_temp.reject_queue_run_insert();
select throws_ok($q$select * from pg_temp.enqueue_fixture((select session_id from second_queue_session))$q$, 'P0001', 'Injected run insert failure', 'run insert failure propagates');
select is((select count(*) from public.agent_jobs where session_id = (select session_id from second_queue_session) and status in ('queued','started','running')), 0::bigint, 'run insert failure leaves no orphan active job');
drop trigger queue_test_run_failure on public.agent_runs;

update public.sessions set archived_at = now() where id = (select session_id from second_queue_session);
select throws_ok($q$select * from pg_temp.enqueue_fixture((select session_id from second_queue_session))$q$, '55000', 'Session is archived.', 'database rechecks archive state before enqueue');
-- Rejection must adopt a queued rerun under an old producer's namespace.
create temp table rejection_legacy_session as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
  'Legacy rejection', 'Keep its queued job', 'codex', 'gpt-5.5', null, null, null,
  (select id from queue_test_pipeline)
);
insert into public.session_artifacts(workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
select s.workspace_id, s.id, s.current_stage_id, 'plan', 1, to_jsonb('Review me'::text)
from public.sessions s where s.id = (select session_id from rejection_legacy_session);
update public.sessions set phase_status = 'awaiting_review', current_artifact_version = 1
where id = (select session_id from rejection_legacy_session);
update public.agent_jobs set dedupe_key = 'pipeline:legacy-rejection:active'
where id = (select job_id from rejection_legacy_session);
create temp table rejection_legacy_result as select * from public.reject_session_stage(
  (select session_id from rejection_legacy_session), 'b1b2c3d4-0001-4000-8000-000000000001',
  1, 'Apply this feedback', 'codex', 'gpt-5.5', 'project', 'c1b2c3d4-0001-4000-8000-000000000001'
);
select is((select job_id from rejection_legacy_result), (select job_id from rejection_legacy_session), 'rejection adopts a queued rerun by session despite its legacy key');
select is((select run_id from rejection_legacy_result), (select run_id from rejection_legacy_session), 'rejection preserves the adopted queued run');
select is((select count(*) from public.agent_jobs where session_id = (select session_id from rejection_legacy_session) and status in ('queued','started','running')), 1::bigint, 'rejection leaves exactly one active job');

select * from finish();
rollback;
