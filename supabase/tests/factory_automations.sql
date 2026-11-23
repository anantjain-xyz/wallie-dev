begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65810000
\set op651_parallel_only true
\set op651_seed_only true
\ir fixtures/factory_workflow_branch.psql
\ir fixtures/factory_workflow_authored_setup.psql

insert into auth.users(id, email) values
  (pg_temp.op651_id(2), 'automation-member@example.test'),
  (pg_temp.op651_id(3), 'automation-foreign-owner@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.op651_id(12), 'automation-foreign-workspace', 'Other automation workspace');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.op651_id(22), pg_temp.op651_id(11), pg_temp.op651_id(2), 'human', 'member'),
  (pg_temp.op651_id(23), pg_temp.op651_id(12), pg_temp.op651_id(3), 'human', 'owner');

create temp table automation_factories as
select 'origin'::text as fixture, workspace_id, factory_id from op651_scope
union all
select 'other-workspace', workspace_id, id from public.factories
  where workspace_id = pg_temp.op651_id(12) and is_default;
insert into automation_factories
select 'sibling', factory.workspace_id, factory.id
from public.create_factory(pg_temp.op651_id(11), pg_temp.op651_id(1), 'Sibling factory', 'automation-sibling') factory;

create temp table automation_sibling_principal as
select principal.* from automation_factories scope
cross join lateral public.create_service_principal(
  scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), 'Sibling principal', 'automation-sibling-principal'
) principal where scope.fixture = 'sibling';
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select pg_temp.op651_id(56), workspace_id, factory_id, pg_temp.op651_id(33), 65810056,
  'automation-sibling', 'fixture/automation-sibling', true, 'https://github.test/fixture/automation-sibling', 'main'
from automation_sibling_principal;
create temp table automation_sibling_grant as
select granted.* from automation_sibling_principal principal cross join op651_grant origin
cross join lateral public.approve_factory_execution_grant(
  principal.workspace_id, principal.factory_id, pg_temp.op651_id(1), principal.id, pg_temp.op651_id(56),
  '{}', '{}', origin.execution_policy_revision_id, pg_temp.op651_id(21),
  clock_timestamp() + interval '1 hour', 0, null, '{sessions:create}'::public.factory_command_scope[]
) granted;
insert into public.workspace_secrets(id, workspace_id, key, encrypted_value)
values (pg_temp.op651_id(57), pg_temp.op651_id(11), 'AUTOMATION_SIBLING_KEY', 'sibling-fixture-ciphertext');
create temp table automation_sibling_binding as
select binding.* from automation_sibling_grant granted
join public.factory_agents agent using (workspace_id, factory_id)
cross join lateral public.create_factory_secret_binding(
  granted.workspace_id, granted.factory_id, pg_temp.op651_id(1), granted.id, granted.version,
  agent.id, 'codex', pg_temp.op651_id(57)
) binding where agent.is_default;

create function pg_temp.automation_definition(p_kind text default 'agent') returns jsonb language sql as $$
  select jsonb_build_object(
    'name', 'Inspect weekday changes',
    'trigger', jsonb_build_object('kind', 'schedule', 'cron', '0 9 * * 1-5', 'timeZone', 'America/Los_Angeles'),
    'filters', '{}'::jsonb,
    'target', jsonb_build_object('kind', p_kind, 'definitionRevisionId', revision.revision_id,
      'agentId', revision.body::jsonb#>>'{implementationAgent,agentId}') || case when p_kind = 'workflow' then
      jsonb_build_object('workflowId', scope.workflow_id, 'workflowActivationId', activation.activation_id)
      else '{}'::jsonb end,
    'executionGrant', jsonb_build_object('id', granted.id, 'version', granted.version),
    'servicePrincipalId', granted.service_principal_id,
    'budgetPayerMemberId', granted.budget_payer_member_id,
    'credentialBindingId', revision.binding_id
  )
  from scoped_revisions revision cross join op651_grant granted
  cross join authored_scope scope cross join authored_version_a activation
  where revision.scenario = 'root'
$$;

create function pg_temp.create_automation(p_slot integer, p_definition jsonb,
  p_fixture text default 'origin', p_actor_user_id uuid default pg_temp.op651_id(1))
returns jsonb language sql as $$
  select public.create_factory_automation(scope.workspace_id, scope.factory_id, p_actor_user_id,
    pg_temp.op651_id(p_slot), p_definition)
  from automation_factories scope where scope.fixture = p_fixture
$$;
create function pg_temp.publish_automation(p_slot integer, p_expected_revision_id uuid,
  p_fixture text default 'origin', p_actor_user_id uuid default pg_temp.op651_id(1))
returns jsonb language sql as $$
  select public.publish_factory_automation(scope.workspace_id, scope.factory_id, p_actor_user_id,
    pg_temp.op651_id(p_slot), p_expected_revision_id)
  from automation_factories scope where scope.fixture = p_fixture
$$;
create function pg_temp.publish_candidate(p_slot integer, p_definition jsonb) returns jsonb language sql as $$
  select pg_temp.publish_automation(p_slot, (pg_temp.create_automation(p_slot, p_definition)->>'draftRevisionId')::uuid)
$$;
create function pg_temp.read_automation(p_fixture text, p_slot integer, p_revision_id uuid default null)
returns jsonb language sql as $$
  select public.read_factory_automation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(p_slot), p_revision_id)
  from automation_factories scope where scope.fixture = p_fixture
