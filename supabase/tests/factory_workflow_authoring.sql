begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65520000
\set op651_open_groups false
\set op651_parallel_only true
\set op652_join_evidence true
\ir fixtures/factory_workflow_branch.psql

-- Run inside the original OP652 proof fixture, using real factory grants and
-- scoped prompts from the existing branch graph.
create temp table op655_scope as
select root.workspace_id,root.factory_id,base.id as base_activation_id,base.activation_number as base_number,
  base.revision_id,base.digest as base_digest,pg_temp.op651_id(900) as workflow_id,
  pg_temp.op651_id(901) as concurrent_workflow_id,pg_temp.op651_id(902) as publish_workflow_id,
  pg_temp.op651_id(903) as base_workflow_id
from branch_owner root
cross join lateral internal.factory_workflow_authoring_base(root.workspace_id,root.factory_id) base
where root.scenario='parallel';

create temp table op655_graphs as
select 'initial' as label,body,encode(sha256(convert_to(body,'UTF8')),'hex') as digest
from branch_graphs where scenario='parallel'
union all
select 'second',changed.body,encode(sha256(convert_to(changed.body,'UTF8')),'hex')
from branch_graphs cross join lateral (
  select jsonb_set(body::jsonb,'{delegationPolicy,maxCostUsdPerAttempt}','0.25'::jsonb)::text as body
) changed where scenario='parallel';

insert into auth.users(id,email) values (pg_temp.op651_id(910),'factory-manager@example.test'),(pg_temp.op651_id(911),'ordinary-member@example.test');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
select pg_temp.op651_id(member.slot+10),scope.workspace_id,pg_temp.op651_id(member.slot),'human','member'
from op655_scope scope cross join (values (910),(911)) member(slot);
select public.grant_factory_membership(workspace_id,factory_id,pg_temp.op651_id(1),pg_temp.op651_id(920),'manager') from op655_scope;

select is((select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(910),workflow_id,'Release workflow')
  from op655_scope),(select workflow_id from op655_scope),'a scoped factory manager can create a workflow without a workspace-admin role');
select throws_ok($$select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(911),
  gen_random_uuid(),'Unauthorized') from op655_scope$$,'42501','Factory manager access is required.',
  'ordinary workspace membership cannot create workflow authoring records');

select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(1),concurrent_workflow_id,'Concurrent draft') from op655_scope;

create function pg_temp.op655_save(p_label text,p_request integer,p_draft uuid default null,p_activation uuid default null,
  p_actor integer default 910,p_reload boolean default false,p_rebase boolean default false,p_workflow uuid default null)
returns jsonb language sql as $$
  select public.save_factory_workflow_authoring_draft(p_workspace_id => scope.workspace_id,p_factory_id => scope.factory_id,p_actor_user_id => pg_temp.op651_id(p_actor),p_workflow_id => coalesce(p_workflow,scope.workflow_id),
    p_request_id => pg_temp.op651_id(p_request),p_expected_draft_id => p_draft,p_expected_activation_id => p_activation,
    p_expected_base_activation_id => case when p_reload then base.id else scope.base_activation_id end,
    p_expected_base_revision_id => case when p_reload then base.revision_id else scope.revision_id end,
    p_expected_base_digest => case when p_reload then base.digest else scope.base_digest end,p_workflow_json => graph.body,p_workflow_digest => graph.digest,p_rebase => p_rebase)
  from op655_scope scope cross join op655_graphs graph
  cross join lateral internal.factory_workflow_authoring_base(scope.workspace_id,scope.factory_id) base
  where graph.label=p_label
$$;
create function pg_temp.op655_publish(p_label text,p_request integer,p_draft uuid,p_activation uuid default null,
  p_actor integer default 910,p_reload boolean default false,p_workflow uuid default null)
returns jsonb language sql as $$
  select public.publish_factory_workflow_authoring_draft(p_workspace_id => scope.workspace_id,p_factory_id => scope.factory_id,p_actor_user_id => pg_temp.op651_id(p_actor),
    p_workflow_id => coalesce(p_workflow,scope.workflow_id),p_request_id => pg_temp.op651_id(p_request),p_expected_draft_id => p_draft,p_expected_activation_id => p_activation,
    p_expected_base_activation_id => case when p_reload then base.id else scope.base_activation_id end,
    p_expected_base_revision_id => case when p_reload then base.revision_id else scope.revision_id end,
    p_expected_base_digest => case when p_reload then base.digest else scope.base_digest end,p_verified_draft_digest => graph.digest)
  from op655_scope scope cross join op655_graphs graph
  cross join lateral internal.factory_workflow_authoring_base(scope.workspace_id,scope.factory_id) base
  where graph.label=p_label
$$;

select throws_ok($$select pg_temp.op655_save('initial',930,p_actor=>911)$$,
  '42501','Factory manager access is required.','an ordinary authenticated actor cannot save through the service broker');
insert into op655_graphs(label,body,digest)
select 'duplicate',payload.body,encode(sha256(convert_to(payload.body,'UTF8')),'hex')
from op655_graphs graph
cross join lateral (select '{"kind":"graph",' || substr(graph.body,2) as body) payload
where graph.label='initial';
insert into op655_graphs(label,body,digest)
select 'wrong-digest',body,repeat('a',64) from op655_graphs where label='initial';
select throws_ok($$select pg_temp.op655_save('duplicate',930)$$,'22023','Verified compiled workflow JSON is required.',
  'native validation rejects duplicate JSON keys even with the exact digest');
select throws_ok($$select pg_temp.op655_save('wrong-digest',930)$$,'22023','Verified compiled workflow JSON is required.',
  'native validation rejects a substituted digest on a valid graph');
create temp table op655_draft_first as select pg_temp.op655_save('initial',930) as result;
select ok((select (result->>'created')::boolean and result->>'draftId' is not null from op655_draft_first),'first save appends an immutable draft');
select is(pg_temp.op655_save('initial',930)->>'draftId',(select result->>'draftId' from op655_draft_first),
  'an exact interrupted save can retrieve its immutable receipt');
select throws_ok($$select pg_temp.op655_save('second',930)$$,'PT409','Workflow save request already identifies a different change.',
  'the same request UUID cannot identify other bytes');
select throws_ok($$select pg_temp.op655_save('second',931)$$,'PT409','The workflow draft or published activation changed.',
  'a competing tab cannot overwrite the latest saved draft');
