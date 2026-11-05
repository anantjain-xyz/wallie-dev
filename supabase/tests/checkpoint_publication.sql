begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local "request.jwt.claim.role"='service_role';
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0) from public.sessions
where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);

create function pg_temp.publication_fixture(label text,head_sha text default repeat('b',40),prepare_source boolean default true)
returns uuid language plpgsql as $$
declare f record;
begin
  select * into f from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Publish durable exact code','codex','gpt-5.5',null,null,null,null);
  update public.sessions set github_repository_id='12b2c3d4-0001-4000-8000-000000000001' where id=f.session_id;
  update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), status='running',attempt_count=1 where id=f.job_id;
  perform public.start_session_job_attempt(f.job_id,1,(select current_stage_id from public.sessions where id=f.session_id),
    0,'codex','gpt-5.5','project','wallie/publication-'||f.run_id::text);
  perform public.pin_session_job_git_input(f.job_id,1,f.run_id,'12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40));
  if prepare_source then
  perform public.prepare_session_source_delivery(f.run_id,'12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40),head_sha,
    label,'Truncated PR body','',case when head_sha<>repeat('a',40) then encode(extensions.digest('private checkpoint'::bytea,'sha256'),'hex') else '' end,
    case when head_sha<>repeat('a',40) then encode('private checkpoint'::bytea,'base64') else '' end);
  end if;
  return f.run_id;
end;
$$;
create temp table publication_fixtures(label text primary key,run_id uuid,claim_id uuid);
insert into publication_fixtures(label,run_id) values('atomic',pg_temp.publication_fixture('Atomic preparation',repeat('b',40),false));
update public.agent_runs set source_recovery_required=true where id=(select run_id from publication_fixtures where label='atomic');
select throws_ok($$select public.prepare_session_source_and_checkpoint_publication(
  (select run_id from publication_fixtures where label='atomic'),'12b2c3d4-0001-4000-8000-000000000001',
  'main',repeat('a',40),repeat('b',40),'Atomic preparation','PR body','',
  encode(extensions.digest('private checkpoint'::bytea,'sha256'),'hex'),encode('private checkpoint'::bytea,'base64'),
  99,'Complete artifact',null,1234,567)$$,'23514','Checkpoint publication intent could not be prepared.',
  'refused publication intent rolls back source preparation in the same transaction');
select ok((select source_recovery_required from public.agent_runs where id=(select run_id from publication_fixtures where label='atomic'))
  and not exists(select 1 from public.session_source_deliveries where run_id=(select run_id from publication_fixtures where label='atomic'))
  and not exists(select 1 from public.session_checkpoint_publications where run_id=(select run_id from publication_fixtures where label='atomic')),
  'failed combined preparation preserves recovery requirement and leaves neither half of the obligation');
select ok((select input_tokens is null and output_tokens is null from public.agent_runs
  where id=(select run_id from publication_fixtures where label='atomic')),
  'refused atomic preparation does not persist token usage independently of its intent');
select is(public.prepare_session_source_and_checkpoint_publication(
  (select run_id from publication_fixtures where label='atomic'),'12b2c3d4-0001-4000-8000-000000000001',
  'main',repeat('a',40),repeat('b',40),'Atomic preparation','PR body','',
  encode(extensions.digest('private checkpoint'::bytea,'sha256'),'hex'),encode('private checkpoint'::bytea,'base64'),
  0,'Complete artifact',null,1234,567),true,'combined preparation saves durable source and complete artifact intent');
select ok((select not source_recovery_required from public.agent_runs where id=(select run_id from publication_fixtures where label='atomic'))
  and exists(select 1 from public.session_source_deliveries d join public.session_checkpoint_publications p using(run_id)
    where d.run_id=(select run_id from publication_fixtures where label='atomic') and p.artifact_md='Complete artifact'),
  'successful combined preparation clears recovery retention only with both durable obligations present');
select ok((select status='running' and input_tokens=1234 and output_tokens=567 from public.agent_runs
  where id=(select run_id from publication_fixtures where label='atomic')),
  'usage is durable on the exact running attempt before any remote publication or adoption');
select is(public.prepare_session_source_and_checkpoint_publication(
  (select run_id from publication_fixtures where label='atomic'),'12b2c3d4-0001-4000-8000-000000000001',
  'main',repeat('a',40),repeat('b',40),'Atomic preparation','PR body','',
  encode(extensions.digest('private checkpoint'::bytea,'sha256'),'hex'),encode('private checkpoint'::bytea,'base64'),
  0,'Complete artifact'),true,'legacy omitted usage arguments can retry the prepared obligation');
select ok((select input_tokens=1234 and output_tokens=567 from public.agent_runs
  where id=(select run_id from publication_fixtures where label='atomic')),
  'omitted optional usage arguments preserve previously recorded token counts');
select throws_ok($$select public.prepare_session_source_and_checkpoint_publication(
  (select run_id from publication_fixtures where label='atomic'),'12b2c3d4-0001-4000-8000-000000000001',
  'main',repeat('a',40),repeat('b',40),'Atomic preparation','PR body','',
  encode(extensions.digest('private checkpoint'::bytea,'sha256'),'hex'),encode('private checkpoint'::bytea,'base64'),
  0,'Complete artifact',null,-1,567)$$,'23514','Token usage must not be negative.',
  'negative input usage is rejected without changing the prepared obligation');
select throws_ok($$select public.prepare_session_source_and_checkpoint_publication(
  (select run_id from publication_fixtures where label='atomic'),'12b2c3d4-0001-4000-8000-000000000001',
  'main',repeat('a',40),repeat('b',40),'Atomic preparation','PR body','',
  encode(extensions.digest('private checkpoint'::bytea,'sha256'),'hex'),encode('private checkpoint'::bytea,'base64'),
  0,'Complete artifact',null,1234,-1)$$,'23514','Token usage must not be negative.',
  'negative output usage is rejected without changing the prepared obligation');
select is((select public.fail_stalled_session_job_attempt(j.id,1,'Stalled',true,3,r.id)
  from public.agent_runs r join public.agent_jobs j on j.id=r.agent_job_id
  where r.id=(select run_id from publication_fixtures where label='atomic')),'stale',
  'authoritative stall failure leaves an unexpired current publication recoverable');
select ok((select r.status='running' and j.status='running' and j.attempt_count=1
  from public.agent_runs r join public.agent_jobs j on j.id=r.agent_job_id
  where r.id=(select run_id from publication_fixtures where label='atomic')),
  'stall protection does not retire or retry the original agent execution');
select ok(not has_function_privilege('authenticated',
  'public.prepare_session_source_and_checkpoint_publication(uuid,uuid,text,text,text,text,text,text,text,text,integer,text,timestamptz,bigint,bigint)','EXECUTE')
  and not has_function_privilege('authenticated','public.fail_stalled_session_job_attempt(uuid,integer,text,boolean,integer,uuid)','EXECUTE'),
  'browser cannot prepare privileged obligations or decide stalled ownership');

update publication_fixtures set claim_id=public.claim_session_checkpoint_publication(run_id) where label='atomic';
select is((select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,repeat('b',40))
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id) where label='atomic'),true,
  'maintenance-style adoption recovers a previously prepared artifact without processor state');
