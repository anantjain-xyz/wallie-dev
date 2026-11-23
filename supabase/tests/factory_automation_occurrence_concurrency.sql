begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
\set op651_fixture_namespace 66030000
\ir fixtures/factory_automation_occurrences.psql

create temp table racing_occurrence as select pg_temp.record_test_occurrence('shared-scheduled-occurrence') as value;
create temp table first_worker_receipt(result jsonb);
commit;

set request.jwt.claim.role = 'service_role';
create function pg_temp.connect_automation_worker(p_name text) returns void language plpgsql as $$
begin
  perform extensions.dblink_connect(p_name, coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
  perform extensions.dblink_exec(p_name, format(
    'set application_name = %L; set statement_timeout = %L; set request.jwt.claim.role = %L',
    p_name, '12s', 'service_role'));
end;
$$;

create function pg_temp.test_automation_workers() returns setof text language plpgsql as $$
declare
  holder jsonb;
  contender jsonb;
begin
  perform pg_temp.connect_automation_worker('op660_worker_one');
  perform pg_temp.connect_automation_worker('op660_worker_two');
  perform extensions.dblink_exec('op660_worker_one', 'begin');
  select result.value into strict holder
  from extensions.dblink('op660_worker_one', 'select public.admit_next_factory_automation_occurrence()') result(value jsonb);
  return next is(holder->>'status', 'admitted', 'the first worker admits while its transaction remains open');
  select result.value into strict contender
  from extensions.dblink('op660_worker_two', 'select public.admit_next_factory_automation_occurrence()') result(value jsonb);
  return next is(contender, null::jsonb, 'an independent overlapping worker cannot claim the owned occurrence');
  perform extensions.dblink_exec('op660_worker_one', 'commit');
  insert into first_worker_receipt values (holder);
  return next is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)),
    1::bigint, 'the two database workers commit exactly one canonical session');
  return next is((select count(*) from public.agent_jobs where workspace_id = pg_temp.op651_id(11)),
    1::bigint, 'the two database workers leave exactly one queued job');
  return next is((select count(*) from internal.session_mutation_receipts receipt
    where receipt.request_id = (holder->>'occurrenceId')::uuid), 1::bigint,
    'the race leaves one exact common mutation receipt');
exception when query_canceled or others then
  return next fail(format('automation workers failed (%s): %s', SQLSTATE, SQLERRM));
end;
$$;

select * from pg_temp.test_automation_workers();
select extensions.dblink_disconnect(peer.name)
from (values ('op660_worker_one'), ('op660_worker_two')) peer(name)
where peer.name = any(coalesce(extensions.dblink_get_connections(), '{}'::text[]));

begin;
create temp table race_published_revision as
select (public.save_factory_automation_draft(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id,
  jsonb_set(pg_temp.dry_run_definition('schedule'), '{name}', '"Review after worker restart"'))->>'draftRevisionId')::uuid as revision_id
from automation_occurrence_rule;
select public.publish_factory_automation(rule.workspace_id, rule.factory_id, pg_temp.op651_id(1), rule.automation_id, replacement.revision_id)
from automation_occurrence_rule rule cross join race_published_revision replacement;
commit;

create function pg_temp.test_automation_restart() returns setof text language plpgsql as $$
declare
  original jsonb;
  replay jsonb;
  replay_query text;
begin
  select result into strict original from first_worker_receipt;
  select format('select public.record_factory_automation_occurrence(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L,%L,%L::jsonb)',
    rule.workspace_id, rule.factory_id, rule.automation_id, active.revision_id,
    'schedule', 'shared-scheduled-occurrence', '{"kind":"schedule","scheduledFor":"2026-11-23T09:00:00-08:00"}')
  into strict replay_query from automation_occurrence_rule rule cross join race_published_revision active;
  perform pg_temp.connect_automation_worker('op660_restarted_worker');
  select result.value into strict replay from extensions.dblink('op660_restarted_worker', replay_query) result(value jsonb);
  return next ok(replay->>'replayed' = 'true' and (replay - 'replayed') = (original - 'replayed'),
    'a new database connection redelivering after republish recovers the original immutable receipt');
  return next is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)),
    1::bigint, 'restarting and replaying do not create a second session');
exception when query_canceled or others then
  return next fail(format('automation restart failed (%s): %s', SQLSTATE, SQLERRM));
