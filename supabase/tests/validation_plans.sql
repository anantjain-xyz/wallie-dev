begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role='service_role';

insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid,coalesce(max(number),0)
from public.sessions where workspace_id='b1b2c3d4-0001-4000-8000-000000000001'
on conflict(workspace_id) do update set last_issue_number=greatest(counters.last_issue_number,excluded.last_issue_number);
create function pg_temp.failure_state(statement text) returns text language plpgsql as $$
begin
  begin execute statement; return '00000'; exception when others then return sqlstate; end;
end;
$$;
create function pg_temp.evidence_fixture(label text)
returns table(session_id uuid,job_id uuid,run_id uuid) language plpgsql as $$
declare fixture record; owner public.sessions; started uuid;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    label,'Durable observed evidence','codex','gpt-5.5',null,null,'12b2c3d4-0001-4000-8000-000000000001',null);
  select * into owner from public.sessions s where s.id=fixture.session_id;
  update public.agent_jobs set git_continuity_release_revision=(select revision from public.get_git_continuity_release_state()),
    status='running',attempt_count=1 where id=fixture.job_id;
  started:=public.start_session_job_attempt(fixture.job_id,1,owner.current_stage_id,owner.current_artifact_version,
    'codex','gpt-5.5','project','wallie/evidence-'||fixture.job_id::text);
  perform public.pin_session_job_git_input(fixture.job_id,1,started,'12b2c3d4-0001-4000-8000-000000000001','main',repeat('a',40));
  return query select fixture.session_id,fixture.job_id,started;
end;
$$;
create function pg_temp.command_receipt(state text default 'passed') returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('key','tests','command','pnpm test','provenance','harness','status',state,
    'exitCode',case when state='passed' then 0 else 1 end,'startedAt',clock_timestamp(),'completedAt',clock_timestamp(),
    'commitSha',repeat('b',40),'treeSha',repeat('c',40),'finalCommitSha',repeat('b',40),'finalTreeSha',repeat('c',40),
    'reportKeys','[]'::jsonb,'missingRequiredReports','[]'::jsonb));
$$;
create temp table first_run as select * from pg_temp.evidence_fixture('First parallel validation plan');
create temp table second_run as select * from pg_temp.evidence_fixture('Second parallel validation plan');
create temp table plan as select '{"version":1,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":300,"reports":[]}]}'::jsonb as value;

select is(pg_temp.failure_state($$select public.pin_session_validation_plan(gen_random_uuid(),repeat('b',40),repeat('c',40),(select value from plan))$$),'42501','unknown runs cannot own plans');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from first_run),repeat('b',40),repeat('c',40),'{"version":1,"commands":[],"passed":true}')$$),'23514','plans cannot contain assertions of success');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from first_run),repeat('b',40),repeat('c',40),jsonb_set((select value from plan),'{commands,0,timeoutSeconds}','301'))$$),'23514','command timeouts are bounded');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from first_run),repeat('b',40),repeat('c',40),jsonb_set((select value from plan),'{commands,0,reports}','[{"key":"report","path":"../secret","kind":"report","required":true}]'))$$),'23514','report paths stay inside their execution directory');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from first_run),repeat('b',40),repeat('c',40),jsonb_set((select value from plan),'{commands}',((select value->'commands' from plan)||(select value->'commands' from plan))))$$),'23514','command identities cannot collide');

create temp table pinned as select * from public.pin_session_validation_plan((select run_id from first_run),repeat('b',40),repeat('c',40),(select value from plan));
select is((select session_id from pinned),(select session_id from first_run),'plan ownership derives from the run');
select is((select attempt_count from pinned),1,'plan belongs to the exact attempt');
select is((select commit_sha from pinned),repeat('b',40),'plan pins the validated commit');
select is((public.pin_session_validation_plan((select run_id from second_run),repeat('d',40),repeat('e',40),
  jsonb_set((select value from plan),'{commands,0,command}','"pnpm check"'))).plan->'commands'->0->>'command','pnpm check','another session independently chooses commands');
select is((select plan->'commands'->0->>'command' from public.session_validation_plans where run_id=(select run_id from first_run)),'pnpm test','parallel plans never overwrite each other');
select is((public.pin_session_validation_plan((select run_id from first_run),repeat('b',40),repeat('c',40),(select value from plan))).created_at,
  (select created_at from pinned),'an exact retry returns the original plan');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from first_run),repeat('b',40),repeat('c',40),'{"version":1,"commands":[]}')$$),'PT409','a run cannot replace its frozen plan');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from first_run),repeat('d',40),repeat('c',40),(select value from plan))$$),'PT409','a frozen plan cannot move to another commit');
