begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
\set op651_fixture_namespace 67410000
\ir fixtures/factory_automation_dry_run.psql

create temp table github_request_scope as
select scope.*, connected.installation_id, connected.generation, mapped.resource_id,
  approved.id as grant_id, approved.version as grant_version
from op651_scope scope cross join op651_grant approved
cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'github', '67410001', '67410033', 0) connected
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  connected.installation_id, connected.generation, 'repository', '67410034', 0, true) mapped;

select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), scope.installation_id,
  scope.generation, 'github', '67410001', '67410002', 'human') from github_request_scope scope;

create function pg_temp.configure_request(p_kind text, p_revision bigint default 0, p_enabled boolean default true,
  p_user uuid default pg_temp.op651_id(1)) returns bigint language sql as $$
  select public.configure_github_connector_request(scope.workspace_id, scope.factory_id, p_user,
    scope.resource_id, p_kind, p_revision, p_enabled, 67410003, scope.grant_id, scope.grant_version)
  from github_request_scope scope
$$;

select throws_ok($$select pg_temp.configure_request('issue', p_user => pg_temp.op651_id(2))$$,
  '42501', null, 'an ordinary workspace member cannot configure request rules');
select is(pg_temp.configure_request('issue'), 1::bigint, 'a manager configures an exact issue label and grant');
select is(pg_temp.configure_request('pull_request'), 1::bigint, 'the same resource has an independent PR rule');
select throws_ok($$select pg_temp.configure_request('issue')$$,
  'PT409', null, 'a stale client cannot overwrite a request rule');

create temp table github_request_epoch as
select date_trunc('second', max(rule.configured_at)) as configured_second
from internal.github_connector_request_rules rule join github_request_scope scope using (resource_id);
create function pg_temp.github_request_time(p_tick integer) returns timestamptz language sql stable as $$
  select configured_second + make_interval(secs => p_tick) from github_request_epoch
$$;
create function pg_temp.deliver_request(
  p_delivery_slot integer, p_number integer, p_tick integer, p_kind text default 'issue',
  p_action text default 'labeled', p_state text default 'open', p_label bigint default 67410003,
  p_sender bigint default 67410002, p_sender_kind public.connector_actor_kind default 'human',
  p_owner bigint default 67410001, p_installation bigint default 67410033, p_repository bigint default 67410034,
  p_head_ref text default 'changes/fixture', p_source_offset int default 0,
  p_body text default 'Review the private GitHub request.'
) returns jsonb language sql as $$
  select public.ingest_github_connector_work(p_installation, p_repository, p_owner, pg_temp.op651_id(p_delivery_slot),
    p_kind, (67000000 + p_number + p_source_offset)::bigint, p_number, p_action, p_state,
    pg_temp.github_request_time(p_tick), p_sender, p_sender_kind,
    case when p_action in ('labeled', 'unlabeled') then p_label end,
    case when p_kind = 'pull_request' then p_head_ref end,
    case when p_kind = 'pull_request' and p_head_ref is not null then repeat('a',40) end,
    case when p_kind = 'pull_request' and p_head_ref is not null then 'main' end,
    case when p_action = 'labeled' then 'Verified GitHub request' end,
    case when p_action = 'labeled' then p_body end)
$$;

select ok(has_function_privilege('service_role',
  'public.ingest_github_connector_work(bigint,bigint,bigint,uuid,text,bigint,integer,text,text,timestamptz,bigint,public.connector_actor_kind,bigint,text,text,text,text,text)', 'execute')
  and not has_function_privilege('authenticated',
  'public.ingest_github_connector_work(bigint,bigint,bigint,uuid,text,bigint,integer,text,text,timestamptz,bigint,public.connector_actor_kind,bigint,text,text,text,text,text)', 'execute'),
  'only the trusted webhook service can submit a verified event');
select is(pg_temp.deliver_request(201, 10, 10, p_owner => 99), null::jsonb,
  'the repository cannot be substituted under another owner');
select is(pg_temp.deliver_request(201, 10, 10, p_installation => 99), null::jsonb,
  'the repository cannot be substituted under another installation');
select is(pg_temp.deliver_request(201, 10, 10, p_repository => 99), null::jsonb,
  'an unconfigured native repository produces no receipt');
select is(pg_temp.deliver_request(202, 10, 10, p_label => 99)->>'status', 'observed',
  'an unselected immutable label does not start work');
select is(pg_temp.deliver_request(203, 11, 10, p_sender => 99)->>'status', 'denied',
  'no unknown user can inherit the grant payer identity');
select is(pg_temp.deliver_request(204, 12, 10, p_sender_kind => 'service')->>'status', 'denied',
  'a bot cannot claim the linked human identity');
select is(pg_temp.deliver_request(205, 13, 20, p_action => 'unlabeled')->>'status', 'observed',
  'a removed request label advances the source watermark');
select is(pg_temp.deliver_request(206, 13, 10)->>'status', 'stale',
  'a reordered older addition cannot act after label removal');
select is(pg_temp.deliver_request(207, 14, 20, p_action => 'closed', p_state => 'closed')->>'status', 'observed',
  'a close advances the source watermark');
select is(pg_temp.deliver_request(208, 14, 20)->>'status', 'stale',
  'an ambiguous same-second addition cannot supersede a close');

select is(pg_temp.deliver_request(209, 15, 20, p_action => 'opened')->>'status', 'observed',
  'a normal issue opened delivery records state without creating work');
