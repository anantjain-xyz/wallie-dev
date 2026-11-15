begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local timezone = 'America/Los_Angeles';
select is('2026-03-07 12:00-08'::timestamptz + internal.run_retention_duration(1),
  '2026-03-08 13:00-07'::timestamptz, 'retention days use 24 elapsed hours across daylight saving transitions');

insert into public.workspaces(id, slug, name) values
  ('53800000-0001-4000-8000-000000000001', 'retention-fixture', 'Retention fixture'),
  ('53800000-0001-4000-8000-000000000002', 'retention-foreign', 'Foreign workspace');
insert into public.workspace_members(workspace_id, user_id, kind, role) values
  ('53800000-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001', 'human', 'owner'),
  ('53800000-0001-4000-8000-000000000001', 'a1b2c3d4-0002-4000-8000-000000000002', 'human', 'member'),
  ('53800000-0001-4000-8000-000000000002', 'a1b2c3d4-0002-4000-8000-000000000002', 'human', 'owner');
insert into public.pipelines(id, workspace_id, name)
select id, id, 'Fixture pipeline' from public.workspaces where slug in ('retention-fixture', 'retention-foreign');
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name) values
  ('53800000-0002-4000-8000-000000000001', '53800000-0001-4000-8000-000000000001', '53800000-0001-4000-8000-000000000001', 1, 'plan', 'Plan'),
  ('53800000-0002-4000-8000-000000000002', '53800000-0001-4000-8000-000000000002', '53800000-0001-4000-8000-000000000002', 1, 'plan', 'Plan');
insert into public.sessions(id, workspace_id, number, title, prompt_md, pipeline_id, current_stage_id) values
  ('53800000-0003-4000-8000-000000000001', '53800000-0001-4000-8000-000000000001', 1, 'Retention fixture', 'Plan', '53800000-0001-4000-8000-000000000001', '53800000-0002-4000-8000-000000000001'),
  ('53800000-0003-4000-8000-000000000002', '53800000-0001-4000-8000-000000000002', 1, 'Foreign workspace', 'Plan', '53800000-0001-4000-8000-000000000002', '53800000-0002-4000-8000-000000000002');
insert into public.agent_jobs(id, workspace_id, session_id, trigger_type, status, attempt_count) values
  ('53800000-0004-4000-8000-000000000001', '53800000-0001-4000-8000-000000000001',
    '53800000-0003-4000-8000-000000000001', 'assignment', 'success', 1);
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, run_type, model_provider, model_name,
  status, attempt_count, created_at, updated_at, finished_at) values
  ('53800000-0005-4000-8000-000000000001', '53800000-0001-4000-8000-000000000001', '53800000-0003-4000-8000-000000000001',
    '53800000-0004-4000-8000-000000000001', 'project', 'codex', 'test', 'success', 1, now()-interval '5 days', now(), now()-interval '4 days'),
  ('53800000-0005-4000-8000-000000000002', '53800000-0001-4000-8000-000000000001', '53800000-0003-4000-8000-000000000001',
    null, 'project', 'codex', 'test', 'error', null, now()-interval '5 days', now()-interval '4 days', null),
  ('53800000-0005-4000-8000-000000000003', '53800000-0001-4000-8000-000000000001', '53800000-0003-4000-8000-000000000001',
    null, 'project', 'codex', 'test', 'running', 1, now()-interval '5 days', now(), null),
  ('53800000-0005-4000-8000-000000000004', '53800000-0001-4000-8000-000000000001', '53800000-0003-4000-8000-000000000001',
    null, 'project', 'codex', 'test', 'canceled', 1, now()-interval '5 days', now(), now()),
  ('53800000-0005-4000-8000-000000000005', '53800000-0001-4000-8000-000000000002', '53800000-0003-4000-8000-000000000002',
    null, 'project', 'codex', 'test', 'error', 1, now()-interval '5 days', now(), now()-interval '4 days');
insert into public.agent_run_messages(workspace_id, agent_run_id, kind, message_md)
select workspace_id, id, 'progress', 'Routine transcript body' from public.agent_runs
where id in (
  '53800000-0005-4000-8000-000000000001', '53800000-0005-4000-8000-000000000002',
  '53800000-0005-4000-8000-000000000003', '53800000-0005-4000-8000-000000000004',
  '53800000-0005-4000-8000-000000000005'
);
insert into public.agent_run_messages(workspace_id, agent_run_id, kind, message_md) values
  ('53800000-0001-4000-8000-000000000001', '53800000-0005-4000-8000-000000000002',
    'run_failure', '{"version":1,"category":"timeout","code":"timeout"}');
insert into public.agent_run_events(agent_run_id, workspace_id, attempt_count, sequence, kind, payload)
select '53800000-0005-4000-8000-000000000001', '53800000-0001-4000-8000-000000000001',
  1, n, 'text', '{"text":"Ordered transcript body"}'::jsonb from generate_series(1, 3) n;

