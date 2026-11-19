begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.inbox_id(slot integer) returns uuid language sql immutable as $$
  select ('57300000-0000-4000-8000-' || lpad(slot::text,12,'0'))::uuid
$$;
insert into auth.users(id,email)
select pg_temp.inbox_id(n), 'inbox-fixture-' || n || '@example.test' from generate_series(1,5) n;
insert into public.workspaces(id,slug,name) values
  (pg_temp.inbox_id(10),'inbox-fixture','Inbox fixture'),
  (pg_temp.inbox_id(11),'inbox-foreign','Other workspace');
insert into public.workspace_members(id,workspace_id,user_id,kind,role,is_active)
select pg_temp.inbox_id(20+n),pg_temp.inbox_id(case when n=5 then 11 else 10 end),pg_temp.inbox_id(n),
  'human',case when n in (1,5) then 'owner'::public.member_role else 'member'::public.member_role end,n<>4
from generate_series(1,5) n;

create temp table inbox_factories as
  select 'shared' as fixture, factory.id, factory.workspace_id from public.create_factory(
    pg_temp.inbox_id(10),pg_temp.inbox_id(1),'Shared Inbox factory','shared-inbox') factory
  union all
  select 'restricted', factory.id, factory.workspace_id from public.create_factory(
    pg_temp.inbox_id(10),pg_temp.inbox_id(1),'Restricted Inbox factory','restricted-inbox') factory;
select public.grant_factory_membership(pg_temp.inbox_id(10),id,pg_temp.inbox_id(1),pg_temp.inbox_id(member.slot),'member')
from inbox_factories factory cross join (values (22),(23)) member(slot) where factory.fixture='shared';
grant select on inbox_factories to authenticated;

insert into public.pipelines(id,workspace_id,factory_id,name,is_default)
select pg_temp.inbox_id(case when fixture='shared' then 31 else 32 end),workspace_id,id,'Inbox fixture pipeline',false
from inbox_factories;
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md,anyone_can_approve,approver_member_ids)
values
  (pg_temp.inbox_id(40),pg_temp.inbox_id(31),pg_temp.inbox_id(10),1,'shared','Shared review','Review',true,'{}'),
  (pg_temp.inbox_id(41),pg_temp.inbox_id(31),pg_temp.inbox_id(10),2,'named','Named review','Review',false,array[pg_temp.inbox_id(22)]),
  (pg_temp.inbox_id(42),pg_temp.inbox_id(32),pg_temp.inbox_id(10),1,'private','Private review','Review',true,'{}');

insert into public.sessions(id,workspace_id,factory_id,number,title,pipeline_id,current_stage_id,phase_status)
select pg_temp.inbox_id(100+n),factory.workspace_id,factory.id,n,'Inbox session ' || n,
  pg_temp.inbox_id(case when n=3 then 32 else 31 end),
  pg_temp.inbox_id(case n when 2 then 41 when 3 then 42 else 40 end),'awaiting_review'
from generate_series(1,28) n join inbox_factories factory
  on factory.fixture=case when n=3 then 'restricted' else 'shared' end;
insert into public.session_selected_stages(session_id,workspace_id,stage_id)
select session.id,session.workspace_id,session.current_stage_id
from public.sessions session where session.workspace_id=pg_temp.inbox_id(10)
on conflict do nothing;
insert into public.session_artifacts(id,workspace_id,session_id,stage_id,stage_slug,version,artifact_json,created_at)
select pg_temp.inbox_id(200+session.number),session.workspace_id,session.id,stage.id,stage.slug,1,
  to_jsonb('Private fixture text'::text),'2026-11-19 00:00:00.000123Z'::timestamptz
from public.sessions session join public.pipeline_stages stage on stage.id=session.current_stage_id
where session.workspace_id=pg_temp.inbox_id(10);
update public.sessions session set current_artifact_id=pg_temp.inbox_id(200+number),current_artifact_version=1,
  artifact_review_revision=3 where session.workspace_id=pg_temp.inbox_id(10);

create function pg_temp.inbox_snapshot(p_factory_id uuid default null, p_before jsonb default null)
returns jsonb language sql as $$
  select public.get_factory_inbox(pg_temp.inbox_id(10), p_factory_id,
    (p_before->>'occurredAt')::timestamptz,(p_before->>'artifactId')::uuid)
$$;

select ok(not has_function_privilege('anon','public.get_factory_inbox(uuid,uuid,timestamptz,uuid)','EXECUTE'),
  'anonymous callers cannot read Inbox counts');
select ok(not has_function_privilege('service_role','public.get_factory_inbox(uuid,uuid,timestamptz,uuid)','EXECUTE'),
  'the browser-only Inbox has no service-role entry point');

