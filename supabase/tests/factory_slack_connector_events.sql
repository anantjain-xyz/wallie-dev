begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(87);

\set op651_fixture_namespace 67700000
\ir fixtures/factory_automation_dry_run.psql

create temp table slack_event_scope as
select scope.*, installed.installation_id, installed.generation, mapped.resource_id,
  mapped.revision, approved.service_principal_id, approved.budget_payer_member_id
from op651_scope scope cross join op651_grant approved
cross join lateral public.configure_slack_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'T67700001', 'Slack event fixture', 'A67700001', 'U67700001', 0, 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA',
  array['app_mentions:read','channels:read','channels:history']) installed
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  installed.installation_id, installed.generation, 'channel', 'C67700001', 0, true) mapped;

create temp table slack_event_actors as
select fixture.actor_id, public.link_connector_actor(scope.workspace_id, scope.factory_id, fixture.user_id,
  scope.installation_id, scope.generation, 'slack', 'T67700001', fixture.actor_id, 'human') as actor_link_id
from slack_event_scope scope cross join (
  values (pg_temp.op651_id(1), 'U67700002'), (pg_temp.op651_id(2), 'U67700003')
) fixture(user_id,actor_id);

grant select on slack_event_scope, slack_event_actors to service_role;
set local role service_role;

create function pg_temp.slack_ts(tick integer) returns text language sql immutable as $$
  select '1732400000.' || lpad(tick::text,6,'0')
$$;

create function pg_temp.enqueue_slack(
  p_event text, p_action text, p_message integer, p_version integer, p_thread integer default null,
  p_actor text default 'U67700002', p_body text default '<@U67700001> Verify the linked task',
  p_team text default 'T67700001', p_app text default 'A67700001', p_channel text default 'C67700001'
) returns text language sql as $$
  select public.enqueue_slack_connector_event(p_team, p_app, p_channel, p_event, p_action, pg_temp.slack_ts(p_message),
    pg_temp.slack_ts(p_version), pg_temp.slack_ts(p_thread), p_actor, p_body)
$$;

create function pg_temp.process_slack(
  p_result text default 'verified', p_channel text default 'C67700001', p_retry integer default null
) returns text language sql as $$
  select public.settle_slack_connector_event(claim.queue_id, claim.lease_id, p_result,
    claim.team_id, claim.app_id, p_channel, claim.bot_user_id, p_retry)
  from public.claim_slack_connector_event(pg_temp.op651_id(11)) claim
$$;

select ok(has_function_privilege('service_role',
    'public.enqueue_slack_connector_event(text,text,text,text,text,text,text,text,text,text)','execute')
  and not has_function_privilege('authenticated','public.claim_slack_connector_event(uuid)','execute')
  and not has_function_privilege('anon','public.settle_slack_connector_event(uuid,uuid,text,text,text,text,text,integer,text)','execute')
  and not has_table_privilege('service_role','internal.slack_connector_event_receipts','select'),
  'only the service entry points can route or claim Slack event receipts');
select throws_ok($$select pg_temp.enqueue_slack('bad-ts', 'edited', 2, 1, 2)$$,
  '22023', null, 'edits must use a later provider version');
select is(pg_temp.enqueue_slack('wrong-team', 'mention', 1, 1, p_team => 'T67700002'),
  'ignored', 'a different Slack team cannot reach this mapping');
select is(pg_temp.enqueue_slack('wrong-app', 'mention', 1, 1, p_app => 'A67700002'),
  'ignored', 'a different Slack app cannot reach this installation');
select is(pg_temp.enqueue_slack('wrong-channel', 'mention', 1, 1, p_channel => 'C67700002'),
  'ignored', 'an unselected channel cannot launch work');
select is(pg_temp.enqueue_slack('plain-message', 'created', 1, 1),
  'ignored', 'a channel root submitted as an ordinary message cannot launch work');
select is(pg_temp.enqueue_slack('wrong-bot-mention', 'mention', 1, 1, p_body => '<@U677000010> Not the installed bot'),
  'ignored', 'an identifier prefix cannot stand in for an exact bot mention');