insert into public.session_validation_evidence(
  run_id, workspace_id, session_id, job_id, attempt_count, repository_id,
  repository_full_name, commit_sha, validation_tree_sha, records, assets, created_at
) values (
  '53800000-0005-4000-8000-000000000001', '53800000-0001-4000-8000-000000000001', '53800000-0003-4000-8000-000000000001',
  '53800000-0004-4000-8000-000000000001', 1, '12b2c3d4-0001-4000-8000-000000000001',
  'fixture/repository', repeat('a',40), repeat('b',40), '[]', '[]', now()-interval '3 days'
);
insert into public.session_validation_assets(
  id, run_id, workspace_id, session_id, evidence_key, kind, required, storage_path, sha256, content_type, size_bytes
)
select id, '53800000-0005-4000-8000-000000000001', '53800000-0001-4000-8000-000000000001',
  '53800000-0003-4000-8000-000000000001', label, 'report', required,
  '53800000-0001-4000-8000-000000000001/53800000-0005-4000-8000-000000000001/' || id::text,
  repeat('c',64), 'text/plain', 13
from (values
  ('53800000-0006-4000-8000-000000000001'::uuid, 'required-report', true),
  ('53800000-0006-4000-8000-000000000002'::uuid, 'optional-report', false),
  ('53800000-0006-4000-8000-000000000003'::uuid, 'redacted-report', false)
) fixtures(id, label, required);
insert into storage.objects(bucket_id, name) select 'session-validation-evidence', storage_path
from public.session_validation_assets where run_id = '53800000-0005-4000-8000-000000000001';
insert into public.session_validation_asset_withholdings(asset_id, state)
values ('53800000-0006-4000-8000-000000000003', 'redacted');

set local role service_role;
select is((select transcripts_expired from public.mark_expired_workspace_run_content()), 0,
  'workspaces must enable retention before historical transcripts expire');
select throws_ok($$select public.save_workspace_run_retention(
  '53800000-0001-4000-8000-000000000001', 'a1b2c3d4-0002-4000-8000-000000000002', 1, 1)$$,
  '42501', 'Workspace administrator access is required.', 'members cannot change retention');
select throws_ok($$select public.save_workspace_run_retention(
  '53800000-0001-4000-8000-000000000002', 'a1b2c3d4-0001-4000-8000-000000000001', 1, 1)$$,
  '42501', 'Workspace administrator access is required.', 'another workspace owner cannot change retention');
select is((public.save_workspace_run_retention(
  '53800000-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001', 1, 1)).transcript_days, 1,
  'workspace owners can opt in to finite retention');
create temp table initial_retention_sweep as select * from public.mark_expired_workspace_run_content();
select is((select transcripts_expired from initial_retention_sweep), 2,
  'the exact terminal, past-cutoff runs expire including legacy activity');
select is((select evidence_expired from initial_retention_sweep), 1,
  'optional validation evidence expires while required active-session evidence remains and existing redaction is preserved');
select is((select count(*) from public.agent_run_transcript_expirations where workspace_id =
  '53800000-0001-4000-8000-000000000002'), 0::bigint,
  'retention cannot expire another workspace');
select is((select transcripts_expired from public.mark_expired_workspace_run_content()), 0,
  'repeating retention marks no new expiry for the exact same runs');

reset role;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';
select ok(not has_function_privilege(current_user, 'public.mark_expired_workspace_run_content(integer,integer)', 'EXECUTE'),
  'clients cannot run retention work');
select ok(not has_function_privilege(current_user, 'public.save_workspace_run_retention(uuid,uuid,integer,integer)', 'EXECUTE'),
  'manager writes pass through the privileged authorization boundary');
select is((select count(*) from public.agent_run_events where agent_run_id =
  '53800000-0005-4000-8000-000000000001'), 0::bigint,
  'expiry immediately hides ordered activity before physical deletion');
select is((select count(*) from public.agent_run_messages where agent_run_id =
  '53800000-0005-4000-8000-000000000002' and kind <> 'run_failure'), 0::bigint,
  'expiry immediately hides legacy projections before physical deletion');
select ok((select transcript_expired_at is not null and not has_events and failure_receipt is not null
  from public.list_workspace_run_catalog('53800000-0001-4000-8000-000000000001',
    p_run_id => '53800000-0005-4000-8000-000000000002')),
  'catalog retains run identity and a failure receipt while labelling transcript expiry');
select results_eq($$select label || '=' || availability from public.list_run_artifacts(
  '53800000-0001-4000-8000-000000000001', '53800000-0005-4000-8000-000000000001')
  order by label$$, $$values ('optional-report=expired'), ('redacted-report=redacted'), ('required-report=recorded')$$,
  'catalog metadata distinguishes expired, redacted and available receipt assets');
