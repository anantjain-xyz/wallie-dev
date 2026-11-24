begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(72);

\set op651_fixture_namespace 67900000
\ir fixtures/factory_automation_dry_run.psql
\ir fixtures/factory_workflow_checkpoint_evidence.psql

create temp table slack_outbound_scope as
select scope.*, installed.installation_id, installed.generation, mapped.resource_id, mapped.revision
from op651_scope scope
cross join lateral public.configure_slack_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'T67900001', 'Slack delivery fixture', 'A67900001', 'U67900001', 0, 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA',
  array['app_mentions:read','chat:write','channels:read','channels:history','groups:read','groups:history']) installed
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  installed.installation_id, installed.generation, 'channel', 'C67900001', 0, true) mapped;

select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), scope.installation_id,
  scope.generation, 'slack', 'T67900001', 'U67900002', 'human') from slack_outbound_scope scope \gset

grant select on slack_outbound_scope to service_role;
set local role service_role;

select is(public.enqueue_slack_connector_event('T67900001', 'A67900001', 'C67900001', 'Ev67900001', 'mention',
  '1732400000.000050', '1732400000.000050', '1732400000.000050', 'U67900002', '<@U67900001> Run the fixture.'),
  'queued', 'the exact captured Slack request is queued');
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'verified', team_id, app_id, channel_id, bot_user_id)
  from public.claim_slack_connector_event(pg_temp.op651_id(11))), 'admitted', 'linked request creates one durable source');
create temp table slack_send_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select count(*) = 1 and bool_and(provider = 'slack' and external_resource_id = 'C67900001'
  and external_thread_id = '1732400000.000050' and content->>'kind' = 'progress') from slack_send_claim),
  'the accepted notice is claimed for the exact linked thread');
select is((select count(*) from slack_send_claim c cross join lateral public.resolve_slack_connector_delivery(c.delivery_id, c.lease_id)),
  0::bigint, 'an unconfirmed lease cannot reveal the Slack credential');
select ok((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from slack_send_claim),
  'the shared outbox confirms the first write lease');
create temp table slack_original_write as
select c.delivery_id, c.lease_id, resolved.* from slack_send_claim c
cross join lateral public.resolve_slack_connector_delivery(c.delivery_id, c.lease_id) resolved;
select ok((select count(*) = 1 and bool_and(team_id = 'T67900001' and app_id = 'A67900001'
  and channel_id = 'C67900001' and bot_user_id = 'U67900001'
  and thread_ts = '1732400000.000050' and encrypted_token = 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA'
  and original_write_authorized_at is not null and deadline_at > original_write_authorized_at) from slack_original_write),
  'exact authorized transport has encrypted credentials and a fixed scope and deadline');
select is((select count(*) from slack_send_claim c cross join lateral public.resolve_slack_connector_delivery(c.delivery_id, gen_random_uuid())),
  0::bigint, 'a different lease cannot resolve Slack transport');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'uncertain') from slack_send_claim),
  'the first write can settle as uncertain');

reset role;
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp()
where id = (select delivery_id from slack_send_claim);
set local role service_role;

create temp table slack_observe_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select count(*) = 1 and bool_and(kind = 'observing') from slack_observe_claim),
  'unknown Slack result is observed before another write');
select ok((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from slack_observe_claim),
  'observation has a fresh exact lease');
select ok((select count(*) = 1 and bool_and((resolved.original_write_authorized_at, resolved.deadline_at, resolved.thread_ts)
  = (first.original_write_authorized_at, first.deadline_at, first.thread_ts))
  from slack_observe_claim c cross join lateral public.resolve_slack_connector_delivery(c.delivery_id, c.lease_id) resolved
  join slack_original_write first using (delivery_id)), 'observation preserves the exact original write time, deadline, and thread');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'found', '1732400000.000051') from slack_observe_claim),
  'the authoritative observation settles the original provider reply');

