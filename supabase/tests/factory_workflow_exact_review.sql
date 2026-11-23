begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65410000
\set op651_open_groups false
\set op651_parallel_only true
\set op652_join_evidence true
\ir fixtures/factory_workflow_branch.psql

create function pg_temp.record_join_validation(p_run uuid,p_commit text,p_tree text,p_pass boolean)
returns void language plpgsql as $$
begin
  perform public.pin_session_validation_plan(p_run,p_commit,p_tree,
    '{"version":1,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":30,"reports":[]}]}');
  perform public.record_session_validation_evidence(p_run,p_commit,p_tree,
    jsonb_build_array(jsonb_build_object('key','tests','command','pnpm test','provenance','harness',
      'status',case when p_pass then 'passed' else 'failed' end,'exitCode',case when p_pass then 0 else 1 end,
      'startedAt',clock_timestamp(),'completedAt',clock_timestamp(),'commitSha',p_commit,'treeSha',p_tree,
      'finalCommitSha',p_commit,'finalTreeSha',p_tree,'reportKeys','[]'::jsonb,'missingRequiredReports','[]'::jsonb)));
end;
$$;

create function pg_temp.prepare_join(p_claim jsonb,p_commit text)
returns boolean language sql as $$
  select public.prepare_session_source_and_checkpoint_publication((p_claim->>'runId')::uuid,pg_temp.op651_id(34),'main',
    repeat('a',40),p_commit,'Integrated output','Parent integration','',
    encode(sha256(convert_to('Joined bundle fixture','UTF8')),'hex'),encode(convert_to('Joined bundle fixture','UTF8'),'base64'),
    (p_claim->>'artifactVersion')::integer,'Joined output with exact validation.',(p_claim->>'deadlineAt')::timestamptz)
$$;

create temp table triage_branch_graph as
select pin.workspace_id, pin.factory_id, pin.definition_revision_id, graph_digest.digest, registered.graph_revision_id
from branch_owner ordinary
join public.session_factory_admission_inputs pin on pin.session_id = ordinary."sessionId"
join branch_graphs graph on graph.scenario = ordinary.scenario
cross join lateral (select graph.body::jsonb as plan) source
cross join lateral (select (source.plan || jsonb_build_object(
  'entryNodeId', 'scope.approved',
  'nodes', jsonb_build_array(jsonb_build_object('id', 'scope.approved', 'kind', 'human-gate',
    'anyoneCanApprove', false, 'approverMemberIds', jsonb_build_array(pg_temp.op651_id(21))),
    jsonb_build_object('id', 'review.final', 'kind', 'review', 'reviewerPromptRevisionId', pg_temp.op651_id(91),
      'ruleIds', '["scope","tests"]'::jsonb, 'repair', '{"edgeId":"review.repair","maxRepairs":2,"eligibleRuleIds":["scope"]}'::jsonb),
    jsonb_build_object('id', 'human.final', 'kind', 'human-gate', 'anyoneCanApprove', false,
      'approverMemberIds', jsonb_build_array(pg_temp.op651_id(21)))) || (source.plan->'nodes'),
  'edges', jsonb_build_array(jsonb_build_object('id', 'scope.fork', 'kind', 'next',
    'from', 'scope.approved', 'to', 'branch.split'),
    '{"id":"inspect.join","kind":"next","from":"join.finish","to":"review.final"}'::jsonb,
    '{"id":"human.review","kind":"next","from":"review.final","to":"human.final"}'::jsonb) || (source.plan->'edges'),
  'delegationPolicy', (source.plan->'delegationPolicy') || '{"maxAttempts":12}'::jsonb))::text as body) triage
cross join lateral (select encode(sha256(convert_to(triage.body, 'UTF8')), 'hex') as digest) graph_digest
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id,
  pin.definition_revision_id, pin.definition_digest, triage.body, graph_digest.digest) registered
 where ordinary.scenario='parallel';

select ok((select configured.created from triage_branch_graph graph
  cross join lateral public.configure_factory_workflow_triage(graph.workspace_id, graph.factory_id,
    pg_temp.op651_id(1), graph.definition_revision_id, graph.graph_revision_id, graph.digest,
    pg_temp.op651_id(32), 0) configured), 'a manager configures a triage gate before a fork');

create temp table triage_branch_root as
select graph.*, created.session_id, created.job_id
from triage_branch_graph graph
join public.factory_definition_revisions revision on revision.id = graph.definition_revision_id
cross join lateral public.create_session_command_once(graph.workspace_id, pg_temp.op651_id(21),
  pg_temp.op651_id(901), repeat('c', 64), revision.canonical_digest, 'Invite contractors',
  'Invite contractors in the first wave.', 'codex', 'gpt-5.5', '{}',
  selected_stage_ids => array[pg_temp.op651_id(32)], target_factory_id => graph.factory_id,
  draft_specification => true) created;

update public.agent_jobs job set status = 'running', attempt_count = 1,
  git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
from triage_branch_root root where job.id = root.job_id;
create temp table triage_branch_run as
select root.*, public.start_session_job_attempt(root.job_id, 1, pg_temp.op651_id(32), 0,
  'codex', 'gpt-5.5', 'code', 'wallie/op651-triage-' || root.job_id) as run_id
from triage_branch_root root;
select ok((select count(*) = 1 from triage_branch_run root
  cross join lateral public.pin_session_job_git_input(root.job_id, 1, root.run_id, pg_temp.op651_id(34),
    'main', repeat('a', 40))), 'the running specification pins the exact source');

