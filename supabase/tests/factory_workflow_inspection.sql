begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 65610000
\set op653_test_validation_seconds 600
\ir fixtures/factory_workflow_repository_delivery.psql

create function pg_temp.inspection(p_page_size integer default 50,p_cursor jsonb default null) returns jsonb
language sql as $$
  select public.read_factory_workflow_inspection(owner."sessionId",null,p_cursor,p_page_size) from multi_owner owner
$$;
create function pg_temp.inspection_events(p_snapshot jsonb,p_kind text) returns setof jsonb language sql as $$
  select event from jsonb_array_elements(p_snapshot->'events') event where event->>'kind'=p_kind
$$;

-- Use the ordinary visibility route for human readers, including sibling factories.
insert into auth.users(id,email) values
  (pg_temp.op651_id(901),'workflow-inspection-viewer@example.test'),
  (pg_temp.op651_id(902),'workflow-inspection-sibling@example.test');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
select pg_temp.op651_id(slot+10),scope.workspace_id,pg_temp.op651_id(slot),'human','member'
from op651_scope scope cross join (values (901),(902)) member(slot);
select public.grant_factory_membership(workspace_id,factory_id,pg_temp.op651_id(1),pg_temp.op651_id(911),'member') from op651_scope;
create temp table sibling_factory as
select * from public.create_factory(pg_temp.op651_id(11),pg_temp.op651_id(1),'Inspection sibling','inspection-sibling');
select public.grant_factory_membership(workspace_id,id,pg_temp.op651_id(1),pg_temp.op651_id(912),'member') from sibling_factory;
select public.revoke_factory_membership(workspace_id,factory_id,pg_temp.op651_id(1),pg_temp.op651_id(912),'Sibling fixture') from op651_scope;
insert into public.sessions(id,workspace_id,factory_id,number,title,prompt_md,creator_member_id,pipeline_id,current_stage_id)
select pg_temp.op651_id(913),workspace_id,factory_id,90,'Serial inspector control','Serial input',pg_temp.op651_id(21),
  pg_temp.op651_id(31),pg_temp.op651_id(32) from op651_scope;

-- Simulate a mismatched historical repository pointer without relaxing the production write fence.
savepoint hidden_repository;
alter table public.github_repositories disable trigger github_repositories_preserve_factory_scope;
update public.github_repositories repository set factory_id=other.id
from sibling_factory other where repository.id=pg_temp.op651_id(62);
select set_config('request.jwt.claim.role','authenticated',true);
select ok((select payload::text not like '%'||pg_temp.op651_id(62)::text||'%'
  and payload::text not like '%fixture/context-b%' and payload::text not like '%'||child.child_session_id::text||'%'
  and payload#>'{budget,graph}'='null'::jsonb
  from multi_children child cross join lateral (select pg_temp.inspection() payload) response where child.edge='run.optional'),
  'historical receipts cannot expose a cross-factory repository, its child or its reserved usage');
rollback to hidden_repository;

select set_config('request.jwt.claim.role','authenticated',true);
create temp table partial_snapshot as select pg_temp.inspection() snapshot;
select ok((select snapshot#>>'{root,sessionId}'=owner."sessionId"::text
    and snapshot#>>'{root,graphRevisionId}'=owner.graph_revision_id::text
    and snapshot#>>'{root,canManage}'='true'
  from partial_snapshot cross join multi_owner owner),'a signed-in manager receives the exact tracked root and manager capability');
select ok((select header->'events'='[]'::jsonb and header->'budget'='null'::jsonb and header->'nextCursor'='null'::jsonb
    and header->'root'=snapshot->'root' and header->'subject'=snapshot->'subject'
  from partial_snapshot cross join lateral (select pg_temp.inspection(0) header) cheap),
  'the header matches the full identity without loading events or budgets');
