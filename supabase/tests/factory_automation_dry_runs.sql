begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65910000
\ir fixtures/factory_automation_dry_run.psql
\ir fixtures/factory_workflow_authored_setup.psql

insert into auth.users(id, email) values (pg_temp.op651_id(3), 'dry-run-foreign-owner@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.op651_id(12), 'dry-run-foreign-workspace', 'Other preview workspace');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.op651_id(23), pg_temp.op651_id(12), pg_temp.op651_id(3), 'human', 'owner');
create temp table dry_run_sibling as
select factory.id from public.create_factory(pg_temp.op651_id(11), pg_temp.op651_id(1),
  'Sibling factory', 'dry-run-sibling') factory;

create temp table dry_run_rules(label text primary key, automation_id uuid not null, revision_id uuid not null);
insert into dry_run_rules
select rule.kind, (draft.value->>'automationId')::uuid, (draft.value->>'draftRevisionId')::uuid
from (values (100, 'schedule'), (101, 'pull-request'), (102, 'issue-state')) rule(slot, kind)
cross join lateral (select pg_temp.create_dry_run_automation(rule.slot, pg_temp.dry_run_definition(rule.kind)) as value) draft;

select public.publish_factory_automation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  rule.automation_id, rule.revision_id)
from dry_run_rules rule cross join op651_scope scope where rule.label = 'pull-request';
insert into dry_run_rules
select 'pull-request-new-draft', rule.automation_id, (draft.value->>'draftRevisionId')::uuid
from dry_run_rules rule cross join op651_scope scope
cross join lateral (select public.save_factory_automation_draft(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  rule.automation_id, rule.revision_id, jsonb_set(pg_temp.dry_run_definition('pull-request'),
    '{filters,baseBranches}', '["release"]')) as value) draft
where rule.label = 'pull-request';

insert into dry_run_rules
select 'workflow', (draft.value->>'automationId')::uuid, (draft.value->>'draftRevisionId')::uuid
from authored_scope scope cross join authored_version_a activation
cross join lateral (select pg_temp.create_dry_run_automation(104, jsonb_set(pg_temp.dry_run_definition('schedule'), '{target}',
  (pg_temp.dry_run_definition('schedule')->'target') || jsonb_build_object('kind', 'workflow',
    'workflowId', scope.workflow_id, 'workflowActivationId', activation.activation_id))) as value) draft;

create function pg_temp.preview_automation(p_label text, p_event jsonb) returns jsonb language sql as $$
  select public.dry_run_factory_automation(scope.workspace_id, scope.factory_id, rule.automation_id, rule.revision_id, p_event)
  from op651_scope scope cross join dry_run_rules rule where rule.label = p_label
$$;
create function pg_temp.preview_event(p_kind text) returns jsonb language sql as $$
  select case p_kind
    when 'schedule' then '{"kind":"schedule","scheduledFor":"2026-11-23T09:00:00-08:00"}'::jsonb
    when 'pull-request' then jsonb_build_object('kind', 'pull-request', 'repositoryId', pg_temp.op651_id(34),
      'action', 'merged', 'baseBranch', 'main')
    when 'issue-state' then '{"kind":"issue-state","stateId":"in-progress","teamId":"platform","projectId":null}'::jsonb
  end
$$;
create function pg_temp.dry_run_effect_counts() returns jsonb language sql as $$
  select jsonb_build_object(
    'sessions', (select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)),
    'jobs', (select count(*) from public.agent_jobs where workspace_id = pg_temp.op651_id(11)),
    'outboundEvents', (select count(*) from internal.factory_outbound_events where workspace_id = pg_temp.op651_id(11)),
    'outboundDeliveries', (select count(*) from internal.factory_outbound_deliveries where workspace_id = pg_temp.op651_id(11)),
    'outboundAttempts', (select count(*) from internal.factory_outbound_delivery_attempts attempt
      join internal.factory_outbound_deliveries delivery on delivery.id = attempt.delivery_id
      where delivery.workspace_id = pg_temp.op651_id(11)),
    'commandAdmissions', (select count(*) from internal.factory_command_admissions where workspace_id = pg_temp.op651_id(11))
  )
$$;
create temp table dry_run_effects_before as select pg_temp.dry_run_effect_counts() as value;

