begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();

select extensions.dblink_connect(peer.name, coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'))
from (values ('workbench_factory_holder'), ('workbench_factory_writer')) peer(name);
select extensions.dblink_exec('workbench_factory_writer', $setup$
  set request.jwt.claim.role = 'service_role';
  set role service_role;
  set lock_timeout = '1s';
  create function pg_temp.workbench_writer_sqlstate(command text) returns text language plpgsql as $$
  begin
    execute command;
    return '00000';
  exception when others then return sqlstate;
  end;
  $$;
$setup$);

-- Keep the contention fixture separate from the rollback-only proposal data.
create temp table workbench_writer_scope as
select gen_random_uuid() as workspace_id, gen_random_uuid() as user_id, null::uuid as factory_id;
insert into auth.users(id, email)
select user_id, 'workbench-fence-' || user_id || '@example.test' from workbench_writer_scope;
insert into public.workspaces(id, slug, name)
select workspace_id, 'workbench-fence-' || workspace_id, 'Workbench writer fence' from workbench_writer_scope;
insert into public.workspace_members(workspace_id, user_id, kind, role)
select workspace_id, user_id, 'human', 'owner' from workbench_writer_scope;
update workbench_writer_scope scope set factory_id = factory.id
from public.factories factory where factory.workspace_id = scope.workspace_id and factory.is_default;
commit;

select extensions.dblink_exec('workbench_factory_holder', 'begin');
select locked.id from workbench_writer_scope scope
cross join lateral extensions.dblink('workbench_factory_holder', format(
  'select id from public.factories where id = %L for key share', scope.factory_id)) locked(id uuid);

-- KEY SHARE conflicts with FOR UPDATE, while allowing weaker row locks.
-- Both production writers must encounter that exact factory fence before
-- looking up the missing proposal/diagnosis or writing a review event.
select is(response.code, '55P03', writer.label)
from workbench_writer_scope scope
cross join lateral (values
  ('review append takes the exclusive factory writer fence', format(
    'select public.save_factory_improvement_review_event(%L,%L,%L,%L,%L,0,%L,''comment'',''Lock fixture'')',
    scope.workspace_id, scope.factory_id, scope.user_id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())),
  ('proposal revision save takes the same exclusive factory writer fence', format(
    'select public.save_factory_improvement_proposal(%L,%L,%L,%L,1,%L,%L,%L,
      ''Lock fixture'',''Lock fixture'','''',''[]'',''[]'',%L,%L)', scope.workspace_id, scope.factory_id, scope.user_id,
    gen_random_uuid(), gen_random_uuid(), repeat('a', 64), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()))
) writer(label, command)
cross join lateral extensions.dblink('workbench_factory_writer', format(
  'select pg_temp.workbench_writer_sqlstate(%L)', writer.command)) response(code text);

select extensions.dblink_exec('workbench_factory_holder', 'rollback');
select extensions.dblink_disconnect(peer.name)
from (values ('workbench_factory_holder'), ('workbench_factory_writer')) peer(name);

begin;
delete from public.workspaces where id = (select workspace_id from workbench_writer_scope);
delete from auth.users where id = (select user_id from workbench_writer_scope);
commit;

begin;
\set diagnosis_fixture_prefix 63700000
\set diagnosis_inference_ciphertext v2.AAAAAAAAAAAAAAAA.YWJj.AAAAAAAAAAAAAAAAAAAAAA
\ir fixtures/factory_diagnosis_source.psql

create temp table workbench_diagnosis as
select public.request_factory_diagnosis(scope.workspace_id, scope.factory_id, scope.owner_id,
  cohort.id, pg_temp.diagnosis_fixture_id(61), agent.id) as receipt, null::jsonb as claim
from diagnosis_scope scope cross join diagnosis_cohort cohort cross join diagnosis_agent agent;
update workbench_diagnosis set claim = public.claim_factory_diagnosis();
select public.begin_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
  (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid,
  receipt->>'evidence_digest') from workbench_diagnosis;
select public.finish_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
  (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid,
  'completed', jsonb_build_object('version', 1, 'claims', jsonb_build_array(jsonb_build_object(
    'member_ids', jsonb_build_array(receipt#>>'{evidence,0,member_id}'),
    'inferred_cause', 'The current prompt could be clearer.', 'uncertainty', 'The cause is uncertain.'))),
  null, null) from workbench_diagnosis;

create function pg_temp.workbench_propose(
  p_request integer, p_prompt text, p_proposal uuid default null, p_predecessor uuid default null
) returns jsonb language sql as $$
  select public.save_factory_improvement_proposal(scope.workspace_id, scope.factory_id,
    pg_temp.diagnosis_fixture_id(2), (diagnosis.receipt->>'diagnosis_id')::uuid, 1, base.id,
    base.canonical_digest, pg_temp.diagnosis_fixture_id(p_request), 'Make the report clearer.',
    'Reviewers can locate the finding.', 'Check existing report consumers.', jsonb_build_array(jsonb_build_object(
      'kind', 'stage_prompt', 'stageId', pg_temp.diagnosis_fixture_id(32),
      'expectedPromptSha256', encode(sha256(convert_to('Produce a report.', 'UTF8')), 'hex'), 'promptTemplateMd', p_prompt)),
    '[]', p_proposal, p_predecessor, candidate.definition_json,
    encode(sha256(convert_to(candidate.definition_json, 'UTF8')), 'hex'), '{"fields":[],"stages":[]}') -> 'proposal'
  from diagnosis_scope scope cross join workbench_diagnosis diagnosis
  join public.factory_definition_revisions base on base.id = pg_temp.diagnosis_fixture_id(51)
  cross join lateral (select jsonb_set(base.definition_json::jsonb, '{stages,0,promptTemplateMd}', to_jsonb(p_prompt))::text) candidate(definition_json);
$$;

create temp table workbench_receipts(name text primary key, receipt jsonb);
grant select on workbench_receipts to authenticated;
insert into workbench_receipts values ('first', pg_temp.workbench_propose(62, 'Describe the failed check.'));

create function pg_temp.workbench_review(
  p_revision text, p_version integer, p_request integer, p_action text, p_note text, p_actor integer default 2
) returns jsonb language sql as $$
  select public.save_factory_improvement_review_event(scope.workspace_id, scope.factory_id,
    pg_temp.diagnosis_fixture_id(p_actor), (revision.receipt->>'proposalId')::uuid,
    (revision.receipt->>'revisionId')::uuid, p_version, pg_temp.diagnosis_fixture_id(p_request), p_action, p_note)
  from diagnosis_scope scope cross join workbench_receipts revision where revision.name = p_revision;
$$;

insert into workbench_receipts values ('comment', pg_temp.workbench_review('first', 0, 71, 'comment', 'Link the source run.'));
select ok((select receipt @> '{"replay":false,"event":{"version":1,"action":"comment","note":"Link the source run."}}'
  from workbench_receipts where name = 'comment'), 'a manager appends a comment to the exact candidate');
select is(pg_temp.workbench_review('first', 0, 71, 'comment', 'Link the source run.'),
  (select jsonb_set(receipt, '{replay}', 'true') from workbench_receipts where name = 'comment'), 'an exact review replay returns the same event');
select throws_ok($$select pg_temp.workbench_review('first', 0, 71, 'comment', 'Different note.')$$,
  'PT409', null, 'a request ID cannot change an existing review');
select throws_ok($$select pg_temp.workbench_review('first', 0, 72, 'investigate', '')$$,
  'PT409', null, 'a stale review version cannot write on the same candidate');
select throws_ok($$select pg_temp.workbench_review('first', 1, 72, 'investigate', '', 3)$$,
  '42501', null, 'a factory reader cannot record a review decision');
select ok(pg_temp.workbench_review('first', 1, 73, 'revise', 'Keep the summary focused.') @>
  '{"event":{"version":2,"action":"revise"}}', 'a revision request is recorded separately from the compiled candidate');

insert into workbench_receipts
select 'second', pg_temp.workbench_propose(63, 'Summarize the failed check.', (receipt->>'proposalId')::uuid, (receipt->>'revisionId')::uuid)
from workbench_receipts where name = 'first';
select throws_ok($$select pg_temp.workbench_review('first', 2, 74, 'dismiss', '')$$,
  'PT409', null, 'a stale decision cannot dismiss a newly compiled revision');
select is(pg_temp.workbench_review('first', 0, 71, 'comment', 'Link the source run.')#>>'{event,version}', '1',
  'exact replay remains available after the candidate is superseded');

select set_config('request.jwt.claim.sub', pg_temp.diagnosis_fixture_id(3)::text, true);
set local request.jwt.claim.role = 'authenticated';
set local role authenticated;
select ok((select workbench @> jsonb_build_object('latestRevisionId', current.receipt->'revisionId',
    'proposal', jsonb_build_object('revisionId', earlier.receipt->'revisionId'),
    'review', '{"disposition":"revise","version":2,"canReview":false}'::jsonb)
    and jsonb_array_length(workbench#>'{review,events}') = 2
  from diagnosis_scope scope join workbench_receipts earlier on earlier.name = 'first'
  join workbench_receipts current on current.name = 'second'
  cross join lateral public.read_factory_improvement_workbench(scope.workspace_id, scope.factory_id,
    (earlier.receipt->>'proposalId')::uuid, (earlier.receipt->>'revisionId')::uuid) workbench),
  'a signed-in reader can inspect the exact old diff and discussion');
select is((select workbench#>>'{review,events,0,action}' from diagnosis_scope scope
  join workbench_receipts earlier on earlier.name = 'first'
  cross join lateral public.read_factory_improvement_workbench(scope.workspace_id, scope.factory_id,
    (earlier.receipt->>'proposalId')::uuid, (earlier.receipt->>'revisionId')::uuid, 2) workbench),
  'comment', 'discussion pagination reads older events without changing the revision');
select is((select workbench#>>'{proposals,0,revisionId}' from diagnosis_scope scope
  cross join lateral public.list_factory_improvement_workbench(scope.workspace_id, scope.factory_id) workbench),
  (select receipt->>'revisionId' from workbench_receipts where name = 'second'), 'the list presents the latest revision');
select is((select jsonb_array_length(workbench->'proposals') from diagnosis_scope scope
  cross join lateral public.list_factory_improvement_workbench(scope.workspace_id, scope.factory_id, 24,
    null, pg_temp.diagnosis_fixture_id(99)) workbench), 0, 'the cohort filter is scoped and exact');
select set_config('request.jwt.claim.sub', pg_temp.diagnosis_fixture_id(4)::text, true);
select throws_ok($$select public.list_factory_improvement_workbench(workspace_id, factory_id) from diagnosis_scope$$,
  'P0002', null, 'an unrelated signed-in user cannot list this workbench');
select throws_ok($$select public.read_factory_improvement_workbench(scope.workspace_id, scope.factory_id,
    (current.receipt->>'proposalId')::uuid) from diagnosis_scope scope
    join workbench_receipts current on current.name = 'second'$$,
  'P0002', null, 'an unrelated signed-in user cannot read a known revision or its discussion');
reset role;
set local request.jwt.claim.role = 'service_role';

select ok(pg_temp.workbench_review('second', 0, 75, 'dismiss', 'Keep the record for later.') @>
  '{"event":{"version":1,"action":"dismiss"}}', 'dismissal applies to the current exact revision');
select throws_ok($$select pg_temp.workbench_review('second', 1, 76, 'investigate', '')$$,
  'PT409', null, 'a dismissed revision does not accept another decision');
select throws_ok($$update internal.factory_improvement_review_events set note = 'replacement'$$,
  '23514', null, 'discussion events are immutable');

select set_config('request.jwt.claim.sub', pg_temp.diagnosis_fixture_id(2)::text, true);
set local request.jwt.claim.role = 'authenticated';
set local role authenticated;
select ok((select workbench->'review' @> '{"disposition":"dismissed","version":1,"canReview":false}'
  and workbench#>>'{review,events,0,note}' = 'Keep the record for later.'
  from diagnosis_scope scope join workbench_receipts current on current.name = 'second'
  cross join lateral public.read_factory_improvement_workbench(scope.workspace_id, scope.factory_id,
    (current.receipt->>'proposalId')::uuid) workbench), 'dismissed proposals retain readable discussion');
reset role;
select is((select count(*)::integer from public.factory_definition_activations
  where workspace_id = pg_temp.diagnosis_fixture_id(11)), 1, 'review decisions do not activate any candidate');

select * from finish();
rollback;