set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='57300000-0000-4000-8000-000000000002';
create temp table first_inbox as select pg_temp.inbox_snapshot() as snapshot;
select is((select snapshot->'counts' from first_inbox),'{"review":27,"clarification":0}'::jsonb,
  'the named reviewer sees shared and restricted-stage reviews only in permitted factories');
select is((select jsonb_array_length(snapshot->'items') from first_inbox),25,'the server bounds each page');
select is((select snapshot->'items'->0->>'artifactId' from first_inbox),pg_temp.inbox_id(228)::text,
  'identical publication timestamps are stably ordered by artifact ID');
create temp table second_inbox as select pg_temp.inbox_snapshot(p_before=>snapshot->'next') as snapshot from first_inbox;
select is((select snapshot->'counts' from second_inbox),'{"review":27,"clarification":0}'::jsonb,
  'counts stay scoped to the entire authorized projection when paginating');
select is((select jsonb_array_length(snapshot->'items') from second_inbox),2,'the cursor includes all remaining permitted items');
select is((select snapshot->'items'->0->>'artifactId' from second_inbox),pg_temp.inbox_id(202)::text,
  'the named review is on page two without duplicating or skipping timestamp ties');
select ok((select snapshot->'items'->0 @> jsonb_build_object('stageId',pg_temp.inbox_id(41),
  'artifactId',pg_temp.inbox_id(202),'stageSlug','named','artifactVersion',1,'reviewRevision',3,'sessionNumber',2,'kind','review',
  'sourceLabel','Wallie','clarificationId',null,'hasBlockingFeedback',false) from second_inbox),
  'each item carries the exact review point, context and action type');
select is(pg_temp.inbox_snapshot((select id from inbox_factories where fixture='restricted')),null::jsonb,
  'an explicitly requested inaccessible factory reveals no counts');
select throws_ok(format('select public.get_factory_inbox(%L,null,now(),null)',pg_temp.inbox_id(10)),
  '22023','Invalid Inbox cursor.','partial pagination bounds are rejected');

set local request.jwt.claim.sub='57300000-0000-4000-8000-000000000003';
select is(pg_temp.inbox_snapshot()->'counts','{"review":26,"clarification":0}'::jsonb,
  'a factory member outside the explicit reviewer list sees no restricted review count');
select is((pg_temp.inbox_snapshot(p_before=> (select snapshot->'next' from first_inbox)))->'items'->0->>'artifactId',
  pg_temp.inbox_id(201)::text,'the hidden item is absent from the list even when a named reviewer cursor is replayed');

set local request.jwt.claim.sub='57300000-0000-4000-8000-000000000004';
select is(pg_temp.inbox_snapshot(),null::jsonb,'inactive workspace members have no Inbox');
set local request.jwt.claim.sub='57300000-0000-4000-8000-000000000005';
select is(pg_temp.inbox_snapshot(),null::jsonb,'ownership in a different workspace grants no Inbox access');

reset role;
set local request.jwt.claim.role='service_role';
select public.revoke_factory_membership(pg_temp.inbox_id(10),id,pg_temp.inbox_id(1),pg_temp.inbox_id(22))
from inbox_factories where fixture='shared';
update public.sessions set phase_status='approved' where id=pg_temp.inbox_id(128);
delete from public.session_selected_stages where session_id=pg_temp.inbox_id(126);

insert into public.session_artifacts(id,workspace_id,session_id,stage_id,stage_slug,version,artifact_json,created_at)
values (pg_temp.inbox_id(301),pg_temp.inbox_id(10),pg_temp.inbox_id(127),pg_temp.inbox_id(40),'shared',2,
  to_jsonb('New private revision'::text),'2026-11-19 01:00:00Z');
update public.sessions set current_artifact_id=pg_temp.inbox_id(301),current_artifact_version=2,artifact_review_revision=4
where id=pg_temp.inbox_id(127);

set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='57300000-0000-4000-8000-000000000002';
select is(pg_temp.inbox_snapshot()->'counts','{"review":0,"clarification":0}'::jsonb,
  'the next read removes all rows and counts as soon as factory access is revoked');
set local request.jwt.claim.sub='57300000-0000-4000-8000-000000000003';
select is(pg_temp.inbox_snapshot()->'counts','{"review":24,"clarification":0}'::jsonb,
  'approval or removal from the admitted stages removes the action');
select ok(pg_temp.inbox_snapshot()->'items'->0 @>
  jsonb_build_object('artifactId',pg_temp.inbox_id(301),'artifactVersion',2,'reviewRevision',4),
  'supersession links only to the replacement artifact and its current review revision');
select is((select count(*) from jsonb_array_elements(pg_temp.inbox_snapshot()->'items') item
  where item->>'artifactId' in (pg_temp.inbox_id(226)::text,pg_temp.inbox_id(227)::text,pg_temp.inbox_id(228)::text)),0::bigint,
  'the obsolete versions no longer appear');

select * from finish();
rollback;