select ok((select r.status='success' and r.input_tokens=1234 and r.output_tokens=567 and j.status='success' and p.status='adopted'
  from publication_fixtures f join public.agent_runs r on r.id=f.run_id
  join public.agent_jobs j on j.id=r.agent_job_id join public.session_checkpoint_publications p on p.run_id=r.id where label='atomic'),
  'recovered successful execution retains complete token usage for analytics');
select ok(has_function_privilege('service_role',
  'public.prepare_session_source_and_checkpoint_publication(uuid,uuid,text,text,text,text,text,text,text,text,integer,text,timestamptz,bigint,bigint)','EXECUTE'),
  'service workers can invoke the usage-bearing atomic preparation signature');

insert into publication_fixtures(label,run_id) values('code',pg_temp.publication_fixture('Code publication'));

select throws_ok($$select public.publish_session_job_with_source(j.id,1,r.id,0,'Full artifact')
  from public.agent_runs r join public.agent_jobs j on j.id=r.agent_job_id where r.id=(select run_id from publication_fixtures where label='code')$$,
  '23514','Exact retained remote checkpoint proof is required.','private durable bundle alone cannot publish changed code');
select throws_ok($$select public.publish_session_job_attempt(j.id,1,r.id,0,'Full artifact')
  from public.agent_runs r join public.agent_jobs j on j.id=r.agent_job_id where r.id=(select run_id from publication_fixtures where label='code')$$,
  '23514','Exact retained remote checkpoint proof is required.','bare artifact primitive cannot bypass the remote proof gate');