create temp table op655_draft_second as
select pg_temp.op655_save('second',931,(result->>'draftId')::uuid) as result from op655_draft_first;
select throws_ok($$select pg_temp.op655_publish('initial',933,(result->>'draftId')::uuid) from op655_draft_first$$,
  'PT409','The workflow draft or published activation changed.','a displaced immutable draft cannot be published');
select throws_ok($$select pg_temp.op655_publish('initial',933,(result->>'draftId')::uuid) from op655_draft_second$$,
  'PT409','The recompiled workflow does not match the saved draft.','publish requires the exact recompiled saved digest');
select throws_ok($$select pg_temp.op655_publish('second',933,(result->>'draftId')::uuid,p_actor=>911) from op655_draft_second$$,
  '42501','Factory manager access is required.','ordinary workspace membership cannot publish through the service role');

select set_config('request.jwt.claim.sub',pg_temp.op651_id(911)::text,true);
select set_config('request.jwt.claim.role','authenticated',true);
select is((select public.read_factory_workflow_authoring(workspace_id,factory_id,workflow_id) from op655_scope),
  null::jsonb,'ordinary workspace membership cannot read private authoring history');
select set_config('request.jwt.claim.sub',pg_temp.op651_id(910)::text,true);
select is((select public.read_factory_workflow_authoring(workspace_id,factory_id,workflow_id)->>'draftId' from op655_scope),
  (select result->>'draftId' from op655_draft_second),'the same factory manager reads the exact latest draft');
select is((select public.read_factory_workflow_authoring(workspace_id,factory_id,concurrent_workflow_id,(result->>'draftId')::uuid)
  from op655_scope cross join op655_draft_second),
  null::jsonb,'a draft identity cannot be substituted into another workflow scope');
select ok((select snapshot.readback->>'selectedDraftId'=prior.result->>'draftId'
    and snapshot.readback->>'selectedDraftDigest'=prior.result->>'digest'
    and snapshot.readback->>'draftId'=latest.result->>'draftId'
    and snapshot.readback#>>'{selectedDraftBaseDefinition,activationId}'=scope.base_activation_id::text
  from op655_scope scope cross join op655_draft_first prior cross join op655_draft_second latest
  cross join lateral (select public.read_factory_workflow_authoring(scope.workspace_id,scope.factory_id,scope.workflow_id,
    (prior.result->>'draftId')::uuid) as readback) snapshot),
  'historical selection reads the exact draft digest and base while keeping the current head visible');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub',pg_temp.op651_id(1)::text,true);

create temp table op655_activation_first as
select pg_temp.op655_publish('second',933,(result->>'draftId')::uuid) as result from op655_draft_second;
select ok((select activation.draft_id=(draft.result->>'draftId')::uuid and graph.workflow_digest=stored.workflow_digest
  and graph.workflow_json=stored.workflow_json
  from op655_activation_first record cross join op655_draft_second draft
  join internal.factory_workflow_authoring_drafts stored on (draft.result->>'draftId')::uuid=stored.id
  join internal.factory_workflow_authoring_activations activation on activation.draft_id=stored.id
  join internal.factory_workflow_graph_revisions graph on graph.id=activation.graph_revision_id
  where activation.id=(record.result->>'activationId')::uuid),'publication pins one exact draft and canonical runtime revision atomically');
select ok(exists (
  select 1 from op655_scope scope cross join op655_activation_first record
  cross join lateral public.list_factory_workflow_intake_options(scope.workspace_id,scope.factory_id) option
  where (option.workflow_id,option.activation_id,option.definition_digest) =
    (scope.workflow_id,(record.result->>'activationId')::uuid,scope.base_digest)
), 'intake catalog returns its selected activation and authoritative base digest from one read');
select is((select pg_temp.op655_publish('second',933,(result->>'draftId')::uuid)->>'created' from op655_draft_second),
  'false','a lost publication response replays the immutable activation');
select throws_ok($$select pg_temp.op655_publish('second',934,(result->>'draftId')::uuid) from op655_draft_second$$,
  'PT409','The workflow draft or published activation changed.','a second publisher with a different request cannot republish the same emitted draft');

select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(910),
  pg_temp.op651_id(1600),'Workflow with long history') from op655_scope;
do $$
declare
  workflow uuid := pg_temp.op651_id(1600);
  prior uuid;
  activation uuid;
begin
  for revision in 1..23 loop
    prior := (pg_temp.op655_save('second',1600+revision,prior,activation,p_workflow=>workflow)->>'draftId')::uuid;
    if revision = 2 then
      activation := (pg_temp.op655_publish('second',1650,prior,p_workflow=>workflow)->>'activationId')::uuid;
    end if;
  end loop;
end;
$$;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.op651_id(910)::text,true);
select is(
  (select array_agg((item.value->>'revision')::integer order by item.position)
   from op655_scope scope
   join internal.factory_workflow_authoring_drafts oldest
     on oldest.workflow_id=pg_temp.op651_id(1600) and oldest.revision_number=1
   cross join lateral jsonb_array_elements(public.read_factory_workflow_authoring(
     scope.workspace_id,scope.factory_id,oldest.workflow_id,oldest.id)->'recentDrafts')
     with ordinality item(value,position)),
  array[23,22,21,20,19,18,17,16,15,14,13,12,11,10,9,8,7,6,2,1],
  'history stays bounded and labels the exact live and selected draft outside the first twenty');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub',pg_temp.op651_id(1)::text,true);

select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(910),pg_temp.op651_id(904),
  'Exact review workflow') from op655_scope;
create temp table op655_foreign_factory as
select factory.* from op655_scope scope
cross join lateral public.create_factory(scope.workspace_id,pg_temp.op651_id(1),'Other review factory','other-review') factory;
insert into public.factory_agent_prompt_revisions(id,workspace_id,factory_id,agent_id,revision_number,
  prompt_md,prompt_sha256,created_by)
select pg_temp.op651_id(905),agent.workspace_id,agent.factory_id,agent.id,2,
  'Other factory reviewer.',encode(sha256(convert_to('Other factory reviewer.','UTF8')),'hex'),pg_temp.op651_id(21)
from op655_foreign_factory factory join public.factory_agents agent on agent.factory_id=factory.id and agent.is_default;

