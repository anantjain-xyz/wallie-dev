begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
set local request.jwt.claim.role = 'service_role';
select plan(48);

create function pg_temp.connector_delivery_fixture_id(slot integer) returns uuid
language sql immutable as $$
  select ('67100000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.connector_delivery_fixture_id(1), 'connector-outbound-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.connector_delivery_fixture_id(11), 'connector-outbound', 'Connector outbound');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.connector_delivery_fixture_id(21), pg_temp.connector_delivery_fixture_id(11),
    pg_temp.connector_delivery_fixture_id(1), 'human', 'owner');
insert into public.workspace_secrets(id, workspace_id, key, encrypted_value) values
  (pg_temp.connector_delivery_fixture_id(31), pg_temp.connector_delivery_fixture_id(11), 'LINEAR_API_KEY', 'fixture-ciphertext');

create temp table outbound_scope as
select factory.workspace_id, factory.id as factory_id, installed.installation_id
from public.factories factory
cross join lateral public.configure_connector_installation(factory.workspace_id, factory.id,
  pg_temp.connector_delivery_fixture_id(1), 'linear', 'tenant-outbound', 'tenant-outbound', 0,
  pg_temp.connector_delivery_fixture_id(31), 1) installed
where factory.workspace_id = pg_temp.connector_delivery_fixture_id(11) and factory.is_default;
create temp table outbound_resources as
select fixture.slot, scope.*, mapping.resource_id
from outbound_scope scope cross join (values (1, 'project-one'), (2, 'project-two')) fixture(slot, project)
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id,
  pg_temp.connector_delivery_fixture_id(1), scope.installation_id, 1, 'project', fixture.project, 0, true) mapping;
create temp table outbound_actor as
select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.connector_delivery_fixture_id(1),
  scope.installation_id, 1, 'linear', 'tenant-outbound', 'linear-human', 'human') as id from outbound_scope scope;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.connector_delivery_fixture_id(41), workspace_id, factory_id, 'Outbound pipeline' from outbound_scope;
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values (
  pg_temp.connector_delivery_fixture_id(42), pg_temp.connector_delivery_fixture_id(41),
  pg_temp.connector_delivery_fixture_id(11), 1, 'plan', 'Plan');
insert into public.sessions(id, workspace_id, factory_id, number, title, prompt_md, creator_member_id,
  pipeline_id, current_stage_id)
select pg_temp.connector_delivery_fixture_id(43), workspace_id, factory_id, 1, 'Outbound session', 'Keep one reply.',
  pg_temp.connector_delivery_fixture_id(21), pg_temp.connector_delivery_fixture_id(41), pg_temp.connector_delivery_fixture_id(42)
from outbound_scope;
create temp table outbound_sources as
select mapping.*, source.session_id, source.id as source_id
from outbound_resources mapping
cross join lateral public.bind_session_conversation_source_once(mapping.workspace_id, mapping.factory_id,
  pg_temp.connector_delivery_fixture_id(43), pg_temp.connector_delivery_fixture_id(21), 'linear', mapping.resource_id::text,
  'issue-' || mapping.slot::text) source;

create function pg_temp.enqueue_outbound(p_key text, p_content jsonb default '{"purpose":"progress"}',
  p_slot integer default 1, p_edit uuid default null, p_actor uuid default null) returns uuid language sql as $$
  select public.enqueue_connector_outbound_delivery(source.workspace_id, source.factory_id, source.resource_id,
    source.session_id, source.source_id, p_key,
    (case when p_edit is null then 'reply' else 'edit' end)::public.connector_outbound_operation,
    p_content, p_actor, p_edit)
  from outbound_sources source where source.slot = p_slot
$$;

create function pg_temp.read_outbound(p_delivery_id uuid) returns jsonb language sql as $$
  select to_jsonb(receipt) from outbound_scope scope
  cross join lateral public.read_connector_outbound_delivery(scope.workspace_id, scope.factory_id, p_delivery_id) receipt
$$;

select ok(has_function_privilege('service_role', 'public.claim_connector_outbound_delivery(public.connector_provider)', 'execute')
  and not has_function_privilege('authenticated', 'public.claim_connector_outbound_delivery(public.connector_provider)', 'execute')
  and not has_table_privilege('service_role', 'internal.connector_outbound_deliveries', 'select,update'),
  'only service RPCs can claim sensitive outbox content');
