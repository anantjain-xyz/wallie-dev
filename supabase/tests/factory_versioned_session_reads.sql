begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set request.jwt.claim.role = 'service_role';
create temp table read_saved_release as select * from internal.git_continuity_release_control;
select public.set_git_continuity_release(true, revision, 'Versioned read fixture') from read_saved_release;

create function pg_temp.read_id(slot integer) returns uuid language sql immutable as $$
  select ('57000000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
set request.jwt.claim.sub = '57000000-0000-4000-8000-000000000001';
insert into auth.users(id,email) values (pg_temp.read_id(1), 'machine-read-owner@example.test');
insert into public.workspaces(id,slug,name) values
  (pg_temp.read_id(2), 'machine-read-fixture', 'Machine read'),
  (pg_temp.read_id(4), 'machine-read-other-workspace', 'Other workspace');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.read_id(3), pg_temp.read_id(2), pg_temp.read_id(1), 'human', 'owner'),
  (pg_temp.read_id(5), pg_temp.read_id(4), pg_temp.read_id(1), 'human', 'owner');

create function pg_temp.read_factory(p_workspace_id uuid default pg_temp.read_id(2)) returns uuid language sql stable as $$
  select factory.id from public.factories factory where factory.workspace_id=p_workspace_id and factory.is_default
$$;
create temp table sibling_factory as
  select * from public.create_factory(pg_temp.read_id(2), pg_temp.read_id(1), 'Other factory', 'other-factory');
insert into public.pipelines(id,workspace_id,factory_id,name,is_default) values
  (pg_temp.read_id(10), pg_temp.read_id(2), pg_temp.read_factory(), 'Machine read', true),
  (pg_temp.read_id(13), pg_temp.read_id(2), (select id from sibling_factory), 'Other factory', false),
  (pg_temp.read_id(15), pg_temp.read_id(4), pg_temp.read_factory(pg_temp.read_id(4)), 'Other workspace', true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md,anyone_can_approve) values
  (pg_temp.read_id(11), pg_temp.read_id(10), pg_temp.read_id(2), 1, 'draft', 'Draft', 'Draft the spec', true),
  (pg_temp.read_id(14), pg_temp.read_id(13), pg_temp.read_id(2), 1, 'draft', 'Draft', 'Draft the spec', true),
  (pg_temp.read_id(16), pg_temp.read_id(15), pg_temp.read_id(4), 1, 'draft', 'Draft', 'Draft the spec', true);

insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
  (pg_temp.read_id(20), pg_temp.read_id(2), 57000001, 'https://github.test/installations/57000001', 57000, 'Organization', 'read-fixture', '{"contents":"write","pull_requests":"write"}'),
  (pg_temp.read_id(24), pg_temp.read_id(4), 57000002, 'https://github.test/installations/57000002', 57000, 'Organization', 'other-workspace', '{"contents":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch) values
  (pg_temp.read_id(21), pg_temp.read_id(2), pg_temp.read_factory(), pg_temp.read_id(20), 570001, 'writer', 'fixture/writer', true, 'https://github.test/fixture/writer', 'main'),
  (pg_temp.read_id(22), pg_temp.read_id(2), pg_temp.read_factory(), pg_temp.read_id(20), 570002, 'context', 'fixture/context', true, 'https://github.test/fixture/context', 'main'),
  (pg_temp.read_id(23), pg_temp.read_id(2), (select id from sibling_factory), pg_temp.read_id(20), 570003, 'sibling', 'fixture/sibling', true, 'https://github.test/fixture/sibling', 'main'),
  (pg_temp.read_id(25), pg_temp.read_id(4), pg_temp.read_factory(pg_temp.read_id(4)), pg_temp.read_id(24), 570004, 'other', 'fixture/other', true, 'https://github.test/fixture/other', 'main');

insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.read_id(1), 'platform_api_key', 'never-project-this-ciphertext');
insert into public.workspace_sandbox_settings(workspace_id,active_provider) values (pg_temp.read_id(2), 'e2b')
on conflict (workspace_id) do update set active_provider=excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
values (pg_temp.read_id(2), 'never-project-this-ciphertext');
create temp table read_policy as select * from public.save_execution_policy(pg_temp.read_id(2), pg_temp.read_id(1), 0,
  '{"version":1,"maxRepairAttempts":5,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}');