insert into op655_graphs(label,body,digest)
select variant.label,added.body,encode(sha256(convert_to(added.body,'UTF8')),'hex')
from op655_graphs graph
cross join (values
  ('scoped-review',91,'review.repair'),
  ('foreign-review',905,'review.repair'),
  ('colliding-repair',91,'review.joined')
) variant(label,prompt_slot,repair_edge)
cross join lateral (
  select (graph.body::jsonb || jsonb_build_object(
    'nodes',graph.body::jsonb->'nodes' || jsonb_build_object('id','review.commit','kind','review',
      'reviewerPromptRevisionId',pg_temp.op651_id(variant.prompt_slot),'ruleIds',jsonb_build_array('security'),
      'repair',jsonb_build_object('edgeId',variant.repair_edge,'maxRepairs',2,'eligibleRuleIds',jsonb_build_array('security'))),
    'edges',graph.body::jsonb->'edges' || jsonb_build_object('id','review.joined','kind','next','from','join.finish','to','review.commit')
  ))::text as body
) added where graph.label='initial';
select throws_ok($$select pg_temp.op655_save('foreign-review',941,p_workflow=>pg_temp.op651_id(904))$$,
  'PT422','Workflow agent prompts are unavailable.','the editor cannot save a reviewer prompt from another factory');
create temp table invalid_review_draft as
select pg_temp.op655_save('colliding-repair',941,p_workflow=>pg_temp.op651_id(904)) as result;
select throws_ok($$select pg_temp.op655_publish('colliding-repair',942,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(904))
  from invalid_review_draft$$,'PT422','The review requires its scoped prompt, declared rules, and exact joined input.',
  'native publication rejects a repair edge ID that aliases a real transition');
create temp table exact_review_draft as
select pg_temp.op655_save('scoped-review',943,p_draft=>(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(904)) as result
from invalid_review_draft;
create temp table exact_review_activation as
select pg_temp.op655_publish('scoped-review',944,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(904)) as result
from exact_review_draft;
select is((select graph.workflow_json from exact_review_activation receipt
  join internal.factory_workflow_graph_revisions graph on graph.id=(receipt.result->>'graphRevisionId')::uuid),
  (select body from op655_graphs where label='scoped-review'),
  'published runtime retains the exact reviewer prompt, rules, and bounded repair draft');

select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(910),pg_temp.op651_id(906),
  'Delegation eligibility workflow') from op655_scope;
insert into op655_graphs(label,body,digest)
select 'no-delegation',payload.body,encode(sha256(convert_to(payload.body,'UTF8')),'hex')
from lateral (
  select jsonb_build_object('schemaVersion',1,'kind','graph','entryNodeId','checkpoint','grants','[]'::jsonb,
    'nodes',jsonb_build_array(jsonb_build_object('id','checkpoint','kind','deterministic','operation','checkpoint'),
      jsonb_build_object('id','worker','kind','agent','agentPromptRevisionId',pg_temp.op651_id(91))),
    'edges',jsonb_build_array(jsonb_build_object('id','work','kind','next','from','checkpoint','to','worker')))::text body
) payload;
create temp table no_delegation_draft as
select pg_temp.op655_save('no-delegation',945,p_workflow=>pg_temp.op651_id(906)) as result;
select throws_ok($$select pg_temp.op655_publish('no-delegation',946,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(906))
  from no_delegation_draft$$,'PT422','The graph requires bounded delegation and exact scoped child profiles.',
  'a scoped agent without an enrollable delegation policy cannot publish');

insert into op655_graphs(label,body,digest)
select 'mismatched-foreman',payload.body,encode(sha256(convert_to(payload.body,'UTF8')),'hex')
from op655_scope scope
join public.factory_definition_revisions profile on profile.id=scope.revision_id
cross join lateral (
  select prompt.id from public.factory_agent_prompt_revisions prompt
  where (prompt.workspace_id,prompt.factory_id)=(scope.workspace_id,scope.factory_id)
    and prompt.id<>pg_temp.op651_id(91) order by prompt.id limit 1
) prompt
cross join lateral (
  select jsonb_build_object('schemaVersion',1,'kind','graph','entryNodeId','route','grants','[]'::jsonb,
    'nodes',jsonb_build_array(jsonb_build_object('id','route','kind','route','agentPromptRevisionId',prompt.id),
      jsonb_build_object('id','checkpoint','kind','deterministic','operation','checkpoint')),
    'edges',jsonb_build_array(jsonb_build_object('id','choose','kind','route','from','route','to','checkpoint')),
    'routePolicy',jsonb_build_object('maxNodeVisits',4,'maxLoopTraversals',0,'nodes',jsonb_build_object('route',
      jsonb_build_object('minimumConfidence',0.8,'allowedDestinationIds',jsonb_build_array('checkpoint'),
        'fallback',jsonb_build_object('kind','clarification'),
        'foremanProfile',jsonb_build_object('definitionRevisionId',profile.id,'definitionDigest',profile.canonical_digest)))),
    'delegationPolicy','{"targets":{},"maxChildren":1,"maxConcurrentChildren":1,"maxAttempts":1,"maxTotalTokens":100,
      "maxTokensPerAttempt":100,"maxCostUsd":1,"maxCostUsdPerAttempt":1}'::jsonb)::text body
) payload;
create temp table mismatched_foreman_draft as
select pg_temp.op655_save('mismatched-foreman',947,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(906)) as result
from no_delegation_draft;
select throws_ok($$select pg_temp.op655_publish('mismatched-foreman',948,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(906))
  from mismatched_foreman_draft$$,'PT422','The graph requires a scoped foreman profile and bounded delegation.',
  'a reviewable draft with a foreman profile bound to a different prompt cannot publish');