select throws_ok($$
  select public.enqueue_connector_outbound_delivery(source.workspace_id, source.factory_id, unrelated.resource_id,
    source.session_id, source.source_id, 'wrong-resource', 'reply', '{}')
  from outbound_sources source cross join outbound_resources unrelated where source.slot = 1 and unrelated.slot = 2
$$, '42501', null, 'a source from another mapped project cannot be reused under this resource');

create temp table primary_delivery as select pg_temp.enqueue_outbound('progress:1', p_actor => id) as id from outbound_actor;
select is(pg_temp.enqueue_outbound('progress:1', p_actor => (select id from outbound_actor)),
  (select id from primary_delivery), 'enqueue retry preserves one logical receipt');
select throws_ok($$select pg_temp.enqueue_outbound('progress:1', '{"purpose":"changed"}', p_actor => (select id from outbound_actor))$$,
  'PT409', null, 'a repeated logical key cannot replace the frozen content');
select throws_ok($$select pg_temp.enqueue_outbound('edit:pending', p_edit => (select id from primary_delivery))$$,
  'PT409', null, 'an edit cannot target a reply with no confirmed external identity');
select is((select count(*) from public.claim_connector_outbound_delivery('github')), 0::bigint,
  'a different provider cannot claim the pending message');
create temp table first_send as select * from public.claim_connector_outbound_delivery('linear');
select ok((select delivery_id = primary_delivery.id and kind = 'sending' and external_thread_id = 'issue-1'
  and credential_ref = pg_temp.connector_delivery_fixture_id(31) and credential_material_revision = 1
  from first_send cross join primary_delivery), 'the first send permit ties the stable receipt to the exact source and credential');
select ok((select pg_temp.read_outbound(id) @> '{"send_attempts":0}' from primary_delivery),
  'reserving the send lease does not consume the send attempt budget');
select ok((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from first_send),
  'the exact live send permit passes the pre-transport authority fence');
select is((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from first_send),
  false, 'the same permit cannot authorize transport a second time');
select ok((select pg_temp.read_outbound(id) @> '{"send_attempts":1}' from primary_delivery),
  'successful authorization charges exactly one send attempt');
create temp table competing_delivery as select pg_temp.enqueue_outbound('competing:1', p_slot => 2) as id;
select is((select count(*) from public.claim_connector_outbound_delivery('linear')), 0::bigint,
  'a second worker cannot claim another resource while the same installation is in flight');
delete from internal.connector_outbound_deliveries where id = (select id from competing_delivery);
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'not_sent') from first_send),
  'a definite failure before provider write settles the attempt');
select is((select pg_temp.read_outbound(id)->>'status' from primary_delivery), 'queued',
  'a proven pre-write failure can retry the original logical message');
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp() where id = (select id from primary_delivery);
create temp table second_send as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from second_send;
select ok((select next.delivery_id = first.delivery_id and next.lease_id <> first.lease_id and next.kind = 'sending'
  from second_send next cross join first_send first), 'resend keeps the original receipt under a fresh lease');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'uncertain') from second_send),
  'a lost response records the possible provider write');
select ok((select pg_temp.read_outbound(id) @> '{"status":"unknown","uncertain":true,"send_attempts":2}' from primary_delivery),
  'the uncertain write remains eligible for observation only');
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp() where id = (select id from primary_delivery);
create temp table first_observation as select * from public.claim_connector_outbound_delivery('linear');
select ok((select pg_temp.read_outbound(id) @> '{"observation_attempts":0,"uncertain":true}' from primary_delivery),
  'reserving an observation keeps the prior uncertainty without charging its budget');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from first_observation;
select ok((select observation.delivery_id = sent.delivery_id and observation.kind = 'observing'
  from first_observation observation cross join second_send sent), 'the recovery worker can only observe the original correlation ID');
select is((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', 'reply-1') from second_send),
  false, 'an older send lease cannot settle while another worker observes its result');
select throws_ok($$select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', 'reply-1')
  from first_observation$$, '22023', null, 'an observation lease cannot report a second write');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'found', 'reply-1') from first_observation),
  'recovery can settle the reply ID confirmed by an exact provider observation');
