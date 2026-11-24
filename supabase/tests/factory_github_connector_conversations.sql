begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
\set op651_fixture_namespace 67510000
\ir fixtures/factory_automation_dry_run.psql

create temp table github_conversation_scope as
select scope.*, connected.installation_id, connected.generation, mapped.resource_id,
  approved.id as grant_id, approved.version as grant_version
from op651_scope scope cross join op651_grant approved
cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'github', '67510001', '67510033', 0) connected
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  connected.installation_id, connected.generation, 'repository', '67510034', 0, true) mapped;

create temp table github_human_link as
select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), scope.installation_id,
  scope.generation, 'github', '67510001', '67510002', 'human') as actor_link_id from github_conversation_scope scope;

select public.configure_github_connector_request(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  scope.resource_id, kinds.kind, 0, true, 67510003, scope.grant_id, scope.grant_version)
from github_conversation_scope scope cross join (values ('issue'), ('pull_request')) kinds(kind);

create temp table github_conversation_clock as
select date_trunc('second', max(rule.configured_at)) as configured_second
from internal.github_connector_request_rules rule join github_conversation_scope scope using (resource_id);
create function pg_temp.github_conversation_time(p_tick integer) returns timestamptz language sql stable as $$
  select configured_second + make_interval(secs => p_tick) from github_conversation_clock
$$;

create temp table github_linked_conversations as
select input.kind, input.number, input.canonical_id, input.issue_id, public.ingest_github_connector_work(
  67510033, 67510034, 67510001, pg_temp.op651_id(input.number), input.kind, input.canonical_id,
  input.number, 'labeled', 'open', pg_temp.github_conversation_time(5), 67510002, 'human', 67510003,
  case when input.kind = 'pull_request' then 'feature/scoped-fixture' end,
  case when input.kind = 'pull_request' then repeat('a', 40) end,
  case when input.kind = 'pull_request' then 'main' end,
  'Private intake title', 'Private intake body that must not be reflected') as receipt
from (values ('issue', 101, 67000101::bigint, 67000101::bigint),
  ('pull_request', 102, 67000102::bigint, 68000102::bigint)) input(kind, number, canonical_id, issue_id);
alter table github_linked_conversations add column session_id uuid;
update github_linked_conversations set session_id = (receipt->>'sessionId')::uuid;

create function pg_temp.deliver_github_comment(
  p_delivery integer, p_comment bigint, p_tick integer, p_kind text default 'issue', p_action text default 'created',
  p_body text default 'A signed human follow-up.', p_actor bigint default 67510002,
  p_override_id bigint default null, p_override_number integer default null, p_owner bigint default 67510001,
  p_installation bigint default 67510033, p_repository bigint default 67510034
) returns jsonb language sql as $$
  select public.ingest_github_connector_comment(p_installation, p_repository, p_owner, pg_temp.op651_id(p_delivery),
    p_action, thread.kind, coalesce(p_override_number, thread.number), coalesce(p_override_id, thread.issue_id),
    p_comment, p_actor, pg_temp.github_conversation_time(p_tick), case when p_action <> 'deleted' then p_body end)
  from github_linked_conversations thread where thread.kind = p_kind
$$;

select ok(has_function_privilege('service_role',
  'public.ingest_github_connector_comment(bigint,bigint,bigint,uuid,text,text,integer,bigint,bigint,bigint,timestamptz,text)', 'execute')
  and not has_function_privilege('authenticated',
  'public.ingest_github_connector_comment(bigint,bigint,bigint,uuid,text,text,integer,bigint,bigint,bigint,timestamptz,text)', 'execute')
  and not has_table_privilege('service_role', 'internal.github_connector_comments', 'select'),
  'the signed provider route alone can submit conversation comments');
select is((select count(*) from github_linked_conversations where receipt->>'status' = 'admitted'), 2::bigint,
  'the real intake path links one issue and one PR');
select is((select count(*) from internal.connector_outbound_deliveries where logical_key = 'github:accepted'
  and session_id in (select session_id from github_linked_conversations)), 2::bigint,
  'both intakes enqueue initial progress without M04 event subscription setup');
select ok(not exists (select 1 from internal.connector_outbound_deliveries posted
  join github_linked_conversations thread using (session_id) where posted.content::text ilike '%private intake%'),
  'outbound messages do not expose external content');

select is(pg_temp.deliver_github_comment(210, 9001, 10, p_owner => 99), null::jsonb,
  'a different authenticated owner is outside the source mapping');
select is(pg_temp.deliver_github_comment(210, 9001, 10, p_installation => 99), null::jsonb,
  'another App installation cannot reach a linked conversation');
select is(pg_temp.deliver_github_comment(210, 9001, 10, p_repository => 99), null::jsonb,
  'another repository cannot reach a linked conversation');
select is(pg_temp.deliver_github_comment(210, 9001, 10, p_override_id => 99), null::jsonb,
  'an issue webhook must identify the exact linked issue');
select is(pg_temp.deliver_github_comment(210, 9001, 10, p_override_number => 99), null::jsonb,
  'a source number without an admitted conversation is acknowledged');