insert into op655_graphs(label,body,digest)
select variant.label,compiled.body,encode(sha256(convert_to(compiled.body,'UTF8')),'hex')
from op655_graphs graph cross join (values ('no-foreman',false),('configured-foreman',true)) variant(label,configured)
cross join lateral (
  select jsonb_set(graph.body::jsonb,'{nodes,0,agentPromptRevisionId}',to_jsonb(pg_temp.op651_id(91))) body
) matching_prompt
cross join lateral (select case when variant.configured then matching_prompt.body::text
  else (matching_prompt.body #- '{routePolicy,nodes,route,foremanProfile}')::text end body) compiled
where graph.label='mismatched-foreman';
create temp table no_foreman_draft as
select pg_temp.op655_save('no-foreman',949,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(906)) as result
from mismatched_foreman_draft;
select is((select (result->>'created')::boolean from no_foreman_draft),true,
  'an incomplete route with a scoped prompt and no Foreman remains editable');
select throws_ok($$select pg_temp.op655_publish('no-foreman',959,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(906))
  from no_foreman_draft$$,'PT422','Published workflow routes require a Foreman profile.',
  'native publication rejects a route with no executable decision producer');
create temp table corrected_authoring_draft as
select pg_temp.op655_save('configured-foreman',1000,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(906)) as result
from no_foreman_draft;
select ok((select (pg_temp.op655_publish('configured-foreman',1001,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(906))
  ->>'created')::boolean from corrected_authoring_draft),
  'the exact same route publishes after configuring a valid Foreman decision profile');

select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(910),pg_temp.op651_id(907),
  'Human approval policy workflow') from op655_scope;
insert into op655_graphs(label,body,digest)
select variant.label,payload.body,encode(sha256(convert_to(payload.body,'UTF8')),'hex')
from (values ('matching-gate',21,false),('other-gate-approver',921,false),('open-gate-policy',21,true))
  variant(label,approver_slot,anyone_can_approve)
cross join lateral (
  select jsonb_build_object('schemaVersion',1,'kind','graph','entryNodeId','checkpoint','grants','[]'::jsonb,
    'nodes',jsonb_build_array(jsonb_build_object('id','checkpoint','kind','deterministic','operation','checkpoint'),
      jsonb_build_object('id','approved','kind','human-gate','anyoneCanApprove',variant.anyone_can_approve,
        'approverMemberIds',jsonb_build_array(pg_temp.op651_id(variant.approver_slot)))),
    'edges',jsonb_build_array(jsonb_build_object('id','approve','kind','next','from','checkpoint','to','approved')))::text body
) payload;
create temp table other_gate_draft as
select pg_temp.op655_save('other-gate-approver',966,p_workflow=>pg_temp.op651_id(907)) as result;
select throws_ok($$select pg_temp.op655_publish('other-gate-approver',967,(result->>'draftId')::uuid,
  p_workflow=>pg_temp.op651_id(907)) from other_gate_draft$$,
  'PT422','Approval settings for workflow gate "approved" must match its source stage.',
  'an active approver outside the authoritative final stage can be saved in a draft but cannot be published');
create temp table open_gate_draft as
select pg_temp.op655_save('open-gate-policy',968,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(907)) as result
from other_gate_draft;
select throws_ok($$select pg_temp.op655_publish('open-gate-policy',969,(result->>'draftId')::uuid,
  p_workflow=>pg_temp.op651_id(907)) from open_gate_draft$$,
  'PT422','Approval settings for workflow gate "approved" must match its source stage.',
  'changing only the anyone-can-approve setting cannot publish over the exact named source policy');
create temp table matching_gate_draft as
select pg_temp.op655_save('matching-gate',970,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(907)) as result
from open_gate_draft;
select ok((select (pg_temp.op655_publish('matching-gate',971,(result->>'draftId')::uuid,p_workflow=>pg_temp.op651_id(907))
  ->>'created')::boolean from matching_gate_draft),
  'the corrected human gate publishes against its exact final preparation stage');

insert into op655_graphs(label,body,digest)
select 'broader-primary-profile',payload.body,encode(sha256(convert_to(payload.body,'UTF8')),'hex')
from op655_graphs graph join public.factory_definition_revisions profile on profile.id=pg_temp.op651_id(45)
cross join lateral (
  select jsonb_set(graph.body::jsonb,'{delegationPolicy,targets,agent.required}',
    jsonb_build_object('definitionRevisionId',profile.id,'definitionDigest',profile.canonical_digest))::text body
) payload where graph.label='initial';
select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(910),pg_temp.op651_id(908),
  'Inherited profile authority workflow') from op655_scope;
select throws_ok($$select pg_temp.op655_save('broader-primary-profile',972,p_workflow=>pg_temp.op651_id(908))$$,
  'PT422','Workflow execution profile exceeds the base authority.',
  'a same-repository child may not read context missing from the pinned parent definition');

savepoint joined_gate_source_policy;
insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.op651_id(variant.slot),child.workspace_id,child.factory_id,1,profile.body,
  encode(sha256(convert_to(profile.body,'UTF8')),'hex'),pg_temp.op651_id(21)
from scoped_revisions child
cross join (values (974,true),(1010,false)) variant(slot,has_delivery_evidence)
cross join lateral (select jsonb_set(jsonb_set(child.body::jsonb,'{stages,0,approverMemberIds}',
  jsonb_build_array(pg_temp.op651_id(921))),'{deliveryPolicyRevisionId}',
  case when variant.has_delivery_evidence then (select to_jsonb(id) from op651_fixture_delivery_policy)
    else 'null'::jsonb end)::text body) profile
where child.scenario='narrow';
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,pg_temp.op651_id(974),6,pg_temp.op651_id(21) from op655_scope
union all
select workspace_id,factory_id,pg_temp.op651_id(1010),7,pg_temp.op651_id(21) from op655_scope
union all
select workspace_id,factory_id,revision_id,8,pg_temp.op651_id(21) from op655_scope;
select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(910),pg_temp.op651_id(975),
  'Joined child approval policy') from op655_scope;
insert into op655_graphs(label,body,digest)
select variant.label,payload.body,encode(sha256(convert_to(payload.body,'UTF8')),'hex')
from op655_graphs graph
join public.factory_definition_revisions foreman on foreman.id=pg_temp.op651_id(43)
cross join (values ('gate-after-child-join',false,974),('gate-before-child-join',true,974),
  ('join-without-child-policy',false,1010)) variant(label,before_join,profile_slot)