select frozen.manifest_sha256 from triage_branch_run root
join public.session_factory_admission_inputs input on input.session_id = root.session_id
cross join lateral (select octet_length(input.original_prompt_md) as bytes) prompt
cross join lateral public.pin_factory_run_context(root.workspace_id, root.job_id, root.run_id, 1,
  jsonb_build_object('version', 1, 'required', jsonb_build_array(jsonb_build_object(
    'key', 'session/prompt', 'utf8Bytes', prompt.bytes,
    'sha256', encode(sha256(convert_to(input.original_prompt_md, 'UTF8')), 'hex'))),
    'documents', '[]'::jsonb, 'conversation', '{"throughSequence":0,"olderOmitted":0,"messages":[]}'::jsonb,
    'budget', jsonb_build_object('maxUtf8Bytes', 1024, 'maxEstimatedTokens', 1024,
      'usedUtf8Bytes', prompt.bytes, 'estimatedTokens', prompt.bytes))) frozen;

create temp table triage_branch_artifact as
select '<!-- wallie-accepted-scope: ' || rtrim(translate(encode(convert_to(
  '{"acceptanceCriteria":["Exclude contractors."],"evidenceReferences":["required:session/prompt"],"scope":"Invite administrators only.","version":1}',
  'UTF8'), 'base64'), E'+/\n', '-_'), '=') || E' -->\n## Scope\nInvite administrators only.\n\n## Acceptance criteria\n- Exclude contractors.\n\n## Evidence\n- `required:session/prompt`' as body;
select ok(public.prepare_session_source_and_checkpoint_publication(root.run_id, pg_temp.op651_id(34), 'main',
  repeat('a', 40), repeat('a', 40), 'Accepted triage source', 'Source stays unchanged during triage',
  '', '', '', 0, artifact.body), 'the specification publishes its contrasting accepted scope')
from triage_branch_run root cross join triage_branch_artifact artifact;
create temp table triage_branch_claim as
select run_id, public.claim_session_checkpoint_publication(run_id) as lease from triage_branch_run;
select ok(public.adopt_session_checkpoint_publication(run_id, lease, null, null), 'the exact scope artifact is adopted')
from triage_branch_claim;

select ok((select approved.phase_status = 'approved' from triage_branch_run root
  join public.sessions session on session.id = root.session_id
  cross join lateral public.approve_session_stage(session.id, session.workspace_id, session.current_stage_id,
    session.current_artifact_id, session.current_artifact_version, pg_temp.op651_id(21),
    'codex', 'gpt-5.5', 'code', session.artifact_review_revision) approved),
  'the exact human review accepts the scope and admits the fork through the production handoff');

select is((select public.advance_factory_workflow_branch_occurrence(root.session_id, root.workspace_id,
    root.factory_id, workflow.generation, workflow.ownership_token, fork.occurrence_id)->>'joinStatus'
  from triage_branch_run root
  join internal.factory_workflow_executions workflow on workflow.root_session_id = root.session_id
  join internal.factory_workflow_node_occurrences fork on fork.root_session_id = workflow.root_session_id
    and fork.node_kind = 'branch'), 'pending', 'the normal dispatcher creates the exact branch children');

create temp table triage_branch_children as
select marker.* from internal.factory_workflow_delegations marker
join triage_branch_run root on root.session_id = marker.root_session_id;
select is((select count(*) from triage_branch_children), 2::bigint, 'both configured siblings are admitted');
select ok((select bool_and(child.prompt_md = 'Invite administrators only.'
    and child_pin.original_prompt_md = 'Invite administrators only.'
    and child.title = 'Branch ' || occurrence.node_id and child_pin.original_title = child.title
    and parent_pin.original_title = 'Invite contractors'
    and parent_pin.original_prompt_md = 'Invite contractors in the first wave.')
  from triage_branch_children marker
  join public.sessions child on child.id = marker.child_session_id
  join internal.factory_workflow_node_occurrences occurrence on
    (occurrence.root_session_id, occurrence.occurrence_id) = (marker.root_session_id, marker.target_occurrence_id)
  join public.session_factory_admission_inputs child_pin on child_pin.session_id = marker.child_session_id
  join public.session_factory_admission_inputs parent_pin on parent_pin.session_id = marker.root_session_id),
  'each branch task uses the approved scope and leaves its contradictory intake intact on the root');
select ok((select bool_and(marker.accepted_scope_receipt_id = receipt.receipt_id
    and marker.source_checkpoint_run_id = root.run_id and input.source_checkpoint_run_id = root.run_id
    and input.input_sha = receipt.commit_sha)
  from triage_branch_children marker
  join triage_branch_run root on root.session_id = marker.root_session_id
  join internal.factory_workflow_accepted_scopes receipt on receipt.session_id = root.session_id
  join public.session_job_git_inputs input on input.job_id = marker.child_job_id),
  'both siblings pin the exact approval receipt and parent source');

update public.agent_jobs job set status = 'running', attempt_count = 1,
  git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
where job.id = (select child_job_id from triage_branch_children order by child_job_id limit 1);

update public.agent_jobs job set status='running',attempt_count=1,
  git_continuity_release_revision=(select revision from public.get_git_continuity_release_state())
where job.id in (select child_job_id from triage_branch_children);
create temp table triage_outputs as
select marker.*, slot.branch_edge_id, pg_temp.adopt_branch_code(marker.child_session_id,marker.child_job_id,
  repeat(case when slot.required then 'b' else 'c' end,40)) as checkpoint_run_id
from triage_branch_children marker
join internal.factory_workflow_branch_slots slot
  on (slot.root_session_id,slot.slot_id)=(marker.root_session_id,marker.source_branch_slot_id);