reset role;
select ok((select count(*) = 1 and bool_and(status = 'delivered' and send_attempts = 1 and observation_attempts = 1
  and provider_reply_id = '1732400000.000051') from internal.connector_outbound_deliveries
  where id = (select delivery_id from slack_send_claim)), 'a recovered message yields exactly one accepted write');
select is((select count(*) from internal.connector_outbound_attempts where delivery_id = (select delivery_id from slack_send_claim)),
  2::bigint, 'the audit history keeps both send and observe receipts');

set local role service_role;
select ok((select history->'deliveries' @> '[{"kind":"slack_ingress","status":"admitted"}]'
  and history->'deliveries' @> '[{"kind":"outbound","status":"delivered"}]'
  and history::text !~ 'encrypted_token|bot_user_id|Fixture request|QQ.AAAAA'
  from (select public.list_factory_connector_deliveries(workspace_id, factory_id, pg_temp.op651_id(1), resource_id) history
    from slack_outbound_scope) scoped), 'manager diagnostics expose redacted Slack ingress and outbound status');
reset role;
select public.set_git_continuity_release(true, revision, 'Slack outbound review fixture')
from public.get_git_continuity_release_state() where not enabled;
select pg_temp.adopt_source_checkpoint(session.id, job.id)
from public.sessions session join public.agent_jobs job on job.session_id = session.id and job.status = 'queued'
where session.id = (select session_id from slack_original_write);
create temp table queued_slack_review as
select id, session_id, deadline_at from internal.connector_outbound_deliveries
where session_id = (select session_id from slack_original_write) and content->>'kind' = 'review_ready';
grant select on queued_slack_review to service_role;
set local role service_role;
select archived.* from queued_slack_review card cross join lateral public.archive_session_job_attempts(
  card.session_id, (select workspace_id from slack_outbound_scope), 'Archive before Slack delivery') archived;
select is((select count(*) from public.claim_connector_outbound_delivery('slack')),
  0::bigint, 'an archived unsent Slack review stays unclaimed');
reset role;
select ok((select delivery.status = 'queued' and delivery.send_attempts = 0
  and delivery.deadline_at = card.deadline_at from queued_slack_review card
  join internal.connector_outbound_deliveries delivery on delivery.id = card.id),
  'pausing a queued review preserves its exact deadline and all send attempts');
update public.sessions set archived_at = null where id = (select session_id from queued_slack_review);
set local role service_role;
create temp table archiving_card_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select claim.delivery_id = card.id and public.confirm_connector_outbound_authority(claim.delivery_id, claim.lease_id)
  from archiving_card_claim claim cross join queued_slack_review card),
  'restoring the review makes the same Slack card eligible again');
select archived.* from queued_slack_review card cross join lateral public.archive_session_job_attempts(
  card.session_id, (select workspace_id from slack_outbound_scope), 'Archive after claiming Slack delivery') archived;
select ok((select resolved.review_paused and not resolved.superseded and resolved.action_target_id is null
  from archiving_card_claim claim
  cross join lateral public.resolve_slack_connector_delivery(claim.delivery_id, claim.lease_id) resolved),
  'a lease held at archive time resolves as paused without reserving a card');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'not_sent')
  from archiving_card_claim), 'an owned Slack lease can settle definitively without writing while archived');
reset role;
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp()
where id = (select id from queued_slack_review);
set local role service_role;
select is((select count(*) from public.claim_connector_outbound_delivery('slack')),
  0::bigint, 'the archived review does not consume a second attempt');
reset role;
update public.sessions set archived_at = null where id = (select session_id from queued_slack_review);
set local role service_role;

create temp table live_card_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select claim.delivery_id = card.id and claim.content->>'kind' = 'review_ready'
  and public.confirm_connector_outbound_authority(claim.delivery_id, claim.lease_id)
  from live_card_claim claim cross join queued_slack_review card),
  'the original Slack delivery remains eligible after restoring the review again');