select is((select count(*) from public.session_artifacts where session_id=(select session_id from public.agent_runs
  where id=(select run_id from publication_fixtures where label='code'))),0::bigint,'failed private-only publication leaves no artifact');
select is(public.prepare_session_checkpoint_publication((select run_id from publication_fixtures where label='code'),0,
  'Full artifact'||repeat(' markdown',10000)),true,'prepare persists the full artifact independently of PR body length');
select is((select length(artifact_md) from public.session_checkpoint_publications where run_id=(select run_id from publication_fixtures where label='code')),
  length('Full artifact'||repeat(' markdown',10000)),'artifact markdown is not truncated to the PR body limit');
select is(public.prepare_session_checkpoint_publication((select run_id from publication_fixtures where label='code'),0,
  'Full artifact'||repeat(' markdown',10000)),true,'preparing the same intent is idempotent');
select throws_ok($$select public.prepare_session_checkpoint_publication((select run_id from publication_fixtures where label='code'),0,'Different artifact')$$,
  '23514','Checkpoint publication intent is immutable.','retry cannot replace the artifact candidate');
select throws_ok($$update public.session_checkpoint_publications set deadline_at=deadline_at+interval '1 hour'
  where run_id=(select run_id from publication_fixtures where label='code')$$,
  '23514','Checkpoint publication intent is immutable.','retry cannot extend the original absolute deadline');
select throws_ok($$update public.session_source_deliveries set head_sha=repeat('c',40)
  where run_id=(select run_id from publication_fixtures where label='code')$$,
  '23514','Accepted Git source identity is immutable.','prepared intent freezes its exact source candidate before any remote push');
select throws_ok($$delete from public.session_source_deliveries where run_id=(select run_id from publication_fixtures where label='code')$$,
  '23514','Checkpoint publication intent is immutable.','direct source deletion cannot erase an unaccepted recovery intent');
select ok((select p.deadline_at=r.started_at+interval '30 minutes' from public.session_checkpoint_publications p
  join public.agent_runs r on r.id=p.run_id where p.run_id=(select run_id from publication_fixtures where label='code')),
  'omitted deadline is captured from original run start rather than retry time');
update publication_fixtures set claim_id=public.claim_session_checkpoint_publication(run_id) where label='code';
select ok((select claim_id is not null from publication_fixtures where label='code'),'current intent receives a publication lease');
select ok((select p.lease_expires_at<=clock_timestamp()+interval '2 minutes' and p.lease_expires_at<=p.deadline_at
  from public.session_checkpoint_publications p where p.run_id=(select run_id from publication_fixtures where label='code')),
  'publication lease is bounded by two minutes and the immutable deadline');
select is(public.claim_session_checkpoint_publication((select run_id from publication_fixtures where label='code')),null::uuid,
  'a second worker cannot claim an unexpired lease');
select is(public.assert_session_checkpoint_publication_claim((select run_id from publication_fixtures where label='code'),
  (select claim_id from publication_fixtures where label='code')),true,'current claim can verify its execution ownership');
select is(public.adopt_session_checkpoint_publication((select run_id from publication_fixtures where label='code'),pg_catalog.gen_random_uuid(),
  'refs/heads/wrong',repeat('b',40)),false,'foreign claim cannot adopt even if it knows a run');
select throws_ok($$select public.adopt_session_checkpoint_publication(run_id,claim_id,'refs/heads/wrong',repeat('b',40))
  from publication_fixtures where label='code'$$,'23514','Exact retained remote checkpoint proof is required.',
  'moving or intended PR branch cannot stand in for immutable retained ref');
