begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65610000
\set op651_open_groups false
\set op651_parallel_only true
\set op652_join_evidence true
\ir fixtures/factory_workflow_branch.psql

create temp table authored_product_graph as
select body,encode(sha256(convert_to(body,'UTF8')),'hex') as digest
from op651_grant grant_row
join public.factory_definition_revisions foreman on foreman.id=pg_temp.op651_id(44)
join public.factory_definition_revisions supporting on supporting.id=pg_temp.op651_id(47)
cross join lateral (select jsonb_build_object(
  'schemaVersion',1,'kind','graph','entryNodeId','scope.approval',
  'grants',jsonb_build_array(jsonb_build_object('id',grant_row.id,'version',grant_row.version)),
  'nodes',jsonb_build_array(
    jsonb_build_object('id','scope.approval','kind','human-gate','anyoneCanApprove',false,
      'approverMemberIds',jsonb_build_array(pg_temp.op651_id(21))),
    jsonb_build_object('id','triage.route','kind','route','grantId',grant_row.id,
      'agentPromptRevisionId',pg_temp.op651_id(91)),
    '{"id":"work.split","kind":"branch"}'::jsonb,
    jsonb_build_object('id','work.implementation','kind','agent','grantId',grant_row.id,
      'agentPromptRevisionId',pg_temp.op651_id(91)),
    jsonb_build_object('id','work.support','kind','agent','grantId',grant_row.id,
      'agentPromptRevisionId',pg_temp.op651_id(91)),
    '{"id":"work.join","kind":"join"}'::jsonb,
    jsonb_build_object('id','work.review','kind','review','reviewerPromptRevisionId',pg_temp.op651_id(91),
      'ruleIds','["scope","validation"]'::jsonb),
    jsonb_build_object('id','final.approval','kind','human-gate','anyoneCanApprove',false,
      'approverMemberIds',jsonb_build_array(pg_temp.op651_id(21)))),
  'edges','[
    {"id":"scope.route","kind":"next","from":"scope.approval","to":"triage.route"},
    {"id":"route.proceed","kind":"route","from":"triage.route","to":"work.split"},
    {"id":"split.implementation","kind":"branch","from":"work.split","to":"work.implementation","required":true},
    {"id":"split.support","kind":"branch","from":"work.split","to":"work.support","required":false},
    {"id":"output.implementation","kind":"branch-result","from":"work.implementation","to":"work.join"},
    {"id":"output.support","kind":"branch-result","from":"work.support","to":"work.join"},
    {"id":"join.review","kind":"next","from":"work.join","to":"work.review"},
    {"id":"review.approve","kind":"next","from":"work.review","to":"final.approval"}
  ]'::jsonb,
  'routePolicy',jsonb_build_object('maxNodeVisits',8,'maxLoopTraversals',0,'nodes',jsonb_build_object('triage.route',
    jsonb_build_object('minimumConfidence',0.8,'allowedDestinationIds','["work.split"]'::jsonb,
      'fallback','{"kind":"clarification"}'::jsonb,
      'foremanProfile',jsonb_build_object('definitionRevisionId',foreman.id,'definitionDigest',foreman.canonical_digest)))),
  'delegationPolicy',jsonb_build_object('maxChildren',2,'maxConcurrentChildren',2,'maxAttempts',12,
    'maxTotalTokens',1000,'maxCostUsd',2,'maxTokensPerAttempt',50,'maxCostUsdPerAttempt',0.2,
    'targets',jsonb_build_object(
      'work.implementation',jsonb_build_object('definitionRevisionId',foreman.id,'definitionDigest',foreman.canonical_digest),
      'work.support',jsonb_build_object('definitionRevisionId',supporting.id,'definitionDigest',supporting.canonical_digest)))
)::text as body) graph;

create temp table authoring_draft as
select scope.*,base.id as base_activation,base.revision_id as definition_revision_id,base.digest as definition_digest,
  graph.digest,pg_temp.op651_id(981) as workflow_id
