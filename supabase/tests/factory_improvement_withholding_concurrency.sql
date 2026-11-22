begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
create temp table improvement_original_release as select enabled, revision from public.get_git_continuity_release_state();

\set diagnosis_fixture_prefix 63610000
\set diagnosis_inference_ciphertext v2.AAAAAAAAAAAAAAAA.YWJj.AAAAAAAAAAAAAAAAAAAAAA
select set_config('wallie.diagnosis_fixture_prefix', :'diagnosis_fixture_prefix', false);
\ir fixtures/factory_diagnosis_source.psql

create temp table improvement_race_diagnosis as
select public.request_factory_diagnosis(scope.workspace_id, scope.factory_id, scope.owner_id,
  cohort.id, pg_temp.diagnosis_fixture_id(61), agent.id) as receipt, null::jsonb as claim
from diagnosis_scope scope cross join diagnosis_cohort cohort cross join diagnosis_agent agent;
update improvement_race_diagnosis set claim = public.claim_factory_diagnosis();
select ok((select public.begin_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
  (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid, receipt->>'evidence_digest')
  is not null from improvement_race_diagnosis), 'the fixture begins its exact diagnosis lease');
select ok((select public.finish_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
  (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid, 'completed',
  jsonb_build_object('version', 1, 'claims', jsonb_build_array(jsonb_build_object(
    'member_ids', jsonb_build_array(receipt#>>'{evidence,0,member_id}'),
    'inferred_cause', 'The prompt may be ambiguous.', 'uncertainty', 'The log does not isolate the cause.'))),
  '{"provider_model":"openai/gpt-4.1-mini","provider_request_id":"withholding-race","worker_runtime":"node"}', null)
  from improvement_race_diagnosis), 'the fixture retains a completed diagnosis with one cited asset');

create temp table improvement_race_commands as
select request.slot, format('select public.save_factory_improvement_proposal(%L,%L,%L,%L,1,%L,%L,%L,
  %L,%L,%L,%L,%L,p_definition_json => %L,p_candidate_digest => %L,p_diff => %L)',
  scope.workspace_id, scope.factory_id, scope.owner_id, diagnosis.receipt->>'diagnosis_id',
  base.id, base.canonical_digest, pg_temp.diagnosis_fixture_id(request.slot),
  'Record the failing checks', 'Provide an exact diagnostic report', '',
  jsonb_build_array(jsonb_build_object('kind','stage_prompt','stageId',pg_temp.diagnosis_fixture_id(32),
    'promptTemplateMd','Describe the observed failures.',
    'expectedPromptSha256',encode(sha256(convert_to('Produce a report.','UTF8')),'hex'))),
  '[]', candidate.definition, encode(sha256(convert_to(candidate.definition, 'UTF8')), 'hex'), '{"fields":[],"stages":[]}'
) as command
from diagnosis_scope scope cross join improvement_race_diagnosis diagnosis
cross join (values (62), (63)) request(slot)
join public.factory_definition_revisions base on base.id = pg_temp.diagnosis_fixture_id(51)
cross join lateral (select jsonb_set(base.definition_json::jsonb, '{stages,0,promptTemplateMd}',
  to_jsonb('Describe the observed failures.'::text))::text) candidate(definition);

-- The release gate is needed only for creating the source, which is now pinned.
select public.set_git_continuity_release(false, current.revision, 'Restore proposal race fixture release')
from improvement_original_release original cross join public.get_git_continuity_release_state() current
where not original.enabled and current.enabled and current.revision = original.revision + 1;
commit;

create function pg_temp.wait_for_improvement_lock(blocked_app text, holder_app text)
returns boolean language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists (select 1 from pg_stat_activity blocked cross join pg_stat_activity holder
      where blocked.application_name = blocked_app and holder.application_name = holder_app
        and holder.pid = any(pg_blocking_pids(blocked.pid))) then return true; end if;
    if clock_timestamp() >= deadline then return false; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;