create temp table live_card as
select claim.delivery_id, claim.lease_id, resolved.* from live_card_claim claim
cross join lateral public.resolve_slack_connector_delivery(claim.delivery_id, claim.lease_id) resolved;
select ok((select card.action_target_id is not null and not card.superseded and card.review_revision = session.artifact_review_revision
  from live_card card join public.sessions session on session.id = card.session_id),
  'the send creates an opaque action target for the exact adopted review');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'not_sent') from live_card),
  'the original card target remains when its send definitively did not start');
reset role;
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp()
where id = (select delivery_id from live_card);
set local role service_role;

create temp table retry_card_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select retry.delivery_id = card.delivery_id and retry.lease_id <> card.lease_id
  and public.confirm_connector_outbound_authority(retry.delivery_id, retry.lease_id) from retry_card_claim retry cross join live_card card),
  'the same card receives an authorized retry lease after a definite no-write result');
select ok((select resolved.action_target_id = card.action_target_id and not resolved.superseded
  from retry_card_claim retry cross join live_card card
  cross join lateral public.resolve_slack_connector_delivery(retry.delivery_id, retry.lease_id) resolved),
  'a new lease can reuse the exact card when the review is unchanged');
reset role;
select is((select association.reserving_lease_id from internal.slack_connector_notice_actions association
  where association.delivery_id = (select delivery_id from retry_card_claim)), (select lease_id from retry_card_claim),
  'the retry reserves its action target even when the existing target can be reused');
update public.sessions set artifact_review_revision = artifact_review_revision + 1
where id = (select session_id from slack_original_write);
set local role service_role;
select ok((select resolved.action_target_id = card.action_target_id and resolved.superseded
  from retry_card_claim retry cross join live_card card
  cross join lateral public.resolve_slack_connector_delivery(retry.delivery_id, retry.lease_id) resolved),
  'an intervening review change fences the existing lease without swapping its rendered target');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'not_sent') from retry_card_claim),
  'the fenced retry has a definitive no-write result');
reset role;
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp()
where id = (select delivery_id from retry_card_claim);
set local role service_role;

create temp table refreshed_card_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select retry.delivery_id = old.delivery_id and retry.lease_id <> old.lease_id
  and public.confirm_connector_outbound_authority(retry.delivery_id, retry.lease_id)
  from refreshed_card_claim retry cross join retry_card_claim old), 'another sending lease can reserve the current revision');
create temp table refreshed_card as
select claim.delivery_id, claim.lease_id, resolved.* from refreshed_card_claim claim
cross join lateral public.resolve_slack_connector_delivery(claim.delivery_id, claim.lease_id) resolved;
select ok((select refreshed.action_target_id <> original.action_target_id and not refreshed.superseded
  and refreshed.review_revision = original.review_revision + 1
  and (refreshed.channel_id, refreshed.thread_ts, refreshed.session_id, refreshed.deadline_at) =
    (original.channel_id, original.thread_ts, original.session_id, original.deadline_at)
  from refreshed_card refreshed cross join live_card original),
  'the safe new lease refreshes the same-artifact card without changing its destination or deadline');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'uncertain') from refreshed_card),
  'a lost Slack review send response recovers by observation');
reset role;
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp()
where id = (select delivery_id from refreshed_card);
set local role service_role;
select archived.* from queued_slack_review card cross join lateral public.archive_session_job_attempts(
  card.session_id, (select workspace_id from slack_outbound_scope), 'Archive while Slack delivery is uncertain') archived;
create temp table observed_card_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select kind = 'observing' and public.confirm_connector_outbound_authority(delivery_id, lease_id)
  from observed_card_claim), 'the uncertain review card still receives an observation lease while archived');
create temp table observed_card as
select claim.delivery_id, claim.lease_id, resolved.* from observed_card_claim claim
cross join lateral public.resolve_slack_connector_delivery(claim.delivery_id, claim.lease_id) resolved;
select ok((select observed.review_paused and observed.action_target_id = original.action_target_id
  and (observed.team_id, observed.app_id, observed.channel_id, observed.thread_ts) =
    (original.team_id, original.app_id, original.channel_id, original.thread_ts)
  from observed_card observed join refreshed_card original using (delivery_id)),
  'observation retains the original action ID and scope for the rendered card while archived');
