begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65140000
\set op651_open_groups false
\set op651_parallel_only true
\ir fixtures/factory_workflow_branch.psql

create temp table triage_branch_graph as
select pin.workspace_id, pin.factory_id, pin.definition_revision_id, graph_digest.digest, registered.graph_revision_id
from branch_owner ordinary
join public.session_factory_admission_inputs pin on pin.session_id = ordinary."sessionId"
join branch_graphs graph on graph.scenario = ordinary.scenario
cross join lateral (select graph.body::jsonb as plan) source
cross join lateral (select (source.plan || jsonb_build_object(
  'entryNodeId', 'scope.approved',
  'nodes', jsonb_build_array(jsonb_build_object('id', 'scope.approved', 'kind', 'human-gate',
    'anyoneCanApprove', false, 'approverMemberIds', jsonb_build_array(pg_temp.op651_id(21)))) || (source.plan->'nodes'),
  'edges', jsonb_build_array(jsonb_build_object('id', 'scope.fork', 'kind', 'next',
    'from', 'scope.approved', 'to', 'branch.split')) || (source.plan->'edges')))::text as body) triage
cross join lateral (select encode(sha256(convert_to(triage.body, 'UTF8')), 'hex') as digest) graph_digest
cross join lateral public.register_factory_workflow_graph_revision(pin.workspace_id, pin.factory_id,
  pin.definition_revision_id, pin.definition_digest, triage.body, graph_digest.digest) registered;

select ok((select configured.created from triage_branch_graph graph
  cross join lateral public.configure_factory_workflow_triage(graph.workspace_id, graph.factory_id,
    pg_temp.op651_id(1), graph.definition_revision_id, graph.graph_revision_id, graph.digest,
    pg_temp.op651_id(32), 0) configured), 'a manager configures a triage gate before a fork');

create temp table triage_branch_root as
select graph.*, created.session_id, created.job_id
from triage_branch_graph graph
join public.factory_definition_revisions revision on revision.id = graph.definition_revision_id
cross join lateral public.create_session_command_once(graph.workspace_id, pg_temp.op651_id(21),
  pg_temp.op651_id(901), repeat('c', 64), revision.canonical_digest, 'Prepare the launch',
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
    and parent_pin.original_prompt_md = 'Invite contractors in the first wave.')
  from triage_branch_children marker
  join public.sessions child on child.id = marker.child_session_id
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
create temp table triage_branch_started as
select marker.*, public.start_session_job_attempt(marker.child_job_id, 1, pg_temp.op651_id(32), 0,
  'codex', 'gpt-5.5', 'code', 'wallie/op651-triage-child-' || marker.child_job_id) as executing_run_id
from triage_branch_children marker order by child_job_id limit 1;
select ok((select scope.pin->>'status' = 'required'
    and scope.pin->>'receiptId' = started.accepted_scope_receipt_id::text
    and scope.pin->>'artifactMarkdown' like '%- Exclude contractors.%'
  from triage_branch_started started cross join lateral (select public.read_factory_workflow_delegated_scope(
    started.workspace_id, started.child_job_id, started.executing_run_id, 1)) scope(pin)),
  'the exact child worker still receives the required criteria and approval identity');

select * from finish();
rollback;