select is(pg_temp.enqueue_slack('app-bot-message', 'mention', 1, 1, p_actor => 'U67700001'),
  'ignored', 'the app bot cannot recursively launch work');
select is(pg_temp.enqueue_slack('unlinked-human', 'mention', 1, 1, p_actor => 'U67700009'),
  'ignored', 'an unlinked Slack author cannot queue request content');
select is(pg_temp.enqueue_slack('orphan-followup', 'created', 2, 2, 1, p_body => 'Unrelated conversation'),
  'queued', 'a linked human’s early reply can briefly wait for its root');
select is((select count(*) from public.claim_slack_connector_event(pg_temp.op651_id(11))), 0::bigint,
  'the wait stage cannot hand out credentials or initiate live membership checks');
reset role;
update internal.slack_connector_event_receipts set wait_for_root_until = clock_timestamp() - interval '1 second',
  next_attempt_at = clock_timestamp() - interval '1 second' where event_id = 'orphan-followup';
set local role service_role;
select is((select count(*) from public.claim_slack_connector_event(pg_temp.op651_id(11))), 0::bigint,
  'unrelated thread content expires without ever claiming provider access');

select is(pg_temp.enqueue_slack('membership-denied', 'mention', 10, 10), 'queued',
  'authorized Slack intake is durable before checking live membership');
select is(pg_temp.enqueue_slack('membership-denied', 'mention', 10, 10), 'replayed',
  'exact event redelivery shares its receipt');
select throws_ok($$select pg_temp.enqueue_slack('membership-denied', 'mention', 10, 10,
  p_body => '<@U67700001> Conflicting payload')$$,
  'PT409', null, 'a reused event identity cannot change the signed input');
select is((select count(*) from public.claim_slack_connector_event(pg_temp.op651_id(12))), 0::bigint,
  'claiming within another workspace cannot obtain this event');
create temp table slack_denied_claim as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select ok((select count(*) = 1 and bool_and(
  (claim.workspace_id,claim.factory_id,claim.resource_id,claim.installation_id,claim.installation_generation,claim.mapping_revision) =
    (scope.workspace_id,scope.factory_id,scope.resource_id,scope.installation_id,scope.generation,scope.revision)
  and claim.team_id = 'T67700001' and claim.app_id = 'A67700001' and claim.channel_id = 'C67700001'
  and claim.bot_user_id = 'U67700001' and claim.encrypted_token = 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA'
  and not (to_jsonb(claim) ? 'body') and not (to_jsonb(claim) ? 'actor_id'))
  from slack_denied_claim claim cross join slack_event_scope scope),
  'the claim exposes only scoped provider identifiers and encrypted transport material');
select is((select count(*) from public.claim_slack_connector_event(pg_temp.op651_id(11))), 0::bigint,
  'an in-flight lease cannot be claimed twice');
select is((select public.settle_slack_connector_event(queue_id, gen_random_uuid(), 'unavailable')
  from slack_denied_claim),'stale','a different lease cannot settle the claimed event');
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'verified', team_id, app_id, 'C67700002', bot_user_id)
  from slack_denied_claim),'membership_denied','proof from a different channel cannot admit the request');

select is(pg_temp.enqueue_slack('early-followup', 'created', 21, 21, 20, p_body => 'Confirm the scoped target.'),
  'queued', 'a follow-up can arrive before its root mention delivery');
select is((select count(*) from public.claim_slack_connector_event(pg_temp.op651_id(11))), 0::bigint,
  'the early follow-up waits until the exact root is admitted');
select is(pg_temp.enqueue_slack('unsolicited-root-edit', 'edited', 19, 26, p_body => 'No earlier mention.'),
  'ignored', 'an edited root cannot queue without its signed original mention');
select is(pg_temp.enqueue_slack('root-mention', 'mention', 20, 20), 'queued',
  'a current human can explicitly mention the installed bot at the thread root');