select ok((select public.register_slack_review_card(action_target_id, team_id, app_id, channel_id, thread_ts, '1732400000.000052')
  from observed_card), 'a recovered exact provider message binds the original review card');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'found', '1732400000.000052')
  from observed_card), 'the outbox retains the observed card as its exact delivered reply');
reset role;
select is((select count(*) from internal.connector_outbound_deliveries edit
  where edit.edited_delivery_id = (select delivery_id from observed_card)), 0::bigint,
  'settling a card while its unchanged review is archived leaves the card intact');
update public.sessions set archived_at = null where id = (select session_id from observed_card);
set local role service_role;
select archived.* from observed_card card cross join lateral public.archive_session_job_attempts(
  card.session_id, (select workspace_id from slack_outbound_scope), 'Archive after Slack delivery') archived;
select is((select public.queue_slack_review_action('approve', action_target_id, team_id, app_id, 'U67900002',
  'approve:1732400000.000056', channel_id, '1732400000.000052') from observed_card), 'stale',
  'an archived review card cannot authorize a Slack approval');
reset role;
update public.sessions set archived_at = null where id = (select session_id from observed_card);
select is((select count(*) from internal.connector_outbound_deliveries edit
  where edit.edited_delivery_id = (select delivery_id from observed_card)), 0::bigint,
  'archiving and restoring the unchanged review keeps the original Slack card intact');
set local role service_role;
select is((select public.queue_slack_review_action('approve', action_target_id, team_id, app_id, 'U67900002',
  'approve:1732400000.000053', channel_id, '1732400000.000052') from observed_card), 'queued',
  'the original observed Slack review card can queue exact approval after restore');
select is((select public.complete_slack_review_action(action_id, lease_id, 'codex', 'gpt-5.5', 'code')
  from public.claim_slack_review_action(pg_temp.op651_id(11))), 'applied',
  'the outbound card reaches the authoritative Wallie stage decision as the linked human');
create temp table closed_card_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select content->>'kind' = 'card_closed' and operation = 'edit' and edit_target = '1732400000.000052'
  and public.confirm_connector_outbound_authority(delivery_id, lease_id) from closed_card_claim),
  'the canonical approval queues an edit for the exact delivered card');
select ok((select resolved.previous_correlation_id = original.delivery_id
  from closed_card_claim claim cross join lateral public.resolve_slack_connector_delivery(claim.delivery_id, claim.lease_id) resolved
  cross join observed_card original), 'the edit can verify the original provider message correlation');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', '1732400000.000052')
  from closed_card_claim), 'closing the original provider card settles the edit');
create temp table approved_notice_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select content->>'kind' = 'outcome' and public.confirm_connector_outbound_authority(delivery_id, lease_id)
  from approved_notice_claim), 'a final approved checkpoint sends one separate outcome');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', '1732400000.000054')
  from approved_notice_claim), 'the final outcome retains its provider message identity');

reset role;
create temp table slack_question_fixture as
select scope.*, created.* from slack_outbound_scope scope
cross join lateral public.create_session_command_once(scope.workspace_id, pg_temp.op651_id(21), pg_temp.op651_id(112), repeat('a', 64),
  (select encode(sha256(convert_to(revision.body, 'UTF8')), 'hex') from scoped_revisions revision where scenario = 'root'),
  'Slack specification fixture', 'Draft the scoped fixture.', 'codex', 'gpt-5.5', '{}',
  selected_stage_ids => array[pg_temp.op651_id(32)], target_factory_id => scope.factory_id, draft_specification => true) created;
select source.id from slack_question_fixture fixture cross join lateral public.bind_session_conversation_source_once(
  fixture.workspace_id, fixture.factory_id, fixture.session_id, pg_temp.op651_id(21), 'slack', fixture.resource_id::text,
  '1732400000.000070', 'Slack', 'https://app.slack.com/archives/C67900001/p1732400000000070') source;
