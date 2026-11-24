begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(66);

\set op651_fixture_namespace 67800000
\ir fixtures/factory_automation_dry_run.psql
\ir fixtures/factory_workflow_checkpoint_evidence.psql

create temp table slack_review_scope as
select scope.*, installed.installation_id, installed.generation, mapped.resource_id, mapped.revision
from op651_scope scope
cross join lateral public.configure_slack_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'T67800001', 'Slack review fixture', 'A67800001', 'U67800001', 0,
  'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA', array['channels:read', 'chat:write']) installed
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  installed.installation_id, installed.generation, 'channel', 'C67800001', 0, true) mapped;
create temp table slack_review_links as
select fixture.actor_id, public.link_connector_actor(scope.workspace_id, scope.factory_id, fixture.user_id,
  scope.installation_id, scope.generation, 'slack', 'T67800001', fixture.actor_id, 'human') as actor_link_id
from slack_review_scope scope cross join (
  values (pg_temp.op651_id(1), 'U67800002'), (pg_temp.op651_id(2), 'U67800003')
) fixture(user_id, actor_id);

create function pg_temp.review_ts(tick integer) returns text language sql immutable strict as $$
  select '1732400000.' || lpad(tick::text, 6, '0')
$$;
create temp table slack_reviews as
select fixture.scenario, fixture.thread_tick, fixture.drafting, scope.resource_id, scope.workspace_id, scope.factory_id, created.*
from slack_review_scope scope
cross join (values ('approval', 120, false), ('wallie-wins', 130, false), ('revoked', 140, false),
  ('clarification', 150, true), ('expired', 160, true)) fixture(scenario, thread_tick, drafting)
cross join lateral public.create_session_command_once(scope.workspace_id, pg_temp.op651_id(21),
  pg_temp.op651_id(fixture.thread_tick), repeat('a', 64),
  (select encode(sha256(convert_to(revision.body, 'UTF8')), 'hex') from scoped_revisions revision where scenario = 'root'),
  'Slack review ' || fixture.scenario, 'Review the scoped fixture.', 'codex', 'gpt-5.5', '{}',
  selected_stage_ids => array[pg_temp.op651_id(32)], target_factory_id => scope.factory_id,
  draft_specification => fixture.drafting) created;

select bound.id as bound_source from slack_reviews fixture
cross join lateral public.bind_session_conversation_source_once(fixture.workspace_id, fixture.factory_id, fixture.session_id,
  pg_temp.op651_id(21), 'slack', fixture.resource_id::text, pg_temp.review_ts(fixture.thread_tick), 'Slack',
  'https://app.slack.com/archives/C67800001/p' || replace(pg_temp.review_ts(fixture.thread_tick), '.', '')) bound;

select public.set_git_continuity_release(true, revision, 'Slack review fixture')
from public.get_git_continuity_release_state() where not enabled;

select pg_temp.adopt_source_checkpoint(fixture.session_id, fixture.job_id)
from slack_reviews fixture where not fixture.drafting;
create function pg_temp.publish_slack_question(p_session_id uuid, p_job_id uuid) returns uuid language plpgsql as $$
declare
  started uuid;
  lease uuid;
  markdown text := '<!-- wallie-clarification: {"question":"What deadline applies?"} -->' || E'\n\n# Draft specification';
begin
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = p_job_id and status = 'queued';
  started := public.start_session_job_attempt(p_job_id, 1, pg_temp.op651_id(32), 0,
    'codex', 'gpt-5.5', 'code', 'wallie/op678-spec-' || p_job_id);
  perform public.pin_session_job_git_input(p_job_id, 1, started, pg_temp.op651_id(34), 'main', repeat('a', 40));
  if not public.prepare_session_source_and_checkpoint_publication(started, pg_temp.op651_id(34), 'main',
    repeat('a', 40), repeat('a', 40), 'Fixture specification', 'Exact Slack review', '', '', '', 0, markdown) then
    raise exception 'The exact specification could not be prepared.';
  end if;
  lease := public.claim_session_checkpoint_publication(started);
  if not public.adopt_session_checkpoint_publication(started, lease) then
    raise exception 'The exact specification could not be adopted.';
  end if;
  return (select id from public.session_specification_clarifications where session_id = p_session_id and status = 'pending');
end;
$$;
select pg_temp.publish_slack_question(fixture.session_id, fixture.job_id) from slack_reviews fixture where fixture.drafting;