select throws_ok($$select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,repeat('c',40))
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id) where label='code'$$,
  '23514','Exact retained remote checkpoint proof is required.','different remote SHA cannot become accepted source');
select is((select remote_verified_sha from public.session_checkpoint_publications where run_id=(select run_id from publication_fixtures where label='code')),
  null::text,'failed proof does not record a trusted receipt');
select is(public.release_session_checkpoint_publication((select run_id from publication_fixtures where label='code'),
  (select claim_id from publication_fixtures where label='code')),true,'current failure becomes a retryable pending intent');
select ok((select status='pending' and last_error_code='remote_publication_failed' and next_attempt_at>clock_timestamp()
  from public.session_checkpoint_publications where run_id=(select run_id from publication_fixtures where label='code')),
  'release records only a safe error code and bounded retry backoff');
select ok((select bundle_base64 is not null from public.session_source_deliveries
  where run_id=(select run_id from publication_fixtures where label='code')),'publication outage retains private source recovery bytes');
update public.session_checkpoint_publications set next_attempt_at=clock_timestamp() where run_id=(select run_id from publication_fixtures where label='code');
update publication_fixtures set claim_id=public.claim_session_checkpoint_publication(run_id) where label='code';
create temp table replaced_publication_claim as select * from publication_fixtures where label='code';
update public.session_checkpoint_publications set lease_expires_at=clock_timestamp()-interval '1 second'
  where run_id=(select run_id from publication_fixtures where label='code');
update publication_fixtures set claim_id=public.claim_session_checkpoint_publication(run_id) where label='code';
select ok((select f.claim_id<>old.claim_id from publication_fixtures f join replaced_publication_claim old using(run_id)),
  'worker loss reclaims an expired lease with a new claim identity');
select is((select public.release_session_checkpoint_publication(run_id,claim_id) from replaced_publication_claim),false,
  'stale worker cannot release the replacement lease');
select is((select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,repeat('b',40))
  from replaced_publication_claim f join public.session_checkpoint_publications p using(run_id)),false,
  'stale worker cannot adopt replacement lease remote proof');

-- A failure after the legacy primitive has written must roll back its artifact,
-- run transition, checkpoint, publication receipt and job completion together.
create function pg_temp.reject_checkpoint() returns trigger language plpgsql as $$
begin raise exception 'Checkpoint guard fixture.' using errcode='23514'; end;
$$;
create trigger checkpoint_atomicity_fixture after insert on public.session_git_checkpoints for each row execute function pg_temp.reject_checkpoint();
select throws_ok($$select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,repeat('b',40))
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id) where label='code'$$,
  '23514','Checkpoint guard fixture.','a post-primitive checkpoint guard can reject the transaction');
select ok((select s.current_artifact_version=0 and s.current_artifact_id is null and r.status='running'
  and j.status='running' and p.status='claimed' and p.artifact_id is null and p.remote_verified_sha is null
  from publication_fixtures f join public.agent_runs r on r.id=f.run_id join public.sessions s on s.id=r.session_id
  join public.agent_jobs j on j.id=r.agent_job_id join public.session_checkpoint_publications p on p.run_id=r.id where label='code'),
  'failed adoption rolls back canonical artifact, run, job, receipt and intent state');
select is((select count(*) from public.session_git_checkpoints where run_id=(select run_id from publication_fixtures where label='code')),0::bigint,
  'failed adoption leaves no accepted checkpoint');
drop trigger checkpoint_atomicity_fixture on public.session_git_checkpoints;
select is((select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,repeat('b',40))
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id) where label='code'),true,
  'exact retained remote proof adopts source and full artifact atomically');
select is((select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,repeat('b',40))
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id) where label='code'),true,
  'retry after a committed adoption is idempotent for its same claim and proof');
select ok((select c.output_ref=p.retained_ref and c.output_sha=p.remote_verified_sha and c.artifact_id=p.artifact_id
  and j.status='success' and r.status='success' and s.current_artifact_id=c.artifact_id
  and a.artifact_json=to_jsonb(p.artifact_md) and p.status='adopted'
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id)
  join public.session_git_checkpoints c using(run_id) join public.agent_runs r on r.id=c.run_id
  join public.agent_jobs j on j.id=c.job_id join public.sessions s on s.id=c.session_id
  join public.session_artifacts a on a.id=c.artifact_id where label='code'),
  'canonical artifact and checkpoint use exact retained receipt and complete the producing job');