end;
$$;

select * from pg_temp.test_automation_restart();
select extensions.dblink_disconnect('op660_restarted_worker')
where 'op660_restarted_worker' = any(coalesce(extensions.dblink_get_connections(), '{}'::text[]));

create temp table pause_race as
select pg_temp.record_test_occurrence('pending-during-pause', revision_id) as value from race_published_revision;

create function pg_temp.test_automation_pause_race() returns setof text language plpgsql as $$
declare
  pause_query text;
  control jsonb;
  contender jsonb;
begin
  select format('select public.configure_factory_automation_admission(%L::uuid,%L::uuid,%L::uuid,%L::uuid,0,true,4)',
    rule.workspace_id, rule.factory_id, pg_temp.op651_id(1), rule.automation_id)
  into strict pause_query from automation_occurrence_rule rule;
  perform pg_temp.connect_automation_worker('op660_pause_manager');
  perform pg_temp.connect_automation_worker('op660_pause_claim');
  perform extensions.dblink_exec('op660_pause_manager', 'begin');
  select result.value into strict control from extensions.dblink('op660_pause_manager', pause_query) result(value jsonb);
  return next is(control->>'paused', 'true', 'the pause claims the factory and rule locks in an open transaction');
  select result.value into strict contender
  from extensions.dblink('op660_pause_claim', 'select public.admit_next_factory_automation_occurrence()') result(value jsonb);
  return next is(contender, null::jsonb, 'an overlapping worker cannot claim through the pause fence');
  perform extensions.dblink_exec('op660_pause_manager', 'commit');
  return next is(public.admit_next_factory_automation_occurrence()->>'reason', 'paused',
    'the worker observes the winning pause after it commits');
  return next is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)),
    1::bigint, 'the pause race does not create another root');
exception when query_canceled or others then
  return next fail(format('automation pause race failed (%s): %s', SQLSTATE, SQLERRM));
end;
$$;

select * from pg_temp.test_automation_pause_race();
select extensions.dblink_disconnect(peer.name)
from (values ('op660_pause_manager'), ('op660_pause_claim')) peer(name)
where peer.name = any(coalesce(extensions.dblink_get_connections(), '{}'::text[]));
select pg_temp.configure_test_automation(1, false, 4);
create temp table resumed_pause_occurrence as select public.admit_next_factory_automation_occurrence() as value;
select ok(resumed.value->>'occurrenceId' = paused.value->>'occurrenceId' and resumed.value->>'status' = 'admitted'
  and resumed.value->>'sessionId' is not null, 'resume admits and links the exact occurrence preserved by the pause race')
from resumed_pause_occurrence resumed cross join pause_race paused;

create temp table retry_occurrence as
select pg_temp.record_test_occurrence('authority-lock-retry', revision_id) as value from race_published_revision;

create function pg_temp.test_automation_retry_limit() returns setof text language plpgsql as $$
declare
  payer_lock_query text;
  occurrence_id uuid;
  outcome jsonb;
  attempt_started timestamptz;
  roots_before bigint;
begin
  select (value->>'occurrenceId')::uuid into strict occurrence_id from retry_occurrence;
  select count(*) into roots_before from public.sessions where workspace_id = pg_temp.op651_id(11);
  select format('select id from public.workspace_members where id = %L::uuid for update', budget_payer_member_id)
  into strict payer_lock_query from op651_grant;
  perform pg_temp.connect_automation_worker('op660_busy_payer');
  perform extensions.dblink_exec('op660_busy_payer', 'begin');
  perform locked.id from extensions.dblink('op660_busy_payer', payer_lock_query) locked(id uuid);

  for attempt in 1..5 loop
    attempt_started := clock_timestamp();
    outcome := public.admit_next_factory_automation_occurrence();
    return next is((outcome->>'attemptCount')::integer, attempt, 'transient contention consumes one attempt');
    if attempt < 5 then
      return next ok(outcome->>'status' = 'pending' and outcome->>'reason' = 'authority_changing'
        and (outcome->>'nextAttemptAt')::timestamptz >= attempt_started + make_interval(secs => 5 * (2 ^ (attempt - 1))),
        'transient authority contention schedules bounded exponential backoff');
      if attempt = 1 then
        return next is(public.admit_next_factory_automation_occurrence(), null::jsonb,
          'the scheduled retry is unavailable before its backoff expires');
      end if;
      update internal.factory_automation_occurrences occurrence set next_attempt_at = clock_timestamp() - interval '1 second'
      where occurrence.id = occurrence_id;
    else
      return next ok(outcome->>'status' = 'denied' and outcome->>'reason' = 'retry_exhausted'
        and outcome->>'sessionId' is null and outcome->>'settledAt' is not null,
        'the final transient failure becomes a durable denial without a session');
    end if;
  end loop;
  perform extensions.dblink_exec('op660_busy_payer', 'rollback');
  return next is(public.admit_next_factory_automation_occurrence(), null::jsonb,
    'an exhausted occurrence is no longer claimable even after the payer lock releases');
  return next is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)), roots_before,
    'retry backoff and exhaustion create no partial root');