create function pg_temp.publish_slack_outbound_question(p_job_id uuid) returns boolean language plpgsql as $$
declare
  started uuid;
  lease uuid;
  markdown text := '<!-- wallie-clarification: {"question":"What deadline applies?"} -->' || E'\n\n# Draft specification';
begin
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = p_job_id and status = 'queued';
  started := public.start_session_job_attempt(p_job_id, 1, pg_temp.op651_id(32), 0,
    'codex', 'gpt-5.5', 'code', 'wallie/op679-spec-' || p_job_id);
  perform public.pin_session_job_git_input(p_job_id, 1, started, pg_temp.op651_id(34), 'main', repeat('a', 40));
  if not public.prepare_session_source_and_checkpoint_publication(started, pg_temp.op651_id(34), 'main',
    repeat('a', 40), repeat('a', 40), 'Fixture specification', 'Exact Slack review', '', '', '', 0, markdown) then
    return false;
  end if;
  lease := public.claim_session_checkpoint_publication(started);
  return public.adopt_session_checkpoint_publication(started, lease);
end;
$$;
select ok((select pg_temp.publish_slack_outbound_question(job_id) from slack_question_fixture),
  'a normal specification checkpoint publishes its actual pending question');
set local role service_role;
create temp table question_accepted as select * from public.claim_connector_outbound_delivery('slack');
select ok((select content->>'kind' = 'progress' and public.confirm_connector_outbound_authority(delivery_id, lease_id)
  from question_accepted), 'the specification source has one accepted notice');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', '1732400000.000071')
  from question_accepted), 'the accepted notice can settle before the question is sent');
create temp table suppressed_review_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select content->>'kind' = 'review_ready' and public.confirm_connector_outbound_authority(delivery_id, lease_id)
  from suppressed_review_claim), 'the generic review notice is checked against current clarification authority');
select ok((select resolved.superseded and resolved.action_target_id is null
  from suppressed_review_claim claim cross join lateral public.resolve_slack_connector_delivery(claim.delivery_id, claim.lease_id) resolved),
  'a pending question suppresses the approval card for the same artifact');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'rejected') from suppressed_review_claim),
  'the superseded approval notice can settle without sending');
create temp table question_notice_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select content->>'kind' = 'clarification' and public.confirm_connector_outbound_authority(delivery_id, lease_id)
  from question_notice_claim), 'the pending question receives its own exact Slack delivery');
create temp table question_notice as
select claim.delivery_id, claim.lease_id, claim.content, resolved.* from question_notice_claim claim
cross join lateral public.resolve_slack_connector_delivery(claim.delivery_id, claim.lease_id) resolved;
select ok((select action_target_id is not null and not superseded and thread_ts = '1732400000.000070' and exists (
  select 1 from public.session_specification_clarifications question where question.session_id = notice.session_id
  and question.status = 'pending' and question.id::text = notice.content#>>'{reviewTarget,clarificationId}')
  from question_notice notice), 'the review action targets the exact real pending clarification and its distinct source thread');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'uncertain')
  from question_notice), 'a question card received by Slack can still lose its write response');
reset role;
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp()
where id = (select delivery_id from question_notice);
set local role service_role;
create temp table observed_question_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select claim.delivery_id = notice.delivery_id and claim.kind = 'observing'
  and public.confirm_connector_outbound_authority(claim.delivery_id, claim.lease_id)
  from observed_question_claim claim cross join question_notice notice),
  'the question card can be observed after an uncertain write');
select ok((select public.register_slack_review_card(resolved.action_target_id, resolved.team_id, resolved.app_id,
  resolved.channel_id, resolved.thread_ts, '1732400000.000072') from observed_question_claim claim
  cross join lateral public.resolve_slack_connector_delivery(claim.delivery_id, claim.lease_id) resolved),
  'the observed question reply becomes actionable before its outbox settlement');
