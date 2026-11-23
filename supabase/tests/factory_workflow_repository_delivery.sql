begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65310000
\set op651_open_groups false
\set op651_parallel_only true
\set op652_join_evidence true
\ir fixtures/factory_workflow_branch.psql

-- The machine root source remains the primary repository. The graph registration
-- below binds the secondary writer and profile without altering the enrolled control.
create temp table multi_root as
select scope.*, session.*,
  pg_temp.adopt_source_checkpoint(session."sessionId", session."jobId") as checkpoint_run_id
from op651_scope scope
cross join lateral jsonb_to_record(pg_temp.op651_create_service_root(260, 'Multi-repository parent')) session(
  "sessionId" uuid, "jobId" uuid, "runId" uuid);
create temp table secondary_grant as
select approved.* from grant_scope scope
cross join lateral public.approve_factory_execution_grant(scope.workspace_id, scope.factory_id, pg_temp.op651_id(1),
  scope.id, pg_temp.op651_id(62), '{}'::uuid[], '{}'::text[], scope.policy_id, pg_temp.op651_id(21),
  clock_timestamp() + interval '1 hour', 0, null, '{sessions:create}'::public.factory_command_scope[]) approved;
insert into public.workspace_secrets (id, workspace_id, key, encrypted_value)
values (pg_temp.op651_id(78), pg_temp.op651_id(11), 'OP653_SECONDARY', 'fixture-ciphertext');

create temp table secondary_definition as
select grant_row.workspace_id, grant_row.factory_id, pg_temp.op651_id(48) as id,
  ((narrow.body::jsonb - 'readContextRepositoryIds') || jsonb_build_object(
    'repositoryId', grant_row.github_repository_id, 'credentialBindingId', binding.id,
    'executionGrant', jsonb_build_object('id', grant_row.id, 'version', grant_row.version)))::text as body
from secondary_grant grant_row
join scoped_revisions narrow on narrow.scenario = 'narrow'
join public.factory_agent_prompt_revisions prompt on prompt.id = pg_temp.op651_id(91)
cross join lateral public.create_factory_secret_binding(grant_row.workspace_id, grant_row.factory_id, pg_temp.op651_id(1),
  grant_row.id, grant_row.version, prompt.agent_id, 'codex', pg_temp.op651_id(78)) binding;