exception when query_canceled or others then
  return next fail(format('automation retry limit failed (%s): %s', SQLSTATE, SQLERRM));
end;
$$;

select * from pg_temp.test_automation_retry_limit();
select extensions.dblink_disconnect('op660_busy_payer')
where 'op660_busy_payer' = any(coalesce(extensions.dblink_get_connections(), '{}'::text[]));

create temp table installation_lock_occurrence as
select pg_temp.record_test_occurrence('installation-lock', revision_id) as value from race_published_revision;

create function pg_temp.test_automation_installation_contention() returns setof text language plpgsql as $$
declare
  occurrence_id uuid;
  roots_before bigint;
  lock_query text;
  grant_check text;
  deferred jsonb;
  replay jsonb;
  resumed jsonb;
begin
  select (value->>'occurrenceId')::uuid into strict occurrence_id from installation_lock_occurrence;
  select count(*) into roots_before from public.sessions where workspace_id = pg_temp.op651_id(11);
  select format('select id from public.github_installations where (workspace_id, id) = (%L::uuid, %L::uuid)
    and not suspended for update', repository.workspace_id, repository.github_installation_id)
  into strict lock_query from op651_grant approved join public.github_repositories repository on repository.id = approved.github_repository_id;
  select format('select internal.require_factory_machine_grant(%L::uuid,%L::uuid,%L::uuid,%L::bigint)',
    workspace_id, factory_id, id, version) into strict grant_check from op651_grant;
  perform pg_temp.connect_automation_worker('op660_busy_installation');
  perform extensions.dblink_exec('op660_busy_installation', 'begin');
  perform locked.id from extensions.dblink('op660_busy_installation', lock_query) locked(id uuid);
  if not found then raise exception 'The active installation was not locked.'; end if;
  return next throws_ok(grant_check, 'PT409', 'Execution grant access is changing. Retry the operation.',
    'the existing grant check detects the installation lock before common session creation');

  deferred := public.admit_next_factory_automation_occurrence();
  return next is(jsonb_build_array(deferred->>'status', deferred->>'reason'), '["pending", "authority_changing"]'::jsonb,
    'automation admission retries when the active installation is temporarily locked');
  return next ok(deferred->>'occurrenceId' = occurrence_id::text and deferred->>'attemptCount' = '1'
    and (deferred->>'nextAttemptAt')::timestamptz > clock_timestamp()
    and deferred->>'sessionId' is null and deferred->>'mutationReceiptId' is null,
    'the blocked attempt preserves the exact occurrence and leaves no session or common receipt');
  select pg_temp.record_test_occurrence('installation-lock', revision_id) into strict replay
  from race_published_revision;
  return next ok(replay->>'replayed' = 'true' and (replay - 'replayed') = (deferred - 'replayed'),
    'redelivery while blocked returns the same durable retry receipt');
  return next is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)), roots_before,
    'the locked installation does not leave a partial root');

  perform extensions.dblink_exec('op660_busy_installation', 'rollback');
  update internal.factory_automation_occurrences occurrence set next_attempt_at = clock_timestamp() - interval '1 second'
  where occurrence.id = occurrence_id and occurrence.status = 'pending';
  resumed := public.admit_next_factory_automation_occurrence();
  return next ok(resumed->>'occurrenceId' = occurrence_id::text and resumed->>'status' = 'admitted'
    and resumed->>'attemptCount' = '2' and resumed->>'sessionId' is not null and resumed->>'mutationReceiptId' is not null,
    'the same occurrence creates one session through the common command after the installation lock releases');
  return next is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)), roots_before + 1,
    'successful retry creates exactly one root');