$$;

create temp table automation_execution_baseline as
select (select count(*) from public.sessions) as sessions, (select count(*) from public.agent_jobs) as jobs;

select throws_ok($$select pg_temp.create_automation(100, pg_temp.automation_definition(),
  p_actor_user_id => pg_temp.op651_id(2))$$,
  '42501', null, 'a workspace participant cannot create an automation');
select throws_ok($$select pg_temp.create_automation(100,
  jsonb_set(pg_temp.automation_definition(), '{target,apiKey}', '"synthetic-raw-credential"'))$$,
  '22023', null, 'an unknown nested credential field cannot enter stored automation JSON');

create temp table automation_draft as select pg_temp.create_automation(100, pg_temp.automation_definition()) as value;
select is(value->>'automationId', pg_temp.op651_id(100)::text, 'a draft retains its stable automation identity')
from automation_draft;
select is(value->>'publishedRevisionId', null::text, 'creating a draft does not publish an automation')
from automation_draft;
select is(value#>'{revision,definition}', pg_temp.automation_definition(),
  'a draft stores the exact definition including only the logical binding reference') from automation_draft;

create temp table automation_edit as
select public.save_factory_automation_draft(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  pg_temp.op651_id(100), (draft.value->>'draftRevisionId')::uuid,
  jsonb_set(pg_temp.automation_definition(), '{name}', '"Inspect changed rules"')) as value
from op651_scope scope cross join automation_draft draft;
select isnt(edit.value->>'draftRevisionId', draft.value->>'draftRevisionId', 'an edit appends a new draft identity')
from automation_edit edit cross join automation_draft draft;
select throws_ok($$
  select public.save_factory_automation_draft(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
    pg_temp.op651_id(100), (draft.value->>'draftRevisionId')::uuid, pg_temp.automation_definition())
  from op651_scope scope cross join automation_draft draft
$$, 'PT409', null, 'a second editor using the previous revision cannot overwrite the newer draft');
select throws_ok($$select pg_temp.publish_automation(100, (value->>'draftRevisionId')::uuid) from automation_draft$$,
  'PT409', null, 'publishing the earlier draft conflicts with the edited head');
select throws_ok($$
  select public.archive_factory_automation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
    pg_temp.op651_id(100), (draft.value->>'draftRevisionId')::uuid, jsonb_build_object('revisionId', null))
  from op651_scope scope cross join automation_draft draft
$$, 'PT409', null, 'archiving requires the currently observed revision');

create temp table automation_published as
select pg_temp.publish_automation(100, (value->>'draftRevisionId')::uuid) as value from automation_edit;
select is(published.value->>'publishedRevisionId', edit.value->>'draftRevisionId',
  'publishing selects the exact draft that won the write conflict')