-- Seed exact active browser definition and let the normal creation and worker
-- transitions produce the session, run, clarification and Git checkpoint.
with snapshot as (
  select jsonb_build_object('agentId',agent.id,'promptRevisionId',prompt.id,'promptMd',prompt.prompt_md,'promptSha256',prompt.prompt_sha256) contents
  from public.factory_agents agent join public.factory_agent_prompt_revisions prompt on prompt.agent_id=agent.id
  where agent.factory_id=pg_temp.read_factory() and agent.is_default and prompt.revision_number=1
), definition as (
  select jsonb_build_object('schemaVersion',1,'kind','serial','sandboxProvider','e2b',
    'pipelineId',pg_temp.read_id(10),'repositoryId',pg_temp.read_id(21),'executionPolicyRevisionId',policy.id,
    'deliveryPolicyRevisionId',null,'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'implementationAgent',snapshot.contents,
    'stages',jsonb_build_array(jsonb_build_object('id',pg_temp.read_id(11),'slug','draft','name','Draft',
      'description','','promptTemplateMd','Draft the spec','anyoneCanApprove',true,
      'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb)))::text bytes
  from snapshot cross join read_policy policy
), revision as (
  insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
  select pg_temp.read_id(2),pg_temp.read_factory(),1,bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'),pg_temp.read_id(1)
    from definition returning *
)
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,1,pg_temp.read_id(1) from revision;

select public.create_service_principal(pg_temp.read_id(2),pg_temp.read_factory(),pg_temp.read_id(1),'Machine reader','machine-reader');
create temp table read_grant as select approved.*
from public.service_principals principal cross join read_policy policy
cross join lateral public.approve_factory_execution_grant(pg_temp.read_id(2),pg_temp.read_factory(),pg_temp.read_id(1),principal.id,
  pg_temp.read_id(21),array[pg_temp.read_id(22)],'{}',policy.id,pg_temp.read_id(3),clock_timestamp()+interval '1 hour',0,null,
  '{sessions:read,sessions:cancel}'::public.factory_command_scope[]) approved
where principal.factory_id=pg_temp.read_factory() and principal.slug='machine-reader';
select public.issue_factory_machine_token(workspace_id,factory_id,pg_temp.read_id(1),id,version,
  pg_temp.read_id(60),repeat('a',64),'Read fixture','{sessions:read,sessions:cancel}') from read_grant;

create function pg_temp.read_create(title text) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select * from public.create_session_with_first_job(pg_temp.read_id(2), pg_temp.read_id(3), title, 'Read the canonical session.', 'codex','gpt-5.5')
$$;
create temp table review_session as
  select created.* from public.factory_definition_revisions revision
  cross join lateral public.create_session_command_once(pg_temp.read_id(2),pg_temp.read_id(3),pg_temp.read_id(70),repeat('a',64),
    revision.canonical_digest,'Review me','Read the canonical session.','codex','gpt-5.5','{}',
    target_factory_id=>pg_temp.read_factory(),draft_specification=>true) created
  where revision.factory_id=pg_temp.read_factory();
create temp table second_session as select * from pg_temp.read_create('Queued session');
create temp table third_session as select * from pg_temp.read_create('Newest session');

insert into public.sessions(id, number, workspace_id,factory_id,creator_member_id,pipeline_id,current_stage_id,title,prompt_md,github_repository_id)
values
  (pg_temp.read_id(101),101,pg_temp.read_id(2),pg_temp.read_factory(),pg_temp.read_id(3),pg_temp.read_id(10),pg_temp.read_id(11),'Unpinned private title','Private',pg_temp.read_id(21)),
  (pg_temp.read_id(102),102,pg_temp.read_id(2),pg_temp.read_factory(),pg_temp.read_id(3),pg_temp.read_id(10),pg_temp.read_id(11),'Context private title','Private',pg_temp.read_id(22)),
  (pg_temp.read_id(103),103,pg_temp.read_id(2),(select id from sibling_factory),pg_temp.read_id(3),pg_temp.read_id(13),pg_temp.read_id(14),'Sibling private title','Private',pg_temp.read_id(23)),
  (pg_temp.read_id(104),104,pg_temp.read_id(4),pg_temp.read_factory(pg_temp.read_id(4)),pg_temp.read_id(5),pg_temp.read_id(15),pg_temp.read_id(16),'Tenant private title','Private',pg_temp.read_id(25));
insert into public.session_git_roots(session_id,workspace_id,repository_id,repository_full_name,base_branch,initial_base_sha) values
  (pg_temp.read_id(102),pg_temp.read_id(2),pg_temp.read_id(22),'fixture/context','main',repeat('a',40)),
  (pg_temp.read_id(103),pg_temp.read_id(2),pg_temp.read_id(23),'fixture/sibling','main',repeat('a',40)),
  (pg_temp.read_id(104),pg_temp.read_id(4),pg_temp.read_id(25),'fixture/other','main',repeat('a',40));
insert into public.session_artifacts(id,workspace_id,session_id,stage_id,stage_slug,version,artifact_json)
values
  (pg_temp.read_id(110),pg_temp.read_id(2),pg_temp.read_id(103),pg_temp.read_id(14),'draft',1,to_jsonb('Sibling artifact private content'::text)),
  (pg_temp.read_id(111),pg_temp.read_id(2),(select session_id from third_session),pg_temp.read_id(11),'draft',1,'{"raw": "do not project arbitrary artifact payloads"}');

create function pg_temp.read_publish() returns uuid language plpgsql as $$
declare target record;
declare started_run uuid;
declare claim uuid;
begin
  select * into strict target from review_session;
  update public.agent_jobs set status='running',attempt_count=1,
    git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()) where id=target.job_id;
  started_run := public.start_session_job_attempt(target.job_id,1,pg_temp.read_id(11),0,
    'codex','gpt-5.5','code','wallie/machine-read-' || target.job_id::text);
  if started_run is null or not exists(select 1 from public.pin_session_job_git_input(
    target.job_id,1,started_run,pg_temp.read_id(21),'main',repeat('a',40))) then
    raise exception 'Read fixture did not pin construction source';
  end if;
  if not public.prepare_session_source_and_checkpoint_publication(started_run,pg_temp.read_id(21),'main',
    repeat('a',40),repeat('a',40),'Fixture spec','Fixture source','','','',0,
    E'<!-- wallie-clarification: {"question":"Which deadline applies?"} -->\n\n# Exact Markdown') then
    raise exception 'Read fixture did not prepare publication';
  end if;
  claim := public.claim_session_checkpoint_publication(started_run);
  if not public.adopt_session_checkpoint_publication(started_run,claim) then
    raise exception 'Read fixture did not adopt publication';
  end if;
  return started_run;
end;
$$;
create temp table producer_run as select pg_temp.read_publish() run_id;
create temp table producer as
  select checkpoint.run_id, checkpoint.artifact_id, checkpoint.attempt_count from public.session_git_checkpoints checkpoint
  join producer_run on producer_run.run_id=checkpoint.run_id;
insert into public.agent_run_transcript_expirations(run_id,workspace_id)
select run_id,pg_temp.read_id(2) from producer;

create temp table read_source as select bound.* from review_session target
cross join lateral public.bind_session_conversation_source_once(pg_temp.read_id(2),pg_temp.read_factory(),target.session_id,
  pg_temp.read_id(3),'linear','opaque-provider-namespace','private-provider-thread','Related issue','https://linear.test/issue/read') bound;
select public.append_session_conversation_message_once(pg_temp.read_id(2),pg_temp.read_factory(),
  (select session_id from review_session),pg_temp.read_id(3),pg_temp.read_id(71),'A linked message',
  (select id from read_source),'private-provider-message','private-provider-actor');

create function pg_temp.scoped_read(p_operation public.factory_session_read_operation, p_session_id uuid default null,
  p_run_id uuid default null, p_artifact_id uuid default null, p_limit integer default 25,
  p_number integer default null, p_created_at timestamptz default null, p_before_id uuid default null,
  p_direction text default 'before', p_sequence integer default null, p_request_id uuid default gen_random_uuid(),
  p_surface public.factory_command_surface default 'api')
returns jsonb language plpgsql as $$
declare admission record;
declare result jsonb;
begin
  select * into strict admission from public.admit_factory_command(pg_temp.read_id(2),pg_temp.read_factory(),'machine_token',
    pg_temp.read_id(60),repeat('a',64),'sessions:read',p_request_id,repeat('b',64),p_surface);
  if admission.status <> 'admitted' then raise exception 'Fixture admission failed: %', admission.status; end if;
  result := public.read_factory_session_command(pg_temp.read_id(2),pg_temp.read_factory(),'machine_token',
    pg_temp.read_id(60),repeat('a',64),p_request_id,repeat('b',64),p_surface,admission.admission_id,admission.lease_id,
    p_operation,p_session_id,p_run_id,p_artifact_id,p_limit,p_number,p_created_at,p_before_id,p_direction,p_sequence);
  perform public.release_factory_command_admission(admission.admission_id,admission.lease_id);
  return result;
end;
$$;

select ok(has_function_privilege('service_role',
    'public.read_factory_session_command(uuid,uuid,public.factory_command_credential_kind,uuid,text,uuid,text,public.factory_command_surface,uuid,uuid,public.factory_session_read_operation,uuid,uuid,uuid,integer,integer,timestamptz,uuid,text,integer)','execute')
  and not has_function_privilege('authenticated',
    'public.read_factory_session_command(uuid,uuid,public.factory_command_credential_kind,uuid,text,uuid,text,public.factory_command_surface,uuid,uuid,public.factory_session_read_operation,uuid,uuid,uuid,integer,integer,timestamptz,uuid,text,integer)','execute')
  and not has_table_privilege('service_role','internal.factory_session_read_owners','select'),
  'only the protected RPC exposes least-privilege factory reads');

create temp table first_session_page as select pg_temp.scoped_read('sessions',p_limit=>1,p_request_id=>pg_temp.read_id(150)) value;
select is((select value #>> '{data,items,0,id}' from first_session_page), (select session_id::text from third_session),
  'session list applies tenant, factory and writer eligibility before page selection');
select is((select value ->> 'workspaceSlug' from first_session_page), 'machine-read-fixture', 'workspace slug supports canonical browser URL construction');
select is(pg_temp.scoped_read('session',pg_temp.read_id(101)) ->> 'status','not_found','mutable configured repository without an immutable pin is hidden');
select is(pg_temp.scoped_read('session',pg_temp.read_id(102)) ->> 'status','not_found','read-context repository conveys no authority to inspect its sessions');
select is(pg_temp.scoped_read('session',pg_temp.read_id(103),p_request_id=>pg_temp.read_id(151)) ->> 'status','not_found','sibling factory is indistinguishable from an unknown resource');
select is(pg_temp.scoped_read('session',pg_temp.read_id(104)) ->> 'status','not_found','a different tenant is hidden');
select is(pg_temp.scoped_read('session',pg_temp.read_id(105)) ->> 'status','not_found','an unknown resource is hidden');
select results_eq(
  $q$select receipt.request_id from internal.factory_command_uses used join internal.factory_command_admissions receipt on receipt.id=used.admission_id
    where receipt.request_id in (pg_temp.read_id(150),pg_temp.read_id(151))$q$,
  'select pg_temp.read_id(150)','only successful scoped projection records use');

create temp table exact_review as select pg_temp.scoped_read('session', session_id, p_surface=>'mcp') value from review_session;
select ok((select (value #>> '{data,review,artifactId}')::uuid=(select artifact_id from producer)
  and (value #>> '{data,review,checkpointRunId}')::uuid=(select run_id from producer)
  and (value #>> '{data,review,runId}')::uuid=(select run_id from producer)
  and (value #>> '{data,review,attemptCount}')::integer=(select attempt_count from producer)
  and value #>> '{data,review,clarification,question}' = 'Which deadline applies?'
  and value #>> '{data,review,stageSlug}' = 'draft'
  and (value #>> '{data,review,reviewRevision}')::bigint=(select artifact_review_revision from public.sessions where id=(select session_id from review_session))
  from exact_review),'current review points to the exact artifact, producer, checkpoint and pending clarification');

create temp table exact_artifact as select pg_temp.scoped_read('artifact',
  (select session_id from review_session), producer.run_id, producer.artifact_id) value from producer;
select ok((select value #>> '{data,id}' = (select artifact_id::text from producer)
  and value #>> '{data,provenance,commitSha}'=repeat('a',40)
  and value #>> '{data,provenance,runId}'=(select run_id::text from producer)
  and value #>> '{data,provenance,checkpointRunId}'=(select run_id::text from producer)
  and value #>> '{data,stageSlug}'='draft' and (value #>> '{data,version}')::integer=1
  and value #>> '{data,bodyMarkdown}' like '%# Exact Markdown'
  and value::text !~ '(checkpoint_path|output_ref|sandbox_id|credential|bundle_sha256)' from exact_artifact),
  'artifact exposes bounded Markdown with its exact accepted producer and excludes private delivery handles');
select is(pg_temp.scoped_read('artifact',p_run_id=>(select run_id from second_session),p_artifact_id=>(select artifact_id from producer)) ->> 'status',
  'not_found','a different run never resolves the artifact');
select is(pg_temp.scoped_read('artifact',p_artifact_id=>pg_temp.read_id(110)) ->> 'status',
  'not_found','sibling factory artifact lookup cannot read an exact identifier');
select is(pg_temp.scoped_read('artifact',p_artifact_id=>pg_temp.read_id(111)) ->> 'status',
  'unavailable','a scoped artifact without exact readable Markdown and producer is explicitly unavailable');

create temp table exact_run as select pg_temp.scoped_read('run',p_run_id=>run_id) value from producer;
select ok((select value #>> '{data,artifactCoverage}'='available' and value #>> '{data,transcriptAvailability}'='expired'
    and value #>> '{data,artifactId}' = (select artifact_id::text from producer)
    and value::text !~ '(sandbox|credential|provider|branch)' from exact_run),
  'run availability reuses the exact artifact/index and retention receipt without exposing trace or private runtime data');
select is(pg_temp.scoped_read('run',p_run_id=>(select run_id from third_session)) #>> '{data,artifactCoverage}',
  'unavailable','an admitted run without a published artifact has explicit coverage');
select is(pg_temp.scoped_read('run',(select session_id from review_session),p_run_id=>(select run_id from second_session)) ->> 'status',
  'not_found','run from one session cannot be read through another session');
select is(pg_temp.scoped_read('runs',pg_temp.read_id(103)) ->> 'status','not_found','run lists authorize their owner before selecting rows');

create temp table latest_conversation as select pg_temp.scoped_read('conversation',session_id,p_limit=>2) value from review_session;
select ok((select value #>> '{data,items,0,kind}'='review_ready'
  and value #>> '{data,items,1,kind}'='message'
  and value #>> '{data,items,1,source,url}'='https://linear.test/issue/read'
  and value #>> '{data,sourceLinks,0,id}'=(select id::text from read_source)
  and value::text !~ '(private-provider|opaque-provider|originating_member)' from latest_conversation),
  'conversation includes review and linked messages, and excludes provider receipt identities');
select is(pg_temp.scoped_read('conversation',(select session_id from review_session),p_limit=>2,
  p_sequence=>(select (value #>> '{data,nextCursor,sequence}')::integer from latest_conversation)) #>> '{data,items,0,kind}',
  'initial_prompt','older conversation pages do not duplicate consecutive sequences');
select is(pg_temp.scoped_read('conversation',(select session_id from review_session),p_limit=>1,p_direction=>'after',p_sequence=>0)
  #>> '{data,items,0,kind}','initial_prompt','zero is a valid forward cursor for reconnect and empty histories');
select is(pg_temp.scoped_read('conversation',pg_temp.read_id(103)) ->> 'status','not_found','conversation uses the same scoped owner fence');
select throws_ok($q$select pg_temp.scoped_read('sessions',p_limit=>51)$q$,'22023','Invalid factory session read parameters.',
  'bounded page size is mandatory at the RPC');
select throws_ok($q$select pg_temp.scoped_read('runs',p_created_at=>clock_timestamp())$q$,'22023','Invalid factory session read parameters.',
  'run cursors require the exact timestamp and tie-breaking identifier');

create temp table cancel_permit as select * from public.admit_factory_command(pg_temp.read_id(2),pg_temp.read_factory(),'machine_token',
  pg_temp.read_id(60),repeat('a',64),'sessions:cancel',pg_temp.read_id(152),repeat('b',64),'api');
select throws_ok($q$select public.read_factory_session_command(pg_temp.read_id(2),pg_temp.read_factory(),'machine_token',
    pg_temp.read_id(60),repeat('a',64),pg_temp.read_id(152),repeat('b',64),'api',admission_id,lease_id,'sessions')
  from cancel_permit$q$,'PT409','Command admission is unavailable.','a lease for another command cannot read session data');
select public.release_factory_command_admission(admission_id,lease_id) from cancel_permit;

-- A committed writer inserts a newer session and run between the two pages.
-- Same-timestamp fixture runs also verify the UUID tie-breaker.
create temp table first_run_page as select pg_temp.scoped_read('runs',p_limit=>1) value;
create temp table next_expected_run as
  select run.id from public.agent_runs run
  where run.workspace_id=pg_temp.read_id(2)
  order by run.created_at desc, run.id desc offset 1 limit 1;
-- The publication used temporary enablement. Restore the release control and
-- its audit before committing the rows needed by the separate page writer.
delete from internal.git_continuity_release_audit where revision > (select revision from read_saved_release);
update internal.git_continuity_release_control control set enabled=saved.enabled,revision=saved.revision,
  reason=saved.reason,updated_at=saved.updated_at from read_saved_release saved where control.singleton=saved.singleton;
commit;
begin;
select extensions.dblink_connect('read_writer',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('read_writer','set request.jwt.claim.role=''service_role''');
create temp table inserted_between_pages as select * from extensions.dblink('read_writer',format($q$
  select session_id, run_id from public.create_session_with_first_job(%L,%L,
    'Concurrent new page','A newer machine read fixture.','codex','gpt-5.5')
$q$,pg_temp.read_id(2),pg_temp.read_id(3))) created(session_id uuid,run_id uuid);
select is(pg_temp.scoped_read('sessions',p_limit=>1,p_number=>(select (value #>> '{data,nextCursor,number}')::integer from first_session_page))
    #>> '{data,items,0,id}',(select session_id::text from second_session),
  'a concurrent committed insert cannot shift the next page of session numbers');
select is(pg_temp.scoped_read('runs',p_limit=>1,
    p_created_at=>(select (value #>> '{data,nextCursor,createdAt}')::timestamptz from first_run_page),
    p_before_id=>(select (value #>> '{data,nextCursor,id}')::uuid from first_run_page))
    #>> '{data,items,0,id}',(select id::text from next_expected_run),
  'run timestamp-plus-ID pagination survives a committed insert and equal-time runs without duplicates');
select is(pg_temp.scoped_read('sessions',p_limit=>1) #>> '{data,items,0,id}',
  (select session_id::text from inserted_between_pages),'a fresh first page includes the committed session');
select extensions.dblink_disconnect('read_writer');

insert into public.session_git_roots(session_id,workspace_id,repository_id,repository_full_name,base_branch,initial_base_sha)
values (pg_temp.read_id(101),pg_temp.read_id(2),pg_temp.read_id(21),'fixture/writer','main',repeat('a',40));
select is(pg_temp.scoped_read('session',pg_temp.read_id(101)) ->> 'status','ok',
  'an immutable Git root establishes eligible legacy writer history');

insert into public.agent_runs(id,workspace_id,session_id,stage_id,stage_slug,stage_name,run_type,model_provider,model_name,status,created_at)
values (pg_temp.read_id(160),pg_temp.read_id(2),(select session_id from review_session),
  pg_temp.read_id(11),'draft','Draft','project','codex','gpt-5.5','error',clock_timestamp());
create temp table review_after_newer_run as select pg_temp.scoped_read('session', session_id) value from review_session;
select ok((select value #>> '{data,currentRunId}' = pg_temp.read_id(160)::text
  and value #>> '{data,review,runId}' = (select run_id::text from producer) from review_after_newer_run),
  'a later attempt never relabels the exact producer of an already accepted artifact');

create temp table formerly_authorized as select * from public.admit_factory_command(pg_temp.read_id(2),pg_temp.read_factory(),'machine_token',
  pg_temp.read_id(60),repeat('a',64),'sessions:read',pg_temp.read_id(153),repeat('b',64),'api');
select public.revoke_factory_machine_token(pg_temp.read_id(2),pg_temp.read_factory(),pg_temp.read_id(1),
  (select id from read_grant),pg_temp.read_id(60));
select throws_ok($q$select public.read_factory_session_command(pg_temp.read_id(2),pg_temp.read_factory(),'machine_token',
    pg_temp.read_id(60),repeat('a',64),pg_temp.read_id(153),repeat('b',64),'api',admission_id,lease_id,'sessions')
  from formerly_authorized$q$,'42501','Machine token is unavailable or does not authorize this command.',
  'a provisional read permit cannot survive token revocation');
select ok(not exists(select 1 from internal.factory_command_uses where admission_id=(select admission_id from formerly_authorized)),
  'a revoked read records no successful use');

delete from public.workspaces where id in (pg_temp.read_id(2), pg_temp.read_id(4));
delete from auth.users where id=pg_temp.read_id(1);
select * from finish();
commit;