create temp table question_modal as
select modal.* from question_notice notice cross join lateral public.prepare_slack_clarification_modal(
  notice.action_target_id, notice.team_id, notice.app_id, 'U67900002', notice.channel_id, '1732400000.000072') modal;
select ok((select public.register_slack_clarification_view(modal_context_id, 'V67900001') from question_modal),
  'the exact delivered question card opens the linked human’s modal');
select is((select public.queue_slack_review_action('answer', modal_context_id, 'T67900001', 'A67900001',
  'U67900002', 'answer:V67900001', p_view_id => 'V67900001', p_answer => 'Friday.') from question_modal), 'queued',
  'the real question card can deliver the exact linked human’s answer');
select is((select public.complete_slack_review_action(action_id, lease_id, 'codex', 'gpt-5.5', 'code')
  from public.claim_slack_review_action(pg_temp.op651_id(11))), 'applied',
  'the authoritative clarification accepts the answer and schedules the next Wallie attempt');
reset role;
select is((select count(*) from internal.connector_outbound_deliveries edit
  where edit.edited_delivery_id = (select delivery_id from question_notice)), 0::bigint,
  'the answer cannot close a question card before its provider message is settled');
set local role service_role;
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'found', '1732400000.000072')
  from observed_question_claim), 'the observer settles the already-answered question card');
reset role;
select is((select count(*) from internal.connector_outbound_deliveries edit
  where edit.edited_delivery_id = (select delivery_id from question_notice)), 1::bigint,
  'settling the observed card captures exactly one missed closure');
set local role service_role;
create temp table answered_card_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select content->>'kind' = 'card_closed' and edit_target = '1732400000.000072'
  and public.confirm_connector_outbound_authority(delivery_id, lease_id) from answered_card_claim),
  'answering the clarification closes only its exact delivered question card');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', '1732400000.000072')
  from answered_card_claim), 'the closed question retains its original Slack identity');

select is(public.enqueue_slack_connector_event('T67900001','A67900001','C67900001','Ev67900002','deleted',
  '1732400000.000050','1732400000.000060'), 'queued', 'the provider can report a bare deleted thread');
select is((select public.settle_slack_connector_event(queue_id, lease_id, 'verified', team_id, app_id, channel_id, bot_user_id)
  from public.claim_slack_connector_event(pg_temp.op651_id(11))), 'deleted', 'the exact source deletion is retained');

reset role;
select internal.queue_slack_connector_notice(existing, 'slack:deleted-source-proof', 'outcome', 'Done.')
from public.sessions existing where existing.id = (select session_id from slack_original_write);
set local role service_role;
create temp table slack_deleted_claim as select * from public.claim_connector_outbound_delivery('slack');
select ok((select public.confirm_connector_outbound_authority(delivery_id,lease_id) from slack_deleted_claim),
  'the common authority still owns the linked resource');
select is((select count(*) from slack_deleted_claim c cross join lateral public.resolve_slack_connector_delivery(c.delivery_id,c.lease_id)),
  0::bigint, 'a deleted Slack root never grants provider credentials for a reply');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'credential_unavailable')
  from slack_deleted_claim), 'the unavailable provider thread remains a durable delivery failure');
select ok((select history->'deliveries' @> jsonb_build_array(jsonb_build_object('id', claim.delivery_id,
    'kind', 'outbound', 'status', 'blocked', 'reason', 'credential_unavailable'))
  from slack_deleted_claim claim cross join slack_outbound_scope scope
  cross join lateral (select public.list_factory_connector_deliveries(scope.workspace_id, scope.factory_id,
    pg_temp.op651_id(1), scope.resource_id) as history) diagnostics),
  'factory diagnostics show the exact blocked reply without exposing the Slack credential');
select is((select session.phase_status::text from public.sessions session where id = (select session_id from slack_original_write)),
  'approved', 'unavailable Slack transport leaves the canonical Wallie decision intact');

select * from finish();
rollback;
