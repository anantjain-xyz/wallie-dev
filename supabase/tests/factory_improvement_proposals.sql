begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set diagnosis_fixture_prefix 63600000
\set diagnosis_include_uncited_stage true
\set diagnosis_inference_ciphertext v2.AAAAAAAAAAAAAAAA.YWJj.AAAAAAAAAAAAAAAAAAAAAA
\ir fixtures/factory_diagnosis_source.psql
\unset diagnosis_include_uncited_stage

create temp table improvement_diagnosis as
select public.request_factory_diagnosis(scope.workspace_id, scope.factory_id, scope.owner_id,
  cohort.id, pg_temp.diagnosis_fixture_id(61), agent.id) as receipt, null::jsonb as claim
from diagnosis_scope scope cross join diagnosis_cohort cohort cross join diagnosis_agent agent;
update improvement_diagnosis set claim = public.claim_factory_diagnosis();

create function pg_temp.improvement_prompt_edit(
  p_prompt text default 'Describe the observed failures.',
  p_stage_id uuid default pg_temp.diagnosis_fixture_id(32)
) returns jsonb language sql stable as $$
  select jsonb_build_array(jsonb_build_object('kind', 'stage_prompt', 'stageId', p_stage_id,
    'expectedPromptSha256', encode(sha256(convert_to('Produce a report.', 'UTF8')), 'hex'),
    'promptTemplateMd', p_prompt));
$$;

create function pg_temp.prepare_improvement(
  p_key integer, p_actor integer default 2, p_edits jsonb default pg_temp.improvement_prompt_edit(),
  p_proposal_id uuid default null, p_predecessor uuid default null,
  p_rationale text default 'Record the failing checks'
) returns jsonb language sql as $$
  select public.prepare_factory_improvement_proposal(scope.workspace_id, scope.factory_id,
    pg_temp.diagnosis_fixture_id(p_actor), (diagnosis.receipt->>'diagnosis_id')::uuid, 1,
    pg_temp.diagnosis_fixture_id(51), diagnosis.receipt->>'definition_digest', pg_temp.diagnosis_fixture_id(p_key),
    p_rationale, 'Provide an exact diagnostic report', '', p_edits, p_proposal_id, p_predecessor)
  from diagnosis_scope scope cross join improvement_diagnosis diagnosis;
$$;

create function pg_temp.save_improvement(
  p_key integer, p_actor integer default 2, p_edits jsonb default pg_temp.improvement_prompt_edit(),
  p_proposal_id uuid default null, p_predecessor uuid default null,
  p_candidate text default null, p_diagnostics jsonb default '[]',
  p_activation_number bigint default 1, p_base_revision_id uuid default pg_temp.diagnosis_fixture_id(51),
  p_base_digest text default null
) returns jsonb language sql as $$
  select public.save_factory_improvement_proposal(scope.workspace_id, scope.factory_id,
    pg_temp.diagnosis_fixture_id(p_actor), (diagnosis.receipt->>'diagnosis_id')::uuid, p_activation_number,
    p_base_revision_id, coalesce(p_base_digest, diagnosis.receipt->>'definition_digest'), pg_temp.diagnosis_fixture_id(p_key),
    'Record the failing checks', 'Provide an exact diagnostic report', '', p_edits, p_diagnostics,
    p_proposal_id, p_predecessor, p_candidate,
    encode(sha256(convert_to(p_candidate, 'UTF8')), 'hex'),
    case when p_candidate is not null then '{"fields":[],"stages":[]}'::jsonb end)
  from diagnosis_scope scope cross join improvement_diagnosis diagnosis;
$$;

select throws_ok($$select pg_temp.prepare_improvement(62)$$, 'PT422', null,
  'a running or queued diagnosis does not authorize a proposal');
select ok((select (public.begin_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
  (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid,
  receipt->>'evidence_digest'))->>'encrypted_api_key' is not null from improvement_diagnosis),
  'the existing bounded diagnosis path begins the exact lease');