create temp table slack_pending_root_claim as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select is(pg_temp.enqueue_slack('root-edit-other-actor', 'edited', 20, 26, p_actor => 'U67700003', p_body => 'Different author.'),
  'ignored', 'another linked human cannot defer an edit against the original author’s pending mention');
select is(pg_temp.enqueue_slack('early-root-edit', 'edited', 20, 26, p_body => 'Use the corrected root request.'),
  'queued', 'the same human can edit the original root before the mention is admitted');
reset role;
update internal.slack_connector_event_receipts set recorded_at = clock_timestamp() - interval '3 seconds'
where event_id = 'root-mention';
update internal.slack_connector_event_receipts set wait_for_root_until = clock_timestamp() - interval '1 second',
  next_attempt_at = clock_timestamp() - interval '1 second' where event_id in ('early-followup', 'early-root-edit');
set local role service_role;
select is((select count(*) from public.claim_slack_connector_event(pg_temp.op651_id(11))), 0::bigint,
  'an early reply can wait past its short window without obtaining provider access while its timely root is in flight');
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'verified', team_id, app_id, channel_id, bot_user_id)
  from slack_pending_root_claim),'admitted','live membership and exact factory authority admit one Slack request');
select is(pg_temp.process_slack(),'appended','the early follow-up attaches to the admitted Slack thread');
select is(pg_temp.process_slack(),'appended','the deferred root edit attaches to the already admitted session');

create temp table slack_linked_session as
select source.session_id, source.id as source_id, source.external_thread_id, source.source_url
from slack_event_scope scope join public.session_conversation_sources source
  on (source.workspace_id,source.factory_id,source.provider,source.source_namespace) =
    (scope.workspace_id,scope.factory_id,'slack',scope.resource_id::text);
grant select on slack_linked_session to authenticated;
select ok((select count(*) = 1 and bool_and(linked.external_thread_id = pg_temp.slack_ts(20)
  and linked.source_url = 'https://app.slack.com/archives/C67700001/p1732400000000020'
  and session.creator_member_id = pg_temp.op651_id(21))
  from slack_linked_session linked join public.sessions session on session.id = linked.session_id),
  'one retained source records the canonical thread and actual Wallie human');
select is(pg_temp.enqueue_slack('duplicate-root', 'mention', 20, 20), 'queued',
  'a differently numbered provider delivery is still checked against the logical request');
select is(pg_temp.process_slack(),'stale','another delivery of the same Slack root never starts a second session');

select is(pg_temp.enqueue_slack('ordinary-reply', 'created', 22, 22, 20, p_body => 'First reply.'),
  'queued', 'ordinary thread replies target the existing conversation');
select is(pg_temp.process_slack(),'appended','the human reply becomes one retained conversation message');
select is(pg_temp.enqueue_slack('same-reply-mention', 'mention', 22, 22, 20, p_body => 'First reply.'),
  'queued', 'a different event type can refer to the same provider message');
select is(pg_temp.process_slack(),'stale','the same provider message and version stay deduplicated across event types');
select is(pg_temp.enqueue_slack('edited-reply', 'edited', 22, 24, 20, p_body => 'Updated reply.'),
  'queued', 'a signed edit keeps its original message identity');
select is(pg_temp.process_slack(),'appended','the original and revised content remain in the same conversation');
select is(pg_temp.enqueue_slack('reordered-edit', 'edited', 22, 23, 20, p_body => 'Older edited text.'),
  'queued', 'an out-of-order event still gets an auditable receipt');
select is(pg_temp.process_slack(),'stale','an older edited version cannot overwrite the retained message');
select is(pg_temp.enqueue_slack('deleted-reply', 'deleted', 22, 25, p_actor => null, p_body => null),
  'queued', 'deletion without the original actor or thread remains a signed scoped tombstone');
select is(pg_temp.process_slack(),'deleted','the deletion tombstone retains history and prevents resurrection');
select is(pg_temp.enqueue_slack('late-edit-after-delete', 'edited', 22, 26, 20, p_body => 'After delete.'),
  'queued', 'a differently numbered edit can still be acknowledged after a tombstone');
select is(pg_temp.process_slack(),'stale','no edit can resurrect the deleted provider message');

