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
  ('54200000-0000-4000-8000-000000000001','platform_api_key','activation-test-ciphertext');
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

create function pg_temp.factory_activation_bundle(p_name text,p_approver uuid default null)
returns text language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion',1,'kind','serial','sandboxProvider','e2b',
    'pipelineId','54200000-0003-4000-8000-000000000001',
    'repositoryId','54200000-0006-4000-8000-000000000001',
    'executionPolicyRevisionId',null,'deliveryPolicyRevisionId',null,
    'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
    'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5','effort',null,
      'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
    'stages',jsonb_build_array(jsonb_build_object('id','54200000-0004-4000-8000-000000000001',
      'slug','verify-delivery','name',p_name,'description','','promptTemplateMd','Check {{session.title}}.',
      'anyoneCanApprove',false,'previousStageIds','[]'::jsonb,'approverMemberIds',
      case when p_approver is null then '[]'::jsonb else jsonb_build_array(p_approver) end))
  )::text;
$$;

create function pg_temp.factory_activation_save(p_base bigint,p_definition text)
returns public.factory_definition_drafts language sql as $$
  select public.save_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,p_base,
    p_definition,encode(sha256(convert_to(p_definition,'UTF8')),'hex')) from factory_activation_scope s;
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

create function pg_temp.factory_admission_command(p_request_id uuid, p_title text)
returns text language sql as $$
  select format($q$select session_id from public.create_session_once_with_first_job(
    '54200000-0001-4000-8000-000000000001', '54200000-0002-4000-8000-000000000001',
    %L::uuid, repeat('d',64), %L, '  Immutable original prompt  ', 'codex','gpt-5.1', '{}'::uuid[],
    session_github_repository_id => '54200000-0006-4000-8000-000000000002',
    selected_stage_ids => array['54200000-0004-4000-8000-000000000002','54200000-0004-4000-8000-000000000001']::uuid[]
  )$q$, p_request_id, '  ' || p_title || '  ');
$$;

create function pg_temp.admit_factory_session(p_request_id uuid, p_title text)
returns uuid language plpgsql as $$
declare admitted_session_id uuid;
begin
  execute pg_temp.factory_admission_command(p_request_id, p_title) into strict admitted_session_id;
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

create temp table factory_activation_initial as
select * from pg_temp.factory_activation_save(0,pg_temp.factory_activation_bundle('Initial'));
select ok((select base_activation_number is null and definition_json=pg_temp.factory_activation_bundle('Initial')
  from factory_activation_initial), 'an initial draft stores exact bytes and no predecessor');
select is((select count(*) from public.factory_definition_activations a join factory_activation_scope s on s.factory_id=a.factory_id),
  0::bigint,'saving a draft has no activation side effect');

create temp table factory_admission_legacy as
select pg_temp.admit_factory_session('54200000-0007-4000-8000-000000000001','Before enrollment') as session_id;
select ok((select s.factory_definition_provenance='legacy' and s.factory_definition_revision_id is null
  and input.session_id is null from factory_admission_legacy fixture
  join public.sessions s on s.id=fixture.session_id
  left join public.session_factory_admission_inputs input on input.session_id=s.id),
  'normal creation before activation makes an explicit legacy session without an admission receipt');

create temp table factory_activation_first as
select a.* from factory_activation_scope s cross join factory_activation_initial d
cross join lateral public.publish_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,0,d.id,
  array['e2b'],pg_temp.factory_activation_probes()) a;
select is((select activation_number from factory_activation_first),1::bigint,'publishing creates the first activation');
select ok((select r.source_draft_id=d.id and r.definition_json=d.definition_json and r.canonical_digest=d.canonical_digest
  from factory_activation_first a join public.factory_definition_revisions r on r.id=a.revision_id
  cross join factory_activation_initial d),'publish copies the selected immutable draft byte for byte');
select is(pg_temp.admit_factory_session('54200000-0007-4000-8000-000000000001','Before enrollment'),
  (select session_id from factory_admission_legacy), 'creation replay after first publication returns the pre-enrollment session');
select ok((select s.factory_definition_provenance='legacy' and s.factory_definition_revision_id is null
  and input.session_id is null from factory_admission_legacy fixture
  join public.sessions s on s.id=fixture.session_id
  left join public.session_factory_admission_inputs input on input.session_id=s.id),
  'publication and replay do not backfill a historical pin or receipt');