select ok((select public.finish_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
  (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid, 'completed',
  jsonb_build_object('version', 1, 'claims', jsonb_build_array(jsonb_build_object(
    'member_ids', jsonb_build_array(receipt#>>'{evidence,0,member_id}'),
    'inferred_cause', 'The present prompt may be ambiguous.', 'uncertainty', 'The log does not isolate the cause.'))),
  '{"provider_model":"openai/gpt-4.1-mini","provider_request_id":"fixture","worker_runtime":"node"}', null)
  from improvement_diagnosis), 'a completed diagnosis has one exact cited producing run');
select throws_ok($$select pg_temp.prepare_improvement(62, 3)$$, '42501', null,
  'a reader cannot authorize proposal compilation');
select throws_ok($$select pg_temp.prepare_improvement(62, 4)$$, '42501', null,
  'an unrelated user cannot authorize proposal compilation');
select is(pg_temp.prepare_improvement(62)->'grant', jsonb_build_object(
  'stageIds', jsonb_build_array(pg_temp.diagnosis_fixture_id(32)),
  'agentIds', jsonb_build_array(receipt#>>'{evidence,0,producing_agent_id}'),
  'skillRevisionIds', '[]'::jsonb, 'scorerRevisionIds', '[]'::jsonb, 'routingRuleIds', '[]'::jsonb),
  'the grant contains exactly the cited stage and agent, with empty uncited skill, scorer, and routing arrays')
from improvement_diagnosis;
select throws_ok($$
  select pg_temp.prepare_improvement(62, p_edits => jsonb_build_array(jsonb_build_object(
    'kind', 'stage_prompt', 'stageId', stage->'id', 'promptTemplateMd', 'Publish everything.',
    'expectedPromptSha256', encode(sha256(convert_to(stage->>'promptTemplateMd', 'UTF8')), 'hex'))))
  from public.factory_definition_revisions base
  cross join lateral jsonb_array_elements(base.definition_json::jsonb->'stages') stage
  where base.id = pg_temp.diagnosis_fixture_id(51) and stage->>'id' = pg_temp.diagnosis_fixture_id(33)::text
$$, 'PT422', null, 'the real pinned uncited stage is rejected despite its exact prior prompt hash');
select throws_ok($$select pg_temp.prepare_improvement(62, p_edits => pg_temp.improvement_prompt_edit()
  || pg_temp.improvement_prompt_edit('Second amendment.'))$$, 'PT422', null,
  'one edit per target is enforced before compilation');
select throws_ok($$select pg_temp.prepare_improvement(62, p_edits => jsonb_build_array(jsonb_build_object(
  'kind', 'stage_prompt', 'stageId', pg_temp.diagnosis_fixture_id(32), 'expectedPromptSha256', repeat('a', 64),
  'promptTemplateMd', 'A change.')))$$, 'PT422', null, 'the exact old stage prompt is required');

create temp table improvement_candidates as
select jsonb_set(revision.definition_json::jsonb, '{stages,0,promptTemplateMd}',
  to_jsonb('Describe the observed failures.'::text)) as expected
from public.factory_definition_revisions revision where revision.id = pg_temp.diagnosis_fixture_id(51);
select throws_ok($$select pg_temp.save_improvement(62,
  p_candidate => jsonb_set(expected, '{repositoryId}', to_jsonb(pg_temp.diagnosis_fixture_id(99)))::text)
  from improvement_candidates$$, 'PT422', null, 'an otherwise valid digest cannot change protected repository binding');
select throws_ok($$select pg_temp.save_improvement(62,
  p_candidate => jsonb_set(expected, '{stages,0,previousStageIds}', jsonb_build_array(pg_temp.diagnosis_fixture_id(99)))::text)
  from improvement_candidates$$, 'PT422', null, 'a compiled bundle cannot add an undeclared predecessor');

-- Two callers prepare the same request before either saves. The second save
-- must report replay based on the receipt that appeared since preparation.
select ok(pg_temp.prepare_improvement(62) ? 'grant', 'the first caller prepares without a saved request');
select ok(pg_temp.prepare_improvement(62) ? 'grant', 'the second caller also prepares before either save');
create temp table improvement_save_results(label text primary key, result jsonb);
create temp view improvement_receipts as select label, result->'proposal' as value from improvement_save_results;
grant select on improvement_receipts to authenticated;
insert into improvement_save_results select 'first', pg_temp.save_improvement(62, p_candidate => expected::text)
from improvement_candidates;
select is((select result->'replay' from improvement_save_results where label = 'first'), 'false'::jsonb,
  'the first save reports a newly written receipt');
select is(pg_temp.save_improvement(62, p_candidate => '{"ignored":true}'),
  (select jsonb_build_object('proposal', value, 'replay', true) from improvement_receipts where label = 'first'),
  'the save after a competing write reports replay and returns the stored receipt');
select ok((select count(*) = 1 and count(candidate_revision_id) = 1
  from internal.factory_improvement_proposal_revisions where workspace_id = pg_temp.diagnosis_fixture_id(11))
  and (select count(*) = 2 from public.factory_definition_revisions where workspace_id = pg_temp.diagnosis_fixture_id(11)),
  'the competing saves create one proposal revision and one inactive candidate');
select ok((select value @> jsonb_build_object('status', 'compiled', 'revisionNumber', 1, 'baseCurrent', true,
    'authorMemberId', pg_temp.diagnosis_fixture_id(22), 'requestId', pg_temp.diagnosis_fixture_id(62))
  and value#>>'{candidate,digest}' = encode(sha256(convert_to(value#>>'{candidate,definitionJson}', 'UTF8')), 'hex')
  from improvement_receipts where label = 'first'), 'a manager saves an attributable exact candidate and canonical bytes');
select ok((select not exists (select 1 from public.factory_definition_activations activation
  where activation.revision_id = (value#>>'{candidate,revisionId}')::uuid)
  and exists (select 1 from public.factory_definition_revisions candidate
  where candidate.id = (value#>>'{candidate,revisionId}')::uuid and candidate.source_draft_id is null
    and (candidate.workspace_id, candidate.factory_id) = (scope.workspace_id, scope.factory_id))
  from improvement_receipts cross join diagnosis_scope scope where label = 'first'),
  'compiled proposal is an exact inactive definition, independent of Settings drafts and activations');
select is(pg_temp.prepare_improvement(62)->'replay', (select value from improvement_receipts where label = 'first'),
  'an exact retry returns the first receipt through prepare');
select throws_ok($$select pg_temp.prepare_improvement(62, p_rationale => 'Different request.')$$, 'PT409', null,
  'the same key cannot replace its authored intent');
select throws_ok($$select pg_temp.prepare_improvement(62, 1)$$, 'PT409', null,
  'a different authorized manager cannot replay another author request');

insert into improvement_save_results
select 'invalid', pg_temp.save_improvement(63, p_edits => pg_temp.improvement_prompt_edit('{{artifact.previousStages.build}}'),
  p_proposal_id => (value->>'proposalId')::uuid, p_predecessor => (value->>'revisionId')::uuid,
  p_diagnostics => '[{"path":["stages",0,"promptTemplateMd"],"code":"unreachable_stage","message":"Build must precede this stage."}]')
from improvement_receipts where label = 'first';
select ok((select value @> '{"status":"invalid","revisionNumber":2,"candidate":null,"diff":null}'
  and value->'diagnostics' <> '[]' from improvement_receipts where label = 'invalid'),
  'a failed compile retains diagnostics and an immutable next revision without materializing a candidate');
select throws_ok($$select pg_temp.prepare_improvement(64, p_proposal_id => (value->>'proposalId')::uuid,
  p_predecessor => (value->>'revisionId')::uuid) from improvement_receipts where label = 'first'$$,
  'PT409', null, 'a stale proposal predecessor cannot append over the current revision');
select throws_ok($$update internal.factory_improvement_proposal_revisions set diff = '{}'$$, '23514', null,
  'proposal revision history cannot be rewritten');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '63600000-0000-4000-8000-000000000003';
select is((select public.get_factory_improvement_proposal_revision(scope.workspace_id, scope.factory_id,
  (value->>'proposalId')::uuid, (value->>'revisionId')::uuid) from diagnosis_scope scope
  cross join improvement_receipts where label = 'first'),
  (select value from improvement_receipts where label = 'first'), 'a scoped reader can open the exact earlier revision');
select is((select public.get_factory_improvement_proposal_revision(scope.workspace_id, scope.factory_id,
  (value->>'proposalId')::uuid) from diagnosis_scope scope
  cross join improvement_receipts where label = 'first'),
  (select value from improvement_receipts where label = 'invalid'), 'the scoped convenience read returns the latest revision');
set local request.jwt.claim.sub = '63600000-0000-4000-8000-000000000004';
select throws_ok($$select public.get_factory_improvement_proposal_revision(scope.workspace_id, scope.factory_id,
  (value->>'proposalId')::uuid) from diagnosis_scope scope cross join improvement_receipts where label = 'first'$$,
  'P0002', null, 'an unrelated user cannot read a proposal by guessed identities');
reset role;
set local request.jwt.claim.role = 'service_role';
select ok(not has_table_privilege('authenticated', 'internal.factory_improvement_proposal_revisions', 'SELECT,INSERT,UPDATE')
  and not has_table_privilege('service_role', 'internal.factory_improvement_proposal_revisions', 'SELECT,INSERT,UPDATE')
  and not has_function_privilege('authenticated',
    'public.prepare_factory_improvement_proposal(uuid,uuid,uuid,uuid,bigint,uuid,text,uuid,text,text,text,jsonb,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_factory_improvement_proposal_revision(uuid,uuid,uuid,uuid)', 'EXECUTE'),
  'history tables stay private and only the authorized roles may use each RPC');

-- Isolate the save boundary from building another qualified routing experiment.
-- The replacement only rejects qualification and is restored in this transaction.
do $$
declare
  original text := pg_get_functiondef('internal.assert_factory_improvement_routing_targets(uuid,uuid,jsonb,jsonb)'::regprocedure);
  command_slot integer;
begin
  execute $stub$
    create or replace function internal.assert_factory_improvement_routing_targets(
      p_workspace_id uuid, p_factory_id uuid, p_candidate jsonb, p_edits jsonb
    ) returns void language plpgsql set search_path = '' as $reject$
    begin
      raise exception 'Fixture provider detail must not be returned.'
        using errcode = current_setting('wallie.improvement_routing_fixture_error');
    end;
    $reject$
  $stub$;
  foreach command_slot in array array[68, 69] loop
    perform set_config('wallie.improvement_routing_fixture_error',
      case when command_slot = 68 then 'PT422' else 'PT409' end, true);
    insert into improvement_save_results
      select 'routing-rejected-' || command_slot, pg_temp.save_improvement(command_slot, p_candidate => expected::text)
      from improvement_candidates;
  end loop;
  execute original;
end;
$$;
select ok((select count(*) = 2 and bool_and(value @> '{"status":"invalid","candidate":null,"diff":null}'
  and value#>'{diagnostics,0,path}' = '["modelRouting"]'
  and value::text not like '%Fixture provider detail%')
  from improvement_receipts where label like 'routing-rejected-%'),
  'current and stale routing requalification failures retain safe invalid diagnostics without a candidate or diff');
select is(pg_temp.save_improvement(68, p_candidate => expected::text),
  (select jsonb_build_object('proposal', value, 'replay', true) from improvement_receipts where label = 'routing-rejected-68'),
  'retrying rejected routing qualification returns the same recorded diagnostic')
from improvement_candidates;
select is((select count(*)::int from public.factory_definition_revisions
  where workspace_id = pg_temp.diagnosis_fixture_id(11)), 2,
  'a routing requalification failure materializes no extra definition');

select public.archive_factory(workspace_id, factory_id, owner_id) from diagnosis_scope;
select is(pg_temp.prepare_improvement(62)->'replay'->>'revisionNumber', '1',
  'a previously authorized exact request can replay after archival');
select throws_ok($$select pg_temp.prepare_improvement(64)$$, 'P0011', null,
  'archival blocks new proposal work');
select public.restore_factory(workspace_id, factory_id, owner_id) from diagnosis_scope;
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, pg_temp.diagnosis_fixture_id(51), 2, owner_id from diagnosis_scope;
select is(pg_temp.prepare_improvement(62)->'replay'->>'baseCurrent', 'false',
  'exact receipt replay reports a later activation even when configuration digest did not change');
select throws_ok($$select pg_temp.prepare_improvement(64)$$, 'PT409', null,
  'a new proposal requires the current activation number as well as revision and digest');

insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
select pg_temp.diagnosis_fixture_id(66), revision.workspace_id, revision.factory_id, revision.schema_version,
  rebased.definition, encode(sha256(convert_to(rebased.definition, 'UTF8')), 'hex'), revision.created_by
from public.factory_definition_revisions revision cross join lateral (
  select jsonb_set(revision.definition_json::jsonb, '{stages,0,promptTemplateMd}', to_jsonb('Newly active prompt.'::text))::text
) rebased(definition)
where revision.id = pg_temp.diagnosis_fixture_id(51);
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, pg_temp.diagnosis_fixture_id(66), 3, owner_id from diagnosis_scope;
select throws_ok($$
  select pg_temp.save_improvement(65, p_proposal_id => (value->>'proposalId')::uuid,
    p_predecessor => (value->>'revisionId')::uuid, p_candidate => expected::text,
    p_activation_number => 3, p_base_revision_id => revision.id, p_base_digest => revision.canonical_digest)
  from improvement_receipts cross join improvement_candidates
  cross join public.factory_definition_revisions revision
  where label = 'invalid' and revision.id = pg_temp.diagnosis_fixture_id(66)
$$, 'PT422', null, 'a rebase must author the exact expected old binding from its new base');
insert into improvement_save_results
select 'rebased', pg_temp.save_improvement(65,
  p_edits => jsonb_set(pg_temp.improvement_prompt_edit(), '{0,expectedPromptSha256}',
    to_jsonb(encode(sha256(convert_to('Newly active prompt.', 'UTF8')), 'hex'))),
  p_proposal_id => (value->>'proposalId')::uuid, p_predecessor => (value->>'revisionId')::uuid,
  p_candidate => expected::text, p_activation_number => 3,
  p_base_revision_id => revision.id, p_base_digest => revision.canonical_digest)
from improvement_receipts cross join improvement_candidates cross join public.factory_definition_revisions revision
where label = 'invalid' and revision.id = pg_temp.diagnosis_fixture_id(66);
select ok((select current.value @> jsonb_build_object('status', 'compiled', 'revisionNumber', 3, 'baseCurrent', true,
    'proposalId', previous.value->>'proposalId', 'previousRevisionId', previous.value->>'revisionId',
    'base', jsonb_build_object('activationNumber', 3, 'revisionId', pg_temp.diagnosis_fixture_id(66)))
  and current.value#>>'{base,digest}' <> previous.value#>>'{base,digest}'
  from improvement_receipts current cross join improvement_receipts previous
  where current.label = 'rebased' and previous.label = 'invalid'),
  'a current-base rebase appends an exact revision of the existing proposal and preserves earlier provenance');
select is(pg_temp.prepare_improvement(62)#>>'{replay,base,activationNumber}', '1',
  'an older revision retains its original base tuple after rebasing');

insert into public.session_validation_asset_withholdings(asset_id, state)
select asset_id, 'redacted' from diagnosis_source;
select throws_ok($$
  select pg_temp.save_improvement(67,
    p_edits => jsonb_set(pg_temp.improvement_prompt_edit(), '{0,expectedPromptSha256}',
      to_jsonb(encode(sha256(convert_to('Newly active prompt.', 'UTF8')), 'hex'))),
    p_proposal_id => (value->>'proposalId')::uuid, p_predecessor => (value->>'revisionId')::uuid,
    p_candidate => expected::text, p_activation_number => 3,
    p_base_revision_id => revision.id, p_base_digest => revision.canonical_digest)
  from improvement_receipts cross join improvement_candidates cross join public.factory_definition_revisions revision
  where label = 'rebased' and revision.id = pg_temp.diagnosis_fixture_id(66)
$$, 'PT422', null, 'withholding the exact cited source blocks a new proposal revision');
select is(pg_temp.prepare_improvement(62)#>>'{replay,revisionNumber}', '1',
  'an exact retry still retrieves the authored receipt without accessing withheld source content');
select public.revoke_factory_membership(workspace_id, factory_id, owner_id, pg_temp.diagnosis_fixture_id(22)) from diagnosis_scope;
select throws_ok($$select pg_temp.prepare_improvement(62)$$, '42501', null,
  'revoked managers cannot replay their earlier proposal requests');

select lives_ok($$delete from public.workspaces where id = pg_temp.diagnosis_fixture_id(11)$$,
  'workspace teardown cascades through compiled and rebased proposals');
set constraints all immediate;
select ok(not exists (
    select 1 from internal.factory_improvement_proposals where workspace_id = pg_temp.diagnosis_fixture_id(11)
  ) and not exists (
    select 1 from internal.factory_improvement_proposal_revisions where workspace_id = pg_temp.diagnosis_fixture_id(11)
  ) and not exists (
    select 1 from public.factory_definition_revisions where workspace_id = pg_temp.diagnosis_fixture_id(11)
  ), 'teardown removes proposal and candidate history with all foreign keys checked');
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'session-validation-evidence'
  and name = pg_temp.diagnosis_fixture_id(11)::text || '/' ||
    (select run_id::text || '/' || asset_id::text from diagnosis_source);
delete from auth.users where id in (
  pg_temp.diagnosis_fixture_id(1), pg_temp.diagnosis_fixture_id(2),
  pg_temp.diagnosis_fixture_id(3), pg_temp.diagnosis_fixture_id(4)
);

select * from finish();
rollback;
