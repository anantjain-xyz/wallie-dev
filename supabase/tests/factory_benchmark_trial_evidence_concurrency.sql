begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '62200000-0000-4000-8000-000000000001';

create function pg_temp.evidence_race_id(slot integer) returns uuid language sql immutable as $$
  select ('62200000-0000-4000-8000-' || lpad(slot::text,12,'0'))::uuid
$$;
insert into auth.users(id,email) values (pg_temp.evidence_race_id(1),'benchmark-evidence-race@example.test');
insert into public.workspaces(id,slug,name)
values (pg_temp.evidence_race_id(2),'benchmark-evidence-race','Benchmark evidence race');
insert into public.workspace_members(id,workspace_id,user_id,kind,role)
values (pg_temp.evidence_race_id(3),pg_temp.evidence_race_id(2),pg_temp.evidence_race_id(1),'human','owner');

create temp table evidence_race_scope as
select workspace_id,id as factory_id,pg_temp.evidence_race_id(1) as owner_id from public.factories
where workspace_id = pg_temp.evidence_race_id(2) and is_default;
insert into public.pipelines(id,workspace_id,factory_id,name)
select pg_temp.evidence_race_id(4),workspace_id,factory_id,'Evidence race' from evidence_race_scope;
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md)
values (pg_temp.evidence_race_id(5),pg_temp.evidence_race_id(4),pg_temp.evidence_race_id(2),1,'review','Review','Inspect result.');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values (pg_temp.evidence_race_id(6),pg_temp.evidence_race_id(2),622001,'https://example.test/install',6220,
  'Organization','Evidence race','{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.evidence_race_id(7),workspace_id,factory_id,pg_temp.evidence_race_id(6),622002,
  'evidence-race','fixture/evidence-race',true,'https://example.test/repo','main' from evidence_race_scope;

with definition as (
  select jsonb_build_object('schemaVersion',1,'kind','serial','pipelineId',pg_temp.evidence_race_id(4),
    'repositoryId',pg_temp.evidence_race_id(7),'sandboxProvider','vercel',
    'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort',null,'concurrencyLimit',1,
      'stallTimeoutMs',120000,'maxRetries',0,'maxTurns',24),
    'executionPolicyRevisionId',null,'deliveryPolicyRevisionId',null,'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
    'stages',jsonb_build_array(jsonb_build_object('id',pg_temp.evidence_race_id(5),'slug','review','name','Review',
      'description','','promptTemplateMd','Inspect result.','anyoneCanApprove',false,'approverMemberIds','[]'::jsonb,
      'previousStageIds','[]'::jsonb)))::text as config
)
insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
select pg_temp.evidence_race_id(8),workspace_id,factory_id,1,config,encode(sha256(convert_to(config,'UTF8')),'hex'),owner_id
from evidence_race_scope cross join definition;
insert into public.sessions(id,number,workspace_id,factory_id,creator_member_id,pipeline_id,current_stage_id,title,archived_at,
  factory_definition_provenance,factory_definition_revision_id)
select pg_temp.evidence_race_id(9),1,workspace_id,factory_id,pg_temp.evidence_race_id(3),pg_temp.evidence_race_id(4),
  pg_temp.evidence_race_id(5),'Original evidence source',clock_timestamp(),'pinned',pg_temp.evidence_race_id(8)
from evidence_race_scope;
insert into public.agent_jobs(id,workspace_id,session_id,stage_id,stage_slug,trigger_type,status,attempt_count,finished_at)
values (pg_temp.evidence_race_id(10),pg_temp.evidence_race_id(2),pg_temp.evidence_race_id(9),pg_temp.evidence_race_id(5),
  'review','manual_run','success',1,clock_timestamp());
insert into public.agent_runs(id,workspace_id,session_id,agent_job_id,stage_id,stage_slug,run_type,model_provider,model_name,
  status,attempt_count,finished_at)
values (pg_temp.evidence_race_id(11),pg_temp.evidence_race_id(2),pg_temp.evidence_race_id(9),pg_temp.evidence_race_id(10),
  pg_temp.evidence_race_id(5),'review','project','codex','gpt-5.5','success',1,clock_timestamp());