select ok((select pg_temp.read_outbound(delivery.id) @> jsonb_build_object(
  'status', 'delivered', 'provider_reply_id', 'reply-1', 'send_attempts', 2, 'observation_attempts', 1,
  'actor_link_id', actor.id, 'actor_kind', 'human', 'initiating_member_id', pg_temp.connector_delivery_fixture_id(21))
  from primary_delivery delivery cross join outbound_actor actor),
  'the final receipt keeps the reply ID, sent and observed counters, and original actor attribution');

select throws_ok($$select pg_temp.enqueue_outbound('edit:wrong-thread', p_slot => 2, p_edit => (select id from primary_delivery))$$,
  'PT409', null, 'an edit cannot reuse a confirmed reply from another source');
create temp table edit_delivery as select pg_temp.enqueue_outbound('edit:1', p_edit => (select id from primary_delivery)) as id;
select throws_ok($$select pg_temp.enqueue_outbound('edit:parallel', p_edit => (select id from primary_delivery))$$,
  'PT409', null, 'two edits cannot race as successors to the same receipt');
create temp table edit_send as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from edit_send;
select ok((select delivery_id = edit_delivery.id and operation = 'edit' and edit_target = 'reply-1'
  from edit_send cross join edit_delivery), 'the edit transport receives the exact existing reply target');
select throws_ok($$select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', 'unrelated')
  from edit_send$$, '22023', null, 'an edit receipt cannot replace the target reply identity');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', edit_target) from edit_send),
  'the edit retains the provider reply identity without opening a new reply');

create temp table never_scheduled as select pg_temp.enqueue_outbound('reply:never-authorized') as id;
update internal.connector_outbound_deliveries set send_attempts = 5 where id = (select id from never_scheduled);
create temp table expired_reservation as select * from public.claim_connector_outbound_delivery('linear');
update internal.connector_outbound_deliveries set lease_expires_at = clock_timestamp() - interval '1 second',
  next_action_at = clock_timestamp() where id = (select id from never_scheduled);
select count(*) from public.claim_connector_outbound_delivery('linear');
select ok((select pg_temp.read_outbound(id) @> '{"status":"queued","uncertain":false,"last_result":"not_sent","send_attempts":5}'
  from never_scheduled), 'an expired reservation that never got transport authority is known to have made no write');
select ok((select delivery_id = never_scheduled.id and kind = 'sending'
  from public.claim_connector_outbound_delivery('linear') cross join never_scheduled),
  'an expired unstarted reservation cannot consume the last authorized send attempt');
delete from internal.connector_outbound_deliveries where id = (select id from never_scheduled);

create temp table lost_delivery as select pg_temp.enqueue_outbound('reply:lost') as id;
create temp table abandoned_send as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from abandoned_send;
update internal.connector_outbound_deliveries set lease_expires_at = clock_timestamp() - interval '1 second',
  next_action_at = clock_timestamp() where id = (select id from lost_delivery);
select is((select count(*) from public.claim_connector_outbound_delivery('linear')), 0::bigint,
  'an expired send is accounted for without handing out another write permit');
select public.disconnect_connector_installation(scope.workspace_id, scope.factory_id,
  pg_temp.connector_delivery_fixture_id(1), scope.installation_id, 1) from outbound_scope scope;
select is((select count(*) from public.claim_connector_outbound_delivery('linear')), 0::bigint,
  'a disconnected installation cannot supply a transport permit for unknown work');
select ok((select pg_temp.read_outbound(id) @> '{"status":"blocked","uncertain":true,"last_result":"credential_unavailable"}'
  from lost_delivery), 'disconnect exposes a repairable state and retains prior uncertainty');
