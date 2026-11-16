begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

-- Independent transactions share only this committed fixture. Never change the
-- seeded workspace or its personal credentials to exercise a revocation.
insert into auth.users(id,email) values
  ('54200000-0000-4000-8000-000000000001','factory-activation-owner@example.com'),
  ('54200000-0000-4000-8000-000000000002','factory-activation-reviewer@example.com');
insert into public.workspaces(id,slug,name) values
  ('54200000-0001-4000-8000-000000000001','factory-activation-test','Factory activation'),
  ('54200000-0001-4000-8000-000000000002','factory-activation-foreign','Other factory');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  ('54200000-0002-4000-8000-000000000001','54200000-0001-4000-8000-000000000001',
   '54200000-0000-4000-8000-000000000001','human','owner'),
  ('54200000-0002-4000-8000-000000000002','54200000-0001-4000-8000-000000000001',
   '54200000-0000-4000-8000-000000000002','human','member');
insert into public.pipelines(id,workspace_id,name,is_default) values
  ('54200000-0003-4000-8000-000000000001','54200000-0001-4000-8000-000000000001','Factory pipeline',true);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name) values
  ('54200000-0004-4000-8000-000000000001','54200000-0003-4000-8000-000000000001',
   '54200000-0001-4000-8000-000000000001',1,'verify-delivery','Verify delivery'),
  ('54200000-0004-4000-8000-000000000002','54200000-0003-4000-8000-000000000001',
   '54200000-0001-4000-8000-000000000001',2,'live-handoff','Live handoff');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
  ('54200000-0005-4000-8000-000000000001','54200000-0001-4000-8000-000000000001',
   54200001,'https://github.com/installations/54200001',5420,'Organization','Fixture',
   '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch) values
  ('54200000-0006-4000-8000-000000000001','54200000-0001-4000-8000-000000000001',
   '54200000-0005-4000-8000-000000000001',54200011,'factory-activation','fixture/factory-activation',true,
   'https://github.com/fixture/factory-activation','main'),
  ('54200000-0006-4000-8000-000000000002','54200000-0001-4000-8000-000000000001',
   '54200000-0005-4000-8000-000000000001',54200012,'factory-admission','fixture/factory-admission',true,
   'https://github.com/fixture/factory-admission','trunk');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential) values
  ('54200000-0000-4000-8000-000000000001','platform_api_key','activation-test-ciphertext'),
  ('54200000-0000-4000-8000-000000000002','platform_api_key','admission-test-ciphertext');
insert into public.workspace_sandbox_settings(workspace_id,active_provider) values
  ('54200000-0001-4000-8000-000000000001','e2b') on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key) values
  ('54200000-0001-4000-8000-000000000001','activation-test-ciphertext');

create function pg_temp.factory_activation_probes() returns text[] language sql immutable as $$
  select array['git','node','packageManager','agentCli','playwrightPackage','chromium','screenshotSmoke','codexExternalSandbox']::text[];
$$;
create function pg_temp.factory_activation_receipt(p_ok boolean default true)
returns void language sql as $$
  insert into public.sandbox_capability_checks(workspace_id,github_repository_id,status,capabilities,
    sandbox_provider,agent_provider,agent_model,sandbox_connection_revision,checked_at)
  select c.workspace_id,'54200000-0006-4000-8000-000000000001',
    case when p_ok then 'success' else 'error' end,
    (select jsonb_object_agg(probe,jsonb_build_object('ok',p_ok,'detail',null))
      from unnest(pg_temp.factory_activation_probes()) as probe),
    'e2b','codex','gpt-5',c.connection_revision,clock_timestamp()
  from public.workspace_e2b_sandbox_connections c
  where c.workspace_id = '54200000-0001-4000-8000-000000000001';
$$;
select pg_temp.factory_activation_receipt();

create temp table factory_activation_scope as
select f.workspace_id, f.id as factory_id,
  '54200000-0000-4000-8000-000000000001'::uuid as owner_id,
  '54200000-0000-4000-8000-000000000002'::uuid as member_user_id
from public.factories f
where f.workspace_id = '54200000-0001-4000-8000-000000000001' and f.is_default;

create function pg_temp.factory_activation_bundle(p_name text,p_approver uuid default null,p_execution_policy uuid default null)
returns text language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion',1,'kind','serial','sandboxProvider','e2b',
    'pipelineId','54200000-0003-4000-8000-000000000001',
    'repositoryId','54200000-0006-4000-8000-000000000001',
    'executionPolicyRevisionId',p_execution_policy,'deliveryPolicyRevisionId',null,
    'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'stages',jsonb_build_array(jsonb_build_object('id','54200000-0004-4000-8000-000000000002',
      'slug','compiled-handoff','name','Compiled handoff','description','','promptTemplateMd','Prepare {{session.title}}.',
      'anyoneCanApprove',true,'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb),
      jsonb_build_object('id','54200000-0004-4000-8000-000000000001',
      'slug','verify-delivery','name',p_name,'description','','promptTemplateMd','Check {{session.title}}.',
      'anyoneCanApprove',false,'previousStageIds','[]'::jsonb,'approverMemberIds',
      case when p_approver is null then '[]'::jsonb else jsonb_build_array(p_approver) end))
  )::text;
$$;

create function pg_temp.factory_admission_budget(p_revision bigint) returns uuid language sql as $$
  select (public.save_execution_policy(s.workspace_id,s.owner_id,p_revision,
    '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}')).id
  from factory_activation_scope s;
$$;

create function pg_temp.factory_activation_save(p_base bigint,p_definition text)
returns public.factory_definition_drafts language sql as $$
  select public.save_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,p_base,
    p_definition,encode(sha256(convert_to(p_definition,'UTF8')),'hex')) from factory_activation_scope s;
$$;

-- Fixture completions represent provider output. They exercise the same durable
-- reservation, authorization and finalization paths as the editor API.
create function pg_temp.factory_smoke_start(p_kind text, p_base bigint, p_target uuid,
  p_providers text[] default array['e2b'], p_digest text default null, p_actor uuid default null)
returns public.factory_definition_smoke_tests language sql as $$
  select public.start_factory_definition_smoke_test(s.workspace_id,s.factory_id,coalesce(p_actor,s.owner_id),
    p_base,p_kind,p_target,coalesce(p_digest,target.canonical_digest),p_providers,pg_temp.factory_activation_probes())
  from factory_activation_scope s
  cross join lateral (
    select d.canonical_digest from public.factory_definition_drafts d
    where p_kind='draft' and (d.workspace_id,d.factory_id,d.id)=(s.workspace_id,s.factory_id,p_target)
    union all
    select r.canonical_digest from public.factory_definition_revisions r
    where p_kind='revision' and (r.workspace_id,r.factory_id,r.id)=(s.workspace_id,s.factory_id,p_target)
  ) target;
$$;