select pg_temp.approve_branch(child_session_id) from triage_outputs;
create temp table triage_first_fork as
select manifest.* from internal.factory_workflow_branch_groups manifest join triage_branch_run root
  on (root.session_id,root.run_id)=(manifest.root_session_id,manifest.source_checkpoint_run_id);
create temp table triage_outcome_receipts as
select recorded.* from triage_first_fork fork cross join triage_outputs child
join internal.factory_workflow_executions execution on execution.root_session_id=child.root_session_id
cross join lateral public.record_factory_workflow_branch_outcome(fork.root_session_id,fork.workspace_id,fork.factory_id,
  execution.generation,execution.ownership_token,fork.group_id,child.branch_edge_id,child.child_job_id,1,child.checkpoint_run_id) recorded;
create temp table triage_join as
select fork.*, public.enqueue_factory_workflow_join_for_user(fork.root_session_id,fork.workspace_id,fork.factory_id,pg_temp.op651_id(1),
  execution.generation,gen_random_uuid(),fork.group_id,fork.source_checkpoint_run_id,
  (select array_agg(outcome_id) from triage_outcome_receipts)) as receipt
from triage_first_fork fork join internal.factory_workflow_executions execution using(root_session_id);
select ok((select receipt->>'created'='true' from triage_join),'the real approved triage root can queue its first join');
update public.agent_jobs set scheduled_at=clock_timestamp()+interval '1 day'
where workspace_id=pg_temp.op651_id(11) and status='queued' and id<>(select (receipt->>'jobId')::uuid from triage_join);
create temp table triage_claimed_join as select * from public.claim_next_agent_job(false,3,'node');
create temp table triage_started_join as
select public.start_factory_workflow_join_attempt(id,workspace_id,session_id,attempt_count,clock_timestamp()+interval '30 seconds') as receipt
from triage_claimed_join;
select ok((select receipt->>'kind'='started' from triage_started_join),'the exact typed worker starts the approved triage join');
select ok((select public.record_active_factory_workflow_join_candidate(
  (receipt->>'rootSessionId')::uuid,(receipt->>'workspaceId')::uuid,(receipt->>'factoryId')::uuid,
  (receipt->>'generation')::bigint,(receipt->>'ownershipToken')::uuid,(receipt->>'joinId')::uuid,
  (receipt->>'jobId')::uuid,(receipt->>'runId')::uuid,(receipt->>'attemptCount')::integer,
  repeat('e',40),repeat('f',40),encode(sha256(convert_to('Joined bundle fixture','UTF8')),'hex'))
  from triage_started_join),'the triage join seals the exact committed candidate');
select pg_temp.record_join_validation((receipt->>'runId')::uuid,repeat('e',40),repeat('f',40),true) from triage_started_join;
select ok((select pg_temp.prepare_join(receipt,repeat('e',40)) from triage_started_join),
  'the triage join only prepares after binding its own exact validation');
create temp table triage_join_publication as
select (receipt->>'runId')::uuid as run_id, public.claim_session_checkpoint_publication((receipt->>'runId')::uuid) as lease
from triage_started_join;
create function pg_temp.adopt_fixture_join() returns boolean language sql as $$
  select public.adopt_session_checkpoint_publication(joined.run_id, joined.lease, publication.retained_ref, repeat('e',40))
  from triage_join_publication joined join public.session_checkpoint_publications publication using (run_id)
$$;

savepoint immediate_join_result;
select ok(pg_temp.adopt_fixture_join(), 'an immediately complete join adopts its primary checkpoint');
select is((select count(*) from internal.factory_workflow_transition_receipts transition
  join triage_join source on (source.root_session_id, (source.receipt->>'occurrenceId')::uuid) =
    (transition.root_session_id, transition.source_occurrence_id)
  where transition.edge_id = 'inspect.join'), 1::bigint,
  'an immediate join result admits the exact review in the same transaction');
rollback to immediate_join_result;

-- Simulate a pending secondary repository suppressing the join result.
create function pg_temp.delay_fixture_join_result()
returns trigger language plpgsql as $$
begin
  if new.evidence_ref like 'join-checkpoint:%' and current_setting('wallie.op654_delay_join_result') = 'on'
    then return null; end if;
  return new;
end;
$$;
create trigger delay_fixture_join_result before insert on internal.factory_workflow_node_results
  for each row execute function pg_temp.delay_fixture_join_result();
set local wallie.op654_delay_join_result = 'on';
select ok(pg_temp.adopt_fixture_join(),
  'the triage root adopts a new exact head through native retained publication');
select ok((select head.checkpoint_run_id = terminal.checkpoint_run_id
    and not exists (select 1 from internal.factory_workflow_node_results result
      where (result.root_session_id, result.occurrence_id) = (manifest.root_session_id, manifest.join_occurrence_id))
    and not exists (select 1 from internal.factory_workflow_node_occurrences occurrence
      where occurrence.root_session_id = manifest.root_session_id and occurrence.node_kind = 'review')
  from triage_join source
  join internal.factory_workflow_joins manifest on manifest.join_id = (source.receipt->>'joinId')::uuid
  join internal.factory_workflow_join_outcomes terminal on
    (terminal.root_session_id, terminal.join_id) = (manifest.root_session_id, manifest.join_id)
  join public.session_git_heads head on (head.session_id, head.workspace_id) =
    (manifest.parent_session_id, manifest.workspace_id)),
  'primary adoption commits while the delayed join result keeps review pending');

