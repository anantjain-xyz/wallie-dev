begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
\set op651_fixture_namespace 68010000
\ir fixtures/factory_automation_dry_run.psql

select public.grant_factory_membership(workspace_id, factory_id, pg_temp.op651_id(1), pg_temp.op651_id(22), 'manager')
from op651_scope;
insert into auth.users(id,email) values (pg_temp.op651_id(3),'op680-viewer@example.test');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
values (pg_temp.op651_id(23), pg_temp.op651_id(11), pg_temp.op651_id(3),'human','member');

create temp table op680_github as
select scope.*, connected.installation_id, mapped.resource_id
from op651_scope scope
cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'github', '68010001', '68010033', 0) connected
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  connected.installation_id, 1, 'repository', '68010034', 0, true) mapped;

insert into public.workspace_secrets(id,workspace_id,key,encrypted_value)
values (pg_temp.op651_id(71), pg_temp.op651_id(11), 'LINEAR_API_KEY','must-not-be-exported');
create temp table op680_linear_install as
select scope.*, connected.installation_id
from op651_scope scope
cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'linear', pg_temp.op651_id(72)::text, pg_temp.op651_id(72)::text, 0, pg_temp.op651_id(71), 1) connected;

create function pg_temp.op680_inventory(p_user integer) returns jsonb language sql as $$
  select public.list_factory_connector_resources(workspace_id,factory_id,pg_temp.op651_id(p_user)) from op651_scope
$$;
select ok(not has_function_privilege('authenticated','public.list_factory_connector_resources(uuid,uuid,uuid)','execute')
  and not has_function_privilege('authenticated','public.retry_factory_connector_delivery(uuid,uuid,uuid,uuid,text,uuid,text)','execute')
  and not has_function_privilege('authenticated','public.disable_github_connector_request(uuid,uuid,uuid,uuid,text,bigint)','execute')
  and has_function_privilege('service_role','public.disable_github_connector_request(uuid,uuid,uuid,uuid,text,bigint)','execute')
  and has_function_privilege('service_role','public.list_factory_connector_deliveries(uuid,uuid,uuid,uuid,text,integer,timestamptz,text,uuid)','execute'),
  'diagnostics, retry and disable are service routes with an explicit authenticated actor');
select is(jsonb_array_length(pg_temp.op680_inventory(1)->'installations'),2,
  'a workspace owner can see a verified unmapped installation in setup');
select is((pg_temp.op680_inventory(1)->>'canConfigure')::boolean,true,'only workspace administration can configure');
select is(jsonb_array_length(pg_temp.op680_inventory(2)->'installations'),1,
  'a factory manager can see only installations mapped to the selected factory');
select is((pg_temp.op680_inventory(2)->>'canConfigure')::boolean,false,'a factory manager cannot configure workspace integration authority');
select throws_ok($$select pg_temp.op680_inventory(3)$$,'42501',null,
  'workspace access alone cannot read operator inventory');
select is(pg_temp.op680_inventory(1)#>>'{resources,0,label}','fixture/workflow-fixture',
  'GitHub inventory exposes a label from the exact scoped native repository');
select ok(pg_temp.op680_inventory(1)::text not like '%must-not-be-exported%'
  and pg_temp.op680_inventory(1)::text not like '%'||pg_temp.op651_id(71)::text||'%',
  'inventory contains neither encrypted key material nor its internal reference');

select public.configure_github_connector_request(scope.workspace_id,scope.factory_id,pg_temp.op651_id(1),
  scope.resource_id,'issue',0,true,68010003,approved.id,approved.version)
from op680_github scope cross join op651_grant approved;
select ok((pg_temp.op680_inventory(1)->'resources'->0->'githubRequests') @>
  '[{"sourceKind":"issue","revision":1,"enabled":true,"labelId":68010003}]'::jsonb, 'inventory exposes only the GitHub rule selector and revision');

create temp table op680_linear as
select scope.*, mapped.resource_id
from op680_linear_install scope
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  scope.installation_id, 1, 'team', pg_temp.op651_id(73)::text, 0, true) mapped;

create temp table op680_github_actor as
select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  scope.installation_id, 1, 'github','68010001','68010002','human') as id from op680_github scope;
create temp table op680_linear_actor as
select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  scope.installation_id, 1, 'linear',pg_temp.op651_id(72)::text,pg_temp.op651_id(75)::text,'human') as id from op680_linear scope;