create function pg_temp.factory_smoke_finish(p_test_id uuid, p_runtime_profile text default null)
returns boolean language sql as $$
  select public.finish_factory_definition_smoke_test(test.workspace_id,test.id,'passed',
    jsonb_build_object(
      'runtimeProfile',coalesce(p_runtime_profile,target.body->>'sandboxProvider'),
      'stageCount',jsonb_array_length(target.body->'stages'),
      'completedStageCount',jsonb_array_length(target.body->'stages'),
      'stages',(select jsonb_agg(jsonb_build_object('stageId',s.value->>'id','promptDigest',repeat('d',64)) order by s.position)
        from jsonb_array_elements(target.body->'stages') with ordinality as s(value,position) where s.position <= 32)))
  from public.factory_definition_smoke_tests test
  cross join lateral (
    select d.definition_json::jsonb body from public.factory_definition_drafts d
    where test.target_kind='draft' and d.id=test.target_id
    union all
    select r.definition_json::jsonb body from public.factory_definition_revisions r
    where test.target_kind='revision' and r.id=test.target_id
  ) target
  where test.id=p_test_id;
$$;

create function pg_temp.seed_factory_smoke(p_kind text, p_base bigint, p_target uuid,
  p_providers text[] default array['e2b']) returns boolean language plpgsql as $$
declare test public.factory_definition_smoke_tests;
begin
  test := pg_temp.factory_smoke_start(p_kind,p_base,p_target,p_providers);
  if test.status is distinct from 'running' then
    raise exception 'Expected an authorized smoke fixture, got % (%)', test.status, test.error_text;
  end if;
  return pg_temp.factory_smoke_finish(test.id);
end;
$$;

-- Build a parameterized query locally, then run it either in this transaction
-- or over dblink. Remote sessions cannot access this session's temp fixture.
create function pg_temp.factory_activation_command(p_kind text,p_base bigint,p_target uuid,
  p_providers text[] default array['e2b']) returns text language sql as $$
  select format('select activation_number,revision_id from public.%I(%L::uuid,%L::uuid,%L::uuid,%L::bigint,%L::uuid,%L::text[],%L::text[])',
    case p_kind when 'publish' then 'publish_factory_definition_draft' else 'rollback_factory_definition' end,
    s.workspace_id,s.factory_id,s.owner_id,p_base,p_target,p_providers,pg_temp.factory_activation_probes())
  from factory_activation_scope s;
$$;

create function pg_temp.factory_admission_command(p_request_id uuid, p_title text,
  p_creator_member_id uuid default '54200000-0002-4000-8000-000000000001',
  p_repository_id uuid default '54200000-0006-4000-8000-000000000001',
  p_pipeline_id uuid default '54200000-0003-4000-8000-000000000001',
  p_stage_ids uuid[] default '{54200000-0004-4000-8000-000000000002,54200000-0004-4000-8000-000000000001}')
returns text language sql as $$
  select format($q$select session_id from public.create_session_once_with_first_job(
    '54200000-0001-4000-8000-000000000001', %L::uuid,
    %L::uuid, repeat('d',64), %L, '  Immutable original prompt  ', 'codex','gpt-5.1', '{}'::uuid[],
    session_github_repository_id => %L::uuid, selected_pipeline_id => %L::uuid, selected_stage_ids => %L::uuid[]
  )$q$, p_creator_member_id, p_request_id, '  ' || p_title || '  ', p_repository_id, p_pipeline_id, p_stage_ids);
$$;

create function pg_temp.admit_factory_session(p_request_id uuid, p_title text,
  p_repository_id uuid default '54200000-0006-4000-8000-000000000001')
returns uuid language plpgsql as $$
declare admitted_session_id uuid;
begin
  execute pg_temp.factory_admission_command(p_request_id, p_title, p_repository_id => p_repository_id)
  into strict admitted_session_id;
  return admitted_session_id;
end;
$$;

select ok(bool_and(has_function_privilege('service_role',signature,'EXECUTE')
  and not has_function_privilege('anon',signature,'EXECUTE')
  and not has_function_privilege('authenticated',signature,'EXECUTE')),
  'only a service caller can invoke factory mutation RPCs')
from (values
  ('public.save_factory_definition_draft(uuid,uuid,uuid,bigint,text,text)'),
  ('public.publish_factory_definition_draft(uuid,uuid,uuid,bigint,uuid,text[],text[])'),
  ('public.rollback_factory_definition(uuid,uuid,uuid,bigint,uuid,text[],text[])')
) as commands(signature);
select ok(has_function_privilege('service_role',signature,'EXECUTE')
  and not has_function_privilege('anon',signature,'EXECUTE')
  and not has_function_privilege('authenticated',signature,'EXECUTE'),
  'only a service caller can reserve a prospective capability check')
from (values ('public.start_factory_definition_capability_check(uuid,uuid,uuid,text,text,text,text)'))
  as commands(signature);
select throws_ok($$select public.save_factory_definition_draft(s.workspace_id,s.factory_id,s.member_user_id,
  0,d.bytes,encode(sha256(convert_to(d.bytes,'UTF8')),'hex')) from factory_activation_scope s
  cross join (select pg_temp.factory_activation_bundle('Denied') bytes) d$$,
  '42501',null,'a regular member cannot save a factory draft');
select throws_ok($$select public.save_factory_definition_draft(s.workspace_id,f.id,s.owner_id,
  0,d.bytes,encode(sha256(convert_to(d.bytes,'UTF8')),'hex')) from factory_activation_scope s
  cross join (select id from public.factories where workspace_id='54200000-0001-4000-8000-000000000002') f
  cross join (select pg_temp.factory_activation_bundle('Foreign') bytes) d$$,
  'P0002',null,'a factory reference cannot cross workspace boundaries');
select throws_ok($$select pg_temp.factory_activation_save(0,'{"schemaVersion":1,"kind":"graph"}')$$,
  '22023',null,'draft admission rejects a nonserial definition envelope');

create temp table factory_admission_policy as select pg_temp.factory_admission_budget(0) as original_revision;
create temp table factory_activation_initial as
select * from pg_temp.factory_activation_save(0,pg_temp.factory_activation_bundle('Initial',p_execution_policy =>
  (select original_revision from factory_admission_policy)));
select ok((select base_activation_number is null and definition_json=pg_temp.factory_activation_bundle('Initial',p_execution_policy => original_revision)
  from factory_activation_initial cross join factory_admission_policy), 'an initial draft stores exact bytes and no predecessor');
select is((select count(*) from public.factory_definition_activations a join factory_activation_scope s on s.factory_id=a.factory_id),
  0::bigint,'saving a draft has no activation side effect');

create temp table factory_admission_legacy as
select pg_temp.admit_factory_session('54200000-0007-4000-8000-000000000001','Before enrollment',
  '54200000-0006-4000-8000-000000000002') as session_id;
select ok((select s.factory_definition_provenance='legacy' and s.factory_definition_revision_id is null
  and not s.execute_pinned_definition and input.session_id is null
  and s.execution_policy_revision_id=(select original_revision from factory_admission_policy)
  and s.github_repository_id='54200000-0006-4000-8000-000000000002'::uuid
  and s.current_stage_id='54200000-0004-4000-8000-000000000001'::uuid
  from factory_admission_legacy fixture
  join public.sessions s on s.id=fixture.session_id
  left join public.session_factory_admission_inputs input on input.session_id=s.id),
  'normal creation before activation makes an explicit legacy session without an admission receipt');