select is(pg_temp.failure_state($$update public.session_validation_plans set plan='{}'$$),'23514','privileged SQL cannot rewrite a plan');
select is(pg_temp.failure_state($$delete from public.session_validation_plans$$),'23514','privileged SQL cannot erase a plan');

select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from first_run),repeat('b',40),repeat('c',40),
  jsonb_set(pg_temp.command_receipt(),'{0,command}','"true"'))$$),'23514','a receipt cannot claim success for a substituted command');
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from first_run),repeat('d',40),repeat('c',40),
  jsonb_set(jsonb_set(pg_temp.command_receipt(),'{0,commitSha}',to_jsonb(repeat('d',40))),'{0,finalCommitSha}',to_jsonb(repeat('d',40))))$$),'23514','passed evidence cannot be reused on another commit');
select is((public.record_session_validation_evidence((select run_id from first_run),repeat('b',40),repeat('c',40),pg_temp.command_receipt())).records->0->>'status','passed','the frozen plan produces evidence for its exact commit');

create temp table report_run as select * from pg_temp.evidence_fixture('Required report in frozen plan');
select public.pin_session_validation_plan((select run_id from report_run),repeat('b',40),repeat('c',40),
  jsonb_set((select value from plan),'{commands,0,reports}','[{"key":"report","path":"tests.json","kind":"report","required":true}]'));
select is(pg_temp.failure_state($$select public.record_session_validation_evidence((select run_id from report_run),repeat('b',40),repeat('c',40),pg_temp.command_receipt())$$),'23514','a receipt cannot omit reports required by the frozen plan');

create temp table stale_run as select * from pg_temp.evidence_fixture('Source changed during validation');
select public.pin_session_validation_plan((select run_id from stale_run),repeat('b',40),repeat('c',40),(select value from plan));
select is((public.record_session_validation_evidence((select run_id from stale_run),repeat('d',40),repeat('e',40),pg_temp.command_receipt('stale'))).records->0->>'status','stale','later source remains recoverable with explicitly stale evidence');
create temp table superseded_run as select * from pg_temp.evidence_fixture('Superseded plan attempt');
update public.agent_jobs set attempt_count=2 where id=(select job_id from superseded_run);
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from superseded_run),repeat('b',40),repeat('c',40),(select value from plan))$$),'PT409','a superseded attempt cannot pin a plan');

create temp table visual_run as select * from pg_temp.evidence_fixture('Browser verification plan');
create temp table visual_plan as
  select value||'{"version":2,"browser":[{"key":"inbox","path":"/fixtures/inbox","timeoutSeconds":20,
    "interactions":[{"action":"expectVisible","testId":"inbox"}],"regionTestId":"inbox",
    "excludedTestIds":["account-menu"],"evidence":[{"kind":"screenshot","required":true}]}]}'::jsonb as value from plan;
create temp table visual_receipt as
  select '[{"key":"inbox","kind":"screenshot","path":"/fixtures/inbox","policy":"isolated-fixture-v1",
    "status":"unavailable","reason":"runtime_unavailable"}]'::jsonb as value;
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from visual_run),repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_plan),'{browser,0,path}','"//example.test/"'))$$),'23514','browser navigation is scoped to a local path');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from visual_run),repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_plan),'{browser,0,interactions}','[{"action":"executeScript","script":"true"}]'))$$),'23514','browser plans cannot execute arbitrary scripts');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from visual_run),repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_plan),'{browser,0,interactions}','[{"other":"expectVisible","testId":"inbox"}]'))$$),'23514','unknown browser action fields cannot substitute for planned instructions');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from visual_run),repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_plan),'{browser,0,evidence,0,passed}','true'))$$),'23514','a visual intent carries no success claim');
select is((public.pin_session_validation_plan((select run_id from visual_run),repeat('b',40),repeat('c',40),(select value from visual_plan))).plan,
  (select value from visual_plan),'browser intent and text commands freeze together on one run');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from visual_run),repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_plan),'{browser,0,path}','"/other"'))$$),'PT409','a retry cannot retarget the frozen browser plan');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from second_run),1,repeat('b',40),repeat('c',40),
  (select value from visual_receipt))$$),'23514','another run cannot borrow browser verification');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from visual_run),2,repeat('b',40),repeat('c',40),
  (select value from visual_receipt))$$),'23514','browser verification cannot move to another attempt');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from visual_run),1,repeat('d',40),repeat('c',40),
  (select value from visual_receipt))$$),'23514','browser verification cannot move to another commit');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from visual_run),1,repeat('b',40),repeat('d',40),
  (select value from visual_receipt))$$),'23514','browser verification cannot move to another validation tree');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from visual_run),1,repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_receipt),'{0,path}','"/other"'))$$),'23514','a receipt cannot attest to an unplanned target');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from visual_run),1,repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_receipt),'{0,kind}','"video"'))$$),'23514','a receipt cannot attest to an unplanned media kind');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from visual_run),1,repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_receipt),'{0,status}','"captured"'))$$),'23514','the contract-only writer cannot assert positive browser capture');