from op651_scope scope cross join authored_product_graph graph
cross join lateral internal.factory_workflow_authoring_base(scope.workspace_id,scope.factory_id) base;
select is((select public.create_factory_workflow_authoring(workspace_id,factory_id,
  pg_temp.op651_id(1),workflow_id,'Fixture product delivery','product-delivery',1)
  from authoring_draft),pg_temp.op651_id(981),'a manager creates a versioned product starter');
select is((select public.create_factory_workflow_authoring(workspace_id,factory_id,
  pg_temp.op651_id(1),workflow_id,'Fixture product delivery','product-delivery',1)
  from authoring_draft),pg_temp.op651_id(981),'an exact template creation request replays');
select throws_ok($$select public.create_factory_workflow_authoring(workspace_id,factory_id,
  pg_temp.op651_id(1),workflow_id,'Fixture product delivery','scoped-fix',1) from authoring_draft$$,
  'PT409','Workflow identity is unavailable.','a replay cannot change the template identity');
select throws_ok($$update internal.factory_workflow_authoring_workflows set template_version=null
  where id=pg_temp.op651_id(981)$$,'23514','The workflow template revision is immutable.',
  'the workflow template cannot be converted after creation');

select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(1),
  pg_temp.op651_id(988),'Invalid product draft','product-delivery',1) from authoring_draft;
create temp table invalid_product_draft as
select workspace_id,factory_id,base_activation,definition_revision_id,definition_digest,
  pg_temp.op651_id(988) as workflow_id,public.save_factory_workflow_authoring_draft(workspace_id,factory_id,
  pg_temp.op651_id(1),pg_temp.op651_id(988),pg_temp.op651_id(982),base_activation,definition_revision_id,definition_digest,
  invalid.body,encode(sha256(convert_to(invalid.body,'UTF8')),'hex')) as saved
from authoring_draft authoring cross join (values (
  '{"schemaVersion":1,"kind":"graph","entryNodeId":"checkpoint","grants":[],"nodes":[{"id":"checkpoint","kind":"deterministic","operation":"checkpoint"}],"edges":[]}'
)) invalid(body);
select throws_ok($$select public.publish_factory_workflow_authoring_draft(workspace_id,factory_id,
  pg_temp.op651_id(1),workflow_id,pg_temp.op651_id(983),(saved->>'draftId')::uuid,
  base_activation,definition_revision_id,definition_digest,saved->>'digest') from invalid_product_draft$$,
  'PT422','Product delivery must begin with scope approval followed by a configured Foreman.',
  'a product draft cannot remove its accepted scope entry on publication');

create temp table product_saved as
select authoring.*,public.save_factory_workflow_authoring_draft(workspace_id,factory_id,
  pg_temp.op651_id(1),workflow_id,pg_temp.op651_id(982),base_activation,definition_revision_id,
  definition_digest,graph.body,graph.digest) as saved
from authoring_draft authoring join authored_product_graph graph using (digest);

create temp table authoring_publish as
select product.*, (published->>'graphRevisionId')::uuid as graph_revision_id, published
from product_saved product
cross join lateral (select public.publish_factory_workflow_authoring_draft(workspace_id,factory_id,
  pg_temp.op651_id(1),workflow_id,pg_temp.op651_id(983),(saved->>'draftId')::uuid,base_activation,
  definition_revision_id,definition_digest,digest) as published) receipt;
select ok((select published->>'activationId' is not null and published->>'digest'=digest from authoring_publish),
  'a valid template publishes its exact graph and digest');

set local request.jwt.claim.role = 'authenticated';
select is((select public.read_factory_workflow_authoring(workspace_id,factory_id,workflow_id)->'template'
  from authoring_publish),'{"id":"product-delivery","version":1}'::jsonb,'authenticated manager reads template identity');
select ok(exists(select 1 from authoring_publish activation
cross join lateral public.list_factory_workflow_intake_options(activation.workspace_id,activation.factory_id) option
where (option.workflow_id,option.activation_id,option.definition_digest) =
  (activation.workflow_id,(activation.published->>'activationId')::uuid,activation.definition_digest)),
  'signed-in native intake lists the exact authored activation');
set local request.jwt.claim.role = 'service_role';