select ok(bool_and(has_function_privilege('service_role',signature,'EXECUTE')
  and not has_function_privilege('anon',signature,'EXECUTE')
  and not has_function_privilege('authenticated',signature,'EXECUTE')),
  'only a service caller can invoke smoke test lifecycle RPCs')
from (values ('public.start_factory_definition_smoke_test(uuid,uuid,uuid,bigint,text,uuid,text,text[],text[])'),
  ('public.finish_factory_definition_smoke_test(uuid,uuid,text,jsonb,text)'),
  ('public.cancel_factory_definition_smoke_test(uuid,uuid,uuid,text)')) commands(signature);
select ok(not has_table_privilege('service_role','public.factory_definition_smoke_tests','INSERT, UPDATE, DELETE')
  and not has_table_privilege('authenticated','public.factory_definition_smoke_tests','INSERT, UPDATE, DELETE'),
  'smoke test evidence can only be written by lifecycle RPCs');

select throws_ok(pg_temp.factory_activation_command('publish',0,(select id from factory_activation_initial)),
  'PT422','A current passing smoke test is required for the exact factory candidate.','a direct activation command rejects missing smoke evidence');
select throws_ok($$select pg_temp.factory_smoke_start('draft',0,(select id from factory_activation_initial),
  p_actor=>(select member_user_id from factory_activation_scope))$$,
  '42501',null,'a workspace member cannot reserve smoke runtime');
select throws_ok($$select pg_temp.factory_smoke_start('draft',0,(select id from factory_activation_initial),
  p_digest=>repeat('0',64))$$,'PT409',null,'a mismatched candidate digest cannot reserve smoke runtime');
select is((select t.status from pg_temp.factory_smoke_start('draft',0,(select id from factory_activation_initial),
  p_providers=>array['daytona']) t),'blocked','an unavailable provider creates blocked evidence before runtime');

create temp table factory_smoke_canceled as
select * from pg_temp.factory_smoke_start('draft',0,(select id from factory_activation_initial));
select ok((select t.status='running' and t.target_id=d.id and t.definition_digest=d.canonical_digest
    and t.policy_version=1 and t.sandbox_connection_revision=c.connection_revision
  from factory_smoke_canceled t cross join factory_activation_initial d
  join public.workspace_e2b_sandbox_connections c on c.workspace_id=d.workspace_id),
  'the smoke reservation records digest, target, policy, and connection revision');
select throws_ok($$select pg_temp.factory_smoke_start('draft',0,(select id from factory_activation_initial))$$,
  'PT409',null,'a live reservation cannot start a second execution');
select throws_ok(pg_temp.factory_activation_command('publish',0,(select id from factory_activation_initial)),
  'PT422',null,'a running smoke cannot qualify activation');
select is((select stopped.status from factory_smoke_canceled t cross join factory_activation_scope s
  cross join lateral public.cancel_factory_definition_smoke_test(t.workspace_id,t.id,s.owner_id,t.definition_digest) stopped),
  'canceled','cancellation records a durable terminal result');
select ok(not pg_temp.factory_smoke_finish((select id from factory_smoke_canceled)),
  'a late successful reply cannot overwrite a canceled result');
select throws_ok(pg_temp.factory_activation_command('publish',0,(select id from factory_activation_initial)),
  'PT422',null,'canceled evidence cannot qualify activation');

create temp table factory_smoke_fake as
select * from pg_temp.factory_smoke_start('draft',0,(select id from factory_activation_initial));
select ok(pg_temp.factory_smoke_finish((select id from factory_smoke_fake),'fake'),
  'the fake profile may record a successful test for inspection');
select throws_ok(pg_temp.factory_activation_command('publish',0,(select id from factory_activation_initial)),
  'PT422',null,'fake evidence cannot qualify activation against a real provider');
select ok(pg_temp.seed_factory_smoke('draft',0,(select id from factory_activation_initial)),
  'a passing test for the exact provider and candidate is stored');
update public.factory_definition_smoke_tests set finished_at=clock_timestamp()-interval '25 hours'
  where status='passed' and target_id=(select id from factory_activation_initial)
    and evidence->>'runtimeProfile'='e2b';
select throws_ok(pg_temp.factory_activation_command('publish',0,(select id from factory_activation_initial)),
  'PT422',null,'stale smoke evidence cannot qualify activation');

create temp table factory_smoke_unsupported as
select * from pg_temp.factory_smoke_start('draft',0,(select id from factory_activation_initial));
select ok((select public.finish_factory_definition_smoke_test(workspace_id,id,'unsupported',
  '{}'::jsonb,'This smoke profile is unsupported.') from factory_smoke_unsupported),
  'unsupported runtime results are durable');
select throws_ok(pg_temp.factory_activation_command('publish',0,(select id from factory_activation_initial)),
  'PT422',null,'unsupported evidence cannot qualify activation');

create temp table factory_smoke_failed as
select * from pg_temp.factory_smoke_start('draft',0,(select id from factory_activation_initial));
select throws_ok($$select public.finish_factory_definition_smoke_test(workspace_id,id,'passed',
  '{"runtimeProfile":"e2b","stageCount":2,"completedStageCount":1,"stages":[]}'::jsonb) from factory_smoke_failed$$,
  '22023',null,'incomplete serial execution cannot be finalized as passing');
select ok((select public.finish_factory_definition_smoke_test(workspace_id,id,'failed',
  '{}'::jsonb,'The isolated command failed.') from factory_smoke_failed),
  'failed execution is retained with a terminal status');
select throws_ok(pg_temp.factory_activation_command('publish',0,(select id from factory_activation_initial)),
  'PT422',null,'failed evidence cannot qualify activation');

select pg_temp.seed_factory_smoke('draft',0,(select id from factory_activation_initial));
create temp table factory_smoke_edited as
select id from pg_temp.factory_activation_save(0,pg_temp.factory_activation_bundle(
  'Subsequently edited',p_execution_policy=>(select original_revision from factory_admission_policy)));
select throws_ok(pg_temp.factory_activation_command('publish',0,(select id from factory_smoke_edited)),
  'PT422',null,'a passing receipt cannot be reused for a subsequently edited draft');

create temp table factory_activation_first as
select a.* from factory_activation_scope s cross join factory_activation_initial d
cross join lateral public.publish_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,0,d.id,
  array['e2b'],pg_temp.factory_activation_probes()) a;
select is((select activation_number from factory_activation_first),1::bigint,'publishing creates the first activation');
select ok((select r.source_draft_id=d.id and r.definition_json=d.definition_json and r.canonical_digest=d.canonical_digest
  from factory_activation_first a join public.factory_definition_revisions r on r.id=a.revision_id
  cross join factory_activation_initial d),'publish copies the selected immutable draft byte for byte');
