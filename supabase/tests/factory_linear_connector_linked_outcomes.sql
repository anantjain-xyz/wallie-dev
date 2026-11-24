begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
\set op651_fixture_namespace 67310000
\ir fixtures/factory_automation_dry_run.psql

select public.set_git_continuity_release(true, revision, 'Isolated Linear outcomes fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into public.workspace_secrets(id, workspace_id, key, encrypted_value)
values (pg_temp.op651_id(51), pg_temp.op651_id(11), 'LINEAR_API_KEY', 'linear-outcomes-fixture-ciphertext');

create temp table linear_outcome_scope as
select scope.*, installed.installation_id, installed.generation, mapped.resource_id, mapped.revision as mapping_revision
from op651_scope scope
cross join lateral public.configure_connector_installation(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  'linear', pg_temp.op651_id(52)::text, pg_temp.op651_id(52)::text, 0, pg_temp.op651_id(51), 1) installed
cross join lateral public.publish_connector_resource_mapping(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  installed.installation_id, installed.generation, 'team', pg_temp.op651_id(53)::text, 0, true) mapped;

select public.link_connector_actor(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), scope.installation_id,
  scope.generation, 'linear', pg_temp.op651_id(52)::text, pg_temp.op651_id(56)::text, 'human')
from linear_outcome_scope scope;
select public.configure_linear_issue_discovery(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  scope.resource_id, 0, scope.mapping_revision, array[pg_temp.op651_id(54)], true)
from linear_outcome_scope scope;

create function pg_temp.read_linear_write_config() returns jsonb language sql as $$
  select public.read_linear_connector_outbound_config(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), scope.resource_id)
  from linear_outcome_scope scope
$$;
create function pg_temp.configure_linear_write(
  p_expected_revision bigint, p_comments_enabled boolean, p_team integer default null, p_from integer default null,
  p_to integer default null, p_mapping_revision bigint default 1, p_owner integer default 1
) returns bigint language sql as $$
  select public.configure_linear_connector_outbound(scope.workspace_id, scope.factory_id, pg_temp.op651_id(p_owner),
    scope.resource_id, p_expected_revision, p_mapping_revision, p_comments_enabled,
    case when p_team is not null then pg_temp.op651_id(p_team) end,
    case when p_from is not null then pg_temp.op651_id(p_from) end,
    case when p_to is not null then pg_temp.op651_id(p_to) end)
  from linear_outcome_scope scope
$$;
create function pg_temp.linear_outcome_issue(p_slot integer, p_span text default null, p_invalid_span boolean default false)
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', pg_temp.op651_id(p_slot), 'identifier', 'OUT-' || p_slot, 'title', 'Private Linear title',
    'description', 'Private Linear task description',
    'url', 'https://linear.app/fixture/issue/OUT-' || p_slot || '/test-issue',
    'team_id', pg_temp.op651_id(53), 'project_id', pg_temp.op651_id(57), 'state_id', pg_temp.op651_id(54),
    'creator_id', pg_temp.op651_id(56), 'label_ids', '[]'::jsonb, 'previous_identifiers', '[]'::jsonb
  ) || case when p_span is null then '{}'::jsonb else jsonb_build_object(
    'origin_span_id', p_span, 'origin_span_started_at', timestamptz '2026-10-02T12:00:00Z',
    'origin_issue_updated_at', case when p_invalid_span then timestamptz '2026-10-01T12:00:00Z'
      else timestamptz '2026-10-03T12:00:00Z' end)
  end
$$;
create function pg_temp.admit_linear_outcomes(p_cursor bigint, p_input jsonb) returns integer language sql as $$
  select public.commit_linear_issue_discovery_page(scope.workspace_id, scope.factory_id, scope.resource_id,
    1, scope.generation, scope.mapping_revision, p_cursor, pg_temp.op651_id(52), pg_temp.op651_id(56), p_input, null)
  from linear_outcome_scope scope