create temp table slack_exact as
select fixture.*, session.current_stage_id as stage_id, session.current_artifact_id as artifact_id,
  session.current_artifact_version as artifact_version, session.artifact_review_revision as review_revision,
  question.id as clarification_id
from slack_reviews fixture join public.sessions session on session.id = fixture.session_id
left join public.session_specification_clarifications question on question.session_id = fixture.session_id;
grant select on slack_exact, slack_review_scope, slack_review_links to service_role;
set local role service_role;

create function pg_temp.slack_create_target(p_scenario text, p_revision_offset integer default 0)
returns uuid language sql as $$
  select public.create_slack_review_target(fixture.workspace_id, fixture.factory_id, fixture.resource_id, fixture.session_id,
    fixture.stage_id, fixture.artifact_id, fixture.artifact_version, fixture.review_revision + p_revision_offset,
    fixture.clarification_id) from slack_exact fixture where fixture.scenario = p_scenario
$$;
create temp table slack_cards as
select fixture.*, pg_temp.slack_create_target(fixture.scenario) as target_id
from slack_exact fixture;

create function pg_temp.slack_bind_card(p_scenario text, p_message_offset integer default 1, p_channel text default 'C67800001')
returns boolean language sql as $$
  select public.register_slack_review_card(card.target_id, 'T67800001', 'A67800001', p_channel,
    pg_temp.review_ts(card.thread_tick), pg_temp.review_ts(card.thread_tick + p_message_offset))
  from slack_cards card where card.scenario = p_scenario
$$;
create function pg_temp.slack_approve(
  p_scenario text, p_action_ts integer, p_actor text default 'U67800002', p_message_offset integer default 1,
  p_thread_offset integer default null, p_team text default 'T67800001', p_app text default 'A67800001',
  p_channel text default 'C67800001'
) returns text language sql as $$
  select public.queue_slack_review_action('approve', card.target_id, p_team, p_app, p_actor,
    'approve:' || pg_temp.review_ts(p_action_ts), p_channel, pg_temp.review_ts(card.thread_tick + p_message_offset),
    pg_temp.review_ts(card.thread_tick + p_thread_offset))
  from slack_cards card where card.scenario = p_scenario
$$;
create function pg_temp.slack_prepare(p_scenario text, p_actor text default 'U67800003', p_message_offset integer default 1)
returns table(modal_context_id uuid, encrypted_token text) language sql as $$
  select context.* from slack_cards card
  cross join lateral public.prepare_slack_clarification_modal(card.target_id, 'T67800001', 'A67800001', p_actor,
    'C67800001', pg_temp.review_ts(card.thread_tick + p_message_offset)) context
  where card.scenario = p_scenario
$$;
create function pg_temp.slack_answer(p_context uuid, p_view text, p_answer text, p_actor text default 'U67800003')
returns text language sql as $$
  select public.queue_slack_review_action('answer', p_context, 'T67800001', 'A67800001', p_actor,
    'answer:' || p_view, p_view_id => p_view, p_answer => p_answer)
$$;

select ok(has_function_privilege('service_role', 'public.claim_slack_review_action(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.queue_slack_review_action(text,uuid,text,text,text,text,text,text,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.prepare_slack_clarification_modal(uuid,text,text,text,text,text,text)', 'execute')
  and not has_table_privilege('service_role', 'internal.slack_review_targets', 'select')
  and not has_table_privilege('service_role', 'internal.slack_review_actions', 'select')
  and not has_table_privilege('service_role', 'internal.slack_clarification_modal_contexts', 'select'),
  'only explicit service commands expose Slack review scope or credential data');
select ok((select count(*) = 5 and bool_and(target_id is not null) from slack_cards),
  'each current artifact is discoverable only through its retained Slack source');
select is(pg_temp.slack_create_target('approval'), (select target_id from slack_cards where scenario = 'approval'),
  'the exact review tuple reuses its opaque ID across attempts');
select throws_ok($$select pg_temp.slack_create_target('approval', 1)$$, 'PT409', null,
  'a stale review revision cannot register a new decision target');
select throws_ok($$select public.create_slack_review_target(fixture.workspace_id, gen_random_uuid(), fixture.resource_id,
    fixture.session_id, fixture.stage_id, fixture.artifact_id, fixture.artifact_version, fixture.review_revision)
  from slack_exact fixture where fixture.scenario = 'approval'$$, 'P0002', null,
  'a mapping from another factory cannot register the session target');