select is(pg_temp.admit_factory_session('54200000-0007-4000-8000-000000000001','Before enrollment',
  '54200000-0006-4000-8000-000000000002'),
  (select session_id from factory_admission_legacy), 'creation replay after first publication returns the pre-enrollment session');
select ok((select s.factory_definition_provenance='legacy' and s.factory_definition_revision_id is null
  and input.session_id is null from factory_admission_legacy fixture
  join public.sessions s on s.id=fixture.session_id
  left join public.session_factory_admission_inputs input on input.session_id=s.id),
  'publication and replay do not backfill a historical pin or receipt');

select pg_temp.factory_admission_budget(1);
update public.pipeline_stages set slug='renamed-live-handoff',name='Renamed live handoff',position=20,archived_at=clock_timestamp()
where id='54200000-0004-4000-8000-000000000002';

create temp table factory_admission_first as
select session_id from public.create_session_with_first_job(
  '54200000-0001-4000-8000-000000000001', '54200000-0002-4000-8000-000000000001',
  'Unwrapped session creation', 'Original input', 'codex', 'gpt-5'
);
select ok((select s.execute_pinned_definition and s.factory_definition_provenance='pinned' and s.factory_definition_revision_id=a.revision_id
  and input.activation_number=a.activation_number and input.definition_revision_id=a.revision_id
  and s.execution_policy_revision_id=(select original_revision from factory_admission_policy)
  and input.execution_policy_revision_id=s.execution_policy_revision_id
  from factory_admission_first fixture join public.sessions s on s.id=fixture.session_id
  join public.session_factory_admission_inputs input on input.session_id=s.id
  cross join factory_activation_first a), 'direct creation admits the active definition with its earlier execution policy');
select ok((select s.current_stage_id='54200000-0004-4000-8000-000000000002'::uuid
  and first_job.stage_id=s.current_stage_id and first_job.stage_slug='compiled-handoff' and first_job.stage_name='Compiled handoff'
  and first_run.stage_id=s.current_stage_id and first_run.stage_slug=first_job.stage_slug and first_run.stage_name=first_job.stage_name
  and first_run.execution_policy_revision_id=s.execution_policy_revision_id
  from factory_admission_first fixture join public.sessions s on s.id=fixture.session_id
  join public.agent_jobs first_job on first_job.session_id=s.id
  join public.agent_runs first_run on first_run.agent_job_id=first_job.id),
  'the first compiled stage and queued run survive live rename, reorder, and archive');
select throws_ok($$update public.sessions set execute_pinned_definition=false
  where id=(select session_id from factory_admission_first)$$,
  '23514','Session factory definition provenance is immutable.','the session cannot switch back to live execution');

delete from public.user_codex_credentials where user_id='54200000-0000-4000-8000-000000000002';
select throws_ok(pg_temp.factory_admission_command('54200000-0007-4000-8000-000000000004','Revoked session owner',
  '54200000-0002-4000-8000-000000000002'),
  'PT422','A current personal credential is required for this agent.','the creator needs a current credential even if the publisher still has one');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values('54200000-0000-4000-8000-000000000002','platform_api_key','admission-test-ciphertext');

update public.github_repositories set is_archived=true where id='54200000-0006-4000-8000-000000000001';
select throws_ok(pg_temp.factory_admission_command('54200000-0007-4000-8000-000000000005','Archived factory repository'),
  'P0002','The factory definition repository is unavailable.','admission rejects a disconnected compiled repository');
update public.github_repositories set is_archived=false where id='54200000-0006-4000-8000-000000000001';

select throws_ok(pg_temp.factory_admission_command('54200000-0007-4000-8000-000000000006','Different repository',
  p_repository_id => '54200000-0006-4000-8000-000000000002'),
  'P0003','The active factory no longer matches the requested session options.','a pinned create must confirm the compiled repository');
select throws_ok(pg_temp.factory_admission_command('54200000-0007-4000-8000-000000000007','Different pipeline',
  p_pipeline_id => '54200000-0003-4000-8000-000000000099'),
  'P0003','The active factory no longer matches the requested session options.','a pinned create must confirm the compiled pipeline');
select throws_ok(pg_temp.factory_admission_command('54200000-0007-4000-8000-000000000008','Missing stage',
  p_stage_ids => array['54200000-0004-4000-8000-000000000002']::uuid[]),
  'P0003','The active factory no longer matches the requested session options.','a pinned create must confirm every compiled stage');

create temp table factory_activation_missing_stage as
select id from pg_temp.factory_activation_save(1,jsonb_set(pg_temp.factory_activation_bundle('Unknown stage')::jsonb,
  '{stages,0,id}','"54200000-0004-4000-8000-000000009999"')::text);
select throws_ok(pg_temp.factory_activation_command('publish',1,(select id from factory_activation_missing_stage)),
  'PT422','The factory definition has stages unavailable in its pipeline.','a definition needs stable backing stage identities before activation');

select ok(has_table_privilege('service_role','public.session_factory_admission_inputs','SELECT')
  and not has_table_privilege('service_role','public.session_factory_admission_inputs','INSERT, UPDATE, DELETE')
  and not has_table_privilege('authenticated','public.session_factory_admission_inputs','SELECT'),
  'admission receipts are service-readable and written only by admission');
select throws_ok($$select pg_temp.factory_activation_save(0,pg_temp.factory_activation_bundle('Stale editor'))$$,
  'PT409',null,'a stale editor cannot save against an old activation number');
select throws_ok(pg_temp.factory_activation_command('publish',1,(select id from factory_activation_initial)),
  'PT409',null,'a stale draft cannot be published by supplying a fresh activation number');
select throws_ok(pg_temp.factory_activation_command('rollback',1,(select revision_id from factory_activation_first)),
  'PT409',null,'rollback cannot append the already active revision');

create temp table factory_activation_publish_race as
select (pg_temp.factory_activation_save(1,pg_temp.factory_activation_bundle(
  'Concurrent winner','54200000-0002-4000-8000-000000000002'))).id as winner_draft,
  (pg_temp.factory_activation_save(1,pg_temp.factory_activation_bundle('Concurrent loser'))).id as loser_draft;