select ok((select inspection#>>'{root,sessionId}'=owner."sessionId"::text
    and (inspection#>>'{subject,sessionId}',inspection#>>'{subject,runId}')=(child.child_session_id::text,child.run_id::text)
  from multi_children child cross join multi_owner owner
  cross join lateral (select public.read_factory_workflow_inspection(child.child_session_id,child.run_id,null,0) inspection) linked
  where child.edge='run.required'),'an exact child run resolves the authorized root and preserves its own subject');
select is((select public.read_factory_workflow_inspection(child.child_session_id,owner.checkpoint_run_id,null,0)
  from multi_children child cross join multi_owner owner where child.edge='run.required'),null::jsonb,
  'an exact run from another session cannot authorize the requested subject');
select is(public.read_factory_workflow_inspection(pg_temp.op651_id(913),p_page_size=>0),null::jsonb,
  'an otherwise visible ordinary serial session has no workflow inspection');

select ok(exists (select 1 from partial_snapshot snapshot cross join multi_join exact cross join primary_claim primary_run
  cross join lateral pg_temp.inspection_events(snapshot.snapshot,'join') event
  where (event->>'state',event#>>'{detail,joinId}',event#>>'{detail,deliveryStatus}',event#>>'{detail,wholeJoinComplete}',
    event#>>'{detail,runId}',event#>>'{detail,stageSlug}') =
    ('adopted',exact.receipt->>'joinId','partial','false',primary_run.claim->>'runId','inspect-output')
    and jsonb_array_length(event#>'{detail,selectedOutcomeIds}')=2),
  'the parent adoption is visible beside incomplete delivery, separate from both selected branch outcomes');
select ok(exists (select 1 from partial_snapshot page cross join secondary_claim exact
  cross join lateral pg_temp.inspection_events(page.snapshot,'repository') event
  where (event#>>'{detail,repositoryId}',event#>>'{detail,runId}',event->>'state')=
    (pg_temp.op651_id(62)::text,exact.claim->>'runId','awaiting_validation')
    and (event#>'{detail,validationRunId}')='null'::jsonb),
  'the visible secondary validation run is distinct from a future sealed delivery proof');
select ok((select snapshot::text !~ 'ownershipToken|leaseId|retained_ref|bundle_bytes|promptMd|artifact_md|providerReceiptId'
    and snapshot::text not like '%Private root checkpoint.%' from partial_snapshot),
  'operator output omits private capabilities, retained source, and raw artifact text');

create temp table paged_inspection as
with recursive pages(position,snapshot) as (
  select 1,pg_temp.inspection(2)
  union all
  select position+1,pg_temp.inspection(2,snapshot->'nextCursor') from pages
  where snapshot->'nextCursor'<>'null'::jsonb and position<50
)
select position,snapshot from pages;
select is((select jsonb_agg(event order by page.position,items.position)
  from paged_inspection page cross join lateral jsonb_array_elements(page.snapshot->'events') with ordinality items(event,position)),
  (select snapshot->'events' from partial_snapshot), 'small cursor pages contain exactly the same ordered receipt identities as one page');
select throws_ok($$select public.read_factory_workflow_inspection(other."sessionId",null,first.snapshot->'nextCursor',2)
  from branch_owner other cross join paged_inspection first where first.position=1$$,
  '22023','Invalid workflow inspection cursor.','a cursor is bound to its exact workflow root');
select throws_ok($$select public.read_factory_workflow_inspection(child.child_session_id,child.run_id,first.snapshot->'nextCursor',2)
  from multi_children child cross join paged_inspection first where child.edge='run.required' and first.position=1$$,
  '22023','Invalid workflow inspection cursor.','the same root cursor cannot change its subject and run');

select set_config('request.jwt.claim.sub',pg_temp.op651_id(901)::text,true);
select is(pg_temp.inspection(0)#>>'{root,canManage}','false','a visible factory member can inspect without a management capability');
select set_config('request.jwt.claim.sub',pg_temp.op651_id(902)::text,true);
select is(pg_temp.inspection(),null::jsonb,'sibling-factory membership reveals no root, rows or cursor');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub',pg_temp.op651_id(1)::text,true);
select public.revoke_factory_membership(workspace_id,factory_id,pg_temp.op651_id(1),pg_temp.op651_id(911),'Inspection proof')
from op651_scope;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',pg_temp.op651_id(901)::text,true);
select is(pg_temp.inspection(2),null::jsonb,'a revoked reader no longer receives the private workflow');
select set_config('request.jwt.claim.sub',pg_temp.op651_id(1)::text,true);
select is(public.read_factory_workflow_inspection(gen_random_uuid()),null::jsonb,'an unavailable workflow has the same null response');

select set_config('request.jwt.claim.role','service_role',true);
savepoint finish_visible_review;
select is(pg_temp.finish_multi_validation(),true,'the fixture seals its exact secondary validation');
create temp table delivery_lease as
select public.claim_factory_workflow_repository_delivery(root_session_id,workspace_id,factory_id,generation,ownership_token,
  join_id,repository_id) as claim from public.list_factory_workflow_repository_deliveries();
create function pg_temp.settle_inspected_delivery(p_action text,p_sha text) returns text language sql as $$
  select public.settle_factory_workflow_repository_delivery(owner."sessionId",owner.workspace_id,owner.factory_id,
    owner.execution_generation,owner.ownership_token,(receipt->>'joinId')::uuid,pg_temp.op651_id(62),
    (claim->>'leaseId')::uuid,p_action,(claim#>>'{target,repository_numeric_id}')::bigint,claim#>>'{intent,retained_ref}',p_sha)
  from multi_owner owner cross join multi_join cross join delivery_lease
$$;
savepoint blocked_delivery;
select is(pg_temp.settle_inspected_delivery('incompatible_ref',repeat('9',40)),'incompatible_ref',
  'the native remote state records a conflicted delivery');
select set_config('request.jwt.claim.role','authenticated',true);
select ok(exists (select 1 from pg_temp.inspection_events(pg_temp.inspection(),'repository') event
    where (event->>'state',event#>>'{detail,blocker}')=('blocked','incompatible_ref'))
  and exists (select 1 from pg_temp.inspection_events(pg_temp.inspection(),'join') event
    where (event#>>'{detail,deliveryStatus}',event#>>'{detail,wholeJoinComplete}')=('partial','false')),
  'a blocked repository can coexist with an already adopted primary and a still-incomplete join');
rollback to blocked_delivery;
select is(pg_temp.settle_inspected_delivery('adopt',repeat('4',40)),'adopted','the exact verified repository completes the join');
create temp table inspected_review_claim as
select public.claim_factory_workflow_exact_review(owner."sessionId",owner.workspace_id,owner.factory_id,
  owner.execution_generation,owner.ownership_token,occurrence.occurrence_id,pg_temp.op651_id(919)) claim
from multi_owner owner join internal.factory_workflow_node_occurrences occurrence on occurrence.root_session_id=owner."sessionId"
where occurrence.node_kind='review';
create temp table inspected_review_report as
select public.record_factory_workflow_exact_review(owner."sessionId",owner.workspace_id,owner.factory_id,
  owner.execution_generation,owner.ownership_token,(claim->>'reviewId')::uuid,(claim->>'reviewRunId')::uuid,pg_temp.op651_id(919),
  (claim->>'checkpointRunId')::uuid,claim->>'commitSha',claim->>'treeSha','{"version":1,"verdict":"pass"}') receipt
from multi_owner owner cross join inspected_review_claim;
select set_config('request.jwt.claim.role','authenticated',true);
select ok(exists (select 1 from inspected_review_report report cross join primary_claim primary_run
  cross join lateral pg_temp.inspection_events(pg_temp.inspection(),'review') event
  where (event->>'state',event#>>'{detail,reviewReceiptId}',event#>>'{detail,runId}',event#>>'{detail,validationTreeSha}')=
    ('pass',report.receipt::text,primary_run.claim->>'runId',repeat('3',40))),
  'a passing exact review carries its saved report and reviewed checkpoint run rather than the provider run');
select ok(exists (select 1 from primary_claim primary_run cross join lateral pg_temp.inspection_events(pg_temp.inspection(),'artifact') event
  where (event#>>'{detail,runId}',event#>>'{detail,approvalState}')=(primary_run.claim->>'runId','awaiting_review')),
  'a passing automated review still displays the adopted primary artifact awaiting human approval');
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.approve_branch(owner."sessionId") from multi_owner owner;
select set_config('request.jwt.claim.role','authenticated',true);
select ok(exists (select 1 from primary_claim primary_run cross join multi_owner owner
  cross join lateral pg_temp.inspection_events(pg_temp.inspection(),'approval') event
  where (event#>>'{detail,runId}',event#>>'{detail,sessionId}',event#>>'{detail,stageSlug}')=
    (primary_run.claim->>'runId',owner."sessionId"::text,'inspect-output')),
  'ordinary approval is visible through the independent receipt for the exact parent artifact');
rollback to finish_visible_review;

create function pg_temp.change_inspected_workflow(p_action text,p_slot integer) returns jsonb language sql as $$
  select public.control_factory_workflow_lifecycle(owner."sessionId",owner.workspace_id,owner.factory_id,
    workflow.generation,pg_temp.op651_id(p_slot),p_action)
  from multi_owner owner join internal.factory_workflow_executions workflow on workflow.root_session_id=owner."sessionId"
$$;
select pg_temp.change_inspected_workflow('pause',920);
select set_config('request.jwt.claim.role','authenticated',true);
select ok((select snapshot#>>'{root,lifecycleStatus}'='paused'
    and exists (select 1 from pg_temp.inspection_events(snapshot,'attempt') event
      where (event#>>'{detail,runId}',event#>>'{detail,retired}',event#>>'{detail,current}')=(prior.claim->>'runId','true','false'))
  from secondary_claim prior cross join lateral (select pg_temp.inspection() snapshot) observed),
  'pause retains the exact earlier attempt as retired history rather than the current run');
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.change_inspected_workflow('resume',921);
select is(public.dispatch_next_factory_workflow_repository_validation(),true,'maintenance requeues the exact paused repository obligation');
select set_config('request.jwt.claim.role','authenticated',true);
select ok(exists (select 1 from pg_temp.inspection_events(pg_temp.inspection(),'attempt') event
    where (event#>>'{detail,source}',event#>>'{detail,current}',event->>'state')=('repository-validation','true','queued')),
  'the resumed workflow shows the separately queued replacement attempt');

select ok((select snapshot#>>'{budget,session,usage,tokensUnavailable}'='true'
    and snapshot#>>'{budget,session,usage,totalTokens}'='0' and snapshot#>>'{budget,graph,accountedAttempts}' is not null
  from partial_snapshot), 'usage availability and numerical totals are preserved separately from graph accounting');
select set_config('request.jwt.claim.role','service_role',true);
savepoint elapsed_read;
update public.agent_runs run set
  started_at=case when run.id=owner.checkpoint_run_id then clock_timestamp()-interval '70 seconds' else run.started_at end,
  finished_at=case when run.id=owner.checkpoint_run_id then clock_timestamp() else run.finished_at end,
  input_tokens=0,output_tokens=0,total_cost_usd=0,token_provenance='measured',cost_provenance='measured'
from multi_owner owner where run.session_id=owner."sessionId" and run.started_at is not null;
select set_config('request.jwt.claim.role','authenticated',true);
create temp table elapsed_snapshot as select pg_temp.inspection() snapshot;
select ok((select snapshot#>>'{budget,session,usage,remainingExecutionMs}'='0'
    and snapshot#>>'{budget,session,usage,tokensUnavailable}'='false'
    and snapshot#>>'{budget,session,usage,totalTokens}'='0'
    and session.execution_exhausted_at is null and session.execution_exhaustion_code is null
  from elapsed_snapshot cross join multi_owner owner join public.sessions session on session.id=owner."sessionId"),
  'an elapsed read shows measured zero and remaining time without persisting execution exhaustion');
rollback to elapsed_read;
select ok(not has_function_privilege('anon','public.read_factory_workflow_inspection(uuid,uuid,jsonb,integer)','execute')
  and not has_function_privilege('service_role','public.read_factory_workflow_inspection(uuid,uuid,jsonb,integer)','execute')
  and has_function_privilege('authenticated','public.read_factory_workflow_inspection(uuid,uuid,jsonb,integer)','execute'),
  'the native read is callable through the signed-in user boundary');
select * from finish();
rollback;