select ok((select count(*) = 4 and bool_and(message.originating_member_id = pg_temp.op651_id(21)
  and message.external_actor_id = 'U67700002')
  from slack_linked_session linked join public.session_conversation_messages message
    on (message.session_id,message.source_id) = (linked.session_id,linked.source_id)),
  'only the actual linked human’s four accepted thread messages are retained');
select is((select message.body_md from slack_linked_session linked join public.session_conversation_messages message
  on (message.session_id, message.source_id) = (linked.session_id, linked.source_id)
  where message.external_message_id = 'slack-message:' || pg_temp.slack_ts(20) || ':' || pg_temp.slack_ts(26)),
  E'Slack message edited:\n\nUse the corrected root request.', 'the admitted conversation retains the preserved corrected root text');
select is((select count(*) from slack_linked_session linked join public.agent_jobs job on job.session_id = linked.session_id),
  1::bigint, 'Slack replies, edits and deletions cannot queue another root job');

select is(pg_temp.enqueue_slack('revoked-author', 'created', 30, 30, 20,
  p_actor => 'U67700003', p_body => 'This actor loses access before settlement.'), 'queued',
  'a live Slack and Wallie human can enqueue a reply');
create temp table slack_revoked_claim as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select ok((select public.revoke_connector_actor_link(pg_temp.op651_id(11),pg_temp.op651_id(2),actor_link_id)
  from slack_event_actors where actor_id = 'U67700003'),
  'the linked human revokes their identity after the worker claim');
select is((select public.settle_slack_connector_event(queue_id,lease_id,'verified',team_id,app_id,channel_id,bot_user_id)
  from slack_revoked_claim),'actor_denied','a provider membership proof cannot restore a revoked actor');

select is(pg_temp.enqueue_slack('retryable-event', 'created', 31, 31, 20, p_body => 'Retry once.'),
  'queued', 'a new follow-up can survive a provider retry');
select is(pg_temp.process_slack('retry', p_retry => 60),'retry','provider wait schedules a bounded retry');
select is((select count(*) from public.claim_slack_connector_event(pg_temp.op651_id(11))), 0::bigint,
  'a retry timing gate prevents immediate reclaims');
reset role;
update internal.slack_connector_event_receipts set next_attempt_at = clock_timestamp()
where event_id = 'retryable-event';
set local role service_role;
select is(pg_temp.process_slack(),'appended','the retried receipt can settle once after live access is restored');

-- Two channels on one Slack installation share the method cooldown, while a
-- different team using the same Slack app can still make progress.
select mapped.resource_id from slack_event_scope scope
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  scope.installation_id, scope.generation, 'channel', 'C67700002', 0, true) mapped;
create temp table slack_other_team as
select scope.workspace_id, scope.factory_id, installed.installation_id, installed.generation, mapped.resource_id
from slack_event_scope scope
cross join lateral public.configure_slack_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'T67700002', 'Independent Slack team', 'A67700001', 'U67700004', 0, 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA',
  array['app_mentions:read','channels:read','channels:history']) installed
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  installed.installation_id, installed.generation, 'channel', 'C67700003', 0, true) mapped;
select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  scope.installation_id, scope.generation, 'slack', 'T67700002', 'U67700002', 'human') from slack_other_team scope;

select is(pg_temp.enqueue_slack('rate-limit-long', 'mention', 36, 36), 'queued', 'the first worker can claim a same-scope receipt');
create temp table slack_rate_limit_long as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select is(pg_temp.enqueue_slack('rate-limit-short', 'mention', 37, 37), 'queued', 'a second attempt can already be in flight before Slack throttles');
create temp table slack_rate_limit_short as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select is(pg_temp.enqueue_slack('rate-limit-sibling', 'mention', 38, 38, p_channel => 'C67700002'),
  'queued', 'another channel can queue work within the throttled Slack scope');