insert into public.sessions(id,workspace_id,factory_id,number,title,creator_member_id,pipeline_id,current_stage_id)
select pg_temp.op651_id(slot),scope.workspace_id,scope.factory_id,number,'Private session title',
  pg_temp.op651_id(21),pg_temp.op651_id(31),pg_temp.op651_id(32)
from op651_scope scope cross join (values(81,1),(82,2)) fixtures(slot,number);
create temp table op680_sources as
select scope.workspace_id, scope.factory_id, scope.resource_id, source.id, source.session_id, 'github'::text as provider
from op680_github scope cross join lateral public.bind_session_conversation_source_once(scope.workspace_id,
  scope.factory_id,pg_temp.op651_id(81),pg_temp.op651_id(21),'github',scope.resource_id::text,'issue:68010004') source
union all
select scope.workspace_id, scope.factory_id, scope.resource_id, source.id, source.session_id, 'linear'::text as provider
from op680_linear scope cross join lateral public.bind_session_conversation_source_once(scope.workspace_id,
  scope.factory_id,pg_temp.op651_id(82),pg_temp.op651_id(21),'linear',scope.resource_id::text,pg_temp.op651_id(74)::text,'OUT-680') source;

insert into internal.github_connector_work_deliveries(workspace_id,factory_id,resource_id,delivery_id,source_kind,source_id,
  source_number,provider_updated_at,snapshot,disposition,recorded_at)
select workspace_id,factory_id,resource_id,pg_temp.op651_id(201),'issue',68010004,17,clock_timestamp(),
  '{"senderKind":"service","contentHash":"private-test-hash"}','denied',timestamptz '2026-11-24T00:00:00Z'
from op680_github;
insert into internal.linear_issue_discovery_receipts(workspace_id,external_tenant_id,issue_id,factory_id,resource_id,
  session_id,source_id,actor_link_id,source_event)
select source.workspace_id,pg_temp.op651_id(72),pg_temp.op651_id(74),source.factory_id,source.resource_id,source.session_id,
  source.id,actor.id,jsonb_build_object('kind','issue-state','stateId',pg_temp.op651_id(76))
from op680_sources source cross join op680_linear_actor actor where source.provider = 'linear';

select public.configure_linear_issue_discovery(scope.workspace_id,scope.factory_id,pg_temp.op651_id(1),
  scope.resource_id,0,1,array[pg_temp.op651_id(76)],true) from op680_linear scope;
insert into internal.linear_issue_discovery_cooldowns(workspace_id,credential_ref,credential_material_revision,retry_at)
values (pg_temp.op651_id(11),pg_temp.op651_id(71),1,clock_timestamp()+interval '1 hour');

select public.defer_github_connector_comment(68010033,68010034,68010001,pg_temp.op651_id(slot),'created',
  'issue',issue_number,issue_id,68010100+slot,68010002,clock_timestamp(),'Private signed pending body')
from (values (201,17,68010004),(202,18,68010005),(203,17,68010004),(204,17,68010004))
  fixtures(slot,issue_number,issue_id);
update internal.github_connector_comment_retries retry set
  recorded_at = timestamptz '2026-11-24T00:00:00Z', next_attempt_at = clock_timestamp()+interval '1 hour'
from op680_github scope where retry.resource_id=scope.resource_id;
update internal.github_connector_comment_retries set status='failed',body=null,last_sqlstate='55P03',
  attempt_count=8,settled_at=clock_timestamp(),next_attempt_at=null where delivery_id=pg_temp.op651_id(203);
update internal.github_connector_comment_retries set status='failed',body=null,last_sqlstate='22023',
  attempt_count=1,settled_at=clock_timestamp()-interval '2 hours', deadline_at=clock_timestamp()-interval '1 hour',
  next_attempt_at=null where delivery_id=pg_temp.op651_id(204);

create temp table op680_outbox as
select item.name, public.enqueue_connector_outbound_delivery(source.workspace_id,source.factory_id,source.resource_id,
  source.session_id,source.id,item.name,'reply','{"body":"Secret delivery body"}') as id
from op680_sources source cross join (values ('unknown-write'),('queued-other'),('initial-block'),('terminal-rejected')) item(name)
where source.provider = 'github';
update internal.connector_outbound_deliveries set status='unknown',uncertain=true,send_attempts=1,last_result='uncertain',
  next_action_at=clock_timestamp()+interval '1 hour'
