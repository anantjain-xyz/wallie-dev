begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(7);
set local request.jwt.claim.role = 'service_role';

create function pg_temp.evaluation_race_id(slot integer) returns uuid language sql immutable as $$
  select ('60400000-6000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values (pg_temp.evaluation_race_id(1), 'evaluation-race@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.evaluation_race_id(2), 'evaluation-race', 'Evaluation queue race');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.evaluation_race_id(3), pg_temp.evaluation_race_id(2), pg_temp.evaluation_race_id(1), 'human', 'owner');
insert into public.pipelines(id, workspace_id, name)
values (pg_temp.evaluation_race_id(4), pg_temp.evaluation_race_id(2), 'Evaluation race pipeline');
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values (pg_temp.evaluation_race_id(5), pg_temp.evaluation_race_id(2), pg_temp.evaluation_race_id(4), 1, 'review', 'Review');

create temp table evaluation_race_fixture as
select factory.workspace_id, factory.id as factory_id, scorer.id as scorer_revision_id,
  pg_temp.evaluation_race_id(6) as definition_id, pg_temp.evaluation_race_id(7) as session_id
from public.factories factory
cross join lateral public.create_factory_scorer(factory.workspace_id, factory.id, pg_temp.evaluation_race_id(1),
  'Queue proof', 'queue-proof',
  '{"schemaVersion":1,"rubric":"Read the retained diff.","requiredEvidence":["code_diff"],"scoring":{"kind":"boolean","passValue":true}}') scorer
where factory.workspace_id = pg_temp.evaluation_race_id(2) and factory.is_default;
insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
)
select fixture.definition_id, fixture.workspace_id, fixture.factory_id, 2, compiled.definition,
  encode(sha256(convert_to(compiled.definition, 'UTF8')), 'hex'), pg_temp.evaluation_race_id(1)
from evaluation_race_fixture fixture
cross join lateral (
  select jsonb_build_object('schemaVersion', 2, 'kind', 'serial', 'pipelineId', pg_temp.evaluation_race_id(4),
    'scorerRevisionIds', jsonb_build_array(fixture.scorer_revision_id))::text as definition
) compiled;
insert into public.sessions(id, workspace_id, factory_id, number, creator_member_id, title, pipeline_id,
  current_stage_id, factory_definition_provenance, factory_definition_revision_id, execute_pinned_definition)
select session_id, workspace_id, factory_id, 1, pg_temp.evaluation_race_id(3), 'Evaluation race session',
  pg_temp.evaluation_race_id(4), pg_temp.evaluation_race_id(5), 'pinned', definition_id, true
from evaluation_race_fixture;
insert into public.agent_runs(id, workspace_id, session_id, stage_id, run_type, model_provider,
  model_name, status, attempt_count, started_at, finished_at)
select pg_temp.evaluation_race_id(slot), workspace_id, session_id, pg_temp.evaluation_race_id(5),
  'project', 'codex', 'gpt-5.5', 'success', 1, clock_timestamp() - interval '1 minute', clock_timestamp()
from evaluation_race_fixture cross join (values (11), (12)) target(slot);

create temp table evaluation_race_policies(revision_number integer primary key, id uuid not null);
insert into evaluation_race_policies
select policy.revision_number, policy.id from evaluation_race_fixture fixture
cross join lateral public.save_factory_scorer_sampling_policy(fixture.workspace_id, fixture.factory_id,
  pg_temp.evaluation_race_id(1), fixture.scorer_revision_id, 0, 10000, 'receipt-a') policy;
insert into evaluation_race_policies
select policy.revision_number, policy.id from evaluation_race_fixture fixture
cross join lateral public.save_factory_scorer_sampling_policy(fixture.workspace_id, fixture.factory_id,
  pg_temp.evaluation_race_id(1), fixture.scorer_revision_id, 1, 10000, 'receipt-b') policy;
select public.configure_factory_evaluation_lane(workspace_id, pg_temp.evaluation_race_id(1), 0, false, 1)
from evaluation_race_fixture;
commit;