create temp table authoring_session as
select scope.*, created.*
from authoring_publish scope
join public.factory_agent_prompt_revisions prompt on prompt.id=pg_temp.op651_id(91)
cross join lateral public.create_session_command_once(scope.workspace_id,pg_temp.op651_id(21),
  pg_temp.op651_id(984),repeat('d',64),scope.definition_digest,'Authored template session',
  'Build from the configured role evidence.','codex','gpt-5.5','{}',
  session_github_repository_id=>pg_temp.op651_id(34),selected_pipeline_id=>pg_temp.op651_id(31),
  selected_stage_ids=>array[pg_temp.op651_id(32)],target_factory_id=>scope.factory_id,
  p_workflow_selection=>jsonb_build_object('workflowId',scope.workflow_id,
    'activationId',scope.published->>'activationId')) created;
select ok(exists(select 1 from authoring_session scope join internal.factory_workflow_authoring_session_pins pin
  on (pin.session_id,pin.workflow_id,pin.activation_id,pin.graph_revision_id,pin.workflow_digest) =
    (scope.session_id,scope.workflow_id,(scope.published->>'activationId')::uuid,scope.graph_revision_id,scope.digest)),
  'ordinary signed-in session creation pins exact authored activation, graph and digest');


select ok(exists(select 1 from authoring_session authored
  join internal.factory_workflow_triage_bindings binding
    on (binding.session_id,binding.graph_revision_id,binding.workflow_digest) =
      (authored.session_id,authored.graph_revision_id,authored.digest)
  join public.sessions session on (session.id,session.specification_stage_id) = (binding.session_id,binding.stage_id)),
  'selected product activation binds its exact specification stage and graph');
update public.agent_jobs job set status = 'running', attempt_count = 1,
  git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
from authoring_session root where job.id = root.job_id;
create temp table template_run as
select root.session_id, root.workspace_id, root.factory_id, root.graph_revision_id, root.digest, root.job_id, public.start_session_job_attempt(root.job_id, 1, pg_temp.op651_id(32), 0,
  'codex', 'gpt-5.5', 'code', 'wallie/op651-triage-' || root.job_id) as run_id
from authoring_session root;
select ok((select count(*) = 1 from template_run root
  cross join lateral public.pin_session_job_git_input(root.job_id, 1, root.run_id, pg_temp.op651_id(34),
    'main', repeat('a', 40))), 'the running specification pins the exact source');

select frozen.manifest_sha256 from template_run root
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
from template_run root cross join triage_branch_artifact artifact;
create temp table triage_branch_claim as
select run_id, public.claim_session_checkpoint_publication(run_id) as lease from template_run;
select ok(public.adopt_session_checkpoint_publication(run_id, lease, null, null), 'the exact scope artifact is adopted')
from triage_branch_claim;


select ok(not exists(select 1 from template_run root
  join internal.factory_workflow_authoring_dispatches dispatch on dispatch.session_id=root.session_id),
  'product adoption queues no pre-approval authored dispatch');
select ok(not exists(select 1 from template_run root
  join internal.factory_workflow_executions execution on execution.root_session_id=root.session_id),
  'adopted scope remains reviewable before execution');
select throws_ok($$ select started.created
  from template_run root cross join lateral public.start_factory_workflow_graph_execution(root.session_id,
    root.workspace_id,root.factory_id,root.graph_revision_id,root.run_id) started $$,
  'PT409','The configured triage workflow requires its exact currently accepted scope.',
  'direct graph start cannot bypass scope acceptance');

select ok((select approved.phase_status = 'approved' from template_run root
  join public.sessions session on session.id = root.session_id
  cross join lateral public.approve_session_stage(session.id, session.workspace_id, session.current_stage_id,
    session.current_artifact_id, session.current_artifact_version, pg_temp.op651_id(21),
    'codex', 'gpt-5.5', 'code', session.artifact_review_revision) approved),
  'the exact human review accepts the exact scope through the production handoff');



select ok(exists(select 1 from template_run root join internal.factory_workflow_accepted_scopes saved
  on (saved.session_id,saved.graph_revision_id,saved.workflow_digest,saved.run_id) =
    (root.session_id,root.graph_revision_id,root.digest,root.run_id)
  where saved.scope->'acceptanceCriteria' ? 'Exclude contractors.'),
  'approval retains the exact canonical scope against the input checkpoint');