exception when query_canceled or others then
  return next fail(format('automation installation contention failed (%s): %s', SQLSTATE, SQLERRM));
end;
$$;

select * from pg_temp.test_automation_installation_contention();
select extensions.dblink_disconnect('op660_busy_installation')
where 'op660_busy_installation' = any(coalesce(extensions.dblink_get_connections(), '{}'::text[]));

begin;
insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.op651_id(40), workspace_id, factory_id, 'Pipeline retired after publication' from op651_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.op651_id(41), pg_temp.op651_id(40), pg_temp.op651_id(11), 1, 'inspect-output', 'Inspect output');
create temp table automation_missing_pipeline_definition as
select scoped.workspace_id, scoped.factory_id, pg_temp.op651_id(49) as revision_id,
  jsonb_set(jsonb_set(scoped.body::jsonb, '{pipelineId}', to_jsonb(pg_temp.op651_id(40))),
    '{stages,0,id}', to_jsonb(pg_temp.op651_id(41)))::text as body
from scoped_revisions scoped where scoped.scenario = 'root';
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
select revision_id, workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.op651_id(21)
from automation_missing_pipeline_definition;
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select revision.workspace_id, revision.factory_id, revision.revision_id, active.activation_number + 1, pg_temp.op651_id(21)
from automation_missing_pipeline_definition revision
cross join lateral internal.factory_workflow_authoring_base(revision.workspace_id, revision.factory_id) active;
create temp table missing_pipeline_rule as
select revision.workspace_id, revision.factory_id, (draft.value->>'automationId')::uuid as automation_id,
  (draft.value->>'draftRevisionId')::uuid as revision_id
from automation_missing_pipeline_definition revision
cross join lateral (select pg_temp.create_dry_run_automation(102, jsonb_set(pg_temp.dry_run_definition('schedule'),
  '{target,definitionRevisionId}', to_jsonb(revision.revision_id))) as value) draft;
select public.publish_factory_automation(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id)
from missing_pipeline_rule;
create temp table missing_pipeline_occurrence as
select public.record_factory_automation_occurrence(workspace_id, factory_id, automation_id, revision_id, 'schedule', 'pipeline-removed',
  '{"kind":"schedule","scheduledFor":"2026-11-23T09:00:00-08:00"}'::jsonb) as value from missing_pipeline_rule;
delete from public.pipelines where id = pg_temp.op651_id(40);
select throws_ok($$
  select public.create_session_command_once(rule.workspace_id, pg_temp.op651_id(21), pg_temp.op651_id(109), repeat('c', 64),
    active.digest, 'Missing pipeline', 'Prove the missing pipeline error.', 'codex', 'gpt-5.5', '{}', target_factory_id => rule.factory_id)
  from missing_pipeline_rule rule
  cross join lateral internal.factory_workflow_authoring_base(rule.workspace_id, rule.factory_id) active
$$, 'P0002', 'The factory definition pipeline is unavailable.', 'the canonical create command reports the actual missing pipeline');
with result as (select public.admit_next_factory_automation_occurrence() as value)
select is(jsonb_build_array(result.value->>'occurrenceId', result.value->>'status', result.value->>'reason'),
  jsonb_build_array(recorded.value->>'occurrenceId', 'denied', 'invalid_assignment'),
  'common session creation still denies an assignment whose published pipeline was actually removed')
from result cross join missing_pipeline_occurrence recorded;
select is(public.admit_next_factory_automation_occurrence(), null::jsonb,
  'missing resources do not stay due for retry');

delete from public.workspaces where id = pg_temp.op651_id(11);
delete from auth.users where id in (pg_temp.op651_id(1), pg_temp.op651_id(2));
select ok(not exists (select 1 from public.workspaces where id = pg_temp.op651_id(11))
  and not exists (select 1 from internal.factory_automation_occurrences where workspace_id = pg_temp.op651_id(11))
  and not exists (select 1 from auth.users where id in (pg_temp.op651_id(1), pg_temp.op651_id(2))),
  'cleanup removes the committed synthetic workspace, accounts and occurrences');
select * from finish();
commit;
