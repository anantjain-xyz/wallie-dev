begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
-- Remove only this fixture's committed state if an earlier race was interrupted.
delete from public.workspaces where id = '66510000-0000-4000-8000-000000000011';
delete from auth.users where id in ('66510000-0000-4000-8000-000000000001', '66510000-0000-4000-8000-000000000002');
\set op651_fixture_namespace 66510000
\ir fixtures/factory_automation_dry_run.psql
\ir fixtures/factory_workflow_checkpoint_evidence.psql

create temp table delivery_release_before as select * from public.get_git_continuity_release_state();
select public.set_git_continuity_release(true, revision, 'Guarded delivery fixture')
from delivery_release_before where not enabled;
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.op651_id(1), 'platform_api_key', 'fixture-ciphertext');

create temp table delivery_policy as
select policy.* from public.save_delivery_policy(pg_temp.op651_id(11), pg_temp.op651_id(31),
  pg_temp.op651_id(1), 0, '{"version":1,"deliveryMode":"code","requiredChecks":[],
  "minimumApprovals":0,"requireCodeOwnerReview":false,"requireResolvedThreads":false,
  "requiredEvidence":[],"freshnessSeconds":300,"requireArtifactApprovalForDelivery":true}') policy;

with definition as (
  select revision.workspace_id, revision.factory_id, revision.created_by,
    jsonb_set(revision.definition_json::jsonb, '{deliveryPolicyRevisionId}', to_jsonb(policy.id))::text as body
  from public.factory_definition_revisions revision cross join delivery_policy policy
  where revision.id = pg_temp.op651_id(43)
), added as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
    canonical_digest, created_by)
  select pg_temp.op651_id(230), workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), created_by
  from definition returning *
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 6, created_by from added;

create temp table delivery_grant as
select approved.* from op651_grant existing
cross join lateral public.approve_factory_execution_grant(existing.workspace_id, existing.factory_id,
  pg_temp.op651_id(1), existing.service_principal_id, existing.github_repository_id, '{}', '{}',
  existing.execution_policy_revision_id, existing.budget_payer_member_id, clock_timestamp() + interval '1 hour',
  0, null, '{deployments:observe}') approved;
select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.op651_id(1), id, version,
  pg_temp.op651_id(231), repeat('a', 64), 'Delivery observation fixture', '{deployments:observe}') from delivery_grant;
create temp table delivery_sources as
select environment.name, (source.payload->>'sourceId')::uuid as source_id
from delivery_grant grant_row cross join (values ('timeout'), ('cancelled'), ('stale'), ('accepted')) environment(name)
cross join lateral (
  select public.approve_factory_deployment_source(grant_row.workspace_id, grant_row.factory_id, pg_temp.op651_id(1),
    grant_row.id, grant_row.version, 'fixture-ci', 'wallie-delivery-fixture', environment.name, true) as payload
) source;

create temp table delivery_execution as select * from public.create_session_with_first_job(
  pg_temp.op651_id(11), pg_temp.op651_id(21), 'Delivery command fixture', 'Publish an exact checkpoint.',
  'codex', 'gpt-5.5');
update public.agent_jobs set status = 'running', attempt_count = 1,
  git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
where id = (select job_id from delivery_execution);
create temp table delivery_checkpoint as
select session_id, pg_temp.adopt_branch_code(session_id, job_id, repeat('b', 40)) as run_id
from delivery_execution;

create function pg_temp.delivery_sync(p_session_id uuid) returns boolean language plpgsql as $$
declare
  operation public.session_pr_operations;
  token uuid := public.claim_session_pr_sync(p_session_id);
  url text := 'https://github.com/fixture/workflow-fixture/pull/665';
  observation uuid;
begin
  select * into strict operation from public.session_pr_operations where claim_id = token;
  if not public.arm_session_pr_creation(operation.epoch_id, operation.id, token) then
    raise exception 'Could not arm PR creation.';
  end if;
  observation := public.begin_session_pr_sync_observation(operation.id, token, 665, url);
  return public.finish_session_pr_sync(operation.id, token, operation.desired_sha, operation.desired_fence_sha,
    665, url, 'open', false, operation.desired_sha, clock_timestamp(), observation);