select extensions.dblink_connect(peer.name, coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'))
from (values ('proposal_save_race'), ('proposal_marker_race')) peer(name);
select extensions.dblink_exec(peer.name, format('set application_name=%L; set statement_timeout=''15s'';
  set request.jwt.claim.role=''service_role''; set role service_role', peer.name))
from (values ('proposal_save_race'), ('proposal_marker_race')) peer(name);
select extensions.dblink_exec('proposal_save_race', $function$
  create function pg_temp.proposal_race_sqlstate(command text) returns text language plpgsql as $$
  begin
    execute command;
    return '00000';
  exception when query_canceled or others then return sqlstate;
  end;
  $$
$function$);

-- Storage deletes its metadata in a transaction. A concurrent save cannot
-- rely on the still-visible snapshot when that exact row is being removed.
select extensions.dblink_exec('proposal_marker_race', 'begin; set local storage.allow_delete_query = ''true''');
select is(extensions.dblink_exec('proposal_marker_race', format(
  'delete from storage.objects where bucket_id = ''session-validation-evidence'' and name = %L',
  pg_temp.diagnosis_fixture_id(11)::text || '/' || run_id::text || '/' || asset_id::text)),
  'DELETE 1', 'the evidence delete owns the exact command log metadata row')
from diagnosis_source;
select is(reply.result, 'PT409', 'saving retries while its exact source object is being removed')
from improvement_race_commands input
cross join lateral extensions.dblink('proposal_save_race',
  format('select pg_temp.proposal_race_sqlstate(%L)', input.command)) reply(result text)
where input.slot = 62;
select extensions.dblink_exec('proposal_marker_race', 'rollback');

select extensions.dblink_exec('proposal_save_race', 'begin');
select ok(reply.result @> '{"proposal":{"status":"compiled"},"replay":false}',
  'the first save completes while still holding its transaction open')
from improvement_race_commands input
cross join lateral extensions.dblink('proposal_save_race', input.command) reply(result jsonb)
where input.slot = 62;
select extensions.dblink_exec('proposal_marker_race', 'begin');
select extensions.dblink_send_query('proposal_marker_race', format(
  'insert into public.session_validation_asset_withholdings(asset_id,state) values (%L,''redacted'')', asset_id))
from diagnosis_source;
select ok(pg_temp.wait_for_improvement_lock('proposal_marker_race', 'proposal_save_race'),
  'a direct service marker waits behind the in-flight proposal save');
select extensions.dblink_exec('proposal_save_race', 'commit');
select is((select result from extensions.dblink_get_result('proposal_marker_race') reply(result text)),
  'INSERT 0 1', 'the marker is written only after the save commits');
select count(*) from extensions.dblink_get_result('proposal_marker_race') reply(result text);

select extensions.dblink_exec('proposal_save_race', 'begin');
select extensions.dblink_send_query('proposal_save_race', format('select pg_temp.proposal_race_sqlstate(%L)', command))
from improvement_race_commands where slot = 63;
select ok(pg_temp.wait_for_improvement_lock('proposal_save_race', 'proposal_marker_race'),
  'the next save waits while the marker transaction is still open');
select extensions.dblink_exec('proposal_marker_race', 'commit');
select is((select result from extensions.dblink_get_result('proposal_save_race') reply(result text)),
  'PT422', 'the save rejects the cited source after withholding wins the transaction');
select count(*) from extensions.dblink_get_result('proposal_save_race') reply(result text);
select extensions.dblink_exec('proposal_save_race', 'commit');
select is((select count(*)::int from internal.factory_improvement_proposal_revisions
  where workspace_id = pg_temp.diagnosis_fixture_id(11)), 1,
  'only the revision committed before withholding is retained');
select extensions.dblink_disconnect(peer.name)
from (values ('proposal_save_race'), ('proposal_marker_race')) peer(name);

begin;
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'session-validation-evidence'
  and name in (select pg_temp.diagnosis_fixture_id(11)::text || '/' || run_id::text || '/' || asset_id::text from diagnosis_source);
delete from public.workspaces where id = pg_temp.diagnosis_fixture_id(11);
delete from auth.users where id in (pg_temp.diagnosis_fixture_id(1), pg_temp.diagnosis_fixture_id(2),
  pg_temp.diagnosis_fixture_id(3), pg_temp.diagnosis_fixture_id(4));
set constraints all immediate;
commit;
select * from finish();