select is(pg_temp.deliver_github_comment(210, 9001, 10, p_actor => 99), null::jsonb,
  'an unlinked bot or foreign human cannot append');
select ok(pg_temp.deliver_github_comment(210, 9001, 10) @> jsonb_build_object(
  'status', 'appended', 'sessionId', (select session_id from github_linked_conversations where kind = 'issue')),
  'a verified human comment continues the original issue session');
select ok(pg_temp.deliver_github_comment(210, 9001, 10) @> '{"status":"appended","replayed":true}'::jsonb,
  'the exact delivery replays its existing receipt');
select throws_ok($$select pg_temp.deliver_github_comment(210, 9001, 10, p_body => 'Changed replay')$$,
  'PT409', null, 'a duplicated delivery ID cannot smuggle changed body text');
select is(pg_temp.deliver_github_comment(211, 9001, 10)->>'status', 'stale',
  'a different delivery ID cannot append the same provider revision');
select is(pg_temp.deliver_github_comment(212, 9001, 10, p_action => 'edited', p_body => 'Correction.')->>'status',
  'appended', 'one same-second edit can advance the initial create without rewriting it');
select is(pg_temp.deliver_github_comment(213, 9001, 10, p_action => 'edited', p_body => 'Ambiguous tie.')->>'status',
  'stale', 'another edit tied to the accepted version cannot assume a chronology');
select is(pg_temp.deliver_github_comment(214, 9001, 9, p_action => 'edited')->>'status', 'stale',
  'an older provider edit cannot outrank the accepted version');
select is(pg_temp.deliver_github_comment(215, 9001, 9, p_action => 'deleted')->>'status', 'deleted',
  'a signed deletion is terminal even when it repeats an old timestamp');
select is(pg_temp.deliver_github_comment(216, 9001, 18, p_action => 'edited')->>'status', 'stale',
  'a late edit cannot resurrect a deleted comment');
select is(pg_temp.deliver_github_comment(217, 9002, 21, p_action => 'deleted')->>'status', 'deleted',
  'deletion can arrive before the created delivery');
select is(pg_temp.deliver_github_comment(218, 9002, 21)->>'status', 'stale',
  'a same-second create cannot reverse a tombstone');
select is((select count(*) from public.session_conversation_messages message join github_linked_conversations linked
  using (session_id) where linked.kind = 'issue' and message.source_id is not null), 2::bigint,
  'only the initial comment and its accepted edit appear as immutable messages');
select ok(exists (select 1 from public.session_conversation_messages message join github_linked_conversations linked
  using (session_id) where linked.kind = 'issue' and message.external_actor_id = '67510002'
    and message.body_md = 'A signed human follow-up.' and message.originating_member_id = pg_temp.op651_id(21)),
  'the exact provider actor and verified workspace member remain attached');
select ok(exists (select 1 from public.session_conversation_messages message join github_linked_conversations linked
  using (session_id) where linked.kind = 'issue' and message.external_message_id like 'github-comment:9001:edited:%'
    and message.body_md like '%Correction.'),
  'the edit records its own provider revision and leaves historical text in place');

select is(pg_temp.deliver_github_comment(221, 9101, 20, 'pull_request')->>'status', 'appended',
  'the PR issue envelope binds its numeric issue ID to the separately admitted canonical PR');
select is(pg_temp.deliver_github_comment(222, 9102, 21, 'pull_request', p_override_id => 67000102), null::jsonb,
  'a later payload cannot replace the bound PR issue ID with its different canonical PR ID');
select is(pg_temp.deliver_github_comment(223, 9001, 21, 'pull_request'), null::jsonb,
  'a comment identity already bound to an issue cannot be reassigned to a PR');
select is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11)), 2::bigint,
  'follow-up delivery does not create new sessions');
select is((select count(*) from public.agent_jobs join github_linked_conversations using (session_id)), 2::bigint,
  'follow-up delivery does not create additional jobs');