select ok(not exists(select 1 from template_run root
  join internal.factory_workflow_triage_route_dispatches queue on queue.root_session_id=root.session_id),
  'the legacy dispatcher does not race the authored route');
create temp table template_route as
select (enrollment->>'rootSessionId')::uuid as root_session_id,
  (enrollment->>'workspaceId')::uuid as workspace_id,(enrollment->>'factoryId')::uuid as factory_id,
  (enrollment->>'occurrenceId')::uuid as occurrence_id,(enrollment->>'generation')::bigint as execution_generation,
  (enrollment->>'ownershipToken')::uuid as ownership_token,enrollment->>'nodeId' as node_id,
  (enrollment->>'leaseId')::uuid as lease_id,(enrollment->>'inputRunId')::uuid as input_run_id
from (select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(985)) as enrollment) claims;
select is((select node_id from template_route), 'triage.route','the authored dispatcher is the sole first-route owner');
create temp table template_foreman as
select lease.*, public.begin_factory_workflow_foreman_inference(root_session_id, workspace_id, factory_id,
  execution_generation, ownership_token, occurrence_id) as issued from template_route lease;
select ok((select issued->>'status' = 'issued' and issued->>'sourceCheckpointRunId' = root.run_id::text
  from template_foreman route join template_run root on root.session_id = route.root_session_id),
  'the configured foreman obtains an exact inference ticket for the adopted input');
create temp table template_outcome as
select jsonb_build_object('status','accepted','planJson', body,
  'planDigest',encode(sha256(convert_to(body,'UTF8')),'hex'),
  'usage','{"inputTokens":12,"outputTokens":3,"costUsd":0.05}'::jsonb,
  'providerReceiptId','op656-template-local-proof') as outcome
from (select jsonb_build_object('version',1,'commands',jsonb_build_array(jsonb_build_object(
  'kind','route','decision',jsonb_build_object('kind','choose','destinationNodeId','work.split',
  'confidence',0.9,'reason','Proceed using the configured lifecycle.'))))::text body) planned;
select is(public.settle_factory_workflow_foreman_inference(root_session_id,workspace_id,factory_id,
  execution_generation,ownership_token,occurrence_id,(issued->>'issueId')::uuid,outcome)->>'status','accepted',
  'native inference settlement accepts the declared route')
from template_foreman cross join template_outcome;
select is(public.dispatch_factory_workflow_foreman_command(root_session_id,workspace_id,factory_id,
  execution_generation,ownership_token,occurrence_id,(issued->>'foremanRunId')::uuid,1)->>'status','accepted',
  'native dispatch records the retained route command') from template_foreman;

select ok((select issued->>'taskPromptMd' like '%Exclude contractors.%' from template_foreman),
  'the authored first route uses accepted scope instead of unconstrained intake');
select is(public.finish_factory_workflow_authoring_dispatch(root_session_id,input_run_id,lease_id,execution_generation),
  'complete','the authored dispatch lease settles the exact completed first route') from template_route;
create temp table authored_fork as
select public.claim_factory_workflow_authoring_dispatch(pg_temp.op651_id(986)) as claimed;
select is((select claimed->>'nodeId' from authored_fork),'work.split','the authored transition durably queues the fork');
select is((select public.advance_factory_workflow_branch_occurrence(root.session_id,root.workspace_id,
    root.factory_id,(fork.claimed->>'generation')::bigint,(fork.claimed->>'ownershipToken')::uuid,
    (fork.claimed->>'occurrenceId')::uuid)->>'joinStatus'
  from template_run root cross join authored_fork fork), 'pending', 'the authored fork creates the exact branch children');
select is((select count(*) from internal.factory_workflow_delegations marker
  join template_run root on marker.root_session_id=root.session_id
  join internal.factory_workflow_accepted_scopes saved on marker.accepted_scope_receipt_id=saved.receipt_id
  join public.sessions child on child.id=marker.child_session_id
  where child.prompt_md='Invite administrators only.'),2::bigint,
  'both children inherit the exact scope receipt and approved task');

select * from finish();
rollback;