where id=(select id from op680_outbox where name='unknown-write');
update internal.connector_outbound_deliveries set next_action_at=clock_timestamp()+interval '1 hour'
where id=(select id from op680_outbox where name='queued-other');
update internal.connector_outbound_deliveries set status='blocked',blocked_generation=1,last_result='credential_unavailable',
  next_action_at=clock_timestamp()+interval '1 hour'
where id=(select id from op680_outbox where name='initial-block');
update internal.connector_outbound_deliveries set status='failed',last_result='rejected',send_attempts=1,
  next_action_at=null, deadline_at=clock_timestamp()-interval '1 hour'
where id=(select id from op680_outbox where name='terminal-rejected');

create function pg_temp.op680_history(p_provider text, p_lane text default 'all', p_user integer default 2,
  p_limit integer default 25, p_cursor jsonb default null) returns jsonb language sql as $$
  select public.list_factory_connector_deliveries(source.workspace_id,source.factory_id,pg_temp.op651_id(p_user),
    source.resource_id,p_lane,p_limit,(p_cursor->>'recordedAt')::timestamptz,p_cursor->>'kind',(p_cursor->>'id')::uuid)
  from op680_sources source where source.provider=p_provider
$$;
create function pg_temp.op680_retry(p_provider text,p_kind text,p_id uuid,p_user integer default 2,
  p_mode text default 'retry') returns boolean language sql as $$
  select public.retry_factory_connector_delivery(source.workspace_id,source.factory_id,pg_temp.op651_id(p_user),
    source.resource_id,p_kind,p_id,p_mode)
  from op680_sources source where source.provider=p_provider
$$;

select ok(pg_temp.op680_history('github','ingress')->'deliveries' @>
  '[{"kind":"github_admission","status":"denied","reason":"actor_not_allowed","sourceReference":"Issue #17","canRetry":false}]'::jsonb,
  'GitHub rejected ingress includes a safe reason and cannot reconstruct a replay');
select ok(pg_temp.op680_history('github','ingress')->'deliveries' @>
  '[{"kind":"github_comment","status":"failed","reason":"attempt_limit","canRetry":false}]'::jsonb,
  'a scrubbed and exhausted GitHub retry is visible without a retry action');
select ok(pg_temp.op680_history('github','outbound')->'deliveries' @>
  '[{"kind":"outbound","status":"unknown","uncertain":true,"sessionNumber":1,"canRetry":true}]'::jsonb,
  'an uncertain delivery exposes observation eligibility and its scoped session locator');
select ok(pg_temp.op680_history('github','all')::text not like '%Private signed pending body%'
  and pg_temp.op680_history('github','all')::text not like '%Secret delivery body%'
  and pg_temp.op680_history('github','all')::text not like '%private-test-hash%'
  and pg_temp.op680_history('github','all')::text not like '%55P03%',
  'history withholds bodies, hashes and raw error codes');
select ok(pg_temp.op680_history('linear')->'deliveries' @>
  '[{"kind":"linear_intake","status":"admitted","sourceReference":"OUT-680","sessionNumber":2}]'::jsonb,
  'Linear history reads only the canonical retained intake receipt');
select is(pg_temp.op680_history('linear')#>>'{linearDiscovery,status}','rate_limited',
  'Linear discovery health reports its exact current credential cooldown');
select is(jsonb_array_length(pg_temp.op680_history('linear','outbound')->'deliveries'),0,
  'a resource with no outbound rows has empty history');

select ok(pg_temp.op680_history('github','ingress')->'deliveries' @>
  jsonb_build_array(jsonb_build_object('id',pg_temp.op651_id(204),'status','failed','reason','processing_failed')),
  'elapsed time does not relabel a previously settled concrete GitHub comment failure');
select ok(pg_temp.op680_history('github','outbound')->'deliveries' @>
  jsonb_build_array(jsonb_build_object('id',(select id from op680_outbox where name='terminal-rejected'),
    'status','failed','reason','rejected','canRetry',false)),
  'elapsed time does not relabel a recorded terminal outbound rejection');