select throws_ok($$select public.create_slack_review_target(fixture.workspace_id, fixture.factory_id, fixture.resource_id,
    fixture.session_id, fixture.stage_id, fixture.artifact_id, fixture.artifact_version, fixture.review_revision)
  from slack_exact fixture where fixture.scenario = 'clarification'$$, 'PT409', null,
  'a pending question cannot be represented by an approval target');

select is(pg_temp.slack_approve('approval', 220), 'denied', 'an opaque ID without a confirmed original Slack card grants no authority');
select is(pg_temp.slack_bind_card('approval', p_channel => 'C67800002'), false, 'a provider result from another channel cannot bind this card');
select is(pg_temp.slack_bind_card('approval', 0), false, 'the human source root is never the confirmed card reply');
select is(pg_temp.slack_bind_card('approval'), true, 'the exact confirmed provider reply binds the actionable card');
select is(pg_temp.slack_bind_card('approval'), true, 'observing the same write after a lost response can bind idempotently');
select is(pg_temp.slack_bind_card('approval', 2), false, 'a different reply cannot replace the registered card');
select is(pg_temp.slack_approve('approval', 220, p_message_offset => 2), 'denied', 'a copied opaque ID in a different message is denied');
select is(pg_temp.slack_approve('approval', 220, p_thread_offset => 1), 'denied', 'a signed but conflicting thread timestamp is denied');
select is(pg_temp.slack_approve('approval', 220, p_team => 'T67800002'), 'denied', 'another team cannot replay the card');
select is(pg_temp.slack_approve('approval', 220, p_app => 'A67800002'), 'denied', 'another app cannot replay the card');
select is(pg_temp.slack_approve('approval', 220, p_actor => 'U67800001'), 'denied', 'the app bot cannot approve');
select is(pg_temp.slack_approve('approval', 220, p_actor => 'U67800009'), 'denied', 'an unlinked human cannot approve');
select is(pg_temp.slack_approve('approval', 220, p_actor => 'U67800003'), 'denied', 'a mapped ordinary member cannot bypass the pinned stage approvers');
select is(pg_temp.slack_approve('approval', 220), 'queued', 'an exact registered card works when Slack omits the redundant thread timestamp');
select is(pg_temp.slack_approve('approval', 220, p_thread_offset => 0), 'replayed', 'the equivalent signed action with thread provenance replays');
select is((select count(*) from public.claim_slack_review_action(gen_random_uuid())), 0::bigint,
  'a scoped worker cannot claim another workspace action');
create temp table approval_claim as select * from public.claim_slack_review_action(pg_temp.op651_id(11));
select ok((select count(*) = 1 and bool_and(claim.action = 'approve' and claim.session_id = card.session_id
    and not (to_jsonb(claim) ?| array['answer', 'actor_id', 'encrypted_token']))
  from approval_claim claim cross join slack_cards card where card.scenario = 'approval'),
  'worker claims carry the exact operation and session with no raw actor, token or answer');
select is((select count(*) from public.claim_slack_review_action(pg_temp.op651_id(11))), 0::bigint,
  'a live lease cannot be claimed twice');
select is((select public.complete_slack_review_action(action_id, gen_random_uuid(), 'codex', 'gpt-5.5', 'code') from approval_claim),
  'stale', 'the action worker must present the exact live lease');
select is((select public.complete_slack_review_action(action_id, lease_id, 'codex', 'gpt-5.5', 'code') from approval_claim),
  'applied', 'Slack approval invokes the authoritative Wallie decision');
select is(pg_temp.slack_approve('approval', 220), 'replayed', 'provider replay after a committed approval does not create another decision');
select is(pg_temp.slack_approve('approval', 221), 'stale', 'a different click cannot approve the artifact after state advances');
select ok((select count(*) = 1 and bool_and((receipt.stage_id, receipt.artifact_id, receipt.artifact_version,
      receipt.approved_by_member_id) = (card.stage_id, card.artifact_id, card.artifact_version, pg_temp.op651_id(21)))
    from public.session_stage_approval_receipts receipt join slack_cards card on card.session_id = receipt.session_id
    where card.scenario = 'approval'), 'Wallie records the exact approved artifact and linked human member once');