from automation_published published cross join automation_edit edit;
select is((pg_temp.publish_candidate(101, pg_temp.automation_definition('workflow'))#>'{revision,definition,target}'),
  (pg_temp.automation_definition('workflow')->'target'), 'publication retains the exact authored workflow activation');

select throws_ok($$
  select pg_temp.publish_candidate(102, jsonb_set(pg_temp.automation_definition(), '{target,agentId}', to_jsonb(agent.id)))
  from automation_factories scope join public.factory_agents agent using (workspace_id, factory_id)
  where scope.fixture = 'sibling' and agent.is_default
$$, 'PT422', null, 'a real sibling-factory agent cannot be published');
select throws_ok($$
  select pg_temp.publish_candidate(102, jsonb_set(pg_temp.automation_definition(), '{servicePrincipalId}', to_jsonb(id)))
  from automation_sibling_principal
$$, 'PT422', null, 'a real sibling service identity cannot be published');
select throws_ok($$
  select pg_temp.publish_candidate(102, jsonb_set(pg_temp.automation_definition(), '{executionGrant,id}', to_jsonb(id)))
  from automation_sibling_grant
$$, 'PT422', null, 'a real sibling execution grant cannot be published');
select throws_ok($$
  select pg_temp.publish_candidate(102, jsonb_set(pg_temp.automation_definition(), '{credentialBindingId}', to_jsonb(id)))
  from automation_sibling_binding
$$, 'PT422', null, 'a real sibling credential binding cannot be published');
select throws_ok($$
  select pg_temp.publish_candidate(102, jsonb_set(pg_temp.automation_definition(), '{budgetPayerMemberId}',
    to_jsonb(pg_temp.op651_id(23))))
$$, 'PT422', null, 'a real member of another workspace cannot be assigned the automation budget');
select throws_ok($$
  select pg_temp.publish_candidate(102, pg_temp.automation_definition() || jsonb_build_object(
    'trigger', jsonb_build_object('kind', 'pull-request', 'repositoryId', pg_temp.op651_id(56)),
    'filters', jsonb_build_object('actions', jsonb_build_array('opened'), 'baseBranches', jsonb_build_array('main'))))
$$, 'PT422', null, 'a pull-request source repository cannot belong to a sibling factory');
select throws_ok($$
  update internal.factory_automation_revisions set definition = '{}'::jsonb
  where id = (select (value->>'draftRevisionId')::uuid from automation_draft)
$$, '23514', null, 'even a privileged direct write cannot replace a recorded revision');

select ok((select sessions = (select count(*) from public.sessions)
  and jobs = (select count(*) from public.agent_jobs) from automation_execution_baseline),
  'definition publication does not start a session or enqueue work');

select ok((select count(*) = 5 and bool_and(actor_member_id = pg_temp.op651_id(21))
  and bool_and(position('fixture-ciphertext' in detail::text) = 0)
  from public.factory_audit_events
  where action like 'automation.%' and workspace_id = pg_temp.op651_id(11)),
  'successful mutations audit the real actor and keep credential material out of the receipt');

select ok(not has_table_privilege('authenticated', 'internal.factory_automations', 'select')
  and not has_table_privilege('service_role', 'internal.factory_automation_revisions', 'update'),
  'storage access remains behind the scoped functions');
select ok(not has_function_privilege('anon', 'public.read_factory_automation(uuid,uuid,uuid,uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.read_factory_automation(uuid,uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.create_factory_automation(uuid,uuid,uuid,uuid,jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.create_factory_automation(uuid,uuid,uuid,uuid,jsonb)', 'execute'),
  'the manager read and privileged mutation RPCs have separate role grants');

create function pg_temp.list_automations(p_fixture text) returns jsonb language sql as $$
  select public.list_factory_automations(scope.workspace_id, scope.factory_id)
  from automation_factories scope where scope.fixture = p_fixture
$$;
grant select on automation_factories, automation_draft to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is(pg_temp.read_automation('origin', 100)->>'automationId', pg_temp.op651_id(100)::text,
  'an authenticated manager can read the scoped automation');
select is(jsonb_array_length(pg_temp.list_automations('origin')->'automations'), 2,
  'the manager list returns only the automations in the requested factory');
select is(jsonb_array_length(pg_temp.list_automations('sibling')->'automations'), 0,
  'a sibling factory manager cannot see other factories through its list');
select is(pg_temp.read_automation('origin', 100, (value->>'draftRevisionId')::uuid)#>'{revision,definition}',
  value#>'{revision,definition}', 'the original revision is still readable with its original bytes')
from automation_draft;
select is(pg_temp.read_automation('sibling', 100), null::jsonb,
  'even a manager of both factories must query the automation in its own factory');
select set_config('request.jwt.claim.sub', pg_temp.op651_id(2)::text, true);
select is(pg_temp.read_automation('origin', 100), null::jsonb, 'an ordinary member cannot read a manager draft');
select set_config('request.jwt.claim.sub', pg_temp.op651_id(3)::text, true);
select is(pg_temp.read_automation('origin', 100), null::jsonb, 'a foreign workspace owner cannot read the automation');
reset role;
set local request.jwt.claim.role = 'service_role';
select set_config('request.jwt.claim.sub', pg_temp.op651_id(1)::text, true);

select throws_ok($$
  select public.archive_factory_automation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
    pg_temp.op651_id(100), (edit.value->>'draftRevisionId')::uuid, jsonb_build_object('revisionId', null))
  from op651_scope scope cross join automation_edit edit
$$, 'PT409', null, 'archiving cannot overwrite a publication made since the editor read the draft');
create temp table automation_archive as
select public.archive_factory_automation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  pg_temp.op651_id(100), (edit.value->>'draftRevisionId')::uuid,
  jsonb_build_object('revisionId', published.value->>'publishedRevisionId')) as value
from op651_scope scope cross join automation_edit edit cross join automation_published published;
select ok(value->>'archivedAt' is not null, 'archive records a terminal automation state') from automation_archive;
select throws_ok($$select pg_temp.publish_automation(100, (value->>'draftRevisionId')::uuid) from automation_edit$$,
  'PT409', null, 'an archived automation cannot be published again');
select ok(exists (select 1 from public.factory_audit_events
  where action = 'automation.archived' and actor_member_id = pg_temp.op651_id(21)
    and factory_id = (select factory_id from op651_scope)),
  'archive audits the manager in the automation factory');

create temp table automation_pending as select pg_temp.create_automation(103, pg_temp.automation_definition()) as value;
select public.revoke_factory_execution_grant(workspace_id, factory_id, pg_temp.op651_id(1), id, version,
  'Confirm pending automation authority is rechecked') from op651_grant;
select throws_ok($$select pg_temp.publish_automation(103, (value->>'draftRevisionId')::uuid) from automation_pending$$,
  'PT422', 'The automation execution grant is unavailable.',
  'publication rechecks grant authority after a previously valid draft was saved');

select * from finish();
rollback;