create temp table evidence_race_task as
select task.* from evidence_race_scope scope cross join lateral public.create_factory_benchmark_task(
  scope.workspace_id,scope.factory_id,scope.owner_id,pg_temp.evidence_race_id(11),'Frozen race task',
  'Private acceptance criterion from the retained source.','{}','eligible') task;
insert into public.factory_benchmark_task_inputs(task_id,workspace_id,factory_id,source_run_id,source_session_id,source_job_id,
  source_attempt_count,repository_id,checkout_sha,definition_revision_id)
select task_id,workspace_id,factory_id,pg_temp.evidence_race_id(11),pg_temp.evidence_race_id(9),pg_temp.evidence_race_id(10),
  1,pg_temp.evidence_race_id(7),repeat('a',40),pg_temp.evidence_race_id(8) from evidence_race_task;
create temp table evidence_race_suite as
select suite.* from evidence_race_scope scope cross join evidence_race_task task
cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id,scope.factory_id,scope.owner_id,
  'Evidence race suite','regression',p_task_revision_ids => array[task.id]) suite;
create temp table evidence_race_policy as
select policy.* from evidence_race_scope scope cross join lateral public.publish_factory_benchmark_replay_policy(
  scope.workspace_id,scope.factory_id,scope.owner_id,'blocked') policy;
select public.freeze_factory_benchmark_experiment(scope.workspace_id,scope.factory_id,scope.owner_id,pg_temp.evidence_race_id(12),
  suite.id,policy.id,jsonb_build_array(jsonb_build_object('definitionRevisionId',definition.id,'definitionDigest',definition.canonical_digest,
    'harness','codex','model','gpt-5.5','sandboxProvider','vercel','workerRuntime','node')),1,31,60000)
from evidence_race_scope scope cross join evidence_race_suite suite cross join evidence_race_policy policy
join public.factory_definition_revisions definition on definition.id = pg_temp.evidence_race_id(8);

create function pg_temp.read_evidence_race() returns jsonb language sql as $$
  select public.read_factory_benchmark_trial_evidence(scope.workspace_id,scope.factory_id,frozen.experiment_id,frozen.trial_id,scope.owner_id)
  from evidence_race_scope scope join public.factory_benchmark_experiment_trials frozen using (workspace_id,factory_id)
  where frozen.experiment_id = pg_temp.evidence_race_id(12)
$$;
select is(pg_temp.read_evidence_race()#>>'{task,acceptanceCriteria}','Private acceptance criterion from the retained source.',
  'an exact readable source exposes its acceptance criterion');
select public.erase_session_retained_content(owner.workspace_id,owner.factory_id,owner.id,owner.archived_at)
from public.sessions owner where owner.id = pg_temp.evidence_race_id(9);
commit;

begin;
set local request.jwt.claim.role = 'service_role';
select is(pg_temp.read_evidence_race()#>>'{source,availability}','withheld',
  'the normal evidence read checks the committed source erasure');
commit;

begin;
set local request.jwt.claim.role = 'service_role';
select extensions.dblink_connect('benchmark_evidence_source_lock',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('benchmark_evidence_source_lock',
  'set statement_timeout = ''3s''; set idle_in_transaction_session_timeout = ''10s''; begin');
select id from extensions.dblink('benchmark_evidence_source_lock',format(
  'select id from public.agent_runs where id = %L for no key update',pg_temp.evidence_race_id(11))) locked(id uuid);
set local statement_timeout = '3s';
create temp table contended_evidence as select pg_temp.read_evidence_race() payload;
select is(payload#>>'{source,availability}','unavailable','real source run contention takes the NOWAIT fallback') from contended_evidence;
select ok(payload#>'{task,acceptanceCriteria}' = 'null'::jsonb and payload#>'{task,acceptanceTruncated}' = 'false'::jsonb
  and payload#>>'{task,name}' = 'Frozen race task' and payload#>>'{task,revisionId}' is not null,
  'a contended source cannot disclose acceptance text before authority is confirmed') from contended_evidence;
set local statement_timeout = '0';
select extensions.dblink_exec('benchmark_evidence_source_lock','rollback');
select extensions.dblink_disconnect('benchmark_evidence_source_lock');
select is(pg_temp.read_evidence_race()#>>'{source,availability}','withheld','the released run still observes its committed erasure');
select * from finish();
delete from public.workspaces where id = pg_temp.evidence_race_id(2);
delete from auth.users where id = pg_temp.evidence_race_id(1);
commit;