set local wallie.op654_delay_join_result = 'off';
create function pg_temp.record_delayed_fixture_join_result() returns table(result_id uuid, created boolean)
language sql as $$
  select recorded.*
  from triage_join source
  join internal.factory_workflow_joins manifest on manifest.join_id = (source.receipt->>'joinId')::uuid
  join internal.factory_workflow_join_outcomes terminal on
    (terminal.root_session_id, terminal.join_id) = (manifest.root_session_id, manifest.join_id)
  join internal.factory_workflow_executions execution on execution.root_session_id = manifest.root_session_id
  cross join lateral internal.insert_factory_workflow_node_result(execution, manifest.join_occurrence_id,
    'succeeded', 'join-checkpoint:' || terminal.checkpoint_run_id) recorded
  where terminal.outcome = 'adopted'
$$;
select ok((select created and result_id is not null from pg_temp.record_delayed_fixture_join_result()),
  'the later whole-join result is durably recorded');
select is((select created from pg_temp.record_delayed_fixture_join_result()), false,
  'replaying whole-join settlement reuses the durable result');

select ok((select internal.read_factory_workflow_current_scope_artifact(binding,saved) like '%Exclude contractors.%'
  from triage_branch_run root join internal.factory_workflow_triage_bindings binding on binding.session_id=root.session_id
  join internal.factory_workflow_accepted_scopes saved on saved.session_id=root.session_id
  join public.session_git_heads head on head.session_id=root.session_id
  where head.checkpoint_run_id<>saved.run_id),
  'the native adopted join carries the original exact approved scope to the new run');

create temp table exact_review_context as
select root.session_id as "sessionId", root.workspace_id, root.factory_id, workflow.generation as execution_generation,
  workflow.ownership_token, manifest.join_id, adopted.run_id as current_join_run_id, transition.target_occurrence_id as review_occurrence_id
from triage_branch_run root
join internal.factory_workflow_executions workflow on workflow.root_session_id = root.session_id
join internal.factory_workflow_joins manifest on manifest.root_session_id = root.session_id
join internal.factory_workflow_transition_receipts transition on
  (transition.root_session_id, transition.source_occurrence_id, transition.edge_id) =
  (root.session_id, manifest.join_occurrence_id, 'inspect.join')
cross join triage_join_publication adopted;
select is((select count(*) from exact_review_context), 1::bigint,
  'the once-inserted whole-join result admits exactly one configured review occurrence');

create function pg_temp.claim_exact_review(p_occurrence_id uuid default null,p_permit uuid default pg_temp.op651_id(405))
returns jsonb language sql as $$
  select public.claim_factory_workflow_exact_review("sessionId",workspace_id,factory_id,execution_generation,
    ownership_token,coalesce(p_occurrence_id,review_occurrence_id),p_permit)
  from exact_review_context
$$;

select throws_ok($$select * from exact_review_context
cross join lateral public.record_factory_workflow_node_result("sessionId",workspace_id,factory_id,execution_generation,
  ownership_token,review_occurrence_id,'succeeded','fake-reviewed')$$,
  '42501','Exact passing workflow review is required.','generic result cannot forge a review pass');

create temp table captured_review as select public.dispatch_next_factory_workflow_exact_review(pg_temp.op651_id(405)) as claim;
select ok((select (claim->>'occurrenceId',claim->>'rootSessionId',claim->>'created') =
    (context.review_occurrence_id::text,context."sessionId"::text,'true')
  from captured_review cross join exact_review_context context), 'maintenance schedules one exact review from the adopted join');
select is(pg_temp.claim_exact_review()->>'created','false','exact permit replay does not issue another reviewer attempt');
select ok((select (claim->>'checkpointRunId',claim->>'commitSha',claim->>'treeSha') =
  (context.current_join_run_id::text, repeat('e',40), repeat('f',40))
  from captured_review cross join exact_review_context context),
  'the reviewer claim uses the exact adopted join run, commit and validation tree');
select is(pg_temp.claim_exact_review(null,pg_temp.op651_id(406)),null::jsonb,
  'a distinct worker permit cannot issue another exact review');
create function pg_temp.read_fixture_review_provider(p_claim jsonb, p_permit uuid)
returns jsonb language sql as $$
  select public.read_factory_workflow_exact_review_provider(
    context."sessionId", context.workspace_id, context.factory_id, context.execution_generation, context.ownership_token,
    (p_claim->>'reviewId')::uuid, (p_claim->>'reviewRunId')::uuid, p_permit)
  from exact_review_context context
$$;
select ok((select profile.provider->>'model' = 'gpt-5.5'
    and profile.provider->>'promptSha256' = encode(sha256(convert_to('Choose a configured destination.', 'UTF8')), 'hex')
    and profile.provider->>'inputSha' = repeat('a',40)
  from captured_review captured
  cross join lateral (select pg_temp.read_fixture_review_provider(captured.claim, pg_temp.op651_id(405))) profile(provider)),
  'the provider reads the exact frozen reviewer prompt with the inherited parent inference authority');
select ok((select profile.provider->>'comparisonBaseSha' = repeat('a',40)
    and profile.provider->'priorReview' = 'null'::jsonb
  from captured_review captured
  cross join lateral (select pg_temp.read_fixture_review_provider(captured.claim, pg_temp.op651_id(405))) profile(provider)),
  'the initial review compares from the exact sealed join base without prior findings');


create function pg_temp.record_exact_review(p_report jsonb, p_tree_sha text default repeat('f',40),
  p_checkpoint uuid default null, p_permit uuid default pg_temp.op651_id(405), p_claim jsonb default null)
returns uuid language sql as $$
  select public.record_factory_workflow_exact_review("sessionId",workspace_id,factory_id,execution_generation,
    ownership_token, (resolved.claim->>'reviewId')::uuid, (resolved.claim->>'reviewRunId')::uuid,p_permit,
    coalesce(p_checkpoint,(resolved.claim->>'checkpointRunId')::uuid),resolved.claim->>'commitSha',p_tree_sha,p_report)
  from exact_review_context cross join captured_review captured
  cross join lateral (select coalesce(p_claim,captured.claim) as claim) resolved