join public.factory_definition_revisions profile on profile.id=pg_temp.op651_id(variant.profile_slot)
cross join lateral (
  select (graph.body::jsonb || jsonb_build_object('entryNodeId','select.parent',
    'nodes',graph.body::jsonb->'nodes' || jsonb_build_array(
      jsonb_build_object('id','select.parent','kind','route','agentPromptRevisionId',pg_temp.op651_id(91)),
      jsonb_build_object('id','agent.parent','kind','agent','agentPromptRevisionId',pg_temp.op651_id(91)),
      jsonb_build_object('id','approve.child','kind','human-gate','anyoneCanApprove',false,
        'approverMemberIds',jsonb_build_array(pg_temp.op651_id(921)))),
    'edges',graph.body::jsonb->'edges' || jsonb_build_array(
      jsonb_build_object('id','choose.parent','kind','route','from','select.parent','to','agent.parent'),
      jsonb_build_object('id','parent.next','kind','next','from','agent.parent','to',
        case when variant.before_join then 'approve.child' else 'branch.split' end),
      jsonb_build_object('id','approval.next','kind','next','from',
        case when variant.before_join then 'approve.child' else 'join.finish' end,'to',
        case when variant.before_join then 'branch.split' else 'approve.child' end)),
    'routePolicy',jsonb_build_object('maxNodeVisits',16,'maxLoopTraversals',0,'nodes',jsonb_build_object('select.parent',
      jsonb_build_object('minimumConfidence',0.8,'allowedDestinationIds',jsonb_build_array('agent.parent'),
        'fallback',jsonb_build_object('kind','clarification'),
        'foremanProfile',jsonb_build_object('definitionRevisionId',foreman.id,'definitionDigest',foreman.canonical_digest)))),
    'delegationPolicy',jsonb_set(jsonb_set(graph.body::jsonb->'delegationPolicy','{maxChildren}','3'::jsonb),
      '{targets,agent.parent}',jsonb_build_object('definitionRevisionId',profile.id,'definitionDigest',profile.canonical_digest))
  ))::text body
) payload where graph.label='initial';
create temp table before_join_gate_draft as
select pg_temp.op655_save('gate-before-child-join',976,p_reload=>true,p_workflow=>pg_temp.op651_id(975)) as result;
select throws_ok($$select pg_temp.op655_publish('gate-before-child-join',977,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(975)) from before_join_gate_draft$$,
  'PT422','Approval settings for workflow gate "approve.child" must match its source stage.',
  'a routed child does not replace the root approval source before its join');
create temp table missing_join_policy_draft as
select pg_temp.op655_save('join-without-child-policy',1011,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(975)) as result from before_join_gate_draft;
select throws_ok($$select pg_temp.op655_publish('join-without-child-policy',1012,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(975)) from missing_join_policy_draft$$,
  'PT422','Workflow step "join.finish" requires its source to pin a delivery policy with valid required evidence.',
  'a routed join cannot borrow the root delivery policy when its exact child parent lacks one');
create temp table after_join_gate_draft as
select pg_temp.op655_save('gate-after-child-join',978,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(975)) as result from missing_join_policy_draft;
select ok((select (pg_temp.op655_publish('gate-after-child-join',979,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(975))->>'created')::boolean from after_join_gate_draft),
  'a join and gate can publish with the exact delivery and approval policies of their routed child source');
rollback to joined_gate_source_policy;

savepoint authored_delivery_policy;
insert into public.delivery_policy_revisions(id,workspace_id,pipeline_id,revision,requirements,created_by)
select pg_temp.op651_id(example.slot),policy.workspace_id,policy.pipeline_id,example.revision,
  jsonb_set(policy.requirements,'{requiredEvidence}',example.evidence),policy.created_by
from op651_fixture_delivery_policy pin join public.delivery_policy_revisions policy using (id)
cross join (values (1013,2,'[]'::jsonb),(1014,3,'["a key with spaces"]'::jsonb)) example(slot,revision,evidence);
insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.op651_id(example.slot),base.workspace_id,base.factory_id,1,definition.body,
  encode(sha256(convert_to(definition.body,'UTF8')),'hex'),pg_temp.op651_id(21)
from scoped_revisions base
cross join (values (1015,1013),(1016,1014),(1017,null)) example(slot,delivery_policy_slot)
cross join lateral (select case when example.delivery_policy_slot is null then
  ((base.body::jsonb-array['executionGrant','credentialBindingId']) || '{"executionPolicyRevisionId":null}'::jsonb)::text
  else jsonb_set(base.body::jsonb,'{deliveryPolicyRevisionId}',to_jsonb(pg_temp.op651_id(example.delivery_policy_slot)))::text
end body) definition where base.scenario='root';
insert into op655_graphs(label,body,digest)
select operation||'-step',payload.body,encode(sha256(convert_to(payload.body,'UTF8')),'hex')
from (values ('checkpoint'),('validation'),('policy')) node(operation)
cross join lateral (select jsonb_build_object('schemaVersion',1,'kind','graph','entryNodeId','check',
  'nodes',jsonb_build_array(jsonb_build_object('id','check','kind','deterministic','operation',operation)),
  'edges','[]'::jsonb,'grants','[]'::jsonb)::text body) payload;
select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(910),pg_temp.op651_id(1018),
  'Pinned policy fixture') from op655_scope;

insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,pg_temp.op651_id(1015),6,pg_temp.op651_id(21) from op655_scope;
create temp table empty_policy_draft as
select pg_temp.op655_save('validation-step',1019,p_reload=>true,p_workflow=>pg_temp.op651_id(1018)) as result;
select throws_ok($$select pg_temp.op655_publish('validation-step',1020,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(1018)) from empty_policy_draft$$,
  'PT422','The graph requires a pinned delivery policy with valid required evidence.',
  'validation cannot publish with an empty exact policy even while the current pipeline policy has evidence');
create temp table root_join_draft as
select pg_temp.op655_save('initial',1021,(result->>'draftId')::uuid,p_reload=>true,p_workflow=>pg_temp.op651_id(1018))
  as result from empty_policy_draft;
select throws_ok($$select pg_temp.op655_publish('initial',1022,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(1018)) from root_join_draft$$,
  'PT422','Workflow step "join.finish" requires its source to pin a delivery policy with valid required evidence.',
  'a root join requires valid pinned evidence even without a validation step');

insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,pg_temp.op651_id(1016),7,pg_temp.op651_id(21) from op655_scope;
create temp table invalid_evidence_key_draft as
select pg_temp.op655_save('validation-step',1023,(result->>'draftId')::uuid,p_reload=>true,p_rebase=>true,
  p_workflow=>pg_temp.op651_id(1018)) as result from root_join_draft;
select throws_ok($$select pg_temp.op655_publish('validation-step',1024,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(1018)) from invalid_evidence_key_draft$$,
  'PT422','The graph requires a pinned delivery policy with valid required evidence.',
  'a nonempty policy with an unusable validation key cannot publish a validation step');

insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,pg_temp.op651_id(1017),8,pg_temp.op651_id(21) from op655_scope;
create temp table no_execution_policy_draft as
select pg_temp.op655_save('policy-step',1025,(result->>'draftId')::uuid,p_reload=>true,p_rebase=>true,
  p_workflow=>pg_temp.op651_id(1018)) as result from invalid_evidence_key_draft;