select ok(pg_temp.slack_bind_card('wallie-wins'), 'the second session also binds its exact card');
select is(pg_temp.slack_approve('wallie-wins', 230), 'queued', 'Slack queues while the review is still current');
create temp table stale_claim as select * from public.claim_slack_review_action(pg_temp.op651_id(11));
select ok((select accepted.id is not null from slack_cards card cross join lateral public.approve_session_stage(
  card.session_id, card.workspace_id, card.stage_id, card.artifact_id, card.artifact_version, pg_temp.op651_id(21),
  'codex', 'gpt-5.5', 'code', card.review_revision) accepted where card.scenario = 'wallie-wins'),
  'Wallie can win the decision before the leased Slack action settles');
select is((select public.complete_slack_review_action(action_id, lease_id, 'codex', 'gpt-5.5', 'code') from stale_claim),
  'stale', 'the queued Slack action cannot repeat the decision after Wallie wins');
select is((select count(*) from public.session_stage_approval_receipts receipt join slack_cards card on card.session_id = receipt.session_id
  where card.scenario = 'wallie-wins'), 1::bigint, 'both surfaces share exactly one canonical approval receipt');

select ok(pg_temp.slack_bind_card('clarification'), 'the exact pending question has a separately registered reply');
select is(pg_temp.slack_approve('clarification', 250, p_thread_offset => 0), 'denied', 'an answer card cannot approve a draft');
select is((select count(*) from pg_temp.slack_prepare('clarification', p_message_offset => 2)), 0::bigint,
  'a copied question identifier cannot open a modal from another provider reply');
select is((select count(*) from pg_temp.slack_prepare('clarification', 'U67800009')), 0::bigint,
  'an unlinked Slack human cannot obtain a modal context or bot credential');
create temp table clarification_modal as select * from pg_temp.slack_prepare('clarification');
select ok((select count(*) = 1 and bool_and(modal_context_id is not null
    and encrypted_token = 'v2.AAAAAAAAAAAAAAAA.QQ.AAAAAAAAAAAAAAAAAAAAAA') from clarification_modal),
  'an authorized scoped member can open a question even when they are not a stage approver');
select is((select pg_temp.slack_answer(modal_context_id, 'V67800001', 'Friday.') from clarification_modal), 'denied',
  'a modal context cannot submit until the exact Slack view is registered');
select is((select public.register_slack_clarification_view(modal_context_id, 'V67800001') from clarification_modal), true,
  'the returned Slack view ID can be bound to the original modal context');
select is((select public.register_slack_clarification_view(modal_context_id, 'V67800001') from clarification_modal), true,
  're-registering the same view is idempotent');
select is((select public.register_slack_clarification_view(modal_context_id, 'V67800002') from clarification_modal), false,
  'another Slack view cannot replace the registered view');
select is((select pg_temp.slack_answer(modal_context_id, 'V67800001', 'Friday.', 'U67800002') from clarification_modal), 'denied',
  'another scoped human cannot submit this actor-bound modal');
select is((select pg_temp.slack_answer(modal_context_id, 'V67800002', 'Friday.') from clarification_modal), 'denied',
  'the intended actor still needs the exact registered view');
select is((select pg_temp.slack_answer(modal_context_id, 'V67800001', repeat('x', 2001)) from clarification_modal), 'denied',
  'the queue enforces the canonical answer limit before retaining text');
select is((select pg_temp.slack_answer(modal_context_id, 'V67800001', 'Friday.') from clarification_modal), 'queued',
  'the exact actor and view queue one durable clarification answer');
select is((select pg_temp.slack_answer(modal_context_id, 'V67800001', 'Monday.') from clarification_modal), 'denied',
  'a reused view cannot change its signed answer');
create temp table answer_claim as select * from public.claim_slack_review_action(pg_temp.op651_id(11));
select is((select action from answer_claim), 'answer', 'the worker can skip PR readiness preparation for answer actions');
select is((select public.complete_slack_review_action(action_id, lease_id, 'codex', 'gpt-5.5', 'code') from answer_claim),
  'applied', 'Slack routes the exact answer through the authoritative Wallie clarification command');
select is((select pg_temp.slack_answer(modal_context_id, 'V67800001', 'Friday.') from clarification_modal), 'replayed',
  'a repeated Slack submission does not send the answer twice');