create temp table factory_admission_first as
select session_id from public.create_session_with_first_job(
  '54200000-0001-4000-8000-000000000001', '54200000-0002-4000-8000-000000000001',
  'Unwrapped session creation', 'Original input', 'codex', 'gpt-5'
);
select ok((select s.factory_definition_provenance='pinned' and s.factory_definition_revision_id=a.revision_id
  and input.activation_number=a.activation_number and input.definition_revision_id=a.revision_id
  from factory_admission_first fixture join public.sessions s on s.id=fixture.session_id
  join public.session_factory_admission_inputs input on input.session_id=s.id
  cross join factory_activation_first a), 'creation without the attachment or idempotency wrapper also admits the active definition');
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
select ok((select input.pipeline_id=s.pipeline_id and input.github_repository_id=s.github_repository_id
    and input.github_repository_id <> (r.definition_json::jsonb ->> 'repositoryId')::uuid
    and input.model_name=run.model_name and input.model_name <> (r.definition_json::jsonb #>> '{agent,model}')
    and input.selected_stage_ids=array['54200000-0004-4000-8000-000000000001','54200000-0004-4000-8000-000000000002']::uuid[]
    and (input.execution_policy_revision_id is not distinct from s.execution_policy_revision_id)
    and input.title_sha256=encode(sha256(convert_to('Admission racing publication','UTF8')),'hex')
    and input.prompt_sha256=encode(sha256(convert_to('Immutable original prompt','UTF8')),'hex')
  from factory_admission_after_publish fixture join public.sessions s on s.id=fixture.session_id
  join public.session_factory_admission_inputs input on input.session_id=s.id
  join public.factory_definition_revisions r on r.id=input.definition_revision_id
  join public.agent_runs run on run.session_id=s.id),
  'admission records the actual selected pipeline, repository, stages, model, policy and normalized text digests');
select throws_ok($$update public.session_factory_admission_inputs set prompt_sha256=repeat('a',64)
  where session_id=(select session_id from factory_admission_after_publish)$$,
  '23514','Session factory admission inputs are immutable.','admitted inputs cannot be updated in place');
select throws_ok($$delete from public.session_factory_admission_inputs
  where session_id=(select session_id from factory_admission_after_publish)$$,
  '23514','Session factory admission inputs are immutable.','the receipt cannot be deleted while the session exists');
update public.sessions set title='Renamed session'
  where id=(select session_id from factory_admission_after_publish);
select is((select input.title_sha256 from factory_admission_after_publish fixture
  join public.session_factory_admission_inputs input using(session_id)),
  encode(sha256(convert_to('Admission racing publication','UTF8')),'hex'),
  'renaming the session preserves its original admission title digest');
select is((select count(*) from public.factory_definition_revisions r join factory_activation_scope s on s.factory_id=r.factory_id),
  2::bigint,'the losing transaction leaves no orphan revision');

create temp table factory_activation_rollback_race as
select (pg_temp.factory_activation_save(2,pg_temp.factory_activation_bundle('Losing to rollback'))).id as loser_draft;
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
update public.workspace_e2b_sandbox_connections set encrypted_api_key='rotated-activation-test-ciphertext',
  connection_revision=gen_random_uuid() where workspace_id='54200000-0001-4000-8000-000000000001';
select throws_ok(pg_temp.factory_activation_command('rollback',3,(select revision_id from factory_activation_second)),
  'PT422',null,'a rotated sandbox connection invalidates the exact tested capability receipt');
select pg_temp.factory_activation_receipt();
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
select is((select a.activation_number from factory_activation_scope s cross join factory_activation_rebased_candidates d
  cross join lateral public.publish_factory_definition_draft(s.workspace_id,s.factory_id,s.owner_id,4,d.id,
    array['e2b','daytona'],pg_temp.factory_activation_probes()) a where d.label='Checked candidate'),
  5::bigint,'the exact candidate capability check permits activation despite a newer unrelated failure');
select ok((select s.active_provider='e2b' and a.value_json='"gpt-5"'::jsonb from public.workspace_sandbox_settings s
  join public.workspace_agent_config a using(workspace_id)
  where s.workspace_id='54200000-0001-4000-8000-000000000001' and a.key='agent_model'),
  'activating the prospective runtime does not change live sandbox or model settings');

select extensions.dblink_disconnect('factory_writer');
select extensions.dblink_disconnect('factory_contender');
select extensions.dblink_disconnect('factory_admitter');
delete from public.workspaces where id in ('54200000-0001-4000-8000-000000000001','54200000-0001-4000-8000-000000000002');
delete from auth.users where id in ('54200000-0000-4000-8000-000000000001','54200000-0000-4000-8000-000000000002');
select * from finish();
commit;
