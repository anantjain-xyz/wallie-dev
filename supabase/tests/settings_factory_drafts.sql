begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into auth.users(id,email) values
  ('54500000-0000-4000-8000-000000000001','settings-draft-owner@example.com'),
  ('54500000-0000-4000-8000-000000000002','settings-draft-member@example.com');
insert into public.workspaces(id,slug,name) values
  ('54500000-0001-4000-8000-000000000001','settings-draft-test','Settings Draft Test');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  ('54500000-0002-4000-8000-000000000001','54500000-0001-4000-8000-000000000001',
   '54500000-0000-4000-8000-000000000001','human','owner'),
  ('54500000-0002-4000-8000-000000000002','54500000-0001-4000-8000-000000000001',
   '54500000-0000-4000-8000-000000000002','human','member');
insert into public.pipelines(id,workspace_id,name,is_default) values
  ('54500000-0003-4000-8000-000000000001','54500000-0001-4000-8000-000000000001','Default',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name) values
  ('54500000-0004-4000-8000-000000000001','54500000-0003-4000-8000-000000000001',
   '54500000-0001-4000-8000-000000000001',1,'plan','Plan');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
  ('54500000-0005-4000-8000-000000000001','54500000-0001-4000-8000-000000000001',
   54500001,'https://github.com/installations/54500001',5450,'Organization','Fixture',
   '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch) values
  ('54500000-0006-4000-8000-000000000001','54500000-0001-4000-8000-000000000001',
   '54500000-0005-4000-8000-000000000001',54500011,'settings-draft','fixture/settings-draft',true,
   'https://github.com/fixture/settings-draft','main');

select ok(
  has_function_privilege(
    'service_role',
    'public.save_settings_factory_definition_draft(uuid,uuid,uuid,bigint,text,text,uuid,uuid,jsonb,bigint,uuid,uuid,jsonb,bigint,uuid,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.save_settings_factory_definition_draft(uuid,uuid,uuid,bigint,text,text,uuid,uuid,jsonb,bigint,uuid,uuid,jsonb,bigint,uuid,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.save_settings_factory_definition_draft(uuid,uuid,uuid,bigint,text,text,uuid,uuid,jsonb,bigint,uuid,uuid,jsonb,bigint,uuid,text,jsonb)',
    'EXECUTE'
  ),
  'only service_role can invoke save_settings_factory_definition_draft'
);

create temp table sd_scope as
select f.workspace_id, f.id as factory_id,
  '54500000-0000-4000-8000-000000000001'::uuid as owner_id,
  '54500000-0000-4000-8000-000000000002'::uuid as member_id,
  '54500000-0003-4000-8000-000000000001'::uuid as pipeline_id,
  '54500000-0006-4000-8000-000000000001'::uuid as repo_id
from public.factories f
where f.workspace_id = '54500000-0001-4000-8000-000000000001' and f.is_default;

create temp table sd_exec_live as
select * from public.save_execution_policy(
  '54500000-0001-4000-8000-000000000001',
  '54500000-0000-4000-8000-000000000001',
  0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}'::jsonb
);
create temp table sd_deliv_live as
select * from public.save_delivery_policy(
  '54500000-0001-4000-8000-000000000001',
  '54500000-0003-4000-8000-000000000001',
  '54500000-0000-4000-8000-000000000001',
  0,
  '{"version":1,"deliveryMode":"code","requiredChecks":["test"],"minimumApprovals":1,"requireCodeOwnerReview":false,"requireResolvedThreads":true,"requiredEvidence":[],"freshnessSeconds":3600,"requireArtifactApprovalForDelivery":true}'::jsonb
);