$$;
create function pg_temp.linear_outcome_session(p_slot integer) returns uuid language sql stable as $$
  select session_id from internal.linear_issue_discovery_receipts where issue_id = pg_temp.op651_id(p_slot)
$$;

select is(pg_temp.read_linear_write_config(),
  '{"revision":0,"mappingRevision":1,"commentsEnabled":false,"statusMapping":null}'::jsonb,
  'a mapped resource defaults to no Linear write permission');
select ok(not has_function_privilege('authenticated',
    'public.configure_linear_connector_outbound(uuid,uuid,uuid,uuid,bigint,bigint,boolean,uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.resolve_linear_connector_delivery(uuid,uuid,uuid,bigint)', 'execute')
  and has_function_privilege('service_role', 'public.resolve_linear_connector_delivery(uuid,uuid,uuid,bigint)', 'execute')
  and not has_table_privilege('service_role', 'internal.linear_connector_notice_targets', 'select'),
  'browser users cannot configure writes or read transport credential material');
select throws_ok($$select pg_temp.configure_linear_write(0,true,p_owner=>2)$$, '42501', null,
  'a regular workspace member cannot opt into Linear writes');
select throws_ok($$select pg_temp.configure_linear_write(0,true,53,54)$$, '22023', null,
  'partial status configuration cannot authorize a provider transition');
select throws_ok($$select pg_temp.configure_linear_write(0,true,99,54,55)$$, '22023', null,
  'a team resource cannot authorize a status mapping for another team');
select is(pg_temp.admit_linear_outcomes(0,jsonb_build_array(pg_temp.linear_outcome_issue(101))), 1,
  'an admitted issue remains supported without an observed provider span');
select is((select count(*) from internal.connector_outbound_deliveries where session_id = pg_temp.linear_outcome_session(101)),
  0::bigint, 'historical sessions do not write until the owner opts in');
select is(pg_temp.configure_linear_write(0,true,53,54,55), 1::bigint,
  'the workspace owner opts into comments and one exact terminal status mapping');
select ok(pg_temp.read_linear_write_config() @> jsonb_build_object('revision', 1, 'mappingRevision', 1,
  'commentsEnabled', true, 'statusMapping', jsonb_build_object('teamId', pg_temp.op651_id(53),
    'fromStateId', pg_temp.op651_id(54), 'toStateId', pg_temp.op651_id(55))),
  'readback exposes the saved bounded mapping and its revision');
select throws_ok($$select pg_temp.configure_linear_write(0,true,53,54,55)$$, 'PT409', null,
  'an old configuration revision does not replace current authority');
select throws_ok($$select pg_temp.configure_linear_write(1,true,p_mapping_revision=>2)$$, 'PT409', null,
  'an old resource snapshot does not acquire authority');

select is(pg_temp.admit_linear_outcomes(1, jsonb_build_array(pg_temp.linear_outcome_issue(102, 'original-span-102'),
  pg_temp.linear_outcome_issue(103, 'invalid-span', true))), 2, 'verified discovery admits both exact issue IDs');
select is((select origin_span_id from internal.linear_issue_discovery_receipts where issue_id = pg_temp.op651_id(102)),
  'original-span-102', 'the canonical discovery receipt retains the original provider span');
select is((select origin_span_started_at from internal.linear_issue_discovery_receipts where issue_id = pg_temp.op651_id(102)),
  timestamptz '2026-10-02T12:00:00Z', 'the original state entry time is frozen at admission');
select is((select origin_span_id from internal.linear_issue_discovery_receipts where issue_id = pg_temp.op651_id(103)),
  null::text, 'an incoherent span is omitted without removing the linked session');
select is(pg_temp.admit_linear_outcomes(2, jsonb_build_array(pg_temp.linear_outcome_issue(102, 'later-span'))), 0,
  'repeat discovery cannot replace the admitted issue or its origin span');
select is((select origin_span_id from internal.linear_issue_discovery_receipts where issue_id = pg_temp.op651_id(102)),
  'original-span-102', 'later provider state-span snapshots cannot rewrite the origin');