select is((select count(*) from public.session_git_checkpoints where run_id=(select run_id from publication_fixtures where label='code')),1::bigint,
  'idempotent adoption creates exactly one checkpoint');
select throws_ok($$update public.session_checkpoint_publications set remote_verified_sha=repeat('c',40)
  where run_id=(select run_id from publication_fixtures where label='code')$$,
  '23514','Checkpoint publication intent is immutable.','accepted remote receipt is immutable');

insert into publication_fixtures(label,run_id) values('nocode',pg_temp.publication_fixture('No-code publication',repeat('a',40)));
select is(public.prepare_session_checkpoint_publication((select run_id from publication_fixtures where label='nocode'),0,'No code needed'),true,
  'no-code publication prepares the unchanged pinned commit');
update publication_fixtures set claim_id=public.claim_session_checkpoint_publication(run_id) where label='nocode';
select throws_ok($$select public.adopt_session_checkpoint_publication(run_id,claim_id,'refs/heads/fabricated',repeat('a',40))
  from publication_fixtures where label='nocode'$$,'23514','No-code checkpoint must not fabricate a remote ref or SHA.',
  'no-code output rejects fabricated remote proof');
select is((select public.adopt_session_checkpoint_publication(run_id,claim_id) from publication_fixtures where label='nocode'),true,
  'no-code publication succeeds without Git or a remote receipt');
select ok((select c.output_kind='no-code' and c.output_ref is null and c.input_sha=c.output_sha
  and p.retained_ref is null and p.remote_verified_ref is null and p.remote_verified_sha is null
  from publication_fixtures f join public.session_git_checkpoints c using(run_id)
  join public.session_checkpoint_publications p using(run_id) where label='nocode'),
  'no-code lineage retains pinned SHA and no invented remote location');

insert into publication_fixtures(label,run_id) values('stale',pg_temp.publication_fixture('Stale publication'));
select public.prepare_session_checkpoint_publication((select run_id from publication_fixtures where label='stale'),0,'Stale candidate');
update publication_fixtures set claim_id=public.claim_session_checkpoint_publication(run_id) where label='stale';
update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()), attempt_count=2 where id=(select job_id from public.session_checkpoint_publications
  where run_id=(select run_id from publication_fixtures where label='stale'));
select is((select public.assert_session_checkpoint_publication_claim(run_id,claim_id) from publication_fixtures where label='stale'),false,
  'new claim generation invalidates the prior publication lease');
select is((select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,repeat('b',40))
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id) where label='stale'),false,
  'stale generation remote proof never becomes canonical');
select is(public.claim_session_checkpoint_publication((select run_id from publication_fixtures where label='stale')),null::uuid,
  'maintenance retires obsolete intents rather than publishing them');
select is((select status from public.session_checkpoint_publications where run_id=(select run_id from publication_fixtures where label='stale')),
  'stale','obsolete intent is marked stale');

insert into publication_fixtures(label,run_id) values('canceled',pg_temp.publication_fixture('Canceled publication'));
select public.prepare_session_checkpoint_publication((select run_id from publication_fixtures where label='canceled'),0,'Canceled candidate');
update publication_fixtures set claim_id=public.claim_session_checkpoint_publication(run_id) where label='canceled';
update public.agent_jobs set status='canceled' where id=(select job_id from public.session_checkpoint_publications
  where run_id=(select run_id from publication_fixtures where label='canceled'));
select is((select public.adopt_session_checkpoint_publication(f.run_id,f.claim_id,p.retained_ref,repeat('b',40))
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id) where label='canceled'),false,
  'cancellation wins over a worker returning with remote proof');
select is((select public.release_session_checkpoint_publication(run_id,claim_id) from publication_fixtures where label='canceled'),false,
  'release marks canceled intent stale without reviving execution');