create function pg_temp.sd_definition(
  p_exec_id uuid default null,
  p_deliv_id uuid default null,
  p_rules text default ''
) returns text language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion',1,'kind','serial','sandboxProvider','vercel',
    'pipelineId','54500000-0003-4000-8000-000000000001',
    'repositoryId','54500000-0006-4000-8000-000000000001',
    'executionPolicyRevisionId',p_exec_id,
    'deliveryPolicyRevisionId',p_deliv_id,
    'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd',p_rules,'operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'stages',jsonb_build_array(jsonb_build_object('id','54500000-0004-4000-8000-000000000001',
      'slug','plan','name','Plan','description','','promptTemplateMd','Plan {{session.title}}.',
      'anyoneCanApprove',true,'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb))
  )::text;
$$;

-- Saving execution & delivery policy drafts does not advance live policy pointers.
create temp table sd_exec_draft as
select d.* from sd_scope s
cross join lateral public.save_settings_factory_definition_draft(
  s.workspace_id, s.factory_id, s.owner_id, 0,
  pg_temp.sd_definition(p_exec_id => '54500000-0010-4000-8000-000000000001'::uuid),
  encode(sha256(convert_to(pg_temp.sd_definition(p_exec_id => '54500000-0010-4000-8000-000000000001'::uuid), 'UTF8')), 'hex'),
  null,
  '54500000-0010-4000-8000-000000000001'::uuid,
  '{"version":1,"maxRepairAttempts":5,"maxExecutionMs":1800000,"maxTotalTokens":null,"maxCostUsd":null}'::jsonb,
  1
) d;

select is(
  (select revision from public.execution_policies where workspace_id = '54500000-0001-4000-8000-000000000001'),
  1::bigint,
  'saving an execution policy draft keeps live execution_policies pointer at revision 1'
);
select is(
  (select current_revision_id from public.execution_policies where workspace_id = '54500000-0001-4000-8000-000000000001'),
  (select id from sd_exec_live),
  'live execution_policies current_revision_id remains unchanged after draft save'
);
select is(
  (select revision from public.execution_policy_revisions where id = '54500000-0010-4000-8000-000000000001'),
  2::bigint,
  'candidate execution policy revision is persisted as revision 2'
);

create temp table sd_deliv_draft as
select d.* from sd_scope s, sd_exec_draft prev
cross join lateral public.save_settings_factory_definition_draft(
  s.workspace_id, s.factory_id, s.owner_id, 0,
  pg_temp.sd_definition(
    p_exec_id => '54500000-0010-4000-8000-000000000001'::uuid,
    p_deliv_id => '54500000-0011-4000-8000-000000000001'::uuid
  ),
  encode(sha256(convert_to(pg_temp.sd_definition(
    p_exec_id => '54500000-0010-4000-8000-000000000001'::uuid,
    p_deliv_id => '54500000-0011-4000-8000-000000000001'::uuid
  ), 'UTF8')), 'hex'),
  prev.id,
  null, null, null,
  '54500000-0011-4000-8000-000000000001'::uuid,
  s.pipeline_id,
  '{"version":1,"deliveryMode":"analysis","requiredChecks":[],"minimumApprovals":0,"requireCodeOwnerReview":false,"requireResolvedThreads":false,"requiredEvidence":[],"freshnessSeconds":3600,"requireArtifactApprovalForDelivery":false}'::jsonb,
  1
) d;

select is(
  (select revision from public.delivery_policies where pipeline_id = '54500000-0003-4000-8000-000000000001'),
  1::bigint,
  'saving a delivery policy draft keeps live delivery_policies pointer at revision 1'
);
select is(
  (select current_revision_id from public.delivery_policies where pipeline_id = '54500000-0003-4000-8000-000000000001'),
  (select id from sd_deliv_live),
  'live delivery_policies current_revision_id remains unchanged after draft save'
);
select is(
  (select revision from public.delivery_policy_revisions where id = '54500000-0011-4000-8000-000000000001'),
  2::bigint,
  'candidate delivery policy revision is persisted as revision 2'
);