select is((select count(*) from internal.connector_outbound_deliveries where logical_key = 'linear:accepted'
  and workspace_id = pg_temp.op651_id(11)), 2::bigint, 'each newly linked eligible issue queues one initial progress comment');
select ok(not exists (select 1 from internal.connector_outbound_deliveries where workspace_id = pg_temp.op651_id(11)
  and content::text ilike '%private linear%'), 'provider payloads exclude private Linear intake content');

create function pg_temp.focus_linear_notice(p_slot integer, p_key text) returns void language sql as $$
  update internal.connector_outbound_deliveries delivery set next_action_at =
    case when (delivery.session_id, delivery.logical_key) = (pg_temp.linear_outcome_session(p_slot), p_key)
      then clock_timestamp() else clock_timestamp() + interval '1 hour' end
  where delivery.workspace_id = pg_temp.op651_id(11) and delivery.status in ('queued', 'unknown', 'blocked')
$$;
select pg_temp.focus_linear_notice(102, 'linear:accepted');
create temp table first_linear_claim as select * from public.claim_connector_outbound_delivery('linear');
select is((select count(*) from first_linear_claim claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision)), 0::bigint,
  'the resolver requires the exact pre-transport authorization');
select ok((select public.confirm_connector_outbound_authority(delivery_id, lease_id) from first_linear_claim),
  'the connector outbox grants a current send permit');
select is((select count(*) from first_linear_claim claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision + 1)), 0::bigint,
  'a substituted credential revision cannot expose the key');
select ok(exists (select 1 from first_linear_claim claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision) target
  where target.issue_id = pg_temp.op651_id(102) and target.external_tenant_id = pg_temp.op651_id(52)
    and target.resource_kind = 'team' and target.resource_external_id = pg_temp.op651_id(53)
    and target.origin_state_id = pg_temp.op651_id(54) and target.origin_team_id = pg_temp.op651_id(53)
    and target.origin_project_id = pg_temp.op651_id(57) and target.origin_span_id = 'original-span-102'
    and target.encrypted_api_key = 'linear-outcomes-fixture-ciphertext'
    and target.credential_material_revision = 1 and target.may_send),
  'the authorized lease resolves the exact issue, scope, origin and current credential');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'uncertain') from first_linear_claim),
  'a possible Linear write is retained for exact observation');

insert into public.session_artifacts(id, workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
select pg_temp.op651_id(301), session.workspace_id, session.id, session.current_stage_id, stage.slug, 1,
  to_jsonb('Private artifact contents'::text)
from public.sessions session join public.pipeline_stages stage on stage.id = session.current_stage_id
where session.id = pg_temp.linear_outcome_session(102);
update public.sessions session set phase_status = 'awaiting_review', current_artifact_id = pg_temp.op651_id(301),
  current_artifact_version = 1, artifact_review_revision = 5 where session.id = pg_temp.linear_outcome_session(102);
select ok(exists (select 1 from internal.connector_outbound_deliveries delivery join public.sessions session on session.id = delivery.session_id
  join public.pipeline_stages stage on stage.id = session.current_stage_id where delivery.content @> jsonb_build_object(
    'kind', 'review_ready', 'sessionId', session.id, 'workspaceSlug', 'op651-67310000', 'sessionNumber', session.number,
    'reviewTarget', jsonb_build_object('stageId', stage.id, 'stageSlug', stage.slug, 'artifactId', pg_temp.op651_id(301),
    'artifactVersion', 1, 'reviewRevision', 5, 'clarificationId', null))
  and delivery.content::text not ilike '%private artifact%'),
  'the review comment freezes the exact artifact link without transmitting artifact text');

-- Final approval normally sets the terminal state and archives the linked session together.
update public.sessions set phase_status = 'approved', archived_at = clock_timestamp() where id in (
  pg_temp.linear_outcome_session(101), pg_temp.linear_outcome_session(102), pg_temp.linear_outcome_session(103));
select is((select count(*) from internal.connector_outbound_deliveries where workspace_id = pg_temp.op651_id(11)
  and logical_key = 'linear:approved' and operation = 'reply'), 3::bigint,
  'archiving on final approval queues immutable outcomes, including for a prior session with no span');
select is((select count(*) from internal.connector_outbound_deliveries where workspace_id = pg_temp.op651_id(11)
  and operation = 'linear_status'), 1::bigint,
  'only the final approved session with the verified originating span and explicit mapping may transition');

select pg_temp.focus_linear_notice(102, 'linear:accepted');
create temp table linear_old_observation as select * from public.claim_connector_outbound_delivery('linear');
select ok((select current.kind = 'observing' and current.delivery_id = first.delivery_id
  from linear_old_observation current cross join first_linear_claim first),
  'an older maybe-written progress comment becomes observation-only');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from linear_old_observation;
select ok(exists (select 1 from linear_old_observation claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision) target
  where not target.may_send and target.issue_id = pg_temp.op651_id(102)),
  'obsolete progress cannot be written while its exact unknown outcome remains observable');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'found', 'old-progress-comment')
  from linear_old_observation), 'an exact old observation can settle without changing the approved session');