end;
$$;
select ok(pg_temp.delivery_sync(session_id), 'the exact reviewed code is retained on a real canonical PR') from delivery_checkpoint;

create function pg_temp.delivery_prepare(p_slot integer, p_environment text, p_override_head uuid default null,
  p_override_policy uuid default null, p_actor uuid default pg_temp.op651_id(1))
returns jsonb language sql as $$
  select public.prepare_factory_delivery_command(scope.workspace_id, scope.factory_id, p_actor, pg_temp.op651_id(p_slot),
    checkpoint.session_id, coalesce(p_override_head, checkpoint.run_id), coalesce(approval.id, gen_random_uuid()),
    coalesce(p_override_policy, policy.id), coalesce(merged.observation_id, gen_random_uuid()), source.source_id)
  from delivery_checkpoint checkpoint cross join op651_scope scope cross join delivery_policy policy
  join delivery_sources source on source.name = p_environment
  left join public.session_stage_approval_receipts approval on approval.session_id = checkpoint.session_id
  left join internal.current_factory_canonical_pull_request_merges merged on merged.session_id = checkpoint.session_id
$$;

select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout')$$, 'PT409', null,
  'an unapproved source cannot create a delivery command');
create function pg_temp.delivery_ready(p_session_id uuid) returns void language plpgsql as $$
declare
  scope uuid := pg_temp.op651_id(11);
  claim jsonb;
  github public.session_pr_verification_observations;
  readiness public.session_pr_verification_observations;
begin
  if not public.enqueue_session_pr_refresh(scope, p_session_id) then raise exception 'Could not enqueue refresh.'; end if;
  claim := public.claim_github_pr_refresh(scope);
  if not public.finish_github_pr_refresh(p_session_id, (claim->>'claim_token')::uuid, repeat('b', 40), repeat('a', 40),
    jsonb_build_object('version', 1, 'githubAccess', 'available', 'checks', 'passed', 'reviews', 'passed',
      'threads', 'passed', 'mergeability', 'passed', 'protection', 'verified', 'blockers', '[]'::jsonb,
      'pr', jsonb_build_object('number', 665, 'state', 'open', 'draft', false, 'headSha', repeat('b', 40),
        'baseSha', repeat('a', 40), 'updatedAt', clock_timestamp()))) then raise exception 'Could not refresh PR.'; end if;
  select observed.* into strict github from public.session_pr_refresh_queue queue
  join public.session_pr_verification_observations observed on observed.id = queue.last_observation_id
  where queue.session_id = p_session_id;
  readiness := public.record_pr_verification_observation(github.workspace_id, github.session_id,
    github.policy_revision_id, github.repository_id, github.repository_full_name, github.pr_epoch_id,
    github.pr_number, github.head_sha, github.base_sha, github.checkpoint_run_id, github.artifact_review_revision,
    'readiness', jsonb_build_object('githubAccess', 'available', 'checks', 'passed', 'reviews', 'passed',
      'evidence', 'passed', 'threads', 'passed', 'sourceObservationId', github.id), clock_timestamp());
  perform public.record_pr_verification_result(readiness.id, 'ready', '[]');
end;
$$;
select pg_temp.delivery_ready(session_id) from delivery_checkpoint;
select is(pg_temp.approve_branch(session_id), session_id, 'real final approval uses the exact Ready decision and policy')
from delivery_checkpoint;
select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout')$$, 'PT409', null,
  'human approval and a green PR alone do not replace the manual source merge');

create function pg_temp.delivery_observe_merge(p_merge_sha text) returns boolean language sql as $$
  select public.finish_session_pr_observation_with_merge(
    public.begin_session_pr_observation(epoch.workspace_id, epoch.repository_id, epoch.branch_name, 665),
    'https://github.com/fixture/workflow-fixture/pull/665', 'merged', false, repeat('b', 40),
    clock_timestamp(), clock_timestamp() - interval '1 millisecond', p_merge_sha, repeat('b', 40))
  from delivery_checkpoint checkpoint
  join public.session_pr_sync sync on sync.session_id = checkpoint.session_id
  join public.session_pr_epochs epoch on epoch.id = sync.current_epoch_id
