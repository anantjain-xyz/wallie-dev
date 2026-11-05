begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

-- Independent committed fixtures isolate workspace deletion from shared seed
-- jobs, Storage objects and every other suite's outstanding operations.
insert into public.workspaces(id,name,slug) values
  ('498c0000-0000-4000-8000-000000000001','Canonical PR race fixture','canonical-pr-race-fixture');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  ('498c0000-0000-4000-8000-000000000002','498c0000-0000-4000-8000-000000000001',
    'a1b2c3d4-0001-4000-8000-000000000001','human','owner');
insert into public.pipelines(id,workspace_id,name) values
  ('498c0000-0000-4000-8000-000000000003','498c0000-0000-4000-8000-000000000001','Canonical race pipeline');
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md) values
  ('498c0000-0000-4000-8000-000000000004','498c0000-0000-4000-8000-000000000003',
    '498c0000-0000-4000-8000-000000000001',1,'plan','Plan','Produce canonical source');
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions) values
  ('498c0000-0000-4000-8000-000000000005','498c0000-0000-4000-8000-000000000001',9900498001,
    'https://github.com/settings/installations/9900498001',1,'Organization','wallie-fixtures','{}');
insert into public.github_repositories(id,workspace_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch) values
  ('498c0000-0000-4000-8000-000000000006','498c0000-0000-4000-8000-000000000001',
    '498c0000-0000-4000-8000-000000000005',9900498002,'canonical-races','wallie-fixtures/canonical-races',true,
    'https://github.com/wallie-fixtures/canonical-races','main');
create temp table canonical_race_context(label text primary key,session_id uuid,operation_id uuid,claim_id uuid,observation_id uuid);
do $$
declare case_label text; created record; started uuid; source_claim uuid; retained text; claim uuid; operation public.session_pr_operations;
begin
  foreach case_label in array array['observation','admission','deletion'] loop
    select * into strict created from public.create_session_with_first_job(
      '498c0000-0000-4000-8000-000000000001','498c0000-0000-4000-8000-000000000002',
      'Canonical PR race '||case_label,'Synchronize accepted code','codex','gpt-5.5',null,null,
      '498c0000-0000-4000-8000-000000000006','498c0000-0000-4000-8000-000000000003',
      array['498c0000-0000-4000-8000-000000000004'::uuid]);
    update public.agent_jobs set status='running',attempt_count=1 where id=created.job_id;
    started:=public.start_session_job_attempt(created.job_id,1,'498c0000-0000-4000-8000-000000000004',0,
      'codex','gpt-5.5','project','wallie/canonical-race-'||created.job_id::text);
    perform public.pin_session_job_git_input(created.job_id,1,started,
      '498c0000-0000-4000-8000-000000000006','main',repeat('a',40));
    if not public.prepare_session_source_and_checkpoint_publication(started,
      '498c0000-0000-4000-8000-000000000006','main',repeat('a',40),repeat('b',40),'Canonical race checkpoint','PR body','',
      encode(extensions.digest('canonical race source'::bytea,'sha256'),'hex'),encode('canonical race source'::bytea,'base64'),
      0,'Canonical race accepted artifact') then raise exception 'Race checkpoint preparation failed'; end if;
    source_claim:=public.claim_session_checkpoint_publication(started);
    select retained_ref into strict retained from public.session_checkpoint_publications where run_id=started;
    if source_claim is null or not public.adopt_session_checkpoint_publication(started,source_claim,retained,repeat('b',40)) then
      raise exception 'Race checkpoint adoption failed';
    end if;
    insert into canonical_race_context(label,session_id) values(case_label,created.session_id);
    if case_label='observation' then
      claim:=public.claim_session_pr_sync(created.session_id);
      select * into strict operation from public.session_pr_operations where claim_id=claim;
      update canonical_race_context set operation_id=operation.id,claim_id=claim,
        observation_id=public.begin_session_pr_sync_observation(operation.id,claim,4901,
          'https://github.com/wallie-fixtures/canonical-races/pull/4901') where canonical_race_context.label=case_label;
    end if;
  end loop;
end;
$$;
commit;
begin;