select throws_ok($$select pg_temp.op655_publish('policy-step',1026,(result->>'draftId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(1018)) from no_execution_policy_draft$$,
  'PT422','The graph requires a pinned execution policy.','a policy step cannot publish with a missing exact execution policy');
create temp table checkpoint_on_blank_policy as
select pg_temp.op655_save('checkpoint-step',1027,(result->>'draftId')::uuid,p_reload=>true,
  p_workflow=>pg_temp.op651_id(1018)) as result from no_execution_policy_draft;
create temp table checkpoint_without_policy_activation as
select pg_temp.op655_publish('checkpoint-step',1028,(result->>'draftId')::uuid,p_reload=>true,
  p_workflow=>pg_temp.op651_id(1018)) as result from checkpoint_on_blank_policy;
select is((select result->>'created' from checkpoint_without_policy_activation),'true',
  'a checkpoint-only graph still publishes without a pinned execution policy');

create function pg_temp.policy_fixture_create(p_request integer,p_activation_id text default null)
returns table(session_id uuid,session_number integer,workspace_slug text,job_id uuid,run_id uuid) language sql as $$
  select session.* from op655_scope scope
  cross join lateral internal.factory_workflow_authoring_base(scope.workspace_id,scope.factory_id) base
  cross join lateral public.create_session_command_once(scope.workspace_id,pg_temp.op651_id(21),pg_temp.op651_id(p_request),
    repeat('d',64),base.digest,'Authored policy intake','Run from the confirmed factory.','codex','gpt-5.5','{}',
    target_factory_id=>scope.factory_id,p_workflow_selection=>case when p_activation_id is not null then
      jsonb_build_object('workflowId',pg_temp.op651_id(1018),'activationId',p_activation_id) end) session
$$;
create function pg_temp.hidden_checkpoint_retains_readback(p_activation_id text) returns boolean language sql stable as $$
  select not exists (select 1 from public.list_factory_workflow_intake_options(scope.workspace_id,scope.factory_id))
    and readback.snapshot->>'activationId'=p_activation_id
    and readback.snapshot#>>'{baseDefinition,digest}'=base.digest
  from op655_scope scope
  cross join lateral internal.factory_workflow_authoring_base(scope.workspace_id,scope.factory_id) base
  cross join lateral (select public.read_factory_workflow_authoring(scope.workspace_id,scope.factory_id,
    pg_temp.op651_id(1018)) snapshot) readback
$$;
select set_config('request.jwt.claim.role','authenticated',true);
select ok((select pg_temp.hidden_checkpoint_retains_readback(result->>'activationId') from checkpoint_without_policy_activation),
  'a signed-in catalog hides the published checkpoint without a grant and preserves its authoring base digest');
select set_config('request.jwt.claim.role','service_role',true);
select throws_ok($$select created.* from checkpoint_without_policy_activation receipt
  cross join lateral pg_temp.policy_fixture_create(1032,receipt.result->>'activationId') created$$,
  'PT409','The selected workflow requires the confirmed factory admission.',
  'a directly submitted activation without a grant cannot bypass picker eligibility');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.op651_id(1),'platform_api_key','fixture-ciphertext');
create temp table ordinary_policy_intake as select * from pg_temp.policy_fixture_create(1033);
select ok((select session.factory_definition_revision_id=pg_temp.op651_id(1017)
    and not exists (select 1 from internal.factory_workflow_authoring_session_pins where session_id=session.id)
  from ordinary_policy_intake created join public.sessions session on session.id=created.session_id),
  'the same confirmed grantless base can still create an ordinary serial session');

insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.op651_id(1034),base.workspace_id,base.factory_id,1,definition.body,
  encode(sha256(convert_to(definition.body,'UTF8')),'hex'),pg_temp.op651_id(21)
from scoped_revisions base cross join lateral (select (base.body::jsonb-'credentialBindingId')::text body) definition
where base.scenario='root';
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,pg_temp.op651_id(1034),9,pg_temp.op651_id(21) from op655_scope;
create temp table no_credential_checkpoint_draft as
select pg_temp.op655_save('checkpoint-step',1035,(result->>'draftId')::uuid,(result->>'activationId')::uuid,
  p_reload=>true,p_rebase=>true,p_workflow=>pg_temp.op651_id(1018)) as result from checkpoint_without_policy_activation;
create temp table no_credential_checkpoint_activation as
select pg_temp.op655_publish('checkpoint-step',1036,(draft.result->>'draftId')::uuid,(prior.result->>'activationId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(1018)) as result
from no_credential_checkpoint_draft draft cross join checkpoint_without_policy_activation prior;
select set_config('request.jwt.claim.role','authenticated',true);
select ok((select pg_temp.hidden_checkpoint_retains_readback(result->>'activationId') from no_credential_checkpoint_activation),
  'a signed-in catalog hides the published checkpoint with a grant but no credential and preserves its authoring base digest');
select set_config('request.jwt.claim.role','service_role',true);
select throws_ok($$select created.* from no_credential_checkpoint_activation receipt
  cross join lateral pg_temp.policy_fixture_create(1037,receipt.result->>'activationId') created$$,
  'PT409','The selected workflow requires the confirmed factory admission.',
  'a directly submitted activation with no credential cannot bypass picker eligibility');

insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,revision_id,10,pg_temp.op651_id(21) from op655_scope;
create temp table valid_validation_draft as
select pg_temp.op655_save('validation-step',1029,(receipt.result->>'draftId')::uuid,(receipt.result->>'activationId')::uuid,
  p_reload=>true,p_rebase=>true,p_workflow=>pg_temp.op651_id(1018)) as result from no_credential_checkpoint_activation receipt;
create temp table valid_validation_activation as
select pg_temp.op655_publish('validation-step',1030,(draft.result->>'draftId')::uuid,(prior.result->>'activationId')::uuid,
  p_reload=>true,p_workflow=>pg_temp.op651_id(1018)) as result
from valid_validation_draft draft cross join no_credential_checkpoint_activation prior;
select set_config('request.jwt.claim.role','authenticated',true);
select ok(exists (select 1 from op655_scope scope cross join valid_validation_activation receipt
  cross join lateral public.list_factory_workflow_intake_options(scope.workspace_id,scope.factory_id) option
  where (option.workflow_id,option.activation_id,option.definition_digest)=
    (pg_temp.op651_id(1018),(receipt.result->>'activationId')::uuid,scope.base_digest)),
  'the signed-in catalog still returns the exact eligible activation and authoritative base digest');
select set_config('request.jwt.claim.role','service_role',true);
create temp table valid_validation_preparation as
select session.session_id,pg_temp.adopt_source_checkpoint(session.session_id,session.job_id) run_id
from valid_validation_activation publication
cross join lateral pg_temp.policy_fixture_create(1031,publication.result->>'activationId') session;
select ok((select started.created and session.pinned_delivery_policy_revision_id=(select id from op651_fixture_delivery_policy)
  from valid_validation_preparation source cross join valid_validation_activation publication
  join public.sessions session on session.id=source.session_id
  cross join lateral public.start_factory_workflow_graph_execution(session.id,session.workspace_id,session.factory_id,
    (publication.result->>'graphRevisionId')::uuid,source.run_id) started),
  'a validation workflow publishes and enrolls against the exact eligible delivery policy');
rollback to authored_delivery_policy;

-- Compose the published activation with real browser and machine create commands.
create function pg_temp.workflow_request_selection(p_version text)
returns jsonb language sql stable as $$
  select jsonb_build_object('workflowId', scope.workflow_id, 'activationId', activation.result->>'activationId')
  from op655_scope scope cross join op655_activation_first activation
  where p_version = 'old'
$$;

create function pg_temp.browser_create_with_workflow(p_slot integer, p_hash text, p_selection jsonb,
  p_attachments uuid[] default '{}'::uuid[])
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select created.* from op655_scope scope cross join lateral public.create_session_command_once(
    scope.workspace_id, pg_temp.op651_id(21), pg_temp.op651_id(p_slot), p_hash, scope.base_digest,
    'Inspect the approved workflow', 'Run the selected exact workflow.', 'codex', 'gpt-5.5', p_attachments,
    target_factory_id => scope.factory_id, p_workflow_selection => p_selection) created
$$;

create function pg_temp.machine_create_with_workflow(p_slot integer, p_selection jsonb)
returns jsonb language plpgsql as $$
declare scope record; permit record; request_id uuid := gen_random_uuid(); receipt jsonb;
begin
  select workspace_id, factory_id into strict scope from op651_scope;
  select * into strict permit from public.admit_factory_command(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op651_id(36), repeat('a', 64), 'sessions:create', request_id, repeat('e', 64), 'api');
  if permit.status <> 'admitted' then raise exception 'Workflow fixture admission failed: %', permit.status; end if;
  receipt := public.execute_factory_session_mutation(scope.workspace_id, scope.factory_id, 'machine_token',
    pg_temp.op651_id(36), repeat('a', 64), request_id, repeat('e', 64), 'api', permit.admission_id, permit.lease_id,
    'create', pg_temp.op651_id(p_slot), jsonb_build_object('title', 'Inspect the approved workflow',
      'prompt', 'Run the selected exact workflow.', 'agentId', (select agent_id from public.factory_agent_prompt_revisions
      where id = pg_temp.op651_id(91)), 'repositoryId', pg_temp.op651_id(34), 'draftSpecification', false)
      || case when p_selection is not null then jsonb_build_object('workflowSelection', p_selection) else '{}'::jsonb end);
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  return receipt;
end;
$$;

create temp table intake_browser_first as
select * from pg_temp.browser_create_with_workflow(950, repeat('d', 64), pg_temp.workflow_request_selection('old'));
create temp table intake_machine_first as
select pg_temp.machine_create_with_workflow(951, pg_temp.workflow_request_selection('old')) as result;
select is((select count(*) from internal.factory_workflow_authoring_session_pins pin
  join op655_activation_first activation on pin.activation_id = (activation.result->>'activationId')::uuid
  where pin.session_id in ((select session_id from intake_browser_first), (select (result->>'sessionId')::uuid from intake_machine_first))),
  2::bigint, 'browser and machine atomically pin the authored activation');
select is((select (pg_temp.machine_create_with_workflow(950, pg_temp.workflow_request_selection('old'))->>'sessionId')::uuid),
  (select session_id from intake_browser_first), 'machine replay recognizes the same selected browser intent');
select is((select session_id from pg_temp.browser_create_with_workflow(951, repeat('f', 64), pg_temp.workflow_request_selection('old'))),
  (select (result->>'sessionId')::uuid from intake_machine_first), 'browser replay recognizes the same selected machine intent');
select throws_ok($q$select pg_temp.machine_create_with_workflow(950, null)$q$, 'P0005', null,
  'dropping authored selection is a different request');
select throws_ok($q$select * from pg_temp.browser_create_with_workflow(950,repeat('d',64),null)$q$, 'P0005', null,
  'an identical caller hash cannot omit the authored selection');

insert into public.session_attachments(id,workspace_id,uploaded_by_member_id,original_filename,content_type,
  size_bytes,storage_path,status,expires_at)
select pg_temp.op651_id(slot),scope.workspace_id,pg_temp.op651_id(21),'workflow-'||slot||'.png','image/png',
  1024,'fixture/workflow-'||slot||'.png','ready',now()+interval '1 hour'
from op655_scope scope cross join (values (961),(962),(964)) image(slot);
create temp table attached_workflow_intake as
select * from pg_temp.browser_create_with_workflow(960,repeat('c',64),pg_temp.workflow_request_selection('old'),
  array[pg_temp.op651_id(962),pg_temp.op651_id(961)]);
select is((select array_agg(attachment.id order by attachment.position)
  from attached_workflow_intake receipt join public.session_attachments attachment on attachment.session_id=receipt.session_id
  where attachment.status='attached' and attachment.expires_at is null),
  array[pg_temp.op651_id(962),pg_temp.op651_id(961)],'the selected workflow admits browser images in their original order');
select ok((select pin.graph_revision_id=(activation.result->>'graphRevisionId')::uuid
    and admission.definition_digest=scope.base_digest
  from attached_workflow_intake receipt
  join public.session_factory_admission_inputs admission on admission.session_id=receipt.session_id
  join internal.factory_workflow_authoring_session_pins pin on (pin.session_id,pin.factory_id)=(admission.session_id,admission.factory_id)
  cross join op655_activation_first activation cross join op655_scope scope),
  'browser images retain the exact factory admission and immutable workflow activation');
select results_eq($q$select * from pg_temp.browser_create_with_workflow(960,repeat('c',64),pg_temp.workflow_request_selection('old'),
  array[pg_temp.op651_id(962),pg_temp.op651_id(961)])$q$,
  'select * from attached_workflow_intake','replaying a request with images returns its original session, job, and run');
select throws_ok($q$select * from pg_temp.browser_create_with_workflow(963,repeat('c',64),pg_temp.workflow_request_selection('old'),
  array[pg_temp.op651_id(962)])$q$,'P0004','Session attachments changed, expired, or are not available',
  'an already-bound image cannot create another authored session');

create temp table op655_session as
select pg_temp.op651_create_service_root(925,'OP655 pinned graph proof') as admitted;
select is((select internal.pin_factory_workflow_authoring_session(workspace_id,factory_id,(admitted->>'sessionId')::uuid,
  workflow_id,(result->>'activationId')::uuid) from op655_scope cross join op655_session cross join op655_activation_first),
  (select (result->>'graphRevisionId')::uuid from op655_activation_first),'new intake selects the exact published graph for its original definition');
create temp table op655_draft_third as select pg_temp.op655_save('initial',935,(draft.result->>'draftId')::uuid,
  (published.result->>'activationId')::uuid) as result from op655_draft_second draft cross join op655_activation_first published;
create temp table op655_activation_second as select pg_temp.op655_publish('initial',936,(draft.result->>'draftId')::uuid,
  (published.result->>'activationId')::uuid) as result from op655_draft_third draft cross join op655_activation_first published;
select ok((select old.result->>'graphRevisionId'<>new.result->>'graphRevisionId' from op655_activation_first old cross join op655_activation_second new),
  'later publication selects a separate runtime revision');
select is((select internal.pin_factory_workflow_authoring_session(workspace_id,factory_id,(admitted->>'sessionId')::uuid,
  workflow_id,(result->>'activationId')::uuid) from op655_scope cross join op655_session cross join op655_activation_first),
  (select (result->>'graphRevisionId')::uuid from op655_activation_first),'existing intake replays its immutable original activation after a later publish');
select throws_ok($$select internal.pin_factory_workflow_authoring_session(workspace_id,factory_id,(admitted->>'sessionId')::uuid,
  workflow_id,(result->>'activationId')::uuid) from op655_scope cross join op655_session cross join op655_activation_second$$,
  'PT409','The session already selected a different workflow activation.','publication cannot change the selected graph on an admitted session');
select results_eq($q$select * from pg_temp.browser_create_with_workflow(950,repeat('d',64),pg_temp.workflow_request_selection('old'))$q$,
  'select * from intake_browser_first', 'a browser retry after publication reuses the original immutable selection');
select is((select pg_temp.machine_create_with_workflow(951,pg_temp.workflow_request_selection('old'))->>'sessionId'),
  (select result->>'sessionId' from intake_machine_first), 'a machine retry after publication reuses the original immutable selection');
create temp table intake_session_count as
select count(*) as count from public.sessions session join op655_scope scope on scope.workspace_id=session.workspace_id
where session.title='Inspect the approved workflow';
select results_eq($q$select * from pg_temp.browser_create_with_workflow(960,repeat('c',64),pg_temp.workflow_request_selection('old'),
  array[pg_temp.op651_id(962),pg_temp.op651_id(961)])$q$,
  'select * from attached_workflow_intake','an exact image request still replays after a later activation publishes');
select throws_ok($q$select * from pg_temp.browser_create_with_workflow(952,repeat('d',64),pg_temp.workflow_request_selection('old'))$q$,
  'PT409','The selected workflow activation does not match the admitted definition.',
  'a stale selection rolls back new browser admission');
select throws_ok($q$select pg_temp.machine_create_with_workflow(953,pg_temp.workflow_request_selection('old'))$q$,
  'PT409','The selected workflow activation does not match the admitted definition.',
  'a stale selection rolls back new machine admission');
select throws_ok($q$select * from pg_temp.browser_create_with_workflow(965,repeat('d',64),pg_temp.workflow_request_selection('old'),
  array[pg_temp.op651_id(964)])$q$,'PT409','The selected workflow activation does not match the admitted definition.',
  'a stale selection rolls back new browser admission with images');
select is((select status from public.session_attachments where id=pg_temp.op651_id(964)),'ready',
  'a rejected authored session leaves its image ready for another request');
select is((select count(*) from internal.session_mutation_receipts where request_id in (pg_temp.op651_id(952),pg_temp.op651_id(953),pg_temp.op651_id(965))),
  0::bigint, 'failed stale commands leave no creation receipt');
select is((select count(*) from public.sessions session join op655_scope scope on scope.workspace_id=session.workspace_id
  where session.title='Inspect the approved workflow'),
  (select count from intake_session_count), 'failed stale commands leave no partial session');

create temp table op655_input as select pg_temp.adopt_source_checkpoint((admitted->>'sessionId')::uuid,(admitted->>'jobId')::uuid) as run_id
from op655_session;
select throws_ok($$select runtime.* from op655_scope cross join op655_session cross join op655_input
  cross join op655_activation_second newer cross join lateral public.start_factory_workflow_graph_execution(
    (admitted->>'sessionId')::uuid,workspace_id,factory_id,(newer.result->>'graphRevisionId')::uuid,run_id) runtime$$,
  'PT409','Execution must use the graph selected at session admission.','direct runtime enrollment cannot substitute a later activation');
select ok((select runtime.created from op655_scope cross join op655_session cross join op655_input
  cross join op655_activation_first prior cross join lateral public.start_factory_workflow_graph_execution(
    (admitted->>'sessionId')::uuid,workspace_id,factory_id,(prior.result->>'graphRevisionId')::uuid,run_id) runtime),
  'the real branch-graph runtime enrolls the original authored activation after a newer publish');
select ok(not exists(select 1 from internal.factory_workflow_authoring_session_pins pin join branch_owner root on root."sessionId"=pin.session_id),
  'other existing sessions acquire no authoring pin through publication');

select public.grant_factory_membership(workspace_id,factory_id,pg_temp.op651_id(1),pg_temp.op651_id(21),'manager') from op655_scope;
select public.revoke_factory_membership(workspace_id,factory_id,pg_temp.op651_id(1),pg_temp.op651_id(920),'Authoring proof') from op655_scope;
select throws_ok($$select pg_temp.op655_publish('second',933,(result->>'draftId')::uuid) from op655_draft_second$$,
  '42501','Factory manager access is required.','revoked authoring access cannot replay a previous successful publish');
select set_config('request.jwt.claim.sub',pg_temp.op651_id(910)::text,true);
select set_config('request.jwt.claim.role','authenticated',true);
select is((select public.read_factory_workflow_authoring(workspace_id,factory_id,workflow_id) from op655_scope),null::jsonb,
  'revoked manager can no longer read draft or activation history');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub',pg_temp.op651_id(1)::text,true);
select ok(not has_function_privilege('authenticated',
  'public.save_factory_workflow_authoring_draft(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,boolean,text)','EXECUTE')
  and not has_table_privilege('service_role','internal.factory_workflow_authoring_drafts','INSERT'),
  'native authoring writes are restricted to the checked service capabilities');

select * from finish();
rollback;