$$;
select ok(pg_temp.delivery_observe_merge(repeat('c', 40)), 'the manual merge arrives as exact canonical evidence');
select ok(
  candidate->>'checkpointRunId' = checkpoint.run_id::text and candidate->>'approvalId' is not null
  and candidate->>'policyRevisionId' = policy.id::text and candidate->>'sourceRevision' = repeat('c', 40),
  'a manager can resolve the exact delivery evidence before preparing a command')
from delivery_checkpoint checkpoint cross join op651_scope scope cross join delivery_policy policy
join delivery_sources source on source.name = 'timeout'
cross join lateral public.read_factory_delivery_command_candidate(scope.workspace_id, scope.factory_id,
  pg_temp.op651_id(1), checkpoint.session_id, source.source_id) candidate;
select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout', p_override_head => gen_random_uuid())$$,
  'PT409', null, 'a stale checkpoint cannot prepare delivery');
select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout', p_override_policy => gen_random_uuid())$$,
  'PT409', null, 'a different policy revision cannot prepare delivery');
select throws_ok($$select pg_temp.delivery_prepare(250, 'timeout', p_actor => pg_temp.op651_id(2))$$,
  '42501', null, 'a workspace viewer cannot prepare a command');

create temp table delivery_intent as select pg_temp.delivery_prepare(250, 'timeout') as result;
select ok(result->>'dispatchState' = 'queued' and result->>'outcome' is null
  and result->>'approvedHeadSha' = repeat('b', 40) and result->>'sourceRevision' = repeat('c', 40),
  'the command pins both the approved head and distinct merged deployment SHA') from delivery_intent;
select is(pg_temp.delivery_prepare(250, 'timeout'), result, 'the same request replays the exact command') from delivery_intent;
select throws_ok($$select pg_temp.delivery_prepare(250, 'cancelled')$$,
  'PT409', null, 'a command ID cannot change its deployment target');
select throws_ok($$select pg_temp.delivery_prepare(251, 'timeout')$$,
  'PT409', null, 'another request ID cannot dispatch the same source to the same target');

create function pg_temp.delivery_claim(p_slot integer, p_provider text default 'fixture-ci') returns jsonb language sql as $$
  select public.claim_factory_delivery_command(workspace_id, factory_id, pg_temp.op651_id(p_slot), p_provider)
  from op651_scope
$$;
create function pg_temp.delivery_state(p_slot integer) returns jsonb language sql as $$
  select public.read_factory_delivery_command(workspace_id, factory_id, pg_temp.op651_id(1), pg_temp.op651_id(p_slot))
  from op651_scope
$$;
create function pg_temp.delivery_cancel(p_slot integer) returns jsonb language sql as $$
  select public.cancel_factory_delivery_command(workspace_id, factory_id, pg_temp.op651_id(1), pg_temp.op651_id(p_slot))
  from op651_scope
$$;
create function pg_temp.delivery_settle(p_slot integer, p_lease uuid, p_result text) returns boolean language sql as $$
  select public.settle_factory_delivery_dispatch(workspace_id, factory_id, pg_temp.op651_id(p_slot), p_lease, p_result)
  from op651_scope
$$;

select pg_temp.delivery_prepare(252, 'cancelled');
select is(pg_temp.delivery_cancel(252)->>'dispatchState', 'cancelled', 'cancellation before the claim prevents dispatch');
select is(pg_temp.delivery_claim(252), null::jsonb, 'claim loses to a committed cancellation');
select is(pg_temp.delivery_prepare(255, 'cancelled')->>'dispatchState', 'queued',
  'a manager can explicitly re-request delivery after confirmed cancellation');
select is(pg_temp.delivery_claim(250, 'wrong-provider'), null::jsonb, 'an adapter cannot claim another provider’s delivery');
create temp table delivery_lease as select pg_temp.delivery_claim(250) as packet;
select ok(packet->>'dispatchState' = 'dispatching' and packet->>'externalDeploymentId' = pg_temp.op651_id(250)::text
  and packet->>'leaseId' is not null, 'one exact lease allocates the stable external correlation ID') from delivery_lease;