select ok(has_function_privilege('authenticated', 'public.dry_run_factory_automation(uuid,uuid,uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.dry_run_factory_automation(uuid,uuid,uuid,uuid,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.dry_run_factory_automation(uuid,uuid,uuid,uuid,jsonb)', 'execute'),
  'the browser preview RPC is scoped to authenticated users');

grant select on op651_scope, dry_run_rules, dry_run_sibling, op651_grant to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';

select is(pg_temp.preview_automation('schedule', pg_temp.preview_event('schedule'))->>'matched', 'true',
  'a normalized scheduled occurrence matches a schedule trigger');
select is(pg_temp.preview_automation('schedule', pg_temp.preview_event('issue-state'))->>'matched', 'false',
  'an issue-state event cannot match a schedule trigger');
select is(pg_temp.preview_automation('schedule', pg_temp.preview_event('issue-state'))->'checks',
  '[{"field":"kind","actual":"issue-state","expected":["schedule"],"passed":false}]'::jsonb,
  'a kind mismatch reports the trigger without applying unrelated filters');
select is(pg_temp.preview_automation('pull-request', pg_temp.preview_event('pull-request')),
  pg_temp.preview_automation('pull-request', pg_temp.preview_event('pull-request')),
  'the same normalized event and stored revision produce the same complete preview');
select is(pg_temp.preview_automation('pull-request', pg_temp.preview_event('pull-request'))->>'matched', 'true',
  'the exact repository, action and base branch match a pull request trigger');
select is(pg_temp.preview_automation('pull-request', pg_temp.preview_event('pull-request'))->>'revisionId', rule.revision_id::text,
  'a preview retains the selected published revision while an edited draft exists')
from dry_run_rules rule where rule.label = 'pull-request';
select is(pg_temp.preview_automation('pull-request-new-draft', pg_temp.preview_event('pull-request'))->>'matched', 'false',
  'selecting the edited draft uses its new base-branch filter');
select is(pg_temp.preview_automation('pull-request-new-draft', pg_temp.preview_event('pull-request'))#>'{checks,3}',
  '{"field":"baseBranch","actual":"main","expected":["release"],"passed":false}'::jsonb,
  'the preview exposes the exact actual and expected failed filter');
select is(pg_temp.preview_automation('pull-request', jsonb_set(pg_temp.preview_event('pull-request'),
  '{repositoryId}', to_jsonb(pg_temp.op651_id(61))))#>>'{checks,1,passed}', 'false',
  'another real repository fails the source identity check');