create temp table admitted_issue as select pg_temp.deliver_request(210, 15, 20) as receipt;
select ok(receipt->>'status' = 'admitted' and receipt->>'sessionId' is not null,
  'a selected authenticated GitHub issue admits one session after a same-second open') from admitted_issue;
select is(pg_temp.deliver_request(210, 15, 20), receipt || '{"replayed":true}'::jsonb,
  'the original exact delivery and session are replayed') from admitted_issue;
select throws_ok($$select pg_temp.deliver_request(210, 15, 20, p_sender => 99)$$,
  'PT409', null, 'a reused delivery ID cannot change the signed actor');
select throws_ok($$select pg_temp.deliver_request(210, 15, 20, p_body => 'Replacement text')$$,
  'PT409', null, 'a reused delivery ID cannot change the signed task content');
select is(pg_temp.deliver_request(211, 15, 20)->>'status', 'stale',
  'a different delivery GUID cannot repeat the same signed source state');
select is(pg_temp.deliver_request(212, 15, 25, p_source_offset => 900)->>'status', 'stale',
  'a source number cannot be reassigned to another immutable issue identity');
select ok(pg_temp.deliver_request(213, 15, 25) @> jsonb_build_object('status', 'linked',
  'sessionId', receipt->>'sessionId'), 'a later label on the already-linked conversation cannot fork it') from admitted_issue;

select ok(exists (
  select 1 from admitted_issue admitted join public.sessions session on session.id = (admitted.receipt->>'sessionId')::uuid
  join internal.session_mutation_receipts mutation on mutation.session_id = session.id
  join public.agent_jobs job on job.session_id = session.id
  join public.agent_runs run on run.agent_job_id = job.id
  join public.session_conversation_sources source on source.session_id = session.id
  join github_request_scope scope on source.source_namespace = scope.resource_id::text
  join internal.github_connector_work_deliveries delivery on delivery.session_id = session.id and delivery.disposition = 'admitted'
  join op651_grant approved on delivery.service_principal_id = approved.service_principal_id
  where mutation.request_id = pg_temp.op651_id(210) and mutation.grant_id = approved.id
    and mutation.actor_member_id = pg_temp.op651_id(21) and delivery.budget_payer_member_id = approved.budget_payer_member_id
    and source.provider = 'github' and source.external_thread_id = 'issue:67000015'
    and source.source_url = 'https://github.com/fixture/workflow-fixture/issues/15'
    and session.prompt_md like '%Verified GitHub request%'
    and session.prompt_md like '%Review the private GitHub request.%'
), 'the common session, first job/run, exact attributed grant receipt and canonical source commit together');

select is(pg_temp.deliver_request(221, 21, 20, 'pull_request', p_head_ref => null)->>'status', 'denied',
  'a fork or deleted head cannot start work without an exact same-repository ref');
select is(pg_temp.deliver_request(222, 22, 20, 'pull_request', p_head_ref => 'wallie/owned')->>'status', 'denied',
  'a reserved Wallie branch does not recursively start another session');
create temp table admitted_pr as select pg_temp.deliver_request(223, 23, 20, 'pull_request') as receipt;
select ok(receipt->>'status' = 'admitted' and exists (
  select 1 from public.sessions session join public.session_conversation_sources source on source.session_id = session.id
  where session.id = (receipt->>'sessionId')::uuid and source.external_thread_id = 'pull_request:67000023'
    and session.prompt_md like '%' || repeat('a',40) || '%' and session.prompt_md like '%Target branch: main%'
), 'a same-repository PR creates one attributed session with exact signed head and base evidence') from admitted_pr;

select public.ingest_factory_github_automation_pr(67410033, 67410034, pg_temp.op651_id(230), 67000024,
  24, 'closed', 'closed', false, pg_temp.github_request_time(32), 'main', 'changes/fixture', repeat('a',40), 67410034);
select is(pg_temp.deliver_request(231, 24, 31, 'pull_request')->>'status', 'denied',
  'a newer independent M12 PR normalization also fences stale connector requests');

create temp table old_rule as
select draft.value from op651_scope scope cross join lateral (select pg_temp.create_dry_run_automation(101,
  jsonb_set(pg_temp.dry_run_definition('pull-request'), '{filters,actions}', '["opened"]'))) draft(value);
select public.publish_factory_automation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  (rule.value->>'automationId')::uuid, (rule.value->>'draftRevisionId')::uuid)
from op651_scope scope cross join old_rule rule;
select ok(public.ingest_factory_github_automation_pr(67410033, 67410034, pg_temp.op651_id(232), 67000025,
  25, 'opened', 'open', false, pg_temp.github_request_time(20), 'main', 'changes/fixture', repeat('a',40), 67410034)
    @> '{"status":"accepted","occurrenceCount":1}'::jsonb,
  'the pre-existing independent PR automation is still recorded');
select is(pg_temp.deliver_request(233, 25, 21, 'pull_request')->>'status', 'denied',
  'a pending legacy intake of the same PR prevents a parallel linked session');

select is(pg_temp.configure_request('issue', 1, false), 2::bigint, 'a manager can disable the existing request rule');
select is(pg_temp.deliver_request(235, 35, 20), null::jsonb, 'a disabled rule cannot accept new activity');
select is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)), 2::bigint,
  'all issue and PR deliveries created only their two authorized sessions');
update public.workspaces set deletion_requested_at = clock_timestamp() where id = pg_temp.op651_id(11);
select is(pg_temp.deliver_request(236, 36, 20, 'pull_request'), null::jsonb,
  'a workspace pending deletion acknowledges the delivery without trying to admit work');
select * from finish();
rollback;