select is(pg_temp.delivery_claim(250), null::jsonb, 'a second worker receives no dispatch lease');
select throws_ok($$select pg_temp.delivery_cancel(250)$$, 'PT409', null, 'cancellation loses after a worker has claimed dispatch');
select is(pg_temp.delivery_settle(250, gen_random_uuid(), 'accepted'), false, 'a stale lease cannot settle dispatch');
update internal.factory_delivery_commands set lease_expires_at = clock_timestamp() - interval '1 second'
where id = pg_temp.op651_id(250);
select is(public.expire_factory_delivery_dispatches(), 1, 'maintenance marks an interrupted dispatch unknown');
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown', 'a dispatch timeout cannot report success');
select is(pg_temp.delivery_claim(250), null::jsonb, 'an unknown dispatch is never automatically retried');
select is(pg_temp.delivery_settle(250, (packet->>'leaseId')::uuid, 'accepted'), false,
  'an expired worker reply cannot settle the dispatch') from delivery_lease;

create function pg_temp.delivery_report(p_request integer, p_slot integer, p_revision integer,
  p_environment text, p_outcome text, p_sha text) returns jsonb language plpgsql as $$
declare
  permit record;
  source uuid;
  factory uuid;
  receipt jsonb;
begin
  select source_id into strict source from delivery_sources where name = p_environment;
  select factory_id into strict factory from op651_scope;
  select * into strict permit from public.admit_factory_command(pg_temp.op651_id(11), factory, 'machine_token',
    pg_temp.op651_id(231), repeat('a', 64), 'deployments:observe', pg_temp.op651_id(p_request), repeat('b', 64), 'api');
  if permit.status <> 'admitted' then raise exception 'Could not admit observation: %', permit.status; end if;
  receipt := public.execute_factory_deployment_observation(pg_temp.op651_id(11), factory, 'machine_token',
    pg_temp.op651_id(231), repeat('a', 64), pg_temp.op651_id(p_request), repeat('b', 64), 'api',
    permit.admission_id, permit.lease_id, source, p_environment, pg_temp.op651_id(p_slot)::text, p_revision,
    p_outcome, p_sha, clock_timestamp());
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  return receipt;
end;
$$;
select pg_temp.delivery_report(260, 250, 1, 'accepted', 'succeeded', repeat('c', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown', 'another approved environment cannot reconcile the command');
select pg_temp.delivery_report(261, 250, 2, 'timeout', 'succeeded', repeat('b', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown', 'a report for the PR head cannot prove the merged deployment');
select pg_temp.delivery_report(262, 250, 3, 'timeout', 'failed', repeat('c', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'failed', 'the exact M06 deployment can resolve unknown as failure');
select pg_temp.delivery_report(263, 250, 1, 'timeout', 'succeeded', repeat('c', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'failed', 'a late superseded success cannot replace a newer failure');
create temp table delivery_observed as select pg_temp.delivery_report(264, 250, 4, 'timeout', 'succeeded', repeat('c', 40)) as result;
select ok(pg_temp.delivery_state(250)->>'outcome' = 'succeeded'
  and pg_temp.delivery_state(250)->>'deploymentObservationId' = result->>'observationId',
  'authoritative exact observation reconciles to success with its separate receipt') from delivery_observed;
select pg_temp.delivery_report(265, 250, 5, 'timeout', 'succeeded', repeat('b', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'unknown', 'a contradictory newer M06 revision invalidates previous success');
select public.revoke_factory_deployment_source(grant_row.workspace_id, grant_row.factory_id, pg_temp.op651_id(1),
  source.source_id)
from delivery_grant grant_row cross join delivery_sources source where source.name = 'timeout';
update delivery_sources source
set source_id = (public.approve_factory_deployment_source(grant_row.workspace_id, grant_row.factory_id,
  pg_temp.op651_id(1), grant_row.id, grant_row.version, 'fixture-ci', 'wallie-delivery-fixture', source.name,
  true)->>'sourceId')::uuid
from delivery_grant grant_row where source.name = 'timeout';
select pg_temp.delivery_report(266, 250, 6, 'timeout', 'succeeded', repeat('c', 40));
select is(pg_temp.delivery_state(250)->>'outcome', 'succeeded',
  'rotation of the authorized reporter preserves the original M06 deployment identity');

select pg_temp.delivery_prepare(253, 'accepted');
create temp table second_delivery_lease as select pg_temp.delivery_claim(253) as packet;
select ok(pg_temp.delivery_settle(253, (packet->>'leaseId')::uuid, 'accepted'),
  'the exact worker lease can record provider acceptance') from second_delivery_lease;
select is(pg_temp.delivery_state(253)->>'outcome', 'pending', 'provider acceptance is still awaiting deployment outcome');

select pg_temp.delivery_prepare(254, 'stale');
select ok(pg_temp.delivery_observe_merge(repeat('d', 40)), 'a newer canonical fact supersedes the original merge');
select is(pg_temp.delivery_claim(254), null::jsonb, 'claim checks merge identity again after preparation');
select is(pg_temp.delivery_state(254)->>'dispatchState', 'blocked', 'stale source command settles without side effects');
select ok(not has_table_privilege('authenticated', 'internal.factory_delivery_commands', 'select')
  and not has_function_privilege('authenticated', 'public.claim_factory_delivery_command(uuid,uuid,uuid,text)', 'execute'),
  'an authenticated browser cannot access worker authority or provider leases directly');

-- Independent connections see the same committed, scoped test commands.
select pg_temp.delivery_prepare(256, 'stale');
select pg_temp.delivery_prepare(257, 'accepted');
select public.set_git_continuity_release(false, gate.revision, 'Restore release gate after guarded delivery setup')
from public.get_git_continuity_release_state() gate cross join delivery_release_before prior
where gate.enabled and not prior.enabled;
commit;
begin;
set local request.jwt.claim.role = 'service_role';

select extensions.dblink_connect(connection, coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'))
from unnest(array['op665_manager', 'op665_worker']) connection;
select extensions.dblink_exec(connection, 'set statement_timeout = ''15s''; set request.jwt.claim.role = ''service_role''')
from unnest(array['op665_manager', 'op665_worker']) connection;
create temp table delivery_worker_backend as
select pid from extensions.dblink('op665_worker', 'select pg_backend_pid()') result(pid integer);

select extensions.dblink_exec('op665_manager', 'begin');
select is(state, 'cancelled', 'the manager holds the cancellation open')
from op651_scope scope cross join lateral extensions.dblink('op665_manager', format(
  'select public.cancel_factory_delivery_command(%L,%L,%L,%L)->>''dispatchState''',
  scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), pg_temp.op651_id(256))) result(state text);
select extensions.dblink_send_query('op665_worker', format(
  'select public.claim_factory_delivery_command(%L,%L,%L,''fixture-ci'') is null',
  workspace_id, factory_id, pg_temp.op651_id(256)))
from op651_scope;
create function pg_temp.delivery_wait_for_lock(p_backend integer) returns boolean language plpgsql as $$
begin
  for attempt in 1..100 loop
    if cardinality(pg_blocking_pids(p_backend)) > 0 then return true; end if;
    perform pg_sleep(0.02);
  end loop;
  return false;
end;
$$;
select ok(pg_temp.delivery_wait_for_lock(pid), 'a concurrent claim reaches the cancellation lock')
from delivery_worker_backend;
select extensions.dblink_exec('op665_manager', 'commit');
select ok(skipped, 'the competing worker receives no lease after the cancellation commits')
from extensions.dblink_get_result('op665_worker') result(skipped boolean);
select count(*) from extensions.dblink_get_result('op665_worker') result(skipped boolean);

select extensions.dblink_exec('op665_manager', 'begin');
select locked from extensions.dblink('op665_manager', format(
  'select id from public.github_installations where id = %L for no key update',
  pg_temp.op651_id(33))) result(locked uuid);
select throws_ok($$select pg_temp.delivery_claim(257)$$, '55P03', null,
  'a real competing installation writer postpones the authority check');
select is(pg_temp.delivery_state(257)->>'dispatchState', 'queued', 'a temporary grant fence leaves the command queued');
select extensions.dblink_exec('op665_manager', 'rollback');
select is(pg_temp.delivery_claim(257)->>'dispatchState', 'dispatching', 'the same command claims after the grant lock clears');

select extensions.dblink_disconnect(connection) from unnest(array['op665_manager', 'op665_worker']) connection;
delete from public.workspaces where id = pg_temp.op651_id(11);
delete from auth.users where id in (pg_temp.op651_id(1), pg_temp.op651_id(2));
select * from finish();
commit;
