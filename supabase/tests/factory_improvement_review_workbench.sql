begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
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