select public.configure_connector_installation(scope.workspace_id, scope.factory_id,
  pg_temp.connector_delivery_fixture_id(1), 'linear', 'tenant-outbound', 'tenant-outbound', 2,
  pg_temp.connector_delivery_fixture_id(31), 1) from outbound_scope scope;
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp() where id = (select id from lost_delivery);
create temp table repaired_observation as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from repaired_observation;
select ok((select delivery_id = lost_delivery.id and kind = 'observing' and installation_generation = 3
  from repaired_observation cross join lost_delivery), 'credential repair resumes with observation on the same logical reply');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'absent') from repaired_observation),
  'only definitive provider absence returns an uncertain reply to the sender path');
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp() where id = (select id from lost_delivery);
create temp table after_absence as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from after_absence;
select ok((select delivery_id = lost_delivery.id and kind = 'sending'
  from after_absence cross join lost_delivery), 'the post-reconciliation retry keeps the stable provider correlation ID');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'rate_limited', p_retry_after_seconds => 120)
  from after_absence), 'a provider rate-limit response is persisted');
create temp table sibling_message as select pg_temp.enqueue_outbound('reply:after-rate-limit', p_slot => 2) as id;
select is((select count(*) from public.claim_connector_outbound_delivery('linear')), 0::bigint,
  'rate limiting holds another resource under the same installation');
select ok((select next_action_at >= clock_timestamp() + interval '100 seconds' from internal.connector_outbound_deliveries
  where id = (select id from sibling_message)), 'the sibling resource observes the shared provider cooldown');
update internal.connector_outbound_cooldowns set retry_at = clock_timestamp() where installation_id = (select installation_id from outbound_scope);
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp()
where id = (select id from sibling_message);
create temp table revoked_send as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from revoked_send;
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'credential_unavailable')
  from revoked_send), 'a definite provider credential rejection parks the original reply');
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp() where id = (select id from sibling_message);
select is((select count(*) from public.claim_connector_outbound_delivery('linear')), 0::bigint,
  'a provider-revoked credential generation is fenced until it changes');
select ok(not exists (select 1 from internal.connector_outbound_deliveries
  where status = 'delivered' and next_action_at is not null), 'successful receipts leave the claim schedule');
create temp table late_cooldown as select pg_temp.enqueue_outbound('reply:cooldown-before-transport') as id;
create temp table cooldown_candidate as select * from public.claim_connector_outbound_delivery('linear');
update internal.connector_outbound_cooldowns set retry_at = clock_timestamp() + interval '30 seconds'
where installation_id = (select installation_id from outbound_scope);
select is((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from cooldown_candidate),
  false, 'preflight also sees a cooldown recorded after the send was claimed');
select ok((select pg_temp.read_outbound(id) @> '{"status":"queued","uncertain":false,"last_result":"rate_limited"}'
  from late_cooldown), 'the late cooldown defers transport without making an unsent reply uncertain');
update internal.connector_outbound_cooldowns set retry_at = clock_timestamp()
where installation_id = (select installation_id from outbound_scope);

create temp table before_transport as select pg_temp.enqueue_outbound('reply:revoked-before-transport') as id;
create temp table fence_candidate as select * from public.claim_connector_outbound_delivery('linear');
select public.disconnect_connector_installation(scope.workspace_id, scope.factory_id,
  pg_temp.connector_delivery_fixture_id(1), scope.installation_id, 3) from outbound_scope scope;
select is((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from fence_candidate),
  false, 'revocation after claim stops the adapter before it can send');
select ok((select pg_temp.read_outbound(id) @> '{"status":"blocked","uncertain":false}' from before_transport),
  'a revoked permit before transport is repairable without pretending a write may have happened');
create temp table exhausted_send as select pg_temp.enqueue_outbound('reply:send-cap') as id;
create temp table exhausted_observation as select pg_temp.enqueue_outbound('reply:observe-cap') as id;
update internal.connector_outbound_deliveries set send_attempts = 6 where id = (select id from exhausted_send);
update internal.connector_outbound_deliveries set status = 'unknown', uncertain = true, observation_attempts = 8
where id = (select id from exhausted_observation);
select count(*) from public.claim_connector_outbound_delivery('linear');
select ok((select pg_temp.read_outbound(id) @> '{"status":"failed","next_action_at":null}' from exhausted_send),
  'definite no-write failures cannot retry past the bounded send budget');
select ok((select pg_temp.read_outbound(id) @> '{"status":"unknown","uncertain":true,"next_action_at":null}'
  from exhausted_observation), 'exhausted observation remains uncertain without putting the message back on the sender path');

select * from finish();
rollback;