select pg_temp.seed_factory_smoke('draft',1,winner_draft) from factory_activation_publish_race;
commit;
begin;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.wait_factory_activation_lock(target_application text) returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    exit when exists(select 1 from pg_stat_activity where application_name=target_application and wait_event_type='Lock');
    if clock_timestamp()>deadline then raise exception 'Expected factory activation lock not reached by %',target_application; end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('factory_writer',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('factory_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('factory_admitter',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('factory_writer',
  'set application_name=''factory_writer''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set role service_role');
select extensions.dblink_exec('factory_contender',
  'set application_name=''factory_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set role service_role');
select extensions.dblink_exec('factory_admitter',
  'set application_name=''factory_admitter''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''; set role service_role');
select extensions.dblink_exec('factory_contender',$function$
  create function pg_temp.factory_activation_sqlstate(command text) returns text language plpgsql as $$
  begin
    execute command;
    return '00000';
  exception when query_canceled or others then
    return sqlstate;
  end;
  $$;
$function$);

-- Two publishers use drafts from the same active revision. Hold the first
-- transaction open so the second actually contends for the same head.
select extensions.dblink_exec('factory_writer','begin');
create temp table factory_activation_second as
select * from extensions.dblink('factory_writer',pg_temp.factory_activation_command('publish',1,
  (select winner_draft from factory_activation_publish_race))) as result(activation_number bigint,revision_id uuid);
select is((select activation_number from factory_activation_second),2::bigint,'the first publisher creates activation two');
select extensions.dblink_send_query('factory_contender',format('select pg_temp.factory_activation_sqlstate(%L)',
  pg_temp.factory_activation_command('publish',1,(select loser_draft from factory_activation_publish_race))));
select pg_temp.wait_factory_activation_lock('factory_contender');
select extensions.dblink_send_query('factory_admitter',pg_temp.factory_admission_command(
  '54200000-0007-4000-8000-000000000002','Admission racing publication'));
select pg_temp.wait_factory_activation_lock('factory_admitter');
select extensions.dblink_exec('factory_writer','commit');
select is((select code from extensions.dblink_get_result('factory_contender') as result(code text)),
  'PT409','the waiting publisher gets a stale activation conflict');
select count(*) from extensions.dblink_get_result('factory_contender') as result(code text);
create temp table factory_admission_after_publish as
select * from extensions.dblink_get_result('factory_admitter') as admitted(session_id uuid);
select count(*) from extensions.dblink_get_result('factory_admitter') as admitted(session_id uuid);
select ok((select s.factory_definition_provenance='pinned' and s.factory_definition_revision_id=a.revision_id
    and (input.workspace_id,input.factory_id,input.activation_number,input.definition_revision_id,input.definition_digest)=
        (s.workspace_id,a.factory_id,a.activation_number,a.revision_id,r.canonical_digest)
  from factory_admission_after_publish fixture join public.sessions s on s.id=fixture.session_id
  join public.session_factory_admission_inputs input on input.session_id=s.id
  cross join factory_activation_second winner
  join public.factory_definition_activations a on a.revision_id=winner.revision_id
  join public.factory_definition_revisions r on r.id=a.revision_id),
  'session admission racing a publication waits for and captures its committed activation and exact definition');
select ok((select s.execute_pinned_definition and input.pipeline_id=s.pipeline_id and input.github_repository_id=s.github_repository_id
    and input.github_repository_id = (r.definition_json::jsonb ->> 'repositoryId')::uuid
    and input.model_name=run.model_name and input.model_name = (r.definition_json::jsonb #>> '{agent,model}')
    and input.selected_stage_ids=array['54200000-0004-4000-8000-000000000002','54200000-0004-4000-8000-000000000001']::uuid[]
    and input.execution_policy_revision_id is null and s.execution_policy_revision_id is null
    and run.execution_policy_revision_id is null and s.pinned_delivery_policy_revision_id is null
    and input.original_title='Admission racing publication' and input.original_prompt_md='Immutable original prompt'
    and input.title_sha256=encode(sha256(convert_to('Admission racing publication','UTF8')),'hex')
    and input.prompt_sha256=encode(sha256(convert_to('Immutable original prompt','UTF8')),'hex')
  from factory_admission_after_publish fixture join public.sessions s on s.id=fixture.session_id
  join public.session_factory_admission_inputs input on input.session_id=s.id
  join public.factory_definition_revisions r on r.id=input.definition_revision_id
  join public.agent_runs run on run.session_id=s.id),
  'admission uses the compiled pipeline, repository, stage order, model, and explicit null policies');
select throws_ok($$update public.session_factory_admission_inputs set prompt_sha256=repeat('a',64)
  where session_id=(select session_id from factory_admission_after_publish)$$,
  '23514','Session factory admission inputs are immutable.','admitted inputs cannot be updated in place');
select throws_ok($$delete from public.session_factory_admission_inputs
  where session_id=(select session_id from factory_admission_after_publish)$$,
  '23514','Session factory admission inputs are immutable.','the receipt cannot be deleted while the session exists');
update public.sessions set title='Renamed session',prompt_md='Edited prompt'
  where id=(select session_id from factory_admission_after_publish);
select ok((select input.title_sha256=encode(sha256(convert_to('Admission racing publication','UTF8')),'hex')
  and input.original_title='Admission racing publication' and input.original_prompt_md='Immutable original prompt'
  from factory_admission_after_publish fixture
  join public.session_factory_admission_inputs input using(session_id)),
  'later session edits preserve original title and prompt bytes');
select is((select count(*) from public.factory_definition_revisions r join factory_activation_scope s on s.factory_id=r.factory_id),
  2::bigint,'the losing transaction leaves no orphan revision');

create temp table factory_activation_rollback_race as
select (pg_temp.factory_activation_save(2,pg_temp.factory_activation_bundle('Losing to rollback'))).id as loser_draft;
select throws_ok(pg_temp.factory_activation_command('rollback',2,(select revision_id from factory_activation_first)),
  'PT422','A current passing smoke test is required for the exact factory candidate.','direct rollback also requires fresh evidence');
select pg_temp.seed_factory_smoke('revision',2,revision_id) from factory_activation_first;
commit;
begin;
set local request.jwt.claim.role = 'service_role';

-- A publisher and rollback from the same head also have one winner. A
-- rollback appends an activation but reuses the original immutable revision.
select extensions.dblink_exec('factory_writer','begin');
create temp table factory_activation_third as
select * from extensions.dblink('factory_writer',pg_temp.factory_activation_command('rollback',2,
  (select revision_id from factory_activation_first))) as result(activation_number bigint,revision_id uuid);
select is((select activation_number from factory_activation_third),3::bigint,'rollback appends the next activation');
select extensions.dblink_send_query('factory_contender',format('select pg_temp.factory_activation_sqlstate(%L)',
  pg_temp.factory_activation_command('publish',2,(select loser_draft from factory_activation_rollback_race))));
select pg_temp.wait_factory_activation_lock('factory_contender');
select extensions.dblink_send_query('factory_admitter',pg_temp.factory_admission_command(
  '54200000-0007-4000-8000-000000000003','Admission racing rollback'));
select pg_temp.wait_factory_activation_lock('factory_admitter');
select extensions.dblink_exec('factory_writer','commit');
select is((select code from extensions.dblink_get_result('factory_contender') as result(code text)),
  'PT409','the publisher waiting behind rollback gets a stale activation conflict');
select count(*) from extensions.dblink_get_result('factory_contender') as result(code text);
create temp table factory_admission_after_rollback as
select * from extensions.dblink_get_result('factory_admitter') as admitted(session_id uuid);
select count(*) from extensions.dblink_get_result('factory_admitter') as admitted(session_id uuid);
select is((select a.revision_id from public.factory_definition_activations a join factory_activation_scope s on s.factory_id=a.factory_id
    order by a.activation_number desc limit 1),(select revision_id from factory_activation_first),
  'the highest activation selects the original revision for future admissions');
select is((select s.factory_definition_revision_id from public.sessions s join factory_admission_after_publish fixture on fixture.session_id=s.id),
  (select revision_id from factory_activation_second),'rollback does not change the existing session pin');
select is(pg_temp.admit_factory_session('54200000-0007-4000-8000-000000000002','Admission racing publication'),
  (select session_id from factory_admission_after_publish),'replaying a creation request after rollback returns its original session');
select ok((select (input.activation_number,input.definition_revision_id)=(a.activation_number,a.revision_id)
  from factory_admission_after_rollback fixture join public.session_factory_admission_inputs input using(session_id)
  cross join factory_activation_third a),'admission after rollback captures the new activation number with the original immutable revision');
select ok((select input.activation_number=a.activation_number and input.definition_revision_id=a.revision_id
  from factory_admission_after_publish fixture join public.session_factory_admission_inputs input using(session_id)
  cross join factory_activation_second a),'idempotent creation replay leaves the original admission receipt intact');
select is((select count(*) from public.factory_definition_revisions r join factory_activation_scope s on s.factory_id=r.factory_id),
  2::bigint,'rollback and its losing publisher create no duplicate or orphan revision');
select throws_ok(pg_temp.factory_activation_command('rollback',1,(select revision_id from factory_activation_second)),
  'PT409',null,'a repeated revision ID does not make its first activation token current again');
select throws_ok(pg_temp.factory_activation_command('rollback',3,(select revision_id from factory_activation_second),array['vercel']),
  'PT422',null,'a prior definition cannot re-enable a disabled sandbox provider');

-- GitHub installation changes can hold an installation row while another
-- operation needs workspace access. Activation must release the workspace lock
-- without waiting for the installation transaction to settle.
select extensions.dblink_exec('factory_writer','begin');
select is((select id from extensions.dblink('factory_writer',$q$
  select id from public.github_installations where id='54200000-0005-4000-8000-000000000001' for update
$q$) as locked(id uuid)), '54200000-0005-4000-8000-000000000001'::uuid,
  'the GitHub writer holds the installation row');
select extensions.dblink_exec('factory_contender','set statement_timeout=''3s''');
select is((select code from extensions.dblink('factory_contender',format('select pg_temp.factory_activation_sqlstate(%L)',
  pg_temp.factory_activation_command('rollback',3,(select revision_id from factory_activation_second)))) as result(code text)),
  'PT409','rollback returns a conflict while the GitHub installation is still locked');
select extensions.dblink_exec('factory_writer','rollback');
select extensions.dblink_exec('factory_contender','set statement_timeout=''15s''');
select is((select a.revision_id from public.factory_definition_activations a join factory_activation_scope s on s.factory_id=a.factory_id
    order by a.activation_number desc limit 1),(select revision_id from factory_activation_first),
  'GitHub lock contention leaves the active revision unchanged');

-- An uncommitted credential revocation races activation. The contender must
-- wait, then reject the previously published definition with current state.
select extensions.dblink_exec('factory_writer','begin');
select extensions.dblink_exec('factory_writer',$q$
  delete from public.user_codex_credentials where user_id='54200000-0000-4000-8000-000000000001'
$q$);
select extensions.dblink_send_query('factory_contender',format('select pg_temp.factory_activation_sqlstate(%L)',
  pg_temp.factory_activation_command('rollback',3,(select revision_id from factory_activation_second))));
select pg_temp.wait_factory_activation_lock('factory_contender');
select extensions.dblink_exec('factory_writer','commit');
select is((select code from extensions.dblink_get_result('factory_contender') as result(code text)),
  'PT422','the waiting rollback rechecks the revoked credential');
select count(*) from extensions.dblink_get_result('factory_contender') as result(code text);

insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential) values
  ('54200000-0000-4000-8000-000000000001','platform_api_key','reconnected-activation-test-ciphertext');
select pg_temp.seed_factory_smoke('revision',3,revision_id) from factory_activation_second;
update public.workspace_e2b_sandbox_connections set encrypted_api_key='rotated-activation-test-ciphertext',
  connection_revision=gen_random_uuid() where workspace_id='54200000-0001-4000-8000-000000000001';
select throws_ok(pg_temp.factory_activation_command('rollback',3,(select revision_id from factory_activation_second)),
  'PT422',null,'a rotated sandbox connection invalidates the exact tested capability receipt');
select pg_temp.factory_activation_receipt();
select throws_ok(pg_temp.factory_activation_command('rollback',3,(select revision_id from factory_activation_second)),
  'PT422','A current passing smoke test is required for the exact factory candidate.',
  'the smoke receipt bound to the old connection remains invalid after capabilities are rechecked');
select pg_temp.factory_activation_receipt(false);
select throws_ok(pg_temp.factory_activation_command('rollback',3,(select revision_id from factory_activation_second)),
  'PT422',null,'a newer unsuccessful capability check cannot be bypassed using older receipts');
select pg_temp.factory_activation_receipt();
select id from public.remove_workspace_member('54200000-0002-4000-8000-000000000002','54200000-0001-4000-8000-000000000001');
select throws_ok(pg_temp.factory_activation_command('rollback',3,(select revision_id from factory_activation_second)),
  'PT422',null,'a prior revision cannot restore a removed named approver');
select is((select count(*) from public.factory_definition_activations a join factory_activation_scope s on s.factory_id=a.factory_id),
  3::bigint,'all revoked or unsupported rollback attempts leave the active pointer unchanged');

-- A candidate can exercise a different model and connected sandbox from live
-- settings. Results remain isolated by digest, even for the same runtime tuple.
insert into public.workspace_agent_config(workspace_id,key,value_json) values
  ('54200000-0001-4000-8000-000000000001','agent_provider','"codex"'),
  ('54200000-0001-4000-8000-000000000001','agent_model','"gpt-5"')
on conflict (workspace_id,key) do update set value_json=excluded.value_json;
insert into public.workspace_daytona_sandbox_connections(workspace_id,encrypted_api_key) values
  ('54200000-0001-4000-8000-000000000001','prospective-activation-test-ciphertext');

create temp table factory_activation_candidate_bodies as
select label,jsonb_set(jsonb_set(pg_temp.factory_activation_bundle(label)::jsonb,
  '{sandboxProvider}','"daytona"'),'{agent,model}','"gpt-5.1"')::text as definition_json
from (values ('Checked candidate'), ('Another candidate')) candidates(label);
create temp table factory_activation_candidates as
select body.label,d.id,d.canonical_digest from factory_activation_candidate_bodies body
cross join lateral pg_temp.factory_activation_save(3,body.definition_json) d;

select throws_ok($$select public.start_factory_definition_capability_check(s.workspace_id,
  '54200000-0006-4000-8000-000000000001',s.member_user_id,'daytona','codex','gpt-5.1',d.canonical_digest)
  from factory_activation_scope s cross join factory_activation_candidates d where d.label='Checked candidate'$$,
  '42501',null,'a regular member cannot reserve a prospective capability check');
select throws_ok($$select public.start_factory_definition_capability_check(s.workspace_id,
  '54200000-0006-4000-8000-000000000001',s.owner_id,'daytona','codex','gpt-5.2',d.canonical_digest)
  from factory_activation_scope s cross join factory_activation_candidates d where d.label='Checked candidate'$$,
  'P0002',null,'an available digest cannot reserve a check for a different runtime');

create temp table factory_activation_candidate_check as
select c.* from factory_activation_scope s cross join factory_activation_candidates d
cross join lateral public.start_factory_definition_capability_check(s.workspace_id,
  '54200000-0006-4000-8000-000000000001',s.owner_id,'daytona','codex','gpt-5.1',d.canonical_digest) c
where d.label='Checked candidate';
select ok((select c.status='running' and c.factory_definition_digest=d.canonical_digest
   and c.sandbox_provider='daytona' and c.agent_provider='codex' and c.agent_model='gpt-5.1'
   and c.sandbox_connection_revision=b.connection_revision
  from factory_activation_candidate_check c join public.workspace_daytona_sandbox_connections b using(workspace_id)
  cross join factory_activation_candidates d where d.label='Checked candidate'),
  'the reservation records the exact candidate digest and connected prospective runtime');
update public.sandbox_capability_checks set status='success',capabilities=(
  select jsonb_object_agg(probe,jsonb_build_object('ok',true,'detail',null))
  from unnest(pg_temp.factory_activation_probes()) as probe
) where id=(select id from factory_activation_candidate_check);
select throws_ok(pg_temp.factory_activation_command('publish',3,
  (select id from factory_activation_candidates where label='Another candidate'),array['e2b','daytona']),
  'PT422',null,'an exact runtime result from another digest cannot qualify the candidate');
select is((select (public.load_workspace_onboarding_sandbox_checks(s.workspace_id)->0->>'id')::uuid
    from factory_activation_scope s),
  (select c.id from public.sandbox_capability_checks c join factory_activation_scope s using(workspace_id)
    where c.factory_definition_digest is null order by c.checked_at desc,c.id desc limit 1),
  'the onboarding check list still selects the current live receipt');

create temp table factory_activation_live_candidate as
select id from pg_temp.factory_activation_save(3,pg_temp.factory_activation_bundle('Live-compatible candidate'));
select pg_temp.seed_factory_smoke('draft',3,id) from factory_activation_live_candidate;
select is((select a.activation_number from factory_activation_scope s cross join factory_activation_live_candidate d
  cross join lateral public.publish_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,3,d.id,
    array['e2b'],pg_temp.factory_activation_probes()) a),
  4::bigint,'a newer prospective check does not mask the current live capability check');

