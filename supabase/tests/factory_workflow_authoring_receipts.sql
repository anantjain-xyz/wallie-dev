begin;
create extension if not exists pgtap with schema extensions;
select plan(8);
\set op651_fixture_namespace 65540000
\set op651_open_groups false
\set op651_parallel_only true
\ir fixtures/factory_workflow_branch.psql

insert into auth.users(id,email)
values (pg_temp.op651_id(910),'workflow-receipt-approver@example.test');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
select pg_temp.op651_id(920),workspace_id,pg_temp.op651_id(910),'human','member'
from branch_owner where scenario='parallel';

insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.op651_id(950),root.workspace_id,root.factory_id,1,revision.body,
  encode(sha256(convert_to(revision.body,'UTF8')),'hex'),pg_temp.op651_id(21)
from scoped_revisions root
cross join lateral (select jsonb_set(root.body::jsonb,'{stages,0,approverMemberIds}',
  jsonb_build_array(pg_temp.op651_id(920)))::text body) revision
where root.scenario='root';
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,pg_temp.op651_id(950),6,pg_temp.op651_id(21)
from scoped_revisions where scenario='root';

create temp table op655_receipt_scope as
select owner.workspace_id,owner.factory_id,base.id as base_activation_id,
  base.revision_id,base.digest as base_digest,pg_temp.op651_id(900) as workflow_id,
  payload.body,encode(sha256(convert_to(payload.body,'UTF8')),'hex') as digest
from branch_owner owner
join branch_graphs graph using (scenario)
cross join lateral internal.factory_workflow_authoring_base(owner.workspace_id,owner.factory_id) base
cross join lateral (
  select (graph.body::jsonb || jsonb_build_object(
    'nodes',graph.body::jsonb->'nodes' || jsonb_build_object('id','review.human','kind','human-gate',
      'anyoneCanApprove',false,'approverMemberIds',jsonb_build_array(pg_temp.op651_id(920))),
    'edges',graph.body::jsonb->'edges' ||
      jsonb_build_object('id','join.review','kind','next','from','join.finish','to','review.human')
  ))::text as body
) payload
where owner.scenario='parallel';

select public.create_factory_workflow_authoring(workspace_id,factory_id,pg_temp.op651_id(1),
  workflow_id,'Lost authoring response') from op655_receipt_scope;

create function pg_temp.read_authoring_receipt(p_action text,p_request integer,p_fingerprint text)
returns jsonb language sql as $$
  select public.find_factory_workflow_authoring_receipt(workspace_id,factory_id,pg_temp.op651_id(1),
    workflow_id,pg_temp.op651_id(p_request),p_action,p_fingerprint)
  from op655_receipt_scope
$$;

select is(pg_temp.read_authoring_receipt('save',930,repeat('a',64)),null::jsonb,
  'a fresh request has no stored save receipt');

create temp table op655_saved_receipt as
select public.save_factory_workflow_authoring_draft(workspace_id,factory_id,pg_temp.op651_id(1),
  workflow_id,pg_temp.op651_id(930),base_activation_id,revision_id,base_digest,body,digest,
  p_request_fingerprint=>repeat('a',64)) as receipt
from op655_receipt_scope;

create temp table op655_published_receipt as
select public.publish_factory_workflow_authoring_draft(workspace_id,factory_id,pg_temp.op651_id(1),
  workflow_id,pg_temp.op651_id(931),(saved.receipt->>'draftId')::uuid,base_activation_id,revision_id,
  base_digest,digest,p_request_fingerprint=>repeat('b',64)) as receipt
from op655_receipt_scope cross join op655_saved_receipt saved;

update public.workspace_members set is_active=false where id=pg_temp.op651_id(920);
select throws_ok($$select public.save_factory_workflow_authoring_draft(workspace_id,factory_id,pg_temp.op651_id(1),
  workflow_id,pg_temp.op651_id(932),base_activation_id,revision_id,base_digest,body,digest,
  (saved.receipt->>'draftId')::uuid,(published.receipt->>'activationId')::uuid,
  p_request_fingerprint=>repeat('c',64))
  from op655_receipt_scope cross join op655_saved_receipt saved cross join op655_published_receipt published$$,
  'PT422','Workflow approvers are unavailable.','a fresh save still requires the named approver to be active');

select is(pg_temp.read_authoring_receipt('save',930,repeat('a',64)),
  (select receipt || '{"created":false}'::jsonb from op655_saved_receipt),
  'the exact prior save receipt survives named approver deactivation');
select is(pg_temp.read_authoring_receipt('publish',931,repeat('b',64)),
  (select receipt || '{"created":false}'::jsonb from op655_published_receipt),
  'the exact prior publication receipt survives named approver deactivation');
select throws_ok($$select pg_temp.read_authoring_receipt('save',930,repeat('c',64))$$,
  'PT409','Workflow save request already identifies a different change.','the same save request ID with a different fingerprint conflicts');
select throws_ok($$select pg_temp.read_authoring_receipt('publish',931,repeat('c',64))$$,
  'PT409','Workflow publish request already identifies a different change.','the same publish request ID with a different fingerprint conflicts');

update public.workspace_members set is_active=false where id=pg_temp.op651_id(21);
select throws_ok($$select pg_temp.read_authoring_receipt('publish',931,repeat('b',64))$$,
  '42501','Active workspace member required.','a formerly authorized actor cannot recover an exact receipt');
select ok(not has_function_privilege('authenticated',
    'public.find_factory_workflow_authoring_receipt(uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE')
  and has_function_privilege('service_role',
    'public.find_factory_workflow_authoring_receipt(uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE'),
  'the exact receipt lookup requires the service role');

select * from finish();
rollback;