$$;

select is(pg_temp.record_exact_review('{"version":1,"verdict":"pass"}',repeat('a',40)),null::uuid,
  'identical work with a different tree does not count as an exact review');
select is(pg_temp.record_exact_review('{"version":1,"verdict":"pass"}',repeat('f',40),pg_temp.op651_id(404)),null::uuid,
  'the same commit and tree require the exact checkpoint run');
select is(pg_temp.record_exact_review('{"version":1,"verdict":"pass"}',repeat('f',40),null,pg_temp.op651_id(408)),null::uuid,
  'an unrelated permit cannot record an otherwise exact review');
select is((select public.record_factory_workflow_exact_review(
  context."sessionId", context.workspace_id, context.factory_id, context.execution_generation, context.ownership_token,
  (captured.claim->>'reviewId')::uuid, (captured.claim->>'reviewRunId')::uuid, pg_temp.op651_id(405),
  context.current_join_run_id, repeat('b',40), repeat('f',40), '{"version":1,"verdict":"pass"}')
  from captured_review captured cross join exact_review_context context), null::uuid,
  'a stale commit cannot record a passing review for the current run and tree');
savepoint failed_provider;
select ok((select public.fail_factory_workflow_exact_review(
  context."sessionId", context.workspace_id, context.factory_id, context.execution_generation, context.ownership_token,
  (captured.claim->>'reviewId')::uuid, (captured.claim->>'reviewRunId')::uuid, pg_temp.op651_id(405), 'provider_unavailable')
from captured_review captured cross join exact_review_context context), 'an unavailable provider retains an exact failed attempt');
select is(pg_temp.record_exact_review('{"version":1,"verdict":"pass"}'), null::uuid,
  'a previously failed provider attempt cannot later forge a passing review');
select is((select public.read_factory_workflow_exact_review_progress(
  "sessionId", workspace_id, factory_id, review_occurrence_id)->>'code' from exact_review_context),
  'provider_unavailable','the workflow observer can see the provider failure without credentials');

rollback to failed_provider;

savepoint retired_provider;
select public.acquire_factory_workflow_ownership("sessionId", workspace_id, factory_id,
  execution_generation, gen_random_uuid()) from exact_review_context;
select ok(public.expire_next_factory_workflow_exact_review(),
  'maintenance retires the old provider permit after workflow ownership changes');
select is((select public.read_factory_workflow_exact_review_progress(
  "sessionId", workspace_id, factory_id, review_occurrence_id)->>'code' from exact_review_context),
  'generation_retired', 'a lost provider permit becomes an observable stop');
select is(public.dispatch_next_factory_workflow_exact_review(gen_random_uuid()), null::jsonb,
  'retiring a provider permit does not issue another charge for the same occurrence');
rollback to retired_provider;

savepoint passing_review;
select ok(pg_temp.record_exact_review('{"version":1,"verdict":"pass"}') is not null,
  'a passing automated review records an exact result');
select ok((select parent.phase_status = 'awaiting_review'
  and not exists (select 1 from public.session_stage_approval_receipts approval
    where (approval.session_id,approval.artifact_id) = (parent.id,parent.current_artifact_id))
  from exact_review_context context join public.sessions parent on parent.id = context."sessionId"),
  'a passing result does not write human approval or advance the parent stage');
select is((select count(*) from internal.factory_workflow_review_repairs),0::bigint,
  'a passing review never schedules repair');
create temp table exact_human_gate as
select context.*, admitted.target_occurrence_id as gate_occurrence_id
from exact_review_context context
join internal.factory_workflow_node_results result on (result.root_session_id,result.occurrence_id) =
  (context."sessionId",context.review_occurrence_id)
join internal.factory_workflow_transition_receipts admitted on
  (admitted.root_session_id,admitted.source_occurrence_id,admitted.source_result_id,admitted.edge_id) =
  (context."sessionId",context.review_occurrence_id,result.result_id,'human.review');
select ok((select (source.session_id,source.run_id) = (gate."sessionId",gate.current_join_run_id)
  from exact_human_gate gate
  cross join lateral public.read_factory_workflow_command_source(
    gate."sessionId", gate.workspace_id, gate.factory_id, gate.gate_occurrence_id) source),
  'the independent human gate observes the exact causal review checkpoint');
select is((select count(*) from exact_human_gate human cross join lateral
  public.record_factory_workflow_command_result(human."sessionId",human.workspace_id,human.factory_id,
    human.execution_generation,human.ownership_token,human.gate_occurrence_id,'human-gate:' || pg_temp.op651_id(430))),
  0::bigint,'automated review proof cannot satisfy the human gate');
rollback to passing_review;
savepoint ineligible_review;
select ok(pg_temp.record_exact_review('{"version":1,"verdict":"findings","findings":[
  {"ruleId":"tests","message":"An issue outside the declared repair rules."}]}') is not null,
  'an exact report can retain a configured but ineligible repair rule');
select ok(public.dispatch_next_factory_workflow_review_repair(), 'maintenance settles the ineligible report');
select is((select progress->>'code' from internal.factory_workflow_repair_dispatch_outcomes), 'finding_ineligible',
  'an ineligible finding produces an escalation and no queue admission');
select is((select count(*) from internal.factory_workflow_review_repairs), 0::bigint,
  'an ineligible report leaves the parent unchanged');
rollback to ineligible_review;