-- Subsequent legacy save_execution_policy / save_delivery_policy still succeed by jumping past draft revisions.
select is(
  (select revision from public.save_execution_policy(
    '54500000-0001-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000001',
    1,
    '{"version":1,"maxRepairAttempts":4,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}'::jsonb
  )),
  3::bigint,
  'direct save_execution_policy advances cleanly past candidate draft revision 2'
);
select is(
  (select revision from public.save_delivery_policy(
    '54500000-0001-4000-8000-000000000001',
    '54500000-0003-4000-8000-000000000001',
    '54500000-0000-4000-8000-000000000001',
    1,
    '{"version":1,"deliveryMode":"code","requiredChecks":["lint"],"minimumApprovals":1,"requireCodeOwnerReview":false,"requireResolvedThreads":true,"requiredEvidence":[],"freshnessSeconds":3600,"requireArtifactApprovalForDelivery":true}'::jsonb
  )),
  3::bigint,
  'direct save_delivery_policy advances cleanly past candidate draft revision 2'
);

-- Commit fixture so dblink transactions can race on expected_draft_id.
commit;
begin;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.wait_sd_lock(target_application text) returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    exit when exists(select 1 from pg_stat_activity where application_name=target_application and wait_event_type='Lock');
    if clock_timestamp()>deadline then raise exception 'Expected lock not reached by %',target_application; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;

create function pg_temp.sd_sqlstate_local(command text) returns text language plpgsql as $$
begin
  execute command;
  return '00000';
exception when others then
  return sqlstate;
end;
$$;