create temp table factory_activation_rebased_candidates as
select body.label,d.id,d.canonical_digest from factory_activation_candidate_bodies body
cross join lateral pg_temp.factory_activation_save(4,body.definition_json) d;
select c.id from factory_activation_scope s cross join factory_activation_rebased_candidates d
cross join lateral public.start_factory_definition_capability_check(s.workspace_id,
  '54200000-0006-4000-8000-000000000001',s.owner_id,'daytona','codex','gpt-5.1',d.canonical_digest) c
where d.label='Another candidate';
update public.sandbox_capability_checks set status='error',error_text='Other candidate failed'
where factory_definition_digest=(select canonical_digest from factory_activation_rebased_candidates where label='Another candidate');
select pg_temp.seed_factory_smoke('draft',4,id,array['e2b','daytona']) from factory_activation_rebased_candidates where label='Checked candidate';
select is((select a.activation_number from factory_activation_scope s cross join factory_activation_rebased_candidates d
  cross join lateral public.publish_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,4,d.id,
    array['e2b','daytona'],pg_temp.factory_activation_probes()) a where d.label='Checked candidate'),
  5::bigint,'the exact candidate capability check permits activation despite a newer unrelated failure');
select ok((select s.active_provider='e2b' and a.value_json='"gpt-5"'::jsonb from public.workspace_sandbox_settings s
  join public.workspace_agent_config a using(workspace_id)
  where s.workspace_id='54200000-0001-4000-8000-000000000001' and a.key='agent_model'),
  'activating the prospective runtime does not change live sandbox or model settings');

