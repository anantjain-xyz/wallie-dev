begin;
create extension if not exists pgtap with schema extensions;
select plan(29);
\set op651_fixture_namespace 66410000
\ir fixtures/factory_automation_dry_run.psql

create temp table setup_history_rule as
select scope.*, (draft.value->>'automationId')::uuid as automation_id,
  (draft.value->>'draftRevisionId')::uuid as revision_id
from op651_scope scope
cross join lateral (select pg_temp.create_dry_run_automation(101, pg_temp.dry_run_definition('issue-state')) as value) draft;
select public.publish_factory_automation(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id)
from setup_history_rule;

create temp table setup_history_sibling as
select factory.workspace_id, factory.id as factory_id
from public.create_factory(pg_temp.op651_id(11), pg_temp.op651_id(1), 'Sibling factory', 'setup-history-sibling') factory;
insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.op651_id(131), workspace_id, factory_id, 'Sibling pipeline' from setup_history_sibling;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name)
values (pg_temp.op651_id(132), pg_temp.op651_id(131), pg_temp.op651_id(11), 1, 'sibling-stage', 'Sibling stage');

insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  execution_purpose, factory_definition_provenance, factory_definition_revision_id)
select pg_temp.op651_id(fixture.slot), scope.workspace_id, scope.factory_id, fixture.number, fixture.title,
  pg_temp.op651_id(31), pg_temp.op651_id(32), fixture.purpose, 'pinned', pg_temp.op651_id(43)
from op651_scope scope cross join (values
  (225, 901, 'Production session', 'production'),
  (224, -902, 'Benchmark session', 'benchmark')
) fixture(slot, number, title, purpose);
insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id)
select pg_temp.op651_id(223), workspace_id, factory_id, 903, 'Sibling session', pg_temp.op651_id(131), pg_temp.op651_id(132)
from setup_history_sibling;

insert into internal.factory_automation_occurrences(
  id, workspace_id, factory_id, automation_id, revision_id, source_namespace, source_key, event,
  status, reason, attempt_count, next_attempt_at, session_id, mutation_receipt_id, recorded_at, settled_at
)
select pg_temp.op651_id(400 + slot), rule.workspace_id, rule.factory_id, rule.automation_id, rule.revision_id,
  'fixture.private', 'private-source-' || slot,
  '{"kind":"issue-state","stateId":"in-progress","teamId":"private-team","projectId":null}',
  case when slot between 23 and 25 then 'admitted' when slot = 21 then 'denied' else 'pending' end,
  case slot when 21 then 'invalid_assignment' when 20 then 'paused' end,
  case when slot between 20 and 25 then 1 else 0 end,
  case when slot not in (21, 23, 24, 25) then '2026-11-24T00:00:00Z'::timestamptz end,
  case when slot between 23 and 25 then pg_temp.op651_id(200 + slot) end,
  case when slot between 23 and 25 then pg_temp.op651_id(300 + slot) end,
  case when slot = 26 then '2026-11-23T12:34:56.123455Z'::timestamptz else '2026-11-23T12:34:56.123456Z'::timestamptz end,
  case when slot in (21, 23, 24, 25) then '2026-11-23T12:35:00Z'::timestamptz end
from setup_history_rule rule cross join generate_series(1, 26) slot;

