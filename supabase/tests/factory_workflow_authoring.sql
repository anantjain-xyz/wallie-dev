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
  p_actor integer default 910,p_reload boolean default false,p_rebase boolean default false)
returns jsonb language sql as $$
  select public.save_factory_workflow_authoring_draft(p_workspace_id => scope.workspace_id,p_factory_id => scope.factory_id,p_actor_user_id => pg_temp.op651_id(p_actor),p_workflow_id => scope.workflow_id,
    p_request_id => pg_temp.op651_id(p_request),p_expected_draft_id => p_draft,p_expected_activation_id => p_activation,
    p_expected_base_activation_id => case when p_reload then base.id else scope.base_activation_id end,
    p_expected_base_revision_id => case when p_reload then base.revision_id else scope.revision_id end,
    p_expected_base_digest => case when p_reload then base.digest else scope.base_digest end,p_workflow_json => graph.body,p_workflow_digest => graph.digest,p_rebase => p_rebase)
  from op655_scope scope cross join op655_graphs graph
  cross join lateral internal.factory_workflow_authoring_base(scope.workspace_id,scope.factory_id) base
  where graph.label=p_label
$$;
create function pg_temp.op655_publish(p_label text,p_request integer,p_draft uuid,p_activation uuid default null,
  p_actor integer default 910,p_reload boolean default false)
returns jsonb language sql as $$
  select public.publish_factory_workflow_authoring_draft(p_workspace_id => scope.workspace_id,p_factory_id => scope.factory_id,p_actor_user_id => pg_temp.op651_id(p_actor),
    p_workflow_id => scope.workflow_id,p_request_id => pg_temp.op651_id(p_request),p_expected_draft_id => p_draft,p_expected_activation_id => p_activation,
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
select is((select pg_temp.op655_publish('second',933,(result->>'draftId')::uuid)->>'created' from op655_draft_second),
  'false','a lost publication response replays the immutable activation');
select throws_ok($$select pg_temp.op655_publish('second',934,(result->>'draftId')::uuid) from op655_draft_second$$,
  'PT409','The workflow draft or published activation changed.','a second publisher with a different request cannot republish the same emitted draft');

-- Compose the published activation with real browser and machine create commands.
create function pg_temp.workflow_request_selection(p_version text)
returns jsonb language sql stable as $$
  select jsonb_build_object('workflowId', scope.workflow_id, 'activationId', activation.result->>'activationId')
  from op655_scope scope cross join op655_activation_first activation
  where p_version = 'old'
$$;

create function pg_temp.browser_create_with_workflow(p_slot integer, p_hash text, p_selection jsonb)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select created.* from op655_scope scope cross join lateral public.create_session_command_once(
    scope.workspace_id, pg_temp.op651_id(21), pg_temp.op651_id(p_slot), p_hash, scope.base_digest,
    'Inspect the approved workflow', 'Run the selected exact workflow.', 'codex', 'gpt-5.5', '{}',
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
select throws_ok($q$select * from pg_temp.browser_create_with_workflow(952,repeat('d',64),pg_temp.workflow_request_selection('old'))$q$,
  'PT409','The selected workflow activation does not match the admitted definition.',
  'a stale selection rolls back new browser admission');
select throws_ok($q$select pg_temp.machine_create_with_workflow(953,pg_temp.workflow_request_selection('old'))$q$,
  'PT409','The selected workflow activation does not match the admitted definition.',
  'a stale selection rolls back new machine admission');
select is((select count(*) from internal.session_mutation_receipts where request_id in (pg_temp.op651_id(952),pg_temp.op651_id(953))),
  0::bigint, 'failed stale commands leave no creation receipt');
select is((select count(*) from public.sessions where title = 'Inspect the approved workflow'),
  2::bigint, 'failed stale commands leave no partial session');

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
  'public.save_factory_workflow_authoring_draft(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,boolean)','EXECUTE')
  and not has_table_privilege('service_role','internal.factory_workflow_authoring_drafts','INSERT'),
  'native authoring writes are restricted to the checked service capabilities');

select * from finish();
rollback;