create temp table finding_report as select '{
  "version":1,"verdict":"findings","findings":[
  {"ruleId":"scope","path":"src/scope.ts","line":1,"message":"Check scope."},
  {"ruleId":"scope","path":"src/scope.ts","line":2,"message":"Verify changed scope."}]}'::jsonb as body;
create temp table finding_receipt as select pg_temp.record_exact_review(body) as receipt_id from finding_report;
select ok((select receipt_id is not null from finding_receipt),'an eligible report becomes a durable exact receipt');
select is((select finding_keys from internal.factory_workflow_exact_review_reports),'[["scope","src/scope.ts"]]'::jsonb,
  'duplicate mentions do not create multiple logical findings');
select is((select pg_temp.record_exact_review(finding.body) from finding_report finding),
  (select receipt_id from finding_receipt),'the exact report replays the existing receipt');

create function pg_temp.repair_review(p_receipt uuid default null,p_head uuid default null,p_claim jsonb default null)
returns jsonb language sql as $$
  select public.admit_factory_workflow_review_repair("sessionId",workspace_id,factory_id,execution_generation,ownership_token,
    (coalesce(p_claim,claim)->>'reviewId')::uuid,coalesce(p_receipt,receipt_id),coalesce(p_head,current_join_run_id))
  from exact_review_context cross join captured_review cross join finding_receipt
$$;
select is(pg_temp.repair_review(pg_temp.op651_id(999))->>'status','stale_review',
  'the wrong receipt cannot reserve repair work');
savepoint exhausted_repair;
update public.sessions parent set execution_repair_attempts = 1
from exact_review_context context where parent.id = context."sessionId";
select is(pg_temp.repair_review()->>'code','repair_budget_exhausted','the pinned repair limit refuses another reservation');
select is((select count(*) from internal.factory_workflow_review_repairs),0::bigint,
  'budget rejection leaves no queued review repair receipt');
rollback to exhausted_repair;
create temp table carried_blocker as
select thread.* from exact_review_context context
join public.sessions parent on parent.id = context."sessionId"
cross join lateral public.create_artifact_review_thread_once(gen_random_uuid(), parent.workspace_id, parent.id,
  parent.current_stage_id, parent.current_artifact_id, parent.current_artifact_version,
  '{"coordinateSystem":"unicode_code_points","start":0,"end":6,"quote":"Joined","prefix":"","suffix":" output with exact validation."}',
  'blocking','Review the original joined artifact before approving its repair.') thread;
select is((select status from carried_blocker), 'open', 'the human blocking request is independent of automated findings');
create temp table repair_result as select pg_temp.repair_review() as repair;
select is((select repair->>'status' from repair_result),'repair_recorded','one exact eligible report queues a repair');
select ok((select jsonb_typeof(repair->'jobId') = 'string' and repair->'created' = 'true' from repair_result),
  'the native receipt identifies a fresh durable repair job');
select is((select public.read_factory_workflow_exact_review_progress(
  context."sessionId",context.workspace_id,context.factory_id,context.review_occurrence_id)
  from exact_review_context context),'{"status":"pending","code":"repair_pending"}'::jsonb,
  'a reserved but unadopted repair exposes no successor occurrence');
select is(pg_temp.repair_review()->>'created','false','an exact repair retry returns the same reservation');
select is(pg_temp.repair_review()->>'jobId',(select repair->>'jobId' from repair_result),
  'exact retries keep the original job identity');
select is((select execution_repair_attempts from public.sessions parent join exact_review_context context on context."sessionId" = parent.id),
  1,'review repair debits the pinned counter once');
select is((select count(*) from internal.factory_workflow_attempt_reservations hold
  join repair_result result on result.repair->>'jobId' = hold.job_id::text),1::bigint,
  'the same repair transaction retains one shared-root reservation');
select ok((select input.source_checkpoint_run_id = context.current_join_run_id and input.input_sha = repeat('e',40)
  from repair_result result join public.session_job_git_inputs input on input.job_id::text = result.repair->>'jobId'
  cross join exact_review_context context),'the repair job checks out the same accepted join, not a branch tip');
create temp table exact_repair_run as
select job.id as job_id, own.run_id
from repair_result result join public.agent_jobs job on job.id::text = result.repair->>'jobId'
cross join lateral (select (result.repair->>'runId')::uuid as run_id) own;
update public.agent_jobs job set status = 'running', attempt_count = 1,
  git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
from exact_repair_run execution where job.id = execution.job_id;
select ok((select public.start_session_job_attempt(exact.job_id,1,parent.current_stage_id,
  parent.current_artifact_version,'codex','gpt-5.5','code','wallie/op654-' || exact.job_id) = exact.run_id
  from exact_repair_run exact join public.agent_jobs job on job.id = exact.job_id
  join public.sessions parent on parent.id = job.session_id), 'the regular worker claims the exact reserved repair run');
select ok((select context->>'sourceCheckpointRunId' = source.current_join_run_id::text
  and context#>>'{findings,0,ruleId}' = 'scope' and context->'requiredEvidence' = '["tests"]'::jsonb
  from exact_repair_run exact join public.agent_jobs job on job.id=exact.job_id
  cross join exact_review_context source
  cross join lateral (select public.read_factory_workflow_review_repair_input(
    job.workspace_id,job.session_id,job.id,exact.run_id,1) as context) observed),
  'the worker obtains its exact persisted repair feedback without changing approval state');
select ok((select scoped.input->>'status' = 'required' and scoped.input->>'artifactMarkdown' like '%Exclude contractors.%'
  from exact_repair_run exact join public.agent_jobs job on job.id = exact.job_id
  cross join lateral (select public.read_factory_workflow_delegated_scope(job.workspace_id,job.id,exact.run_id,1)) scoped(input)),
  'the root repair receives the original approved triage scope under its exact attempt');