select is(pg_temp.enqueue_slack('rate-limit-other-team', 'mention', 39, 39,
  p_body => '<@U67700004> Independent work', p_team => 'T67700002', p_channel => 'C67700003'),
  'queued', 'the same Slack app queues independent work in a different team');
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'rate_limited',
  p_retry_after_seconds => 120, p_rate_limited_method => 'conversations.info') from slack_rate_limit_long),
  'retry', 'a provider throttle records the method cooldown and defers the original receipt');
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'rate_limited',
  p_retry_after_seconds => 30, p_rate_limited_method => 'conversations.info') from slack_rate_limit_short),
  'retry', 'an already-owned receipt can report a concurrent provider throttle');
create temp table slack_independent_claim as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select is((select team_id from slack_independent_claim), 'T67700002',
  'another team using the same app remains eligible during the cooldown');
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'unavailable') from slack_independent_claim),
  'membership_denied', 'the independent receipt can settle while the original scope is throttled');
reset role;
select is((select attempt_count from internal.slack_connector_event_receipts where event_id = 'rate-limit-sibling'),
  0, 'a newly due same-scope receipt has spent no attempts during the cooldown');
select ok((select retry_at > clock_timestamp() + interval '90 seconds'
  from internal.slack_connector_event_cooldowns where (team_id, app_id, method) = ('T67700001', 'A67700001', 'conversations.info')),
  'an out-of-order shorter throttle cannot shorten the shared method cooldown');
update internal.slack_connector_event_cooldowns set retry_at = clock_timestamp() - interval '1 second'
where (team_id, app_id, method) = ('T67700001', 'A67700001', 'conversations.info');
set local role service_role;
create temp table slack_rate_limit_last as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select is((select channel_id from slack_rate_limit_last), 'C67700002', 'the unattempted sibling is eligible after cooldown');
reset role;
update internal.slack_connector_event_receipts set attempt_count = 6 where event_id = 'rate-limit-sibling';
set local role service_role;
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'rate_limited',
  p_retry_after_seconds => 60, p_rate_limited_method => 'users.conversations') from slack_rate_limit_last),
  'attempt_limit', 'the last attempt can still report its own method throttle');
reset role;
select ok((select retry_at > clock_timestamp() from internal.slack_connector_event_cooldowns
  where (team_id, app_id, method) = ('T67700001', 'A67700001', 'users.conversations')),
  'the final attempt publishes its provider cooldown before scrubbing the receipt');
update internal.slack_connector_event_cooldowns set retry_at = clock_timestamp() - interval '1 second'
where (team_id, app_id, method) = ('T67700001', 'A67700001', 'users.conversations');
set local role service_role;

select pg_temp.enqueue_slack('cleanup-' || tick, 'deleted', tick, tick + 20, p_actor => null, p_body => null)
from generate_series(41, 49) tick;
select pg_temp.enqueue_slack('cleanup-next-valid', 'deleted', 50, 70, p_actor => null, p_body => null);
reset role;
update internal.slack_connector_event_receipts set deadline_at = clock_timestamp() - interval '1 second',
  next_attempt_at = clock_timestamp() - interval '1 second' where event_id ~ '^cleanup-[0-9]+$';
set local role service_role;
select ok((select kind = 'cleanup' and queue_id is null and encrypted_token is null
  from public.claim_slack_connector_event(pg_temp.op651_id(11))), 'scan-limit cleanup is distinguishable from an empty inbox');
create temp table slack_valid_after_cleanup as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select is((select kind from slack_valid_after_cleanup), 'event', 'the next bounded claim reaches still-valid work');
reset role;
update internal.slack_connector_event_receipts set lease_expires_at = clock_timestamp() - interval '1 second'
where event_id = 'cleanup-next-valid';
set local role service_role;
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'unavailable') from slack_valid_after_cleanup),
  'stale', 'an expired exact lease cannot record terminal denial');
reset role;
update internal.slack_connector_event_receipts set next_attempt_at = clock_timestamp()
where event_id = 'cleanup-next-valid';
set local role service_role;
select is(pg_temp.process_slack('unavailable'), 'membership_denied', 'the same receipt can settle under its new lease');

