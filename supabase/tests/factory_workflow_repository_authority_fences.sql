begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
\set op651_fixture_namespace 65350000
\set op653_test_validation_seconds 600
\ir fixtures/factory_workflow_repository_delivery.psql

create temp table inactive_secondary_profile as
with inserted as (
  insert into public.factory_definition_revisions (
    id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
  )
  select pg_temp.op651_id(49), workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
  from public.factory_definition_revisions where id = pg_temp.op651_id(48)
  returning id, workspace_id, factory_id, canonical_digest, created_by
)
select inserted.*, jsonb_set(multi_graph.body, '{delegationPolicy,targets,agent.optional}',
  jsonb_build_object('definitionRevisionId', inserted.id, 'definitionDigest', inserted.canonical_digest)) as graph
from inserted cross join multi_graph;
select throws_ok(
  $$select pg_temp.register_repository_graph(graph) from inactive_secondary_profile$$,
  '42501', 'The frozen branch profile does not own the declared repository writer.',
  'an activated revision with identical bytes does not authorize a different, inactive profile ID'
);
insert into public.factory_definition_activations (workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 7, created_by from inactive_secondary_profile;
select ok((select pg_temp.register_repository_graph(graph) is not null from inactive_secondary_profile),
  'the exact secondary profile can be pinned once activated');

create temp table revoked_observation_writer as
select approved.* from grant_scope scope
cross join lateral public.approve_factory_execution_grant(
  scope.workspace_id, scope.factory_id, pg_temp.op651_id(1), scope.id, pg_temp.op651_id(63),
  '{}'::uuid[], '{}'::text[], scope.policy_id, pg_temp.op651_id(21), clock_timestamp() + interval '1 hour',
  0, null, '{sessions:create}'::public.factory_command_scope[]
) approved;
select public.revoke_factory_execution_grant(workspace_id, factory_id, pg_temp.op651_id(1), id, version, null)
from revoked_observation_writer;
insert into internal.factory_workflow_repository_writers (
  graph_revision_id, join_node_id, repository_id, branch_edge_ids, grant_id, grant_version
)
select owner.graph_revision_id, 'join.revoked', writer.github_repository_id, array['run.revoked'], writer.id, writer.version
from multi_owner owner cross join revoked_observation_writer writer;

-- Fill the front of the actual ordered batch with outstanding observations
-- whose frozen grant has been revoked. Reuse the enrolled root and its base.
create temp table revoked_observation_occurrences as
with seeded as (
  insert into internal.factory_workflow_node_occurrences (root_session_id, node_id, node_kind, admitted_generation)
  select owner."sessionId", 'branch.split', 'branch', owner.execution_generation
  from multi_owner owner cross join generate_series(1,16)
  returning root_session_id, occurrence_id
)
select * from seeded;
insert into internal.factory_workflow_branch_groups (
  root_session_id, branch_occurrence_id, workspace_id, factory_id, parent_session_id, source_checkpoint_run_id,
  repository_id, repository_full_name, base_branch, initial_base_sha, input_sha, input_ref, join_node_id, created_generation
)
select original.root_session_id, revoked.occurrence_id, original.workspace_id, original.factory_id, original.parent_session_id,
  original.source_checkpoint_run_id, original.repository_id, original.repository_full_name, original.base_branch,
  original.initial_base_sha, original.input_sha, original.input_ref, 'join.revoked', original.created_generation
from internal.factory_workflow_branch_groups original
join multi_group scoped using (group_id)
join revoked_observation_occurrences revoked using (root_session_id);
update internal.factory_workflow_branch_dispatches dispatch set due_at = clock_timestamp() - interval '1 hour'
from revoked_observation_occurrences revoked
where (dispatch.root_session_id, dispatch.branch_occurrence_id) = (revoked.root_session_id, revoked.occurrence_id);

create temp table observed_secondary_base as
select pin.* from internal.factory_workflow_branch_repository_bases pin join multi_group scoped using (group_id);
delete from internal.factory_workflow_branch_repository_bases pin using multi_group scoped where pin.group_id = scoped.group_id;
select results_eq(
  $$select listed.group_id, listed.repository_id from public.list_factory_workflow_branch_repository_bases() listed
    cross join multi_owner owner where listed.root_session_id = owner."sessionId"$$,
  $$select group_id, pg_temp.op651_id(62) from multi_group$$,
  'sixteen revoked observations ahead of an authorized repository cannot consume the batch'
);
insert into internal.factory_workflow_branch_repository_bases select * from observed_secondary_base;

select ok(pg_temp.finish_multi_validation(), 'the validated repository has a sealed publication intent');
create temp table expiring_publication as
select due.*, public.claim_factory_workflow_repository_delivery(
  due.root_session_id,due.workspace_id,due.factory_id,due.generation,due.ownership_token,due.join_id,due.repository_id
) as claim
from public.list_factory_workflow_repository_deliveries() due
join multi_owner owner on owner."sessionId" = due.root_session_id;
update internal.factory_workflow_repository_delivery_state state
set claim_until = clock_timestamp() + interval '6 seconds'
from expiring_publication exact
where (state.root_session_id,state.join_id,state.repository_id,state.claim_id) =
  (exact.root_session_id,exact.join_id,exact.repository_id,(exact.claim->>'leaseId')::uuid);
commit;
set request.jwt.claim.role = 'service_role';

create function pg_temp.test_repository_lease_expiry_after_fence() returns setof text language plpgsql as $$
declare
  connection_info text := coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres');
  holder text := 'op653_publication_evidence_holder';
  worker text := 'op653_publication_lease_worker';
  peer text;
  captured record;
  verify_sql text;
  cutoff timestamptz;
  waited boolean;
  result text;
begin
  select * into strict captured from expiring_publication;
  select state.claim_until into strict cutoff
  from internal.factory_workflow_repository_delivery_state state
  where state.claim_id = (captured.claim->>'leaseId')::uuid;

  foreach peer in array array[holder,worker] loop
    perform extensions.dblink_connect(peer, connection_info);
    perform extensions.dblink_exec(peer, format(
      'set application_name=%L; set statement_timeout=%L; set request.jwt.claim.role=%L', peer, '20s', 'service_role'
    ));
  end loop;
  perform extensions.dblink_exec(holder, 'begin; lock table public.session_validation_plans in access exclusive mode');
  verify_sql := format(
    'select public.settle_factory_workflow_repository_delivery(%L::uuid,%L::uuid,%L::uuid,%L::bigint,%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L)',
    captured.root_session_id, captured.workspace_id, captured.factory_id, captured.generation, captured.ownership_token,
    captured.join_id, captured.repository_id, captured.claim->>'leaseId', 'verify'
  );
  perform extensions.dblink_send_query(worker, verify_sql);
  loop
    select exists (
      select 1 from pg_stat_activity active
      cross join lateral unnest(pg_blocking_pids(active.pid)) blockers(blocker)
      join pg_stat_activity owning on owning.pid = blockers.blocker
      where active.datname = current_database() and active.application_name = worker and owning.application_name = holder
    ) into waited;
    exit when waited or clock_timestamp() >= cutoff;
    perform pg_sleep(0.02);
  end loop;
  return next ok(waited, 'the current publication checks its validation evidence while holding the root lock');
  perform pg_sleep(greatest(0, extract(epoch from cutoff - clock_timestamp())) + 0.05);
  perform extensions.dblink_exec(holder, 'commit');
  select value into strict result from extensions.dblink_get_result(worker) status(value text);
  return next is(result, 'stale_lease', 'waiting for the fence cannot authorize a write after lease expiry');
exception when others then
  return next fail(format('independent publication transactions failed (%s): %s', SQLSTATE, SQLERRM));
end;
$$;
select * from pg_temp.test_repository_lease_expiry_after_fence();
select extensions.dblink_disconnect(name) from unnest(extensions.dblink_get_connections()) name
where name in ('op653_publication_evidence_holder', 'op653_publication_lease_worker');

begin;
delete from public.workspaces where id = pg_temp.op651_id(11);
delete from auth.users where id = pg_temp.op651_id(1);
select ok(not exists (select 1 from public.workspaces where id = pg_temp.op651_id(11))
  and not exists (select 1 from auth.users where id = pg_temp.op651_id(1)),
  'cleanup removes the exact committed fixture');
select * from finish();
commit;