update internal.linear_issue_discovery_cooldowns set retry_at=clock_timestamp()-interval '1 second'
where workspace_id=pg_temp.op651_id(11) and credential_ref=pg_temp.op651_id(71);
create temp table op680_scan_claim as
select public.claim_linear_issue_discovery(pg_temp.op651_id(11)) as task;
create function pg_temp.op680_record_scan_failure(p_reason text, p_material_offset integer default 0,
  p_claim_offset_seconds integer default 0) returns boolean language sql as $$
  select public.record_linear_issue_discovery_failure(
    (task->>'workspaceId')::uuid,(task->>'factoryId')::uuid,(task->>'resourceId')::uuid,
    (task->>'configRevision')::bigint,(task->>'installationGeneration')::bigint,(task->>'mappingRevision')::bigint,
    (task->>'credentialRef')::uuid,(task->>'credentialMaterialRevision')::bigint+p_material_offset,
    (task->>'cursorGeneration')::bigint,(task->>'claimExpiresAt')::timestamptz+make_interval(secs=>p_claim_offset_seconds),p_reason)
  from op680_scan_claim
$$;
select ok((select task is not null and task ? 'claimExpiresAt' from op680_scan_claim),
  'the scoped worker claims a bounded Linear scan and captures its exact authority');
select is(pg_temp.op680_record_scan_failure('provider_access_denied',1),false,
  'a different credential material revision cannot record a scan failure');
select is(pg_temp.op680_record_scan_failure('provider_access_denied',p_claim_offset_seconds=>1),false,
  'a different claim expiry cannot record a scan failure');
select throws_ok($$select pg_temp.op680_record_scan_failure('provider returned secret diagnostic')$$,'22023',null,
  'linear scan failure persistence rejects arbitrary error text');
select ok(pg_temp.op680_record_scan_failure('provider_access_denied'), 'the current scoped scan records one closed reason');
select ok(pg_temp.op680_history('linear') @> '{"linearDiscovery":{"status":"failed","lastFailureReason":"provider_access_denied"}}'::jsonb
  and pg_temp.op680_history('linear')#>>'{linearDiscovery,lastFailureAt}' is not null,
  'history distinguishes a bounded failure from a scheduled additional scan');
select ok(pg_temp.op680_history('linear')::text not like '%'||pg_temp.op651_id(71)::text||'%',
  'scan failure projection does not expose its credential identity');

select is((
  select public.commit_linear_issue_discovery_page(
    (task->>'workspaceId')::uuid,(task->>'factoryId')::uuid,(task->>'resourceId')::uuid,
    (task->>'configRevision')::bigint,(task->>'installationGeneration')::bigint,(task->>'mappingRevision')::bigint,
    (task->>'cursorGeneration')::bigint,(task->>'externalTenantId')::uuid,pg_temp.op651_id(75),'[]'::jsonb)
  from op680_scan_claim
),0,'a successful exact page advances its cursor without inventing issue receipts');
select is(pg_temp.op680_record_scan_failure('provider_unavailable'),false,
  'completion of the exact cursor makes an older failure writer stale');
select ok(pg_temp.op680_history('linear') @>
  '{"linearDiscovery":{"status":"scheduled","lastFailureReason":null,"lastFailureAt":null}}'::jsonb,
  'the advanced cursor hides the previous failure while preserving admission history');

update internal.linear_issue_discovery_config set next_scan_at=clock_timestamp()-interval '1 second'
where workspace_id=pg_temp.op651_id(11);
update op680_scan_claim set task=public.claim_linear_issue_discovery(pg_temp.op651_id(11));
select ok(pg_temp.op680_record_scan_failure('scope_mismatch'), 'the next current scan can replace its one retained diagnostic');
select is((select count(*) from internal.linear_issue_discovery_failures where workspace_id=pg_temp.op651_id(11)),
  1::bigint, 'normal scan health keeps one latest receipt per resource');
update public.workspace_secrets set encrypted_value='rotated-fixture-material'
where workspace_id=pg_temp.op651_id(11) and id=pg_temp.op651_id(71);
select ok(pg_temp.op680_history('linear') @>
  '{"linearDiscovery":{"status":"unavailable","lastFailureReason":null,"lastFailureAt":null}}'::jsonb,
  'credential change hides the previous scan failure without erasing its issue history');