select is(pg_temp.enqueue_slack('reply-before-late-root', 'created', 52, 52, 51, p_body => 'This root arrives late.'),
  'queued', 'a reply can wait while the root is still absent');
reset role;
update internal.slack_connector_event_receipts set wait_for_root_until = clock_timestamp() - interval '1 second',
  next_attempt_at = clock_timestamp() - interval '1 second' where event_id = 'reply-before-late-root';
set local role service_role;
select is(pg_temp.enqueue_slack('root-after-cutoff', 'mention', 51, 51), 'queued', 'a later root still starts its own session');
select is(pg_temp.process_slack(), 'admitted', 'a root received after the short wait can be admitted independently');
reset role;
select is((select result from internal.slack_connector_event_receipts where event_id = 'reply-before-late-root'),
  'ignored', 'an early reply does not attach to a root whose receipt arrived outside the window');
set local role service_role;

select is(pg_temp.enqueue_slack('expired-event','created',32,32,20,p_body => 'Expired input.'),
  'queued','an authorized event has a bounded original deadline');
reset role;
update internal.slack_connector_event_receipts set deadline_at = clock_timestamp() - interval '1 second'
where event_id = 'expired-event';
set local role service_role;
select is((select count(*) from public.claim_slack_connector_event(pg_temp.op651_id(11))), 0::bigint,
  'expired work cannot hand out encrypted bot access');

select is(pg_temp.enqueue_slack('mapping-revoked','created',33,33,20,p_body => 'Do not apply after disable.'),
  'queued','the event snapshots its original mapping authority');
create temp table slack_disabled_claim as select * from public.claim_slack_connector_event(pg_temp.op651_id(11));
select is(pg_temp.enqueue_slack('prior-mapping-root', 'mention', 34, 34), 'queued',
  'the second pending root is bound to the current mapping revision');
select mapping.revision from slack_event_scope scope
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id,scope.factory_id,pg_temp.op651_id(1),
  scope.installation_id,scope.generation,'channel','C67700001',scope.revision,false) mapping;
select is((select public.settle_slack_connector_event(queue_id,lease_id,'verified',team_id,app_id,channel_id,bot_user_id)
  from slack_disabled_claim),'authority_unavailable','a mapping change after claim fences the whole event');
select is(pg_temp.enqueue_slack('new-disabled-event','mention',34,34), 'ignored',
  'new work is not queued for the disabled mapping');
select mapping.revision from slack_event_scope scope
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id,scope.factory_id,pg_temp.op651_id(1),
  scope.installation_id,scope.generation,'channel','C67700001',scope.revision + 1,true) mapping;
select is(pg_temp.enqueue_slack('root-edit-next-mapping', 'edited', 34, 35, p_body => 'Changed after remapping.'), 'ignored',
  'a pending root from a previous mapping revision cannot authorize a deferred edit');

reset role;
select ok((select result = 'admitted' and session_id is not null and receipt.service_principal_id = scope.service_principal_id
    and receipt.budget_payer_member_id = scope.budget_payer_member_id and receipt.actor_link_id = actor.actor_link_id
  from internal.slack_connector_event_receipts receipt cross join slack_event_scope scope cross join slack_event_actors actor
  where event_id = 'root-mention' and actor.actor_id = 'U67700002'),
  'the durable Slack admission distinguishes the linked human, execution principal and budget payer');
select ok((select count(*) = 1 and bool_and(event.result = 'expired' and event.body is null and event.lease_id is null)
  from internal.slack_connector_event_receipts event where event.event_id = 'expired-event'),
  'expired delivery records its outcome and scrubs retained content');
select ok(not exists (select 1 from internal.slack_connector_event_receipts event
  where event.result is not null and (event.body is not null or event.lease_id is not null)),
  'all completed, denied or stale receipts scrub pending content and leases');
select ok((select version.deleted and version.version_ts = pg_temp.slack_ts(25)
  from internal.slack_connector_message_versions version where version.message_ts = pg_temp.slack_ts(22)),
  'the exact deleted message version survives its receipt and prevents resurrection');

select * from finish();
rollback;