insert into public.session_artifacts(id, workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
select pg_temp.op651_id(301), session.workspace_id, session.id, session.current_stage_id, stage.slug, 1,
  to_jsonb('Private review content'::text)
from public.sessions session join github_linked_conversations linked on linked.session_id = session.id
join public.pipeline_stages stage on stage.id = session.current_stage_id where linked.kind = 'pull_request';
update public.sessions session set phase_status = 'awaiting_review', current_artifact_id = pg_temp.op651_id(301),
  current_artifact_version = 1, artifact_review_revision = 3
from github_linked_conversations linked where linked.kind = 'pull_request' and linked.session_id = session.id;

select ok(exists (select 1 from internal.connector_outbound_deliveries delivery
  join public.sessions session on session.id = delivery.session_id
  join public.pipeline_stages stage on stage.id = session.current_stage_id
  where delivery.content @> jsonb_build_object('kind', 'review_ready', 'sessionId', session.id,
    'workspaceSlug', 'op651-67510000', 'sessionNumber', session.number,
    'reviewTarget', jsonb_build_object('stageId', stage.id, 'stageSlug', stage.slug, 'artifactId', pg_temp.op651_id(301),
      'artifactVersion', 1, 'reviewRevision', 3, 'clarificationId', null))
    and delivery.content::text not like '%Private review content%'),
  'review delivery freezes scoped session and exact artifact link fields without exposing artifact content');

select is(pg_temp.deliver_github_comment(224, 9103, 22, 'pull_request', p_body => '@Wallie approve this')->>'status',
  'appended', 'command-looking human text is ordinary conversation context');
select ok(exists (select 1 from public.sessions session join github_linked_conversations linked on linked.session_id = session.id
  where linked.kind = 'pull_request' and session.phase_status = 'awaiting_review'
    and session.current_artifact_id = pg_temp.op651_id(301) and session.artifact_review_revision = 3)
  and not exists (select 1 from public.session_stage_approval_receipts approval
    join github_linked_conversations linked using (session_id)),
  'provider comments cannot approve, reopen, or change the exact review');
update public.sessions session set phase_status = 'approved' from github_linked_conversations linked
where linked.kind = 'pull_request' and linked.session_id = session.id;
select is((select count(*) from internal.connector_outbound_deliveries delivery join github_linked_conversations linked using (session_id)
  where linked.kind = 'pull_request' and delivery.content->>'kind' = 'outcome' and delivery.operation = 'reply'),
  1::bigint, 'final approval produces a separate immutable outcome reply');

-- Select one deterministic claim independently of the other retained statuses.
update internal.connector_outbound_deliveries delivery set next_action_at = clock_timestamp() + interval '1 hour'
where delivery.session_id in (select session_id from github_linked_conversations)
  and delivery.logical_key <> 'github:review:' || pg_temp.op651_id(301)::text;
create temp table github_review_claim as select * from public.claim_connector_outbound_delivery('github');

select is((select count(*) from github_review_claim claim
  cross join lateral public.resolve_github_connector_delivery(claim.delivery_id, claim.lease_id)), 0::bigint,
  'a reserved lease does not yet authorize reading provider routing');
select ok((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from github_review_claim),
  'a current scoped review claim reaches the transport fence');
select is((select count(*) from github_review_claim claim
  cross join lateral public.resolve_github_connector_delivery(claim.delivery_id, pg_temp.op651_id(999))), 0::bigint,
  'the provider target cannot be read with another lease');
select ok(exists (select 1 from github_review_claim claim
  cross join lateral public.resolve_github_connector_delivery(claim.delivery_id, claim.lease_id) resolved
  where (resolved.github_installation_id, resolved.github_repository_id, resolved.repository_full_name,
    resolved.source_kind, resolved.source_number, resolved.source_id) =
    (67510033::bigint, 67510034::bigint, 'fixture/workflow-fixture', 'pull_request', 102, 67000102::bigint)),
  'only the authorized current lease resolves the exact native provider thread and canonical PR ID');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'uncertain') from github_review_claim),
  'lost output can enter common outbox recovery without touching the review');
update internal.connector_outbound_deliveries set next_action_at = clock_timestamp()
where id = (select delivery_id from github_review_claim);
create temp table github_review_observation as select * from public.claim_connector_outbound_delivery('github');
select ok((select observation.kind = 'observing' and observation.delivery_id = initial.delivery_id
  from github_review_observation observation cross join github_review_claim initial),
  'unknown outcome is retried as observation of the same logical reply');
select ok((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from github_review_observation),
  'observation acquires its own authority while review remains finalized');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'found', '9910')
  from github_review_observation), 'recovery confirms the existing provider comment ID without rewriting it');
select ok(exists (select 1 from public.sessions session join github_linked_conversations linked on linked.session_id = session.id
  where linked.kind = 'pull_request' and session.phase_status = 'approved' and session.artifact_review_revision = 3),
  'reply delivery and recovery preserve the newer review decision');

update public.sessions session set phase_status = 'rejected', execution_exhaustion_code = 'elapsed_execution',
  execution_exhausted_at = clock_timestamp()
from github_linked_conversations linked where linked.kind = 'issue' and linked.session_id = session.id;
select ok(exists (select 1 from internal.connector_outbound_deliveries delivery
  join github_linked_conversations linked using (session_id)
  where linked.kind = 'issue' and delivery.logical_key = 'github:budget-exhausted'
    and delivery.content->>'kind' = 'outcome'),
  'a canonical session stop with recorded budget exhaustion produces its own linked outcome');

select public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), scope.installation_id,
  scope.generation, 'repository', '67510034', 1, false) from github_conversation_scope scope;
select is(pg_temp.deliver_github_comment(229, 9105, 24, 'pull_request'), null::jsonb,
  'a disabled mapping cannot append more external conversation text');
select lives_ok($$update public.sessions session set phase_status = 'approved' from github_linked_conversations linked
  where linked.kind = 'issue' and linked.session_id = session.id$$,
  'a disabled mapping does not make ordinary session lifecycle writes fail');
select ok(exists (select 1 from internal.connector_outbound_deliveries delivery join github_linked_conversations linked using (session_id)
  where linked.kind = 'issue' and delivery.logical_key = 'github:approved'),
  'provider unavailability leaves the linked lifecycle receipt for outbox authority to handle');

select * from finish();
rollback;