select pg_temp.focus_linear_notice(103, 'linear:accepted');
create temp table linear_stale_send as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from linear_stale_send;
select ok(exists (select 1 from linear_stale_send claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision) target
  where not target.may_send and claim.kind = 'sending'),
  'a stale never-written progress reply cannot overwrite the newer final outcome');
select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'rejected') from linear_stale_send;

select pg_temp.focus_linear_notice(101, 'linear:approved');
create temp table linear_archived_outcome as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from linear_archived_outcome;
select ok(exists (select 1 from linear_archived_outcome claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision) target
  where claim.operation = 'reply' and target.may_send and target.issue_id = pg_temp.op651_id(101)),
  'archived final approval remains eligible to publish the linked outcome comment');
select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'sent', 'approved-outcome-comment')
from linear_archived_outcome;

select pg_temp.focus_linear_notice(102, 'linear:approved-status');
create temp table linear_status_claim as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from linear_status_claim;
select ok(exists (select 1 from linear_status_claim claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision) target
  where claim.operation = 'linear_status' and target.may_send
    and target.from_state_id = pg_temp.op651_id(54) and target.to_state_id = pg_temp.op651_id(55)),
  'the archived approved session can use only the explicitly configured status mapping');
select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'uncertain') from linear_status_claim;
select is(pg_temp.configure_linear_write(1,false), 2::bigint, 'an owner revokes comments and automatic status transitions');

select pg_temp.focus_linear_notice(102, 'linear:approved-status');
create temp table linear_status_observation as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from linear_status_observation;
select ok(exists (select 1 from linear_status_observation claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision) target
  where claim.kind = 'observing' and not target.may_send and target.to_state_id = pg_temp.op651_id(55)),
  'revocation prevents status sends without erasing historical unknown observation authority');
select ok((select public.settle_connector_outbound_delivery(delivery_id, lease_id, 'found', pg_temp.op651_id(55)::text)
  from linear_status_observation), 'a known status outcome can be recorded without a second update');

select pg_temp.focus_linear_notice(102, 'linear:approved');
create temp table linear_revoked_outcome as select * from public.claim_connector_outbound_delivery('linear');
select public.confirm_connector_outbound_authority(delivery_id, lease_id) from linear_revoked_outcome;
select ok(exists (select 1 from linear_revoked_outcome claim cross join lateral public.resolve_linear_connector_delivery(
  claim.delivery_id, claim.lease_id, claim.credential_ref, claim.credential_material_revision) target
  where not target.may_send and claim.kind = 'sending'), 'revocation also fences an unwritten final comment');
select is((select count(*) from public.sessions where workspace_id = pg_temp.op651_id(11) and phase_status = 'approved' and archived_at is not null),
  3::bigint, 'reply and status delivery leave every approved Wallie session intact');

select * from finish();
rollback;