select is((select count(*) from storage.objects where bucket_id = 'session-validation-evidence'
  and name like '53800000-0001-%'), 1::bigint,
  'immediate evidence withholding leaves only the active required object readable');

set local request.jwt.claim.sub = 'a1b2c3d4-0002-4000-8000-000000000002';
select is((select count(*) from public.agent_run_transcript_expirations
  where workspace_id = '53800000-0001-4000-8000-000000000001'), 2::bigint,
  'workspace members can see their transcript availability markers');
select is((select count(*) from public.agent_run_transcript_expirations
  where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'), 0::bigint,
  'the retention worker did not alter the default workspace');
reset role;
set local role service_role;
set local request.jwt.claim.role = 'service_role';

select lives_ok($$insert into public.agent_run_messages(workspace_id, agent_run_id, kind, message_md) values
  ('53800000-0001-4000-8000-000000000001', '53800000-0005-4000-8000-000000000001', 'error', 'Late diagnostic')$$,
  'a delayed diagnostic cannot fail a completed cancellation or cleanup path');
select is((select count(*) from public.agent_run_messages where agent_run_id =
  '53800000-0005-4000-8000-000000000001'), 1::bigint,
  'a delayed diagnostic cannot repopulate expired transcript bytes');
select is(public.purge_expired_run_transcripts(8, 2), 1, 'transcript cleanup commits only bounded pages');
select is((select count(*) from public.agent_run_events where agent_run_id =
  '53800000-0005-4000-8000-000000000001'), 1::bigint, 'unprocessed pages remain durable after restart');
select is(public.purge_expired_run_transcripts(8, 2), 1, 'another cleanup completes the remaining transcript page');
select is(public.purge_expired_run_transcripts(8, 2), 0, 'already-purged streams are skipped on retry');
select is((select count(*) from public.agent_run_messages where agent_run_id =
  '53800000-0005-4000-8000-000000000002' and kind = 'run_failure'), 1::bigint,
  'structured failure summary survives retention');
select is((select count(*) from public.agent_run_messages where agent_run_id in (
  '53800000-0005-4000-8000-000000000003', '53800000-0005-4000-8000-000000000004',
  '53800000-0005-4000-8000-000000000005')), 3::bigint,
  'running, recent terminal and unrelated workspace activity remain intact');

create temp table first_purge_claims as select * from public.claim_run_evidence_purges();
select is((select count(*) from first_purge_claims), 2::bigint, 'only withheld assets enter Storage cleanup');
select is((select count(*) from public.claim_run_evidence_purges()), 0::bigint,
  'unacknowledged cleanup belongs to the live lease');
update public.session_validation_asset_withholdings set cleanup_available_at = clock_timestamp()-interval '1 second'
where asset_id in (select asset_id from first_purge_claims);
create temp table retry_purge_claims as select * from public.claim_run_evidence_purges();
select results_eq($$select storage_path from retry_purge_claims order by storage_path$$,
  $$select storage_path from first_purge_claims order by storage_path$$,
  'a crash or failed object deletion retries the identical workspace-owned paths');
select is(public.complete_run_evidence_purges((select array_agg(claim_id) from first_purge_claims)), 0,
  'a stale acknowledgement cannot settle another worker lease');
select is(public.complete_run_evidence_purges((select array_agg(claim_id) from retry_purge_claims)), 2,
  'storage success acknowledges precisely the leased assets');
select is(public.complete_run_evidence_purges((select array_agg(claim_id) from retry_purge_claims)), 0,
  'repeating an acknowledgement leaves durable withholding state unchanged');
select is((select state from public.session_validation_asset_withholdings where asset_id =
  '53800000-0006-4000-8000-000000000003'), 'redacted', 'object removal does not rewrite redaction as expiry');
select is((select count(*) from public.session_validation_assets where run_id =
  '53800000-0005-4000-8000-000000000001'), 3::bigint, 'object removal preserves manifest identity and digest');

update public.sessions set archived_at = clock_timestamp() where id = '53800000-0003-4000-8000-000000000001';
select is((select evidence_expired from public.mark_expired_workspace_run_content()), 1,
  'archival makes formerly required evidence eligible after its retention interval');
select is((select state from public.session_validation_asset_withholdings where asset_id =
  '53800000-0006-4000-8000-000000000001'), 'expired', 'required evidence keeps its catalog entry after expiry');
select is((public.save_workspace_run_retention(
  '53800000-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001')).evidence_days, null,
  'clearing a policy keeps future eligible bytes indefinitely');
select is((select count(*) from public.session_validation_asset_withholdings where asset_id in (
  '53800000-0006-4000-8000-000000000001', '53800000-0006-4000-8000-000000000002',
  '53800000-0006-4000-8000-000000000003')), 3::bigint, 'clearing the policy cannot reactivate withheld bytes');

select * from finish();
rollback;