create temp table browser_recorded as select * from public.record_session_browser_verification(
  (select run_id from visual_run),1,repeat('b',40),repeat('c',40),(select value from visual_receipt));
select is((select records from browser_recorded),(select value from visual_receipt),'the exact worker records durable unavailability');
select is((public.record_session_browser_verification((select run_id from visual_run),1,repeat('b',40),repeat('c',40),
  (select value from visual_receipt))).created_at,(select created_at from browser_recorded),'an exact retry reuses the immutable receipt');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from visual_run),1,repeat('b',40),repeat('c',40),
  jsonb_set((select value from visual_receipt),'{0,reason}','"tool_not_approved"'))$$),'PT409','a recorded browser outcome cannot be replaced');
select is(pg_temp.failure_state($$update public.session_browser_verification_receipts set records='[]'$$),'23514','privileged updates cannot rewrite browser history');
select is((public.record_session_validation_evidence((select run_id from visual_run),repeat('b',40),repeat('c',40),
  pg_temp.command_receipt())).records->0->>'status','passed','unsupported visual capture leaves the exact text receipt passing');

grant select on first_run,plan,visual_run,visual_receipt to authenticated,service_role;
set local role authenticated;
set local request.jwt.claim.role='authenticated';
set local request.jwt.claim.sub='a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from public.session_validation_plans where run_id=(select run_id from first_run)),1::bigint,'workspace members can inspect run plans');
select is(pg_temp.failure_state($$select public.pin_session_validation_plan((select run_id from first_run),repeat('b',40),repeat('c',40),(select value from plan))$$),'42501','browser clients cannot pin plans');
select is((select count(*) from public.session_browser_verification_receipts where run_id=(select run_id from visual_run)),
  1::bigint,'authorized members can read the exact browser receipt');
select is(pg_temp.failure_state($$select public.record_session_browser_verification((select run_id from visual_run),1,repeat('b',40),repeat('c',40),
  (select value from visual_receipt))$$),'42501','browser users cannot write trusted verification receipts');
select is(pg_temp.failure_state($$update public.session_validation_plans set plan='{}'$$),'42501','browser clients cannot modify plans');
reset role;
insert into auth.users(id,email) values('50900000-0000-4000-8000-000000000002','validation-plan-outsider@example.test');
set local role authenticated;
set local request.jwt.claim.sub='50900000-0000-4000-8000-000000000002';
select is((select count(*) from public.session_validation_plans),0::bigint,'other workspaces cannot read plans');
select is((select count(*) from public.session_browser_verification_receipts),0::bigint,'other workspaces cannot read browser receipts');
reset role;
set local role service_role;
select is(pg_temp.failure_state($$insert into public.session_validation_plans select * from public.session_validation_plans limit 1$$),'42501','service writes must use the fenced RPC');
reset role;
set local role anon;
select is(pg_temp.failure_state($$select * from public.session_validation_plans$$),'42501','anonymous clients cannot read plans');
reset role;
set local request.jwt.claim.role='service_role';
select lives_ok($$delete from public.sessions where id=(select session_id from first_run)$$,'owning-session deletion cascades immutable plans');
select is((select count(*) from public.session_validation_plans where run_id=(select run_id from first_run)),0::bigint,'deleted sessions retain no plan rows');
select lives_ok($$delete from public.sessions where id=(select session_id from visual_run)$$,'owning-session deletion cascades browser receipts');
select is((select count(*) from public.session_browser_verification_receipts),0::bigint,'deleted sessions retain no browser receipt');
select * from finish();
rollback;