insert into publication_fixtures(label,run_id) values('expired',pg_temp.publication_fixture('Expired publication'));
select public.prepare_session_checkpoint_publication((select run_id from publication_fixtures where label='expired'),0,'Expired candidate',clock_timestamp()-interval '1 second');
select is(public.claim_session_checkpoint_publication((select run_id from publication_fixtures where label='expired')),null::uuid,
  'original deadline expiry cannot acquire a fresh publication lease');
select ok((select p.status='stale' and p.last_error_code='publication_deadline_exceeded' and r.status='error' and j.status='error'
  from publication_fixtures f join public.session_checkpoint_publications p using(run_id)
  join public.agent_runs r on r.id=p.run_id join public.agent_jobs j on j.id=p.job_id where label='expired'),
  'expired current intent terminally fails the exact run and job without retrying the agent');

-- Scope is revalidated even for privileged inserts and after repository state changes.
insert into publication_fixtures(label,run_id) values('scope',pg_temp.publication_fixture('Scoped publication'));
insert into public.workspaces(id,name,slug) values('49600000-0001-4000-8000-000000000001','Foreign publication workspace','foreign-publication-workspace');
select throws_ok($$insert into public.session_checkpoint_publications(run_id,workspace_id,session_id,job_id,attempt_count,
  expected_artifact_version,artifact_md,deadline_at,retained_ref)
  select r.id,'49600000-0001-4000-8000-000000000001',r.session_id,r.agent_job_id,1,0,'Foreign candidate',
    clock_timestamp()+interval '1 minute','refs/heads/wallie/checkpoints/'||r.id::text||'/'||repeat('b',40)
  from public.agent_runs r where r.id=(select run_id from publication_fixtures where label='scope')$$,
  '23514','Checkpoint publication does not match the current execution.','foreign workspace metadata cannot be smuggled into a private intent');
select public.prepare_session_checkpoint_publication((select run_id from publication_fixtures where label='scope'),0,'Scoped candidate');
update publication_fixtures set claim_id=public.claim_session_checkpoint_publication(run_id) where label='scope';
update public.github_installations set suspended=true where id=(select repo.github_installation_id
  from public.github_repositories repo join public.session_source_deliveries d on d.repository_id=repo.id
  where d.run_id=(select run_id from publication_fixtures where label='scope'));
select is((select public.assert_session_checkpoint_publication_claim(run_id,claim_id) from publication_fixtures where label='scope'),false,
  'suspended installation invalidates current remote publication ownership');
update public.github_installations set suspended=false where id=(select repo.github_installation_id
  from public.github_repositories repo join public.session_source_deliveries d on d.repository_id=repo.id
  where d.run_id=(select run_id from publication_fixtures where label='scope'));
update public.github_repositories set is_archived=true where id=(select repository_id from public.session_source_deliveries
  where run_id=(select run_id from publication_fixtures where label='scope'));
select is((select public.assert_session_checkpoint_publication_claim(run_id,claim_id) from publication_fixtures where label='scope'),false,
  'archived repository cannot accept an already claimed publication');
update public.github_repositories set is_archived=false where id=(select repository_id from public.session_source_deliveries
  where run_id=(select run_id from publication_fixtures where label='scope'));

-- The final clock check also rolls back an adoption delayed inside its writes.
insert into publication_fixtures(label,run_id) values('slow',pg_temp.publication_fixture('Slow publication'));
create function pg_temp.delay_checkpoint() returns trigger language plpgsql as $$
begin perform pg_sleep(0.5); return new; end;
$$;
create trigger checkpoint_deadline_fixture after insert on public.session_git_checkpoints for each row execute function pg_temp.delay_checkpoint();
create function pg_temp.expiring_adoption() returns boolean language plpgsql as $$
declare v_run_id uuid; v_claim_id uuid; v_remote_ref text;
begin
  select f.run_id into v_run_id from publication_fixtures f where label='slow';
  perform public.prepare_session_checkpoint_publication(v_run_id,0,'Slow candidate',clock_timestamp()+interval '300 milliseconds');
  v_claim_id:=public.claim_session_checkpoint_publication(v_run_id);
  select p.retained_ref into v_remote_ref from public.session_checkpoint_publications p where p.run_id=v_run_id;
  begin
    perform public.adopt_session_checkpoint_publication(v_run_id,v_claim_id,v_remote_ref,repeat('b',40));
    return false;
  exception when query_canceled then return true;
  end;