create temp table op680_first_page as select pg_temp.op680_history('github','ingress',p_limit=>1) as page;
select is(jsonb_array_length(page->'deliveries'),1,'history enforces the requested page size') from op680_first_page;
select is((page#>>'{deliveries,0,id}')::uuid,pg_temp.op651_id(204),
  'the first tied page selects the highest GitHub comment delivery ID') from op680_first_page;
select is((pg_temp.op680_history('github','ingress',p_limit=>1,p_cursor=>page->'nextCursor')#>>'{deliveries,0,id}')::uuid,
  pg_temp.op651_id(203),'the continuation selects the exact next delivery at the same timestamp') from op680_first_page;
select throws_ok($$select pg_temp.op680_history('github',p_limit=>51)$$,'22023',null,
  'history rejects page sizes outside the hard bound');
select throws_ok($$select pg_temp.op680_history('github',p_user=>3)$$,'42501',null,
  'a workspace member outside the factory manager role cannot inspect history');
select throws_ok($$select pg_temp.op680_retry('github','github_comment',pg_temp.op651_id(201),3)$$,'42501',null,
  'an unauthorized actor cannot schedule a connector delivery');
select is(pg_temp.op680_retry('linear','github_comment',pg_temp.op651_id(201)),false,
  'a selected Linear resource cannot schedule a GitHub delivery ID');

create temp table op680_pending_before as
select retry.* from internal.github_connector_comment_retries retry where retry.delivery_id=pg_temp.op651_id(201);
select ok(pg_temp.op680_retry('github','github_comment',pg_temp.op651_id(201)),
  'a factory manager can schedule the selected retained GitHub input');
select ok(exists(select 1 from internal.github_connector_comment_retries retry
  join op680_pending_before prior using (resource_id,delivery_id)
  where retry.next_attempt_at < prior.next_attempt_at and
    (retry.status,retry.attempt_count,retry.deadline_at,retry.actor_id,retry.input_hash,retry.body) =
    (prior.status,prior.attempt_count,prior.deadline_at,prior.actor_id,prior.input_hash,prior.body)),
  'scheduling touches only the original retry time and preserves input, actor and limits');
select ok(exists(select 1 from internal.github_connector_comment_retries retry where retry.delivery_id=pg_temp.op651_id(202)
  and retry.next_attempt_at > clock_timestamp()+interval '45 minutes'),
  'selecting one GitHub delivery does not accelerate its neighbor');
select is(pg_temp.op680_retry('github','github_comment',pg_temp.op651_id(203)),false,
  'a permanently failed GitHub row without a body cannot be rescheduled');
select throws_ok($$select pg_temp.op680_retry('github','github_comment',pg_temp.op651_id(201),p_mode=>'observe')$$,
  '22023',null,'a GitHub comment retry cannot be scheduled as provider observation');

update internal.github_connector_comment_retries set next_attempt_at=clock_timestamp()+interval '1 hour'
where delivery_id=pg_temp.op651_id(201);
insert into internal.github_connector_work_deliveries(workspace_id,factory_id,resource_id,delivery_id,source_kind,source_id,
  source_number,provider_updated_at,snapshot,disposition)
select workspace_id,factory_id,resource_id,pg_temp.op651_id(205),'issue',68010004,17,clock_timestamp(),'{}','deleted'
from op680_github;
select ok(pg_temp.op680_history('github','ingress')->'deliveries' @>
  jsonb_build_array(jsonb_build_object('id',pg_temp.op651_id(201),'status','pending','canRetry',false))
  and pg_temp.op680_history('github','ingress')->'deliveries' @>
  jsonb_build_array(jsonb_build_object('id',pg_temp.op651_id(202),'status','pending','canRetry',true)),
  'an issue tombstone removes retry eligibility only for its own pending comment');
select is(pg_temp.op680_retry('github','github_comment',pg_temp.op651_id(201)),false,
  'the scheduler refuses the exact deleted issue comment even though its retry is still pending');
select ok(exists(select 1 from internal.github_connector_comment_retries where delivery_id=pg_temp.op651_id(201)
  and next_attempt_at > clock_timestamp()+interval '45 minutes'),
  'the deleted issue retry preserves its existing attempt time');

create temp table op680_unknown_before as select delivery.* from internal.connector_outbound_deliveries delivery
where delivery.id=(select id from op680_outbox where name='unknown-write');
select is(pg_temp.op680_retry('github','outbound',(select id from op680_unknown_before)),false,
  'a sending retry cannot accelerate an unknown delivery');
select ok(pg_temp.op680_retry('github','outbound',(select id from op680_unknown_before),p_mode=>'observe'),
  'an uncertain reply may be accelerated for observation');
select ok(exists(select 1 from internal.connector_outbound_deliveries delivery join op680_unknown_before prior using(id)
  where delivery.next_action_at < prior.next_action_at and delivery.uncertain and
    (delivery.status,delivery.deadline_at,delivery.send_attempts,delivery.observation_attempts,delivery.logical_key,delivery.content) =
    (prior.status,prior.deadline_at,prior.send_attempts,prior.observation_attempts,prior.logical_key,prior.content)),
  'retry never clears uncertainty or restores a write permit');

-- Install the authorized observation lease for only this fixture. Claiming a
-- provider queue here could touch unrelated ready rows in the local stack.
update internal.connector_outbound_deliveries set status='observing',lease_id=pg_temp.op651_id(501),
  lease_expires_at=clock_timestamp()+interval '1 minute',observation_attempts=1
where id=(select id from op680_unknown_before);
insert into internal.connector_outbound_attempts(lease_id,delivery_id,operation,installation_generation,mapping_revision,
  started_at,authorized_at)
select pg_temp.op651_id(501),id,'observing',1,1,clock_timestamp(),clock_timestamp() from op680_unknown_before;
select ok(public.settle_connector_outbound_delivery((select id from op680_unknown_before),pg_temp.op651_id(501),'absent'),
  'a worker observation authoritatively confirms absence on the exact delivery');
create temp table op680_after_absence as select delivery.* from internal.connector_outbound_deliveries delivery
where delivery.id=(select id from op680_unknown_before);
select is(pg_temp.op680_retry('github','outbound',(select id from op680_after_absence),p_mode=>'observe'),false,
  'a stale observation command cannot accelerate the subsequent sending attempt');
select ok(exists(select 1 from internal.connector_outbound_deliveries delivery join op680_after_absence prior using(id)
  where delivery.status='queued' and not delivery.uncertain and delivery.next_action_at=prior.next_action_at),
  'the stale observation leaves the scheduled retry undisturbed');
select ok(pg_temp.op680_retry('github','outbound',(select id from op680_after_absence)),
  'an exact sending retry can accelerate the confirmed-absent delivery');
select is(pg_temp.op680_retry('github','outbound',(select id from op680_outbox where name='initial-block')),
  false,'unchanged blocked credential generation does not become retryable');

insert into internal.connector_outbound_cooldowns(installation_id,retry_at)
select installation_id,clock_timestamp()+interval '10 minutes' from op680_github;
select is(pg_temp.op680_retry('github','outbound',(select id from op680_outbox where name='queued-other')),
  false,'operator retry cannot bypass the shared installation cooldown');
delete from internal.connector_outbound_cooldowns cooldown using op680_github scope where cooldown.installation_id=scope.installation_id;
update internal.connector_outbound_deliveries set deadline_at=clock_timestamp()-interval '1 second'
where id=(select id from op680_outbox where name='queued-other');
select is(pg_temp.op680_retry('github','outbound',(select id from op680_outbox where name='queued-other')),
  false,'operator retry cannot extend the original delivery deadline');

select public.publish_connector_resource_mapping(scope.workspace_id,scope.factory_id,pg_temp.op651_id(1),
  scope.installation_id,1,'repository','68010034',1,false) from op680_github scope;
select is(pg_temp.op680_retry('github','github_comment',pg_temp.op651_id(202)),false,
  'a revoked mapping cannot reschedule an otherwise pending inbound delivery');
select ok(pg_temp.op680_history('github','ingress')->'deliveries' @>
  '[{"kind":"github_admission","status":"denied"}]'::jsonb,'revoked mappings retain historical diagnostics');

create function pg_temp.op680_disable(p_user integer,p_expected_revision bigint) returns bigint language sql as $$
  select public.disable_github_connector_request(scope.workspace_id,scope.factory_id,pg_temp.op651_id(p_user),
    scope.resource_id,'issue',p_expected_revision) from op680_github scope
$$;
select throws_ok($$select pg_temp.op680_disable(2,1)$$,'42501',null,
  'a factory manager cannot disable workspace-owned GitHub intake');
select throws_ok($$select pg_temp.op680_disable(1,0)$$,'PT409',null,
  'disabling GitHub intake still requires the exact current revision');
select public.revoke_factory_execution_grant(workspace_id,factory_id,pg_temp.op651_id(1),id,version,
  'Fixture revoked grant') from op651_grant;
select is(pg_temp.op680_disable(1,1),2::bigint,
  'the owner can disable GitHub intake after its subscription and grant are revoked');
select ok((pg_temp.op680_inventory(1)->'resources'->0->'githubRequests') @>
  '[{"sourceKind":"issue","revision":2,"enabled":false,"labelId":68010003}]'::jsonb,
  'disabling retains the exact selector in history at its next revision');

select * from finish();
rollback;