select public.pin_session_job_git_input(exact.job_id,1,exact.run_id,pg_temp.op651_id(34),'main',repeat('e',40))
from exact_repair_run exact;

savepoint no_op_repair;
select pg_temp.record_join_validation(exact.run_id,repeat('e',40),repeat('f',40),true) from exact_repair_run exact;
select ok((select public.prepare_session_source_and_checkpoint_publication(exact.run_id, pg_temp.op651_id(34),
  'main',repeat('e',40),repeat('e',40),'No-op repair','Source byte-identical to prior join', '', '', '',
  parent.current_artifact_version,'Fresh validated no-op repair.')
  from exact_repair_run exact join public.agent_jobs job on job.id=exact.job_id
  join public.sessions parent on parent.id=job.session_id),
  'a no-op repair can prepare after validating its own run');
create temp table no_op_repair_claim as
select run_id, public.claim_session_checkpoint_publication(run_id) as lease from exact_repair_run;
select ok((select public.adopt_session_checkpoint_publication(run_id, lease, null, null) from no_op_repair_claim),
  'the no-op repair adopts a new exact checkpoint identity at the previous commit and tree');
create temp table no_op_review as select public.dispatch_next_factory_workflow_exact_review(pg_temp.op651_id(412)) as claim;
select ok((select (claim->>'checkpointRunId', claim->>'commitSha', claim->>'treeSha') =
    (exact.run_id::text, repeat('e',40), repeat('f',40))
    and (profile.provider->>'inputSha', profile.provider->>'comparisonBaseSha') = (repeat('e',40), repeat('a',40))
    and profile.provider#>>'{priorReview,checkpointRunId}' = context.current_join_run_id::text
    and profile.provider#>'{priorReview,findings}' = finding.body->'findings'
  from no_op_review reviewed cross join exact_repair_run exact cross join exact_review_context context
  cross join finding_report finding
  cross join lateral (select pg_temp.read_fixture_review_provider(reviewed.claim, pg_temp.op651_id(412))) profile(provider)),
  'the no-op re-review retains the original comparison and the finding from its exact prior checkpoint');
create temp table no_op_repeat as
select pg_temp.record_exact_review(finding.body, repeat('f',40), null, pg_temp.op651_id(412), reviewed.claim) as receipt_id
from no_op_review reviewed cross join finding_report finding;
select is((select pg_temp.repair_review(repeated.receipt_id, exact.run_id, reviewed.claim)->>'code'
  from no_op_repeat repeated cross join no_op_review reviewed cross join exact_repair_run exact),
  'finding_repeated','an unchanged prior finding at the same commit cannot enqueue another repair');
rollback to no_op_repair;

select public.pin_session_validation_plan(exact.run_id,repeat('1',40),repeat('2',40),
  '{"version":1,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":30,"reports":[]}]}')
from exact_repair_run exact;
create function pg_temp.prepare_review_repair() returns boolean language sql as $$
  select public.prepare_session_source_and_checkpoint_publication(exact.run_id, pg_temp.op651_id(34),
    'main',repeat('e',40),repeat('1',40),'Repair output','Repair validation proof','',
    encode(sha256(convert_to('private-exact-repair','UTF8')),'hex'),encode(convert_to('private-exact-repair','UTF8'),'base64'),
    parent.current_artifact_version,'Private repair artifact.')
  from exact_repair_run exact join public.agent_jobs job on job.id=exact.job_id
  join public.sessions parent on parent.id=job.session_id
$$;
select throws_ok($$select pg_temp.prepare_review_repair()$$,
  '23514','Specification publication requires unchanged source from the exact execution attempt.',
  'earlier passing evidence cannot prepare changed source for this triage repair');
select throws_ok($$select public.prepare_session_source_and_checkpoint_publication(exact.run_id, pg_temp.op651_id(34),
  'main',repeat('e',40),repeat('e',40),'No-code repair','Repair evidence must still be fresh', '', '', '',
  parent.current_artifact_version,'Private repair artifact.')
  from exact_repair_run exact join public.agent_jobs job on job.id=exact.job_id
  join public.sessions parent on parent.id=job.session_id$$,
  '23514','Checkpoint publication intent could not be prepared.',
  'even an unchanged commit cannot open a repair publication with inherited evidence');

select pg_temp.record_join_validation(exact.run_id,repeat('1',40),repeat('2',40),true) from exact_repair_run exact;
select ok(pg_temp.prepare_review_repair(),'fresh exact validation allows changed source from the typed repair');
create temp table exact_repair_claim as
select exact.*,public.claim_session_checkpoint_publication(exact.run_id) as claim_id
from exact_repair_run exact;
select ok((select public.adopt_session_checkpoint_publication(exact.run_id,exact.claim_id,publication.retained_ref,repeat('1',40))
  from exact_repair_claim exact join public.session_checkpoint_publications publication using (run_id)),
  'exact fresh validation lets the normal retained checkpoint adopter accept the repair');
select ok((select parent.phase_status = 'awaiting_review'
  and not exists (select 1 from public.session_stage_approval_receipts approval
    where (approval.session_id,approval.artifact_id) = (parent.id,parent.current_artifact_id))
  from exact_review_context context join public.sessions parent on parent.id = context."sessionId"),
  'repaired output still needs an independent human decision');

create temp table rereview as select public.dispatch_next_factory_workflow_exact_review(pg_temp.op651_id(410)) as claim;
select ok((select (claim->>'checkpointRunId',claim->>'commitSha',claim->>'treeSha') =
  (exact.run_id::text,repeat('1',40),repeat('2',40)) from rereview cross join exact_repair_run exact),
  'the next exact reviewer observes the independently adopted repaired output');