select ok((select count(*) = 1 and bool_and((question.status, question.artifact_id, question.artifact_version,
    question.answered_by_member_id, question.answer_text) = ('answered', card.artifact_id, card.artifact_version,
    pg_temp.op651_id(22), 'Friday.'))
  from public.session_specification_clarifications question join slack_cards card on card.clarification_id = question.id
  where card.scenario = 'clarification'), 'the canonical clarification retains the exact answer, artifact and actual Wallie human');

select ok(pg_temp.slack_bind_card('expired'), 'a separate pending question binds to its own card');
create temp table expiring_modal as select * from pg_temp.slack_prepare('expired');
select ok((select public.register_slack_clarification_view(modal_context_id, 'V67800003') from expiring_modal),
  'the delayed answer fixture uses a bound Slack view');
select is((select pg_temp.slack_answer(modal_context_id, 'V67800003', 'Monday.') from expiring_modal), 'queued',
  'an undispatched answer remains durably queued within its deadline');
reset role;
update internal.slack_review_actions set deadline_at = clock_timestamp() - interval '1 second'
where delivery_key = 'answer:V67800003';
update internal.slack_clarification_modal_contexts set expires_at = clock_timestamp() - interval '11 minutes'
where view_id = 'V67800003';
set local role service_role;
select is((select count(*) from public.claim_slack_review_action(pg_temp.op651_id(11))), 0::bigint,
  'expired answer work never reaches a worker lease');

select ok(pg_temp.slack_bind_card('revoked'), 'a review target remains available for revocation testing');
select is(pg_temp.slack_approve('revoked', 240), 'queued', 'the worker must recheck queued actor authority');
reset role;
insert into internal.slack_review_actions(
  target_id, workspace_id, team_id, app_id, actor_id, actor_link_id, member_id, action, delivery_key, input_hash,
  deadline_at, next_attempt_at
)
select action.target_id, action.workspace_id, action.team_id, action.app_id, action.actor_id,
  action.actor_link_id, action.member_id, action.action, 'approve:' || pg_temp.review_ts(300 + slot),
  action.input_hash, clock_timestamp() - interval '1 second', clock_timestamp() - interval '2 seconds'
from internal.slack_review_actions action cross join generate_series(1, 8) as slots(slot)
where action.delivery_key = 'approve:' || pg_temp.review_ts(240);
set local role service_role;
create temp table cleanup_claim as select * from public.claim_slack_review_action(pg_temp.op651_id(11));
select ok((select count(*) = 1 and bool_and(to_jsonb(claim)->>'kind' = 'cleanup' and action_id is null and lease_id is null)
  from cleanup_claim claim), 'a full expired-actions batch reports cleanup without exposing a lease');
create temp table revoked_claim as select * from public.claim_slack_review_action(pg_temp.op651_id(11));
select ok((select count(*) = 1 and bool_and(to_jsonb(claim)->>'kind' = 'action' and action_id is not null and lease_id is not null)
  from revoked_claim claim), 'a fresh claim continues to the live action behind the cleanup batch');
select ok((select public.revoke_connector_actor_link(pg_temp.op651_id(11), pg_temp.op651_id(1), actor_link_id)
  from slack_review_links where actor_id = 'U67800002'), 'identity revocation succeeds after Slack queues the action');
select is((select public.complete_slack_review_action(action_id, lease_id, 'codex', 'gpt-5.5', 'code') from revoked_claim),
  'denied', 'revoking a Slack identity after claim prevents approval');
select is((select count(*) from public.session_stage_approval_receipts receipt join slack_cards card on card.session_id = receipt.session_id
  where card.scenario = 'revoked'), 0::bigint, 'current linked identity remains a hard prerequisite for the Wallie receipt');

reset role;
select is((select count(*) from internal.slack_review_actions receipt
  where receipt.delivery_key between 'approve:' || pg_temp.review_ts(301) and 'approve:' || pg_temp.review_ts(308)
    and receipt.result = 'expired' and receipt.attempt_count = 0), 8::bigint,
  'cleanup retires expired actions without spending their attempts');
select is((select count(*) from internal.slack_clarification_modal_contexts where view_id = 'V67800003'), 0::bigint,
  'the worker prunes expired modal binding metadata after the replay window');
select is((select count(*) from internal.slack_review_actions receipt
  where receipt.action = 'answer' and receipt.result in ('applied', 'expired') and receipt.answer is null), 2::bigint,
  'the private Slack queue scrubs terminal answer text on success and expiry');
select * from finish();
rollback;