end;
$$;
select is(pg_temp.expiring_adoption(),true,'deadline expiring after checkpoint insertion aborts all canonical writes');
drop trigger checkpoint_deadline_fixture on public.session_git_checkpoints;
select ok((select s.current_artifact_id is null and r.status='running' and j.status='running'
  and p.status='claimed' and p.remote_verified_sha is null and p.artifact_id is null
  from publication_fixtures f join public.agent_runs r on r.id=f.run_id join public.sessions s on s.id=r.session_id
  join public.agent_jobs j on j.id=r.agent_job_id join public.session_checkpoint_publications p on p.run_id=r.id where label='slow'),
  'post-write expiry rolls back artifact, successful run, completed job, checkpoint and verified receipt');
select is((select count(*) from public.session_git_checkpoints where run_id=(select run_id from publication_fixtures where label='slow')),0::bigint,
  'expired adoption leaves no checkpoint');
select is(public.claim_session_checkpoint_publication((select run_id from publication_fixtures where label='slow')),null::uuid,
  'expired retry cannot extend the original deadline after rollback');

select ok((select i.indisunique and pg_get_expr(i.indpred,i.indrelid)='(claim_id IS NOT NULL)'
  from pg_catalog.pg_index i join pg_catalog.pg_class idx on idx.oid=i.indexrelid
  join pg_catalog.pg_namespace ns on ns.oid=idx.relnamespace
  where ns.nspname='public' and idx.relname='session_checkpoint_publications_claim_idx'),
  'claim ID lookup is backed by a unique index for every non-NULL claim');
select throws_ok($$update public.session_checkpoint_publications set claim_id=(select claim_id
  from public.session_checkpoint_publications where run_id=(select run_id from publication_fixtures where label='code'))
  where run_id=(select run_id from publication_fixtures where label='scope')$$,
  '23505','duplicate key value violates unique constraint "session_checkpoint_publications_claim_idx"',
  'two pending or adopted publication intents cannot share a worker claim lookup key');

select ok(not has_table_privilege('authenticated','public.session_checkpoint_publications','SELECT'),
  'browser sessions cannot read full artifact candidates or publication metadata');
select ok(not has_table_privilege('anon','public.session_checkpoint_publications','SELECT'),'anonymous access is revoked');
select ok(has_table_privilege('service_role','public.session_checkpoint_publications','SELECT'),'service worker can read private publication metadata');
select ok(not has_table_privilege('service_role','public.session_checkpoint_publications','INSERT')
  and not has_table_privilege('service_role','public.session_checkpoint_publications','UPDATE')
  and not has_table_privilege('service_role','public.session_checkpoint_publications','DELETE'),
  'service callers cannot forge proof or mutate intents directly');
select ok(not has_function_privilege('authenticated','public.adopt_session_checkpoint_publication(uuid,uuid,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','internal.adopt_session_checkpoint_publication(uuid,uuid,text,text)','EXECUTE'),
  'both public wrapper and private privileged adoption helper reject browser invocation');
set local role authenticated;
select throws_ok($$select * from public.session_checkpoint_publications$$,'42501','permission denied for table session_checkpoint_publications',
  'browser query is denied rather than exposing a private recovery row');
reset role;
set local role service_role;
select throws_ok($$update public.session_checkpoint_publications set status='adopted'$$,'42501','permission denied for table session_checkpoint_publications',
  'direct service-role proof mutation is denied');
reset role;

select lives_ok($$delete from public.sessions where id=(select session_id from public.session_checkpoint_publications
  where run_id=(select run_id from publication_fixtures where label='code'))$$,
  'owning session cleanup can cascade accepted immutable publication history');
select is((select count(*) from public.session_checkpoint_publications where run_id=(select run_id from publication_fixtures where label='code')),0::bigint,
  'session cleanup leaves no private publication orphan');
select * from finish();
rollback;