set request.jwt.claim.role = 'service_role';
-- Insert exact sampler receipts in separate transactions. The lifecycle
-- fixture covers real retained checkout and artifact eligibility.
create function pg_temp.evaluation_receipt_sql(p_run_id uuid, p_revision integer) returns text language sql as $$
  select format($command$
    insert into public.factory_scorer_sample_receipts(
      workspace_id, factory_id, policy_id, scorer_revision_id, definition_revision_id, session_id,
      run_id, attempt_count, run_finished_at, target_commit_sha, outcome, missing_evidence, evidence
    ) select %L, %L, %L, %L, %L, %L, run.id, run.attempt_count, run.finished_at, repeat('a', 40),
      'sampled', '{}', jsonb_build_array(jsonb_build_object('kind', 'code_diff', 'id', run.id))
    from public.agent_runs run where run.id = %L returning id
  $command$, fixture.workspace_id, fixture.factory_id, policy.id, fixture.scorer_revision_id,
    fixture.definition_id, fixture.session_id, p_run_id)
  from evaluation_race_fixture fixture cross join evaluation_race_policies policy
  where policy.revision_number = p_revision
$$;

select extensions.dblink_connect('evaluation_leader',
  coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('evaluation_contender',
  coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('evaluation_leader',
  'set statement_timeout = ''10s''; set request.jwt.claim.role = ''service_role''; begin');
select extensions.dblink_exec('evaluation_contender',
  'set statement_timeout = ''10s''; set request.jwt.claim.role = ''service_role''; set application_name = ''evaluation_contender''');

create temp table evaluation_first_receipt as
select id from extensions.dblink('evaluation_leader',
  pg_temp.evaluation_receipt_sql(pg_temp.evaluation_race_id(11), 1)) as receipt(id uuid);
select extensions.dblink_send_query('evaluation_contender', pg_temp.evaluation_receipt_sql(pg_temp.evaluation_race_id(11), 2));
do $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    exit when exists (select 1 from pg_stat_activity
      where application_name = 'evaluation_contender' and wait_event_type = 'Lock');
    if clock_timestamp() >= deadline then raise exception 'The second sampled receipt did not reach the admission fence.'; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_exec('evaluation_leader', 'commit');
select is((select count(*) from extensions.dblink_get_result('evaluation_contender') as receipt(id uuid)),
  1::bigint, 'both independent sampling policies retain their own receipts');
select * from extensions.dblink_get_result('evaluation_contender') as receipt(id uuid);
select is((select count(*) from public.factory_evaluation_jobs where run_id = pg_temp.evaluation_race_id(11)),
  1::bigint, 'concurrent completion deliveries admit a single evaluation');
select is((select sample_receipt_id from public.factory_evaluation_jobs where run_id = pg_temp.evaluation_race_id(11)),
  (select id from evaluation_first_receipt), 'duplicate admission preserves the winning sampled receipt');

select id from extensions.dblink('evaluation_leader',
  pg_temp.evaluation_receipt_sql(pg_temp.evaluation_race_id(12), 1)) as receipt(id uuid);
select extensions.dblink_exec('evaluation_leader', 'begin');
create temp table evaluation_first_claim as
select job_id, attempt_id from extensions.dblink('evaluation_leader',
  'select job_id, attempt_id from public.claim_factory_evaluation_job()') as claim(job_id uuid, attempt_id uuid);
select is((select count(*) from evaluation_first_claim), 1::bigint, 'the leader reserves the only workspace slot');
select is((select count(*) from public.claim_factory_evaluation_job()), 0::bigint,
  'concurrent claims cannot take the last evaluation slot twice');
select extensions.dblink_exec('evaluation_leader', 'commit');
select is((select count(*) from public.claim_factory_evaluation_job()), 0::bigint,
  'after commit the active lease continues to occupy its slot');
select is((select count(*) from public.factory_evaluation_attempts where workspace_id = pg_temp.evaluation_race_id(2)),
  1::bigint, 'only one attempt exists across the competing workers');

select extensions.dblink_disconnect('evaluation_contender');
select extensions.dblink_disconnect('evaluation_leader');
delete from public.workspaces where id = pg_temp.evaluation_race_id(2);
delete from auth.users where id = pg_temp.evaluation_race_id(1);
reset request.jwt.claim.role;
select * from finish();