create temp table expected_setup as
select jsonb_build_object('assignment', jsonb_build_object(
  'definitionDigest', revision.canonical_digest, 'definitionRevisionId', revision.id,
  'agentId', agent.id, 'agentName', agent.name,
  'executionGrant', jsonb_build_object('id', grant_row.id, 'version', grant_row.version),
  'servicePrincipalId', grant_row.service_principal_id, 'budgetPayerMemberId', grant_row.budget_payer_member_id,
  'credentialBindingId', scoped.binding_id
)) as value
from op651_grant grant_row
join scoped_revisions scoped on scoped.grant_id = grant_row.id
join public.factory_definition_revisions revision on revision.id = scoped.revision_id
join public.factory_agents agent on agent.id = (revision.definition_json::jsonb#>>'{implementationAgent,agentId}')::uuid;

create function pg_temp.setup_assignment() returns jsonb language sql as $$
  select public.read_factory_automation_setup(workspace_id, factory_id) from setup_history_rule
$$;
create function pg_temp.occurrence_history(p_at timestamptz default null, p_id uuid default null)
returns jsonb language sql as $$
  select public.list_factory_automation_occurrence_history(workspace_id, factory_id, automation_id, p_at, p_id)
  from setup_history_rule
$$;

select ok(bool_and(has_function_privilege('authenticated', signature, 'execute')
  and not has_function_privilege('anon', signature, 'execute')
  and not has_function_privilege('service_role', signature, 'execute')),
  'both setup and history reads require the authenticated role')
from (values ('public.read_factory_automation_setup(uuid,uuid)'),
  ('public.list_factory_automation_occurrence_history(uuid,uuid,uuid,timestamptz,uuid)')) rpc(signature);

grant select on setup_history_rule, setup_history_sibling, expected_setup to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '';
select is(pg_temp.setup_assignment(), null::jsonb, 'setup requires a signed-in user');
select is(pg_temp.occurrence_history(), null::jsonb, 'history requires a signed-in user');

select set_config('request.jwt.claim.sub', pg_temp.op651_id(2)::text, true);
select is(pg_temp.setup_assignment(), null::jsonb, 'a workspace member cannot read setup');
select is(pg_temp.occurrence_history(), null::jsonb, 'a workspace member cannot read history');

reset role;
select set_config('request.jwt.claim.sub', pg_temp.op651_id(1)::text, true);
select public.grant_factory_membership(workspace_id, factory_id, pg_temp.op651_id(1), pg_temp.op651_id(22), 'manager')
from setup_history_rule;
set local role authenticated;
select set_config('request.jwt.claim.sub', pg_temp.op651_id(2)::text, true);
select is(pg_temp.setup_assignment(), value, 'the scoped manager sees only the exact current executable assignment')
from expected_setup;
select is(jsonb_array_length(pg_temp.occurrence_history()->'occurrences'), 20, 'the scoped manager can read the first history page');
select is(public.read_factory_automation_setup(workspace_id, factory_id), null::jsonb,
  'the scoped manager cannot read setup from a sibling factory') from setup_history_sibling;

select set_config('request.jwt.claim.sub', pg_temp.op651_id(1)::text, true);
select is(pg_temp.setup_assignment(), value, 'the workspace owner sees the same exact assignment') from expected_setup;
select is(public.read_factory_automation_setup(workspace_id, factory_id), '{"assignment":null}'::jsonb,
  'an active factory without an executable definition has no assignment') from setup_history_sibling;
select is(public.list_factory_automation_occurrence_history(sibling.workspace_id, sibling.factory_id, rule.automation_id), null::jsonb,
  'an owner cannot select a rule through a different factory') from setup_history_sibling sibling cross join setup_history_rule rule;
select is(public.list_factory_automation_occurrence_history(workspace_id, factory_id, pg_temp.op651_id(999)), null::jsonb,
  'an absent rule does not have a page') from setup_history_rule;

create temp table setup_first_page as select pg_temp.occurrence_history() as value;
select is((select array_agg((entry->>'id')::uuid order by position)
    from jsonb_array_elements(value->'occurrences') with ordinality item(entry, position)),
  array(select pg_temp.op651_id(slot) from generate_series(425, 406, -1) slot),
  'the first 20 receipts use descending timestamp and then descending UUID') from setup_first_page;
select is(value->'nextCursor', jsonb_build_object('id', pg_temp.op651_id(406),
  'recordedAt', '2026-11-23T12:34:56.123456Z'::timestamptz),
  'the cursor is the last returned position with exact timestamp precision') from setup_first_page;
select is(value#>'{occurrences,0}', jsonb_build_object(
  'id', pg_temp.op651_id(425), 'revisionId', (select revision_id from setup_history_rule),
  'revisionNumber', 1, 'triggerKind', 'issue-state', 'status', 'admitted',
  'reason', null, 'attemptCount', 1, 'recordedAt', '2026-11-23T12:34:56.123456Z'::timestamptz,
  'settledAt', '2026-11-23T12:35:00Z'::timestamptz, 'nextAttemptAt', null, 'sessionNumber', 901
), 'an admitted receipt includes the visible session number and only approved history fields') from setup_first_page;
select is(value#>'{occurrences,1,sessionNumber}', 'null'::jsonb, 'benchmark session numbers stay private') from setup_first_page;
select is(value#>'{occurrences,2,sessionNumber}', 'null'::jsonb, 'sibling factory session numbers stay private') from setup_first_page;
select is(value#>>'{occurrences,4,reason}', 'invalid_assignment', 'a denied receipt keeps its normalized reason') from setup_first_page;
select is(value#>'{occurrences,5,nextAttemptAt}', to_jsonb('2026-11-24T00:00:00Z'::timestamptz),
  'a pending receipt exposes its next attempt independently of settlement') from setup_first_page;

create temp table setup_second_page as
select pg_temp.occurrence_history((value#>>'{nextCursor,recordedAt}')::timestamptz, (value#>>'{nextCursor,id}')::uuid) as value
from setup_first_page;
select is((select array_agg((entry->>'id')::uuid order by position)
    from jsonb_array_elements(value->'occurrences') with ordinality item(entry, position)),
  array(select pg_temp.op651_id(slot) from unnest(array[405, 404, 403, 402, 401, 426]) slot),
  'paging neither repeats nor skips tied receipts, and ends on the older receipt') from setup_second_page;
select is(value->'nextCursor', 'null'::jsonb, 'the last page has no next cursor') from setup_second_page;
select is(pg_temp.occurrence_history('2026-11-23T12:34:56.123455Z', pg_temp.op651_id(426)),
  '{"occurrences":[],"nextCursor":null}'::jsonb, 'a cursor after all receipts returns an empty page');
select throws_ok($$select pg_temp.occurrence_history(now())$$, '22023', 'Provide both occurrence history cursor fields.',
  'a timestamp alone is rejected');
select throws_ok($$select pg_temp.occurrence_history(p_id => pg_temp.op651_id(1))$$, '22023',
  'Provide both occurrence history cursor fields.', 'a UUID alone is rejected');
select throws_ok($$select pg_temp.occurrence_history('infinity', pg_temp.op651_id(1))$$, '22023',
  'Provide both occurrence history cursor fields.', 'a nonfinite timestamp is rejected');

reset role;
set local request.jwt.claim.role = 'service_role';
select public.archive_factory_automation(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id,
  jsonb_build_object('revisionId', revision_id)) from setup_history_rule;
select public.revoke_factory_execution_grant(workspace_id, factory_id, pg_temp.op651_id(1), id, version, 'Fixture revoked grant')
from op651_grant;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is(pg_temp.occurrence_history(), value, 'an archived rule keeps the exact recorded history') from setup_first_page;
select is(pg_temp.setup_assignment(), '{"assignment":null}'::jsonb, 'a revoked grant removes the executable setup assignment');

reset role;
set local request.jwt.claim.role = 'service_role';
select public.archive_factory(workspace_id, factory_id, pg_temp.op651_id(1), 'Fixture archived factory') from setup_history_rule;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is(pg_temp.setup_assignment(), null::jsonb, 'setup requires an active factory');
select is(pg_temp.occurrence_history(), null::jsonb, 'history requires an active factory');

select * from finish();
rollback;