create function pg_temp.wait_canonical_lock(target_application text) returns void language plpgsql as $$
declare deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
  while not exists(select 1 from pg_catalog.pg_stat_activity where application_name=target_application and wait_event_type='Lock') loop
    if clock_timestamp()>deadline then raise exception 'Expected canonical lock not reached by %',target_application; end if;
    perform pg_catalog.pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_connect('canonical_owner',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_connect('canonical_contender',coalesce(nullif(current_setting('wallie.test_db_connection',true),''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('canonical_owner','set application_name=''canonical_owner''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');
select extensions.dblink_exec('canonical_contender','set application_name=''canonical_contender''; set statement_timeout=''15s''; set request.jwt.claim.role=''service_role''');

-- The webhook owns session -> sync -> epoch, commits a newer causal read, and
-- clears its token before the older publisher can acquire the session lock.
select extensions.dblink_exec('canonical_owner','begin');
create temp table fresh_webhook as select * from extensions.dblink('canonical_owner',$q$
  select public.begin_session_pr_observation('498c0000-0000-4000-8000-000000000001',
    '498c0000-0000-4000-8000-000000000006',epoch.branch_name,4901)
  from public.session_pr_epochs epoch join public.sessions s on s.id=epoch.session_id
  where s.workspace_id='498c0000-0000-4000-8000-000000000001' and s.title='Canonical PR race observation'
$q$) as result(observation_id uuid);
select is((select applied from extensions.dblink('canonical_owner',format($q$
  select public.finish_session_pr_observation(%L::uuid,'https://github.com/wallie-fixtures/canonical-races/pull/4901',
    'open',true,repeat('e',40),'2026-11-05T20:00:00Z')
$q$,(select observation_id from fresh_webhook))) as result(applied boolean)),true,
  'webhook commits its own newer admitted PR head read while retaining lifecycle locks');
select extensions.dblink_send_query('canonical_contender',format($q$
  select public.finish_session_pr_sync(operation.id,operation.claim_id,operation.desired_sha,operation.desired_fence_sha,
    4901,'https://github.com/wallie-fixtures/canonical-races/pull/4901','open',true,operation.desired_sha,
    '2026-11-05T20:00:00Z',%L::uuid)
  from public.session_pr_operations operation join public.sessions s on s.id=operation.session_id
  where s.workspace_id='498c0000-0000-4000-8000-000000000001' and s.title='Canonical PR race observation'
$q$,(select observation_id from canonical_race_context where label='observation')));
select pg_temp.wait_canonical_lock('canonical_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='canonical_contender' and wait_event_type='Lock'),
  'older publisher actually waits behind the webhook session lock');
select extensions.dblink_exec('canonical_owner','commit');
select is((select applied from extensions.dblink_get_result('canonical_contender') as result(applied boolean)),false,
  'older publisher cannot receipt after a newer equal-time observation completed and cleared its token');
select count(*) from extensions.dblink_get_result('canonical_contender') as result(applied boolean);
select ok((select sync.status='pending' and sync.observed_pr_head_sha=repeat('e',40)
  and epoch.pr_head_sha=repeat('e',40) and epoch.observation_id is null
  and epoch.pr_updated_at='2026-11-05T20:00:00Z' and epoch.acknowledged_head_sha is null
  and operation.receipted_at is null and operation.status='claimed'
  from canonical_race_context fixture join public.session_pr_sync sync on sync.session_id=fixture.session_id
  join public.session_pr_epochs epoch on epoch.id=sync.current_epoch_id
  join public.session_pr_operations operation on operation.id=fixture.operation_id where fixture.label='observation'),
  'stale completion preserves newer PR head, unacknowledged refs, and unsynchronized state');
select is((select public.fail_session_pr_sync(operation_id,claim_id,'pr_api_failed') from canonical_race_context where label='observation'),true,
  'losing publisher can release its claim without discarding the newer PR observation');
commit;
begin;

-- Deletion admission owns the workspace UPDATE first. A canonical claimant
-- must SKIP before taking any session lock, even though its transaction stays open.
select extensions.dblink_exec('canonical_owner','begin');
select extensions.dblink_exec('canonical_owner',$q$
  update public.workspaces set deletion_requested_at=clock_timestamp() where id='498c0000-0000-4000-8000-000000000001'
$q$);
select extensions.dblink_exec('canonical_contender','begin');
select is((select claim_id from extensions.dblink('canonical_contender',$q$
  select public.claim_session_pr_sync(id) from public.sessions
    where workspace_id='498c0000-0000-4000-8000-000000000001' and title='Canonical PR race admission'
$q$) as result(claim_id uuid)),null::uuid,'claim skips workspace admission held by concurrent deletion');
select is((select id from extensions.dblink('canonical_owner',$q$
  select id from public.sessions where workspace_id='498c0000-0000-4000-8000-000000000001'
    and title='Canonical PR race admission' for no key update nowait
$q$) as result(id uuid)),(select session_id from canonical_race_context where label='admission'),
  'skipped claimant holds no session lock that could invert workspace deletion ordering');
select ok(not exists(select 1 from public.session_pr_epochs where session_id=(select session_id from canonical_race_context where label='admission')),
  'workspace-first skip creates neither an epoch nor a remote operation');
select extensions.dblink_exec('canonical_contender','rollback');
select extensions.dblink_exec('canonical_owner','rollback');

-- Claim admission wins first. Deletion must wait on workspace SHARE, then its
-- cleanup must observe the committed canonical lease rather than deleting it.
select ok(not exists(select 1 from public.agent_jobs where workspace_id='498c0000-0000-4000-8000-000000000001'
  and status in ('queued','started','running'))
  and not exists(select 1 from public.agent_runs where workspace_id='498c0000-0000-4000-8000-000000000001'
    and status in ('queued','started','running'))
  and not exists(select 1 from public.workspace_resource_operations where workspace_id='498c0000-0000-4000-8000-000000000001')
  and not exists(select 1 from public.workspace_sandbox_connection_mutations where workspace_id='498c0000-0000-4000-8000-000000000001')
  and not exists(select 1 from public.session_source_deliveries where workspace_id='498c0000-0000-4000-8000-000000000001' and status='claimed')
  and not exists(select 1 from storage.objects where split_part(name,'/',1)='498c0000-0000-4000-8000-000000000001'),
  'isolated workspace has no legacy execution, sandbox, source lease, or Storage cleanup blocker');
select extensions.dblink_exec('canonical_owner','begin');
create temp table deletion_race_claim as select * from extensions.dblink('canonical_owner',$q$
  select public.claim_session_pr_sync(id) from public.sessions
    where workspace_id='498c0000-0000-4000-8000-000000000001' and title='Canonical PR race deletion'
$q$) as result(claim_id uuid);
select ok((select claim_id is not null from deletion_race_claim),'canonical publisher owns workspace SHARE before deletion begins');
select extensions.dblink_exec('canonical_contender','begin');
select extensions.dblink_send_query('canonical_contender',$q$
  select public.begin_workspace_deletion('498c0000-0000-4000-8000-000000000001',
    '498c0000-0000-4000-8000-000000000002','Canonical PR race fixture')
$q$);
select pg_temp.wait_canonical_lock('canonical_contender');
select ok(exists(select 1 from pg_catalog.pg_stat_activity where application_name='canonical_contender' and wait_event_type='Lock'),
  'workspace deletion actually waits behind canonical claim admission');
select extensions.dblink_exec('canonical_owner','commit');
select ok((select requested_at is not null from extensions.dblink_get_result('canonical_contender') as result(requested_at timestamptz)),
  'deletion request proceeds after the publisher commits its durable lease');
select count(*) from extensions.dblink_get_result('canonical_contender') as result(requested_at timestamptz);
select is((select finished from extensions.dblink('canonical_contender',$q$
  select public.finish_workspace_deletion('498c0000-0000-4000-8000-000000000001')
$q$) as result(finished boolean)),false,'workspace cleanup refuses the committed live canonical publisher lease');
select ok((select count(*)=1 from public.session_pr_operations where workspace_id='498c0000-0000-4000-8000-000000000001'
  and status='claimed' and lease_expires_at>clock_timestamp() and claim_id=(select claim_id from deletion_race_claim)),
  'the sole live operation remains recoverable after racing workspace deletion');
select extensions.dblink_exec('canonical_contender','rollback');
select extensions.dblink_disconnect('canonical_owner');
select extensions.dblink_disconnect('canonical_contender');
select * from finish();
delete from public.workspaces where id='498c0000-0000-4000-8000-000000000001';
commit;