insert into public.factory_definition_revisions (id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
select id, workspace_id, factory_id, 1, body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.op651_id(21)
from secondary_definition;
insert into public.factory_definition_activations (workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 6, pg_temp.op651_id(21) from secondary_definition;

create temp table multi_graph as
select jsonb_set(jsonb_set(jsonb_set(jsonb_set(graph.body::jsonb,
  '{nodes,2,grantId}', to_jsonb(writer.id)), '{edges,1,required}', 'true'::jsonb),
  '{delegationPolicy,targets,agent.optional}', jsonb_build_object(
    'definitionRevisionId', revision.id, 'definitionDigest', revision.canonical_digest)),
  '{grants}', graph.body::jsonb->'grants' || jsonb_build_array(jsonb_build_object('id', writer.id, 'version', writer.version)))
  || jsonb_build_object('repositorySets', jsonb_build_object('join.finish', jsonb_build_array(jsonb_build_object(
    'repositoryId', writer.github_repository_id, 'writerGrant', jsonb_build_object('id', writer.id, 'version', writer.version),
    'branchEdgeIds', jsonb_build_array('run.optional'))))) as body
from branch_graphs graph cross join secondary_grant writer
join public.factory_definition_revisions revision on revision.id = pg_temp.op651_id(48)
where graph.scenario = 'parallel';

create function pg_temp.register_repository_graph(p_body jsonb) returns uuid language sql as $$
  select registered.graph_revision_id from multi_root root
  join public.session_factory_admission_inputs pin on pin.session_id = root."sessionId"
  cross join lateral public.register_factory_workflow_graph_revision(root.workspace_id, root.factory_id,
    pin.definition_revision_id, pin.definition_digest, p_body::text,
    encode(sha256(convert_to(p_body::text, 'UTF8')), 'hex')) registered
$$;
select throws_ok($$select pg_temp.register_repository_graph(
  jsonb_set(body, '{repositorySets,join.finish,0,repositoryId}', to_jsonb(pg_temp.op651_id(63)))) from multi_graph$$,
  '42501', 'Execution grant is unavailable or does not authorize these resources.',
  'a live repository in the same factory cannot substitute for the declared writer repository');
select throws_ok($$select pg_temp.register_repository_graph(
  jsonb_set(body, '{repositorySets,join.finish,0,branchEdgeIds}', '["run.optional","run.required"]')) from multi_graph$$,
  '22023', 'The assigned branch must declare its repository writer.',
  'repository writers cannot absorb another branch without its explicit authority');
create temp table multi_owner as
select root.*, graph.id as graph_revision_id, started.*
from multi_root root cross join lateral (select pg_temp.register_repository_graph(body) id from multi_graph) graph
cross join lateral public.start_factory_workflow_graph_execution(root."sessionId", root.workspace_id, root.factory_id,
  graph.id, root.checkpoint_run_id) started;
select ok((select writer.branch_edge_ids = array['run.optional'] from internal.factory_workflow_repository_writers writer
  join multi_owner owner on owner.graph_revision_id = writer.graph_revision_id),
  'registration projects the exact secondary assignment from compiled bytes');

create temp table multi_group as
select groups.* from multi_owner owner
cross join lateral public.open_factory_workflow_branch_group(owner."sessionId", owner.workspace_id, owner.factory_id,
  owner.execution_generation, owner.ownership_token, owner.entry_occurrence_id, owner.checkpoint_run_id) groups;
create function pg_temp.multi_admit(p_edge text) returns table(child_session_id uuid, job_id uuid, run_id uuid)
language sql as $$
  select scope.child_session_id, scope.job_id, scope.run_id from multi_owner owner cross join multi_group grp
  cross join lateral public.admit_factory_workflow_branch_slot(owner."sessionId", owner.workspace_id, owner.factory_id,
    owner.execution_generation, owner.ownership_token, grp.group_id, p_edge) scope
$$;
select is((select count(*) from pg_temp.multi_admit('run.optional')), 0::bigint,
  'a secondary branch waits for its repository base observation');
create temp table observed_repository as select * from public.list_factory_workflow_branch_repository_bases();
select is((select repository_id from observed_repository), pg_temp.op651_id(62),
  'the observation worker receives only the declared and authorized repository');
create function pg_temp.pin_repository_base(p_numeric bigint, p_sha text) returns boolean language sql as $$
  select public.pin_factory_workflow_branch_repository_base(root_session_id, workspace_id, factory_id, group_id, generation,
    repository_id, installation_id, installation_numeric_id, p_numeric, base_branch, p_sha) from observed_repository
$$;
select is((select pg_temp.pin_repository_base(repository_numeric_id + 1, repeat('1',40)) from observed_repository), false,
  'an observed ref in another numeric repository cannot pin the base');
select ok((select pg_temp.pin_repository_base(repository_numeric_id, repeat('1',40)) from observed_repository),
  'the exact observed secondary base can be pinned');
select is((select pg_temp.pin_repository_base(repository_numeric_id, repeat('9',40)) from observed_repository), false,
  'a later observation cannot repin the manifest to another commit');

create temp table multi_children(edge text, child_session_id uuid, job_id uuid, run_id uuid);
insert into multi_children select 'run.required', * from pg_temp.multi_admit('run.required');
insert into multi_children select 'run.optional', * from pg_temp.multi_admit('run.optional');
select is((select count(*) from multi_children), 2::bigint, 'both selected repositories receive a production child');
select results_eq(
  $$select input.repository_id, input.input_sha from multi_children child join public.session_job_git_inputs input on input.job_id = child.job_id order by child.edge$$,
  $$values (pg_temp.op651_id(62), repeat('1',40)), (pg_temp.op651_id(34), repeat('a',40))$$,
  'the branch attempts inherit their own exact repository base while preserving causal parent ancestry');

create function pg_temp.record_multi_evidence(p_run uuid, p_commit text, p_tree text) returns void language plpgsql as $$
begin
  perform public.pin_session_validation_plan(p_run, p_commit, p_tree,
    '{"version":1,"commands":[{"key":"tests","command":"git status --porcelain","timeoutSeconds":30,"reports":[]}]}');
  perform public.record_session_validation_evidence(p_run,p_commit,p_tree,
    jsonb_build_array(jsonb_build_object('key','tests','command','git status --porcelain','provenance','harness',
      'status','passed','exitCode',0,'startedAt',clock_timestamp(),'completedAt',clock_timestamp(),
      'commitSha',p_commit,'treeSha',p_tree,'finalCommitSha',p_commit,'finalTreeSha',p_tree,
      'reportKeys','[]'::jsonb,'missingRequiredReports','[]'::jsonb)));
end;
$$;

create function pg_temp.retain_multi_branch(p_edge text, p_output text) returns uuid language plpgsql as $$
declare
  child record;
  root record;
  input public.session_job_git_inputs;
  artifact_run uuid;
  publication_lease uuid;
  checkpoint_ref text;
  outcome_id uuid;
  bundle bytea := convert_to('retained multi-repository Git fixture','UTF8');
begin
  select * into strict child from multi_children where edge = p_edge;
  select * into strict root from multi_owner cross join multi_group;
  select * into strict input from public.session_job_git_inputs where job_id = child.job_id;
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
  where id = child.job_id;
  artifact_run := public.start_session_job_attempt(child.job_id, 1, pg_temp.op651_id(32), 0,
    'codex', 'gpt-5.5', 'code', 'wallie/op653-branch-' || child.job_id);
  perform public.pin_session_job_git_input(child.job_id, 1, artifact_run, input.repository_id, input.base_branch, input.input_sha);
  perform pg_temp.record_multi_evidence(artifact_run, p_output, repeat('e',40));
  if not public.prepare_session_source_and_checkpoint_publication(artifact_run,input.repository_id,input.base_branch,
    input.input_sha,p_output,'Component output','Retained branch work','',encode(sha256(bundle),'hex'),encode(bundle,'base64'),
    0,'Private branch output') then raise exception 'The component output could not be prepared.'; end if;
  publication_lease := public.claim_session_checkpoint_publication(artifact_run);
  select publication.retained_ref into strict checkpoint_ref from public.session_checkpoint_publications publication where publication.run_id = artifact_run;
  if not public.adopt_session_checkpoint_publication(artifact_run,publication_lease,checkpoint_ref,p_output)
    then raise exception 'The component output could not be adopted.'; end if;
  perform pg_temp.approve_branch(child.child_session_id);
  select outcome.outcome_id into strict outcome_id from public.record_factory_workflow_branch_outcome(
    root."sessionId",root.workspace_id,root.factory_id,root.execution_generation,root.ownership_token,root.group_id,
    p_edge,child.job_id,1,artifact_run) outcome;
  return outcome_id;
end;
$$;

create temp table multi_outcomes as
select pg_temp.retain_multi_branch('run.required', repeat('b',40)) as primary_id,
  pg_temp.retain_multi_branch('run.optional', repeat('2',40)) as secondary_id;
create temp table multi_join as
select public.enqueue_factory_workflow_join_for_user(owner."sessionId",owner.workspace_id,owner.factory_id,
  pg_temp.op651_id(1),owner.execution_generation,pg_temp.op651_id(261),grp.group_id,owner.checkpoint_run_id,
  array[outcome.primary_id, outcome.secondary_id]) as receipt
from multi_owner owner cross join multi_group grp cross join multi_outcomes outcome;

create function pg_temp.multi_status() returns jsonb language sql as $$
  select public.read_factory_workflow_repository_delivery(owner."sessionId", owner.workspace_id, owner.factory_id,
    (receipt->>'joinId')::uuid) from multi_owner owner cross join multi_join
$$;
select is(pg_temp.multi_status()->>'status', 'pending', 'join admission persists the full delivery obligation before any worker starts');
select is((pg_temp.multi_status() #>> '{repositories,0,baseSha}'), repeat('1',40), 'delivery retains the exact branch-set base');

create function pg_temp.claim_multi_join() returns jsonb language plpgsql as $$
declare job public.agent_jobs;
begin
  select * into strict job from public.claim_next_agent_job(false,3,'node');
  return public.start_factory_workflow_join_attempt(job.id,job.workspace_id,job.session_id,
    job.attempt_count,clock_timestamp()+interval '10 minutes');
end;
$$;
create temp table primary_claim as select pg_temp.claim_multi_join() as claim;
select is((select claim->>'kind' from primary_claim), 'started', 'the queue starts the primary integration with its typed claim');
select ok((select public.record_active_factory_workflow_join_candidate(
  (claim->>'rootSessionId')::uuid,(claim->>'workspaceId')::uuid,(claim->>'factoryId')::uuid,
  (claim->>'generation')::bigint,(claim->>'ownershipToken')::uuid,(claim->>'joinId')::uuid,
  (claim->>'jobId')::uuid,(claim->>'runId')::uuid,(claim->>'attemptCount')::integer,
  repeat('a',40),repeat('3',40)) from primary_claim), 'the primary integration retains its exact candidate');
select pg_temp.record_multi_evidence((claim->>'runId')::uuid,repeat('a',40),repeat('3',40)) from primary_claim;
select ok((select public.prepare_session_source_and_checkpoint_publication((claim->>'runId')::uuid,pg_temp.op651_id(34),'main',
  repeat('a',40),repeat('a',40),'Integrated primary','Primary validation','','','',
  (claim->>'artifactVersion')::integer,'Integrated primary output.',(claim->>'deadlineAt')::timestamptz) from primary_claim),
  'the primary checkpoint outbox opens normally');
create temp table primary_lease as
select (claim->>'runId')::uuid as run_id, public.claim_session_checkpoint_publication((claim->>'runId')::uuid) as lease from primary_claim;
select ok((select public.adopt_session_checkpoint_publication(run_id,lease,null,null) from primary_lease),
  'the parent can adopt the validated primary while the secondary is pending');
select is(pg_temp.multi_status()->>'status', 'partial', 'a primary adoption with unfinished secondary delivery is visibly partial');
select ok(not exists(select 1 from internal.factory_workflow_node_results r join multi_join q
  on r.occurrence_id = (q.receipt->>'occurrenceId')::uuid), 'partial delivery cannot continue the graph');

select is(public.dispatch_next_factory_workflow_repository_validation(), true,
  'production dispatch admits a dedicated exact secondary validation job');
create temp table secondary_claim as select pg_temp.claim_multi_join() as claim;
select is((select claim->>'kind' from secondary_claim), 'repository', 'the worker dispatches the exact secondary job through its typed entry');
select is((select claim->>'repositoryId' from secondary_claim), pg_temp.op651_id(62)::text,
  'its writable identity comes from the declared secondary writer');
select is((select claim->>'baseSha' from secondary_claim), repeat('1',40), 'typed validation owns the immutable secondary Git base');

create function pg_temp.finish_multi_validation() returns boolean language sql as $$
  select public.finish_factory_workflow_repository_validation(
    (claim->>'rootSessionId')::uuid,(claim->>'workspaceId')::uuid,(claim->>'factoryId')::uuid,
    (claim->>'generation')::bigint,(claim->>'ownershipToken')::uuid,(claim->>'joinId')::uuid,
    (claim->>'repositoryId')::uuid,(claim->>'jobId')::uuid,(claim->>'runId')::uuid,(claim->>'attemptCount')::integer,
    'passed',repeat('4',40),repeat('5',40),encode(sha256(convert_to('secondary validation bundle','UTF8')),'hex'),
    encode(convert_to('secondary validation bundle','UTF8'),'base64')) from secondary_claim
$$;
select is(pg_temp.finish_multi_validation(), false, 'a branch validation receipt cannot authorize the new joined tree');
select pg_temp.record_multi_evidence((claim->>'runId')::uuid, repeat('4',40), repeat('5',40)) from secondary_claim;
select is(pg_temp.finish_multi_validation(), true, 'the exact passing secondary run durably seals its own candidate');
select is(pg_temp.multi_status() #>> '{repositories,0,validationRunId}', (select claim->>'runId' from secondary_claim),
  'the delivery read preserves the validation identity without exposing the lease');

create function pg_temp.claim_secondary_delivery() returns jsonb language sql as $$
  select public.claim_factory_workflow_repository_delivery(root_session_id,workspace_id,factory_id,generation,ownership_token,
    join_id,repository_id) from public.list_factory_workflow_repository_deliveries()
$$;
create function pg_temp.settle_secondary_delivery(p_lease jsonb,p_action text,p_remote_sha text default null)
returns text language sql as $$
  select public.settle_factory_workflow_repository_delivery(
    owner."sessionId",owner.workspace_id,owner.factory_id,owner.execution_generation,owner.ownership_token,
    (receipt->>'joinId')::uuid,pg_temp.op651_id(62),(p_lease->>'leaseId')::uuid,p_action,
    (p_lease#>>'{target,repository_numeric_id}')::bigint,p_lease#>>'{intent,retained_ref}',p_remote_sha)
  from multi_owner owner cross join multi_join
$$;

create temp table first_secondary_lease as select pg_temp.claim_secondary_delivery() as claim;
select is(pg_temp.claim_secondary_delivery(), null::jsonb, 'an exact live publication lease cannot be concurrently replaced');
select is((select pg_temp.settle_secondary_delivery(claim,'adopt',repeat('9',40)) from first_secondary_lease),
  'proof_mismatch', 'an incompatible remote SHA cannot be adopted');
create function pg_temp.probe_rejected_repository_delivery(p_case text)
returns text language plpgsql as $$
declare
  result text;
  lease jsonb;
  writer public.factory_execution_grants;
begin
  select claim into strict lease from first_secondary_lease;
  if p_case = 'revoked' then
    select value.* into strict writer from secondary_grant value;
    perform public.revoke_factory_execution_grant(writer.workspace_id, writer.factory_id,
      pg_temp.op651_id(1), writer.id, writer.version, null);
    result := pg_temp.settle_secondary_delivery(lease, 'adopt', repeat('4',40));
  elsif p_case = 'stale' then
    update internal.factory_workflow_secondary_repository_heads set receipt_id = gen_random_uuid()
    where repository_id = pg_temp.op651_id(62);
    result := pg_temp.settle_secondary_delivery(lease, 'adopt', repeat('4',40));
  else
    result := pg_temp.settle_secondary_delivery(lease, 'incompatible_ref', repeat('9',40));
    if not exists (select 1 from internal.factory_workflow_repository_delivery_state
      where blocker = 'incompatible_ref' and observed_conflicting_sha = repeat('9',40)) then
      result := 'missing_conflict_proof';
    end if;
  end if;
  raise exception using errcode = 'P7777', message = 'Revert the isolated negative probe.';
exception when sqlstate 'P7777' then
  return result;
end;
$$;
select is(pg_temp.probe_rejected_repository_delivery('revoked'), 'authority_unavailable',
  'revoking the actual repository grant prevents an exact existing lease from adopting');
select is(pg_temp.probe_rejected_repository_delivery('stale'), 'stale_repository_head',
  'the same commit under a newer head receipt cannot satisfy causal adoption');
select is(pg_temp.probe_rejected_repository_delivery('incompatible'), 'incompatible_ref',
  'the ledger retains exact conflicting ref evidence for reconciliation');
select is((select pg_temp.settle_secondary_delivery(claim,'retry') from first_secondary_lease),
  'publication_unavailable', 'transient remote failure retains immutable validated bytes and releases its lease');
select is(pg_temp.multi_status() #>> '{repositories,0,blocker}', 'publication_unavailable',
  'publication failure surfaces as a recoverable repository-specific obligation');
update internal.factory_workflow_repository_delivery_state set next_attempt_at = clock_timestamp()
where status = 'pending';
create temp table second_secondary_lease as select pg_temp.claim_secondary_delivery() as claim;
select ok((select first.claim->>'leaseId' <> second.claim->>'leaseId'
  and first.claim->'intent' = second.claim->'intent' from first_secondary_lease first cross join second_secondary_lease second),
  'restart claims the same retained ref and candidate with a new lease');
select is((select pg_temp.settle_secondary_delivery(claim,'adopt',repeat('4',40)) from first_secondary_lease),
  'stale_lease', 'the earlier worker cannot adopt the exact candidate after recovery replaced its lease');
select is((select pg_temp.settle_secondary_delivery(claim,'adopt',repeat('4',40)) from second_secondary_lease),
  'adopted', 'the new worker can adopt the same verified repository ref');
select is(pg_temp.multi_status()->>'status', 'adopted', 'the parent reports complete only after all repositories are adopted');
select ok(exists(select 1 from internal.factory_workflow_node_results r join multi_join q
  on r.occurrence_id = (q.receipt->>'occurrenceId')::uuid where r.outcome = 'succeeded'),
  'the last repository adoption publishes exactly one causal join result');

select * from finish();
rollback;