create temp table factory_activation_reordered as
select saved.id from (select pg_temp.factory_activation_bundle('Reordered stages')::jsonb as body) draft
cross join lateral pg_temp.factory_activation_save(5, jsonb_set(draft.body,'{stages}',
  jsonb_build_array(draft.body #> '{stages,1}',draft.body #> '{stages,0}'))::text) saved;
select pg_temp.seed_factory_smoke('draft',5,id) from factory_activation_reordered;
select is((select a.activation_number from factory_activation_scope s cross join factory_activation_reordered d
  cross join lateral public.publish_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,5,d.id,
    array['e2b'],pg_temp.factory_activation_probes()) a),6::bigint,'a revision can publish a new stage order');
select throws_ok(pg_temp.factory_admission_command('54200000-0007-4000-8000-000000000009','Stale stage order'),
  'P0003','The active factory no longer matches the requested session options.','fresh admission detects a reordered compiled stage selection');
select is(pg_temp.admit_factory_session('54200000-0007-4000-8000-000000000002','Admission racing publication'),
  (select session_id from factory_admission_after_publish),'a committed creation replays even when its confirmed stage order has changed');

-- Settings stages and policies belong to the candidate until its guarded publication.
create temp table factory_settings_fixture as
select '54200000-0004-4000-8000-000000000003'::uuid as stage_id, gen_random_uuid() as execution_id,
  gen_random_uuid() as delivery_id,
  '{"version":1,"maxRepairAttempts":1,"maxExecutionMs":600000,"maxTotalTokens":null,"maxCostUsd":null}'::jsonb as execution_requirements,
  '{"version":1,"deliveryMode":"analysis","requireCodeOwnerReview":false,"requireResolvedThreads":false,
    "requireArtifactApprovalForDelivery":false,"minimumApprovals":0,"freshnessSeconds":600,
    "requiredChecks":[],"requiredEvidence":[]}'::jsonb as delivery_requirements;
create temp table factory_settings_legacy as
select e.current_revision_id as execution_id, e.revision as execution_revision,
  d.id as delivery_id, d.revision as delivery_revision
from factory_activation_scope s join public.execution_policies e using (workspace_id)
cross join factory_settings_fixture fixture
cross join lateral public.save_delivery_policy(s.workspace_id,'54200000-0003-4000-8000-000000000001',
  s.owner_id,0,fixture.delivery_requirements) d;

create function pg_temp.save_factory_settings(p_name text, p_expected_draft_id uuid default null)
returns public.factory_definition_drafts language sql as $$
  select public.save_settings_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,6,
    candidate.bytes,encode(sha256(convert_to(candidate.bytes,'UTF8')),'hex'),
    jsonb_build_object('pipelineName',p_name,'newStageIds',jsonb_build_array(fixture.stage_id),
      'executionPolicy',jsonb_build_object('id',fixture.execution_id,'requirements',fixture.execution_requirements),
      'deliveryPolicy',jsonb_build_object('id',fixture.delivery_id,'requirements',fixture.delivery_requirements)),
    p_expected_draft_id)
  from factory_activation_scope s cross join factory_settings_fixture fixture
  cross join lateral (select jsonb_set(jsonb_set(
    pg_temp.factory_activation_bundle(p_name,p_execution_policy => fixture.execution_id)::jsonb,
    '{deliveryPolicyRevisionId}',to_jsonb(fixture.delivery_id)),'{stages,0,id}',to_jsonb(fixture.stage_id))::text as bytes) candidate;