select is(pg_temp.preview_automation('pull-request', jsonb_set(pg_temp.preview_event('pull-request'),
  '{action}', '"opened"'))#>>'{checks,2,passed}', 'false', 'an unmatched pull request action fails only its action check');
select is(pg_temp.preview_automation('issue-state', pg_temp.preview_event('issue-state'))->>'matched', 'true',
  'state and team match while an empty project filter accepts a null project');
select is(pg_temp.preview_automation('issue-state', jsonb_set(pg_temp.preview_event('issue-state'),
  '{stateId}', '"done"'))#>>'{checks,1,passed}', 'false', 'another issue state fails its check');
select is(pg_temp.preview_automation('issue-state', jsonb_set(pg_temp.preview_event('issue-state'),
  '{teamId}', 'null'))#>>'{checks,2,passed}', 'false', 'a configured team filter does not accept an unassigned team');
select is(pg_temp.preview_automation('workflow', pg_temp.preview_event('schedule'))#>>'{assignment,workflowName}',
  'Authored fixture workflow', 'a workflow target resolves the published authored workflow label');
select is(pg_temp.preview_automation('schedule', pg_temp.preview_event('schedule'))#>>'{assignment,executionPolicyRevisionId}',
  execution_policy_revision_id::text, 'an eligible assignment reports the pinned execution budget policy') from op651_grant;
select is(pg_temp.preview_automation('schedule', pg_temp.preview_event('schedule'))->>'budgetPayerMemberId',
  pg_temp.op651_id(21)::text, 'the preview reports the exact budget payer identity');

select throws_ok(format($$select pg_temp.preview_automation('schedule', %L::jsonb)$$, malformed.event),
  '22023', null, malformed.description)
from (values
  ('[]', 'an event must be an object'),
  ('{"kind":"schedule","scheduledFor":"2026-11-23T09:00:00"}', 'a schedule occurrence requires an explicit offset'),
  ('{"kind":"schedule","scheduledFor":"2026-11-23T09:00Z"}', 'a schedule occurrence requires seconds'),
  ('{"kind":"schedule","scheduledFor":"2026-11-23T09:00:00.1234Z"}', 'a schedule occurrence accepts at most millisecond precision'),
  ('{"kind":"schedule","scheduledFor":"2026-02-30T09:00:00Z"}', 'a schedule occurrence must use a real calendar date'),
  ('{"kind":"pull-request","repositoryId":"garbage","action":"merged","baseBranch":"main"}', 'a pull-request event needs a normalized repository identity'),
  ('{"kind":"pull-request","repositoryId":"65910000-0000-4000-8000-000000000034","action":"unknown","baseBranch":"main"}', 'a pull-request event may only name a recognized action'),
  ('{"kind":"issue-state","stateId":"in-progress","teamId":"platform"}', 'an issue-state event must identify a project or explicitly supply null'),
  ('{"kind":"issue-state","stateId":"in-progress","teamId":"platform","projectId":null,"rawPayload":{}}', 'a normalized event rejects additional provider data')
) malformed(event, description);

select is(public.dry_run_factory_automation(scope.workspace_id, scope.factory_id, correct.automation_id,
  other.revision_id, pg_temp.preview_event('schedule')), null::jsonb, 'a revision of a different rule cannot be previewed')
from op651_scope scope cross join dry_run_rules correct cross join dry_run_rules other
where correct.label = 'schedule' and other.label = 'issue-state';
select is(public.dry_run_factory_automation(scope.workspace_id, sibling.id, rule.automation_id,
  rule.revision_id, pg_temp.preview_event('schedule')), null::jsonb, 'an owner cannot preview a rule through a sibling factory')
from op651_scope scope cross join dry_run_sibling sibling cross join dry_run_rules rule where rule.label = 'schedule';
select set_config('request.jwt.claim.sub', pg_temp.op651_id(2)::text, true);
select is(pg_temp.preview_automation('schedule', pg_temp.preview_event('schedule')), null::jsonb,
  'a workspace member without manager access cannot preview another member’s automation');
select set_config('request.jwt.claim.sub', pg_temp.op651_id(3)::text, true);
select is(pg_temp.preview_automation('schedule', pg_temp.preview_event('schedule')), null::jsonb,
  'a manager in another workspace cannot preview the rule');

reset role;
set local request.jwt.claim.role = 'service_role';
select set_config('request.jwt.claim.sub', pg_temp.op651_id(1)::text, true);
select public.revoke_factory_secret_binding(revision.workspace_id, revision.factory_id, pg_temp.op651_id(1),
  revision.binding_id, 1) from scoped_revisions revision where revision.scenario = 'root';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
with preview as (select pg_temp.preview_automation('schedule', pg_temp.preview_event('schedule')) as value)
select ok(value->>'matched' = 'true' and value#>>'{assignment,status}' = 'denied'
  and value#>>'{assignment,reason}' = 'invalid_assignment'
  and value#>>'{assignment,message}' like '%credential binding%',
  'a revoked credential is explained without changing the deterministic filter match') from preview;

reset role;
set local request.jwt.claim.role = 'service_role';
select public.revoke_factory_execution_grant(workspace_id, factory_id, pg_temp.op651_id(1), id, version,
  'Verify preview denial for revoked authority') from op651_grant;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
with preview as (select pg_temp.preview_automation('schedule', pg_temp.preview_event('schedule')) as value)
select ok(value#>>'{assignment,status}' = 'denied' and value#>>'{assignment,reason}' = 'invalid_assignment'
  and value#>>'{assignment,message}' like '%execution grant%' and value#>>'{assignment,message}' like '%budget payer%',
  'a revoked grant gives the manager actionable grant and budget guidance') from preview;

reset role;
select is(pg_temp.dry_run_effect_counts(), value,
  'all previews leave sessions, jobs, outbound events and deliveries, and command admissions unchanged')
from dry_run_effects_before;

select * from finish();
rollback;