select is((select public.read_factory_workflow_exact_review_progress(
  context."sessionId",context.workspace_id,context.factory_id,context.review_occurrence_id)
  from exact_review_context context),
  (select jsonb_build_object('status','pending','code','repair_advanced','nextReviewOccurrenceId',bound.review_occurrence_id)
    from rereview review join internal.factory_workflow_exact_reviews bound on (bound.root_session_id,bound.review_id) =
      ((review.claim->>'rootSessionId')::uuid,(review.claim->>'reviewId')::uuid)),
  'the original occurrence links to the exact admitted re-review');
select ok((select (profile.provider->>'inputSha', profile.provider->>'comparisonBaseSha') = (repeat('e',40), repeat('a',40))
    and (profile.provider#>>'{priorReview,checkpointRunId}', profile.provider#>>'{priorReview,commitSha}',
      profile.provider#>>'{priorReview,treeSha}') = (context.current_join_run_id::text, repeat('e',40), repeat('f',40))
    and profile.provider#>'{priorReview,findings}' = finding.body->'findings'
  from rereview reviewed cross join exact_review_context context cross join finding_report finding
  cross join lateral (select pg_temp.read_fixture_review_provider(reviewed.claim, pg_temp.op651_id(410))) profile(provider)),
  'a changed repair compares from the original join base and sees the latest saved findings');
savepoint repeat_report;
create temp table repeated_finding as
select pg_temp.record_exact_review('{"version":1,"verdict":"findings","findings":[
  {"ruleId":"scope","path":"src/scope.ts","line":20,"message":"Same blocker in a new location."}]}',
  repeat('2',40),null,pg_temp.op651_id(410),rereview.claim) as receipt_id from rereview;
select is((select pg_temp.repair_review(repeated.receipt_id, exact.run_id, rereview.claim)->>'code'
  from repeated_finding repeated cross join rereview cross join exact_repair_run exact),
  'finding_repeated','a rule and path already repaired escalate despite changed line and text');
select is((select count(*) from internal.factory_workflow_review_repairs),1::bigint,
  'repeat findings never enqueue a second job');
select ok(public.dispatch_next_factory_workflow_review_repair(),
  'maintenance resumes the persisted repeated report even after the reporting worker disappears');
select is((select progress->>'code' from internal.factory_workflow_repair_dispatch_outcomes outcome
  join rereview on outcome.review_id::text = rereview.claim->>'reviewId'),
  'finding_repeated','maintenance durably retains the escalation for operator visibility');

rollback to repeat_report;
select ok((select pg_temp.record_exact_review('{"version":1,"verdict":"pass"}',
  repeat('2',40),null,pg_temp.op651_id(410),claim) is not null from rereview),
  'the repaired source can receive its own exact passing review');
create temp table repaired_human_gate as
select context.*, transition.target_occurrence_id as gate_occurrence_id
from exact_review_context context join internal.factory_workflow_review_repairs repair
  on repair.root_session_id=context."sessionId"
join internal.factory_workflow_transition_receipts transition on
  (transition.root_session_id,transition.source_occurrence_id,transition.edge_id) =
  (repair.root_session_id,repair.next_review_occurrence_id,'human.review');
select is((select source.run_id from repaired_human_gate gate
  cross join lateral public.read_factory_workflow_command_source(gate."sessionId",gate.workspace_id,gate.factory_id,
    gate.gate_occurrence_id) source), (select exact.run_id from exact_repair_run exact),
  'the downstream observer follows the repaired checkpoint instead of the earlier joined run');
select is((select count(*) from repaired_human_gate gate
  join internal.factory_workflow_accepted_scopes saved on saved.session_id=gate."sessionId"
  cross join lateral public.record_factory_workflow_command_result(gate."sessionId",gate.workspace_id,gate.factory_id,
    gate.execution_generation,gate.ownership_token,gate.gate_occurrence_id,'human-gate:' || saved.approval_id)),
  0::bigint,'neither the passing automated report nor the original triage approval satisfies the repaired human gate');
select ok(exists (select 1 from public.artifact_review_threads thread join carried_blocker original using(id)
  where thread.status = 'open' and thread.artifact_id = original.artifact_id),
  'repair and re-review leave the original human blocking request open');
select throws_ok($$select pg_temp.approve_branch(gate."sessionId") from repaired_human_gate gate$$,
  'PT409','Resolve or supersede open blocking requests before approving.',
  'an independently open human request blocks approval of the changed artifact');
select public.transition_artifact_review_thread_once(gen_random_uuid(),workspace_id,id,revision,'resolved',
  'The reviewer verified the requested change.') from carried_blocker;
select pg_temp.approve_branch(gate."sessionId") from repaired_human_gate gate;
select is((select count(*) from repaired_human_gate gate
  join public.sessions parent on parent.id = gate."sessionId"
  join public.session_stage_approval_receipts approval on
    (approval.session_id,approval.artifact_id)=(parent.id,parent.current_artifact_id)
  cross join lateral public.record_factory_workflow_command_result(gate."sessionId",gate.workspace_id,gate.factory_id,
    gate.execution_generation,gate.ownership_token,gate.gate_occurrence_id,'human-gate:' || approval.id)),
  1::bigint,'a separate human approval of the repaired artifact satisfies the exact downstream gate');

select ok(not has_function_privilege('authenticated','public.admit_factory_workflow_review_repair(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid)','EXECUTE'),
  'only the service can admit a repair');

select * from finish();
rollback;