$$;
create function pg_temp.publish_factory_settings(p_draft_id uuid, p_providers text[] default array['e2b'])
returns public.factory_definition_activations language sql as $$
  select public.publish_settings_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,6,
    p_draft_id,p_providers,pg_temp.factory_activation_probes()) from factory_activation_scope s;
$$;

select ok(bool_and(has_function_privilege('service_role',signature,'EXECUTE')
  and not has_function_privilege('anon',signature,'EXECUTE')
  and not has_function_privilege('authenticated',signature,'EXECUTE')),
  'only a service caller can invoke the Settings draft mutation RPCs')
from (values ('public.save_settings_factory_definition_draft(uuid,uuid,uuid,bigint,text,text,jsonb,uuid)'),
  ('public.publish_settings_factory_definition_draft(uuid,uuid,uuid,bigint,uuid,text[],text[])')) commands(signature);
create temp table factory_settings_first as select * from pg_temp.save_factory_settings('First Settings draft');
select throws_ok($$select pg_temp.save_factory_settings('Stale editor')$$,
  'PT409','The factory draft changed. Reload before saving.','a stale editor cannot append over a newer shared draft');
create temp table factory_settings_latest as
select * from pg_temp.save_factory_settings('Latest Settings draft',(select id from factory_settings_first));
select throws_ok($$select pg_temp.publish_factory_settings((select id from factory_settings_first))$$,
  'PT409','The factory draft changed. Reload before publishing.','only the latest shared draft can be published from Settings');
select throws_ok($$select pg_temp.publish_factory_settings((select id from factory_settings_latest),array['daytona'])$$,
  'PT422',null,'the latest Settings draft still requires the canonical publication checks');

update public.workspace_members set is_active = true where id='54200000-0002-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '54200000-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_definition_drafts
  where workspace_id='54200000-0001-4000-8000-000000000001' and settings_metadata ? 'newStageIds'),
  0::bigint,'a workspace member cannot read the candidate settings');
select is((select count(*) from public.factory_definition_smoke_tests
  where workspace_id='54200000-0001-4000-8000-000000000001'),
  0::bigint,'a workspace member cannot read candidate smoke evidence');
set local request.jwt.claim.sub = '54200000-0000-4000-8000-000000000001';
select is((select count(*) from public.factory_definition_drafts
  where workspace_id='54200000-0001-4000-8000-000000000001' and settings_metadata ? 'newStageIds'),
  2::bigint,'a workspace manager can read the saved candidate settings');
select ok((select count(*) > 0 from public.factory_definition_smoke_tests
  where workspace_id='54200000-0001-4000-8000-000000000001'),
  'a workspace manager can read candidate smoke evidence');
reset role;
set local request.jwt.claim.role = 'service_role';

select ok((select not exists (select 1 from public.pipeline_stages s where s.id=fixture.stage_id)
    and not exists (select 1 from public.execution_policy_revisions r where r.id=fixture.execution_id)
    and not exists (select 1 from public.delivery_policy_revisions r where r.id=fixture.delivery_id)
    and (select name from public.pipelines where id='54200000-0003-4000-8000-000000000001')='Factory pipeline'
  from factory_settings_fixture fixture), 'save and failed publish leave no live stage, policy, or name changes');
select ok(pg_temp.seed_factory_smoke('draft',6,(select id from factory_settings_latest)),
  'candidate smoke accepts privately reserved stages and policy revisions');
select ok((select not exists (select 1 from public.pipeline_stages s where s.id=fixture.stage_id)
    and not exists (select 1 from public.execution_policy_revisions r where r.id=fixture.execution_id)
    and not exists (select 1 from public.delivery_policy_revisions r where r.id=fixture.delivery_id)
  from factory_settings_fixture fixture), 'smoke does not materialize any private candidate records');
create temp table factory_settings_published as
select * from pg_temp.publish_factory_settings((select id from factory_settings_latest));
select ok((select a.activation_number=7 and r.source_draft_id=d.id and r.definition_json=d.definition_json
  from factory_settings_published a join public.factory_definition_revisions r on r.id=a.revision_id
  cross join factory_settings_latest d), 'the successful publication activates the exact latest draft');
select ok((select stage.archived_at is not null and stage.prompt_template_md=''
    and execution.requirements=fixture.execution_requirements and delivery.requirements=fixture.delivery_requirements
  from factory_settings_fixture fixture join public.pipeline_stages stage on stage.id=fixture.stage_id
  join public.execution_policy_revisions execution on execution.id=fixture.execution_id
  join public.delivery_policy_revisions delivery on delivery.id=fixture.delivery_id),
  'the publication materializes an archived stage anchor and the exact candidate policies');
select is((select name from public.pipelines where id='54200000-0003-4000-8000-000000000001'),
  'Latest Settings draft','the pipeline name appears only after successful publication');
select ok((select e.current_revision_id=legacy.execution_id and d.current_revision_id=legacy.delivery_id
  from factory_activation_scope s join public.execution_policies e using(workspace_id)
  join public.delivery_policies d using(workspace_id) cross join factory_settings_legacy legacy),
  'a factory publication preserves the execution and delivery pointers used by legacy sessions');
select is((select (public.save_execution_policy(s.workspace_id,s.owner_id,legacy.execution_revision,
    fixture.execution_requirements)).revision
  from factory_activation_scope s cross join factory_settings_legacy legacy cross join factory_settings_fixture fixture),
  (select execution_revision+2 from factory_settings_legacy),'an immediate execution policy save advances over factory history');
select is((select (public.save_delivery_policy(s.workspace_id,'54200000-0003-4000-8000-000000000001',
    s.owner_id,legacy.delivery_revision,fixture.delivery_requirements)).revision
  from factory_activation_scope s cross join factory_settings_legacy legacy cross join factory_settings_fixture fixture),
  (select delivery_revision+2 from factory_settings_legacy),'an immediate delivery policy save advances over factory history');

select extensions.dblink_disconnect('factory_writer');
select extensions.dblink_disconnect('factory_contender');
select extensions.dblink_disconnect('factory_admitter');
delete from public.workspaces where id in ('54200000-0001-4000-8000-000000000001','54200000-0001-4000-8000-000000000002');
delete from auth.users where id in ('54200000-0000-4000-8000-000000000001','54200000-0000-4000-8000-000000000002');
select * from finish();
commit;