select extensions.dblink_connect('sd_writer',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('sd_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('sd_writer',
  'set application_name=''sd_writer''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set role service_role');
select extensions.dblink_exec('sd_contender',
  'set application_name=''sd_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set role service_role');
select extensions.dblink_exec('sd_contender',$function$
  create function pg_temp.sd_sqlstate(command text) returns text language plpgsql as $$
  begin
    execute command;
    return '00000';
  exception when others then
    return sqlstate;
  end;
  $$;
$function$);

create temp table sd_latest as
select d.workspace_id, d.factory_id, d.id as expected_draft_id
from public.factory_definition_drafts d
where d.workspace_id = '54500000-0001-4000-8000-000000000001'
order by d.created_at desc, d.id desc
limit 1;

select extensions.dblink_exec('sd_writer','begin');
create temp table sd_race_winner as
select * from extensions.dblink('sd_writer', format($q$
  select id from public.save_settings_factory_definition_draft(
    %L::uuid, %L::uuid, '54500000-0000-4000-8000-000000000001'::uuid, 0,
    %L,
    encode(sha256(convert_to(%L, 'UTF8')), 'hex'),
    %L::uuid
  )
$q$,
  (select workspace_id from sd_latest),
  (select factory_id from sd_latest),
  (select jsonb_build_object(
    'schemaVersion',1,'kind','serial','sandboxProvider','vercel',
    'pipelineId','54500000-0003-4000-8000-000000000001',
    'repositoryId','54500000-0006-4000-8000-000000000001',
    'executionPolicyRevisionId',null,'deliveryPolicyRevisionId',null,
    'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','Winner rules','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'stages',jsonb_build_array(jsonb_build_object('id','54500000-0004-4000-8000-000000000001',
      'slug','plan','name','Plan','description','','promptTemplateMd','Plan {{session.title}}.',
      'anyoneCanApprove',true,'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb))
  )::text),
  (select jsonb_build_object(
    'schemaVersion',1,'kind','serial','sandboxProvider','vercel',
    'pipelineId','54500000-0003-4000-8000-000000000001',
    'repositoryId','54500000-0006-4000-8000-000000000001',
    'executionPolicyRevisionId',null,'deliveryPolicyRevisionId',null,
    'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','Winner rules','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'stages',jsonb_build_array(jsonb_build_object('id','54500000-0004-4000-8000-000000000001',
      'slug','plan','name','Plan','description','','promptTemplateMd','Plan {{session.title}}.',
      'anyoneCanApprove',true,'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb))
  )::text),
  (select expected_draft_id from sd_latest)
)) as result(id uuid);

select extensions.dblink_send_query('sd_contender', format('select pg_temp.sd_sqlstate(%L)', format($q$
  select id from public.save_settings_factory_definition_draft(
    %L::uuid, %L::uuid, '54500000-0000-4000-8000-000000000001'::uuid, 0,
    %L,
    encode(sha256(convert_to(%L, 'UTF8')), 'hex'),
    %L::uuid,
    '54500000-0010-4000-8000-000000000099'::uuid,
    '{"version":1,"maxRepairAttempts":9,"maxExecutionMs":1800000,"maxTotalTokens":null,"maxCostUsd":null}'::jsonb,
    3
  )
$q$,
  (select workspace_id from sd_latest),
  (select factory_id from sd_latest),
  (select jsonb_build_object(
    'schemaVersion',1,'kind','serial','sandboxProvider','vercel',
    'pipelineId','54500000-0003-4000-8000-000000000001',
    'repositoryId','54500000-0006-4000-8000-000000000001',
    'executionPolicyRevisionId','54500000-0010-4000-8000-000000000099','deliveryPolicyRevisionId',null,
    'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','Loser rules','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'stages',jsonb_build_array(jsonb_build_object('id','54500000-0004-4000-8000-000000000001',
      'slug','plan','name','Plan','description','','promptTemplateMd','Plan {{session.title}}.',
      'anyoneCanApprove',true,'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb))
  )::text),
  (select jsonb_build_object(
    'schemaVersion',1,'kind','serial','sandboxProvider','vercel',
    'pipelineId','54500000-0003-4000-8000-000000000001',
    'repositoryId','54500000-0006-4000-8000-000000000001',
    'executionPolicyRevisionId','54500000-0010-4000-8000-000000000099','deliveryPolicyRevisionId',null,
    'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','Loser rules','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'stages',jsonb_build_array(jsonb_build_object('id','54500000-0004-4000-8000-000000000001',
      'slug','plan','name','Plan','description','','promptTemplateMd','Plan {{session.title}}.',
      'anyoneCanApprove',true,'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb))
  )::text),
  (select expected_draft_id from sd_latest)
)));

select pg_temp.wait_sd_lock('sd_contender');
select extensions.dblink_exec('sd_writer','commit');

select is(
  (select code from extensions.dblink_get_result('sd_contender') as result(code text)),
  'PT409',
  'concurrent save_settings_factory_definition_draft with same expectedDraftId returns PT409'
);
select count(*) from extensions.dblink_get_result('sd_contender') as result(code text);

select is(
  (select count(*) from public.execution_policy_revisions where id = '54500000-0010-4000-8000-000000000099'),
  0::bigint,
  'losing concurrent draft rolls back candidate execution policy revision'
);

-- Publishing an older draft via publish_settings_factory_definition_draft fails with PT409 when a newer draft exists.
select is(
  (select pg_temp.sd_sqlstate_local(format($q$
    select id from public.publish_settings_factory_definition_draft(
      %L::uuid, %L::uuid, '54500000-0000-4000-8000-000000000001'::uuid, 0,
      %L::uuid, array['vercel'], array['git']
    )
  $q$, (select workspace_id from sd_latest), (select factory_id from sd_latest), (select expected_draft_id from sd_latest)))),
  'PT409',
  'publish_settings_factory_definition_draft rejects a superseded draft with PT409'
);

select extensions.dblink_disconnect('sd_writer');
select extensions.dblink_disconnect('sd_contender');
delete from public.workspaces where id = '54500000-0001-4000-8000-000000000001';
delete from auth.users where id in ('54500000-0000-4000-8000-000000000001','54500000-0000-4000-8000-000000000002');
select * from finish();
commit;
