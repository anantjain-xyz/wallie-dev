begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local storage.allow_delete_query = 'true';
select * from public.set_git_continuity_release(true,
  (select revision from public.get_git_continuity_release_state()), 'Run export fixture');

insert into auth.sessions(id, user_id, not_after) values
  ('53810000-0006-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001', null),
  ('53810000-0006-4000-8000-000000000002', 'a1b2c3d4-0002-4000-8000-000000000002',
    clock_timestamp() + interval '1 hour'),
  ('53810000-0006-4000-8000-000000000003', 'a1b2c3d4-0001-4000-8000-000000000001',
    clock_timestamp() - interval '1 hour');

insert into internal.workspace_issue_counters as counters (workspace_id, last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, max(number)
from public.sessions where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
on conflict (workspace_id) do update
set last_issue_number = greatest(counters.last_issue_number, excluded.last_issue_number);

create temp table export_fixture as
select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
  'Export fixture', 'Export fixture', 'codex', 'gpt-5.5', null, null,
  '12b2c3d4-0001-4000-8000-000000000001', null
);
update public.agent_jobs set git_continuity_release_revision = (
  select revision from public.get_git_continuity_release_state()
), status = 'running', attempt_count = 1
where id = (select job_id from export_fixture);

create temp table export_run as
select f.session_id, f.job_id, s.workspace_id, public.start_session_job_attempt(
  f.job_id, 1, s.current_stage_id, s.current_artifact_version,
  'codex', 'gpt-5.5', 'project', 'wallie/run-export-fixture'
) as run_id
from export_fixture f join public.sessions s on f.session_id = s.id;

select public.pin_session_job_git_input(f.job_id, 1, f.run_id,
  '12b2c3d4-0001-4000-8000-000000000001', 'main', repeat('a', 40))
from export_run f;
select public.append_agent_run_event(f.job_id, f.run_id, 1, 1, 'text', '{"text":"Recorded answer"}', false,
  null, 'Recorded answer') from export_run f;
select public.append_agent_run_event(f.job_id, f.run_id, 1, 3, 'tool_result',
  '{"tool":"Read","output":"ok","status":"completed"}', false, 1, 'Cursor compatibility result')
from export_run f;
select public.append_agent_run_event(f.job_id, f.run_id, 1, 4, 'capture_gap',
  '{"reason":"missing_tool_result"}', true) from export_run f;
select public.append_agent_run_event(f.job_id, f.run_id, 1, 5, 'capture_end',
  '{"status":"interrupted"}', false) from export_run f;

create temp table fixture_assets as
select id, label, f.workspace_id::text || '/' || f.run_id::text || '/' || id::text as path,
  digest, withheld
from export_run f cross join (values
  ('53810000-0001-4000-8000-000000000001'::uuid, 'copy-report', repeat('d', 64), false),
  ('53810000-0001-4000-8000-000000000002'::uuid, 'missing-report', repeat('e', 64), false),
  ('53810000-0001-4000-8000-000000000003'::uuid, 'redacted-report', repeat('f', 64), true),
  ('53810000-0001-4000-8000-000000000004'::uuid, 'required-report', repeat('c', 64), false)
) fixtures(id, label, digest, withheld);

insert into storage.objects(bucket_id, name, metadata)
select 'session-validation-evidence', path, '{"size":11,"mimetype":"text/plain"}'
from fixture_assets;
select public.record_session_validation_evidence(
  f.run_id, repeat('a', 40), repeat('b', 40), '[]',
  (select jsonb_agg(jsonb_build_object('id', a.id, 'key', 'checks/' || a.label, 'kind', 'report',
    'required', a.label = 'required-report', 'storagePath', a.path, 'sha256', a.digest, 'contentType', 'text/plain', 'sizeBytes', 11))
  from fixture_assets a)
)
from export_run f;
insert into public.session_validation_asset_withholdings(asset_id, state)
select a.id, 'redacted' from fixture_assets a where a.withheld;

select public.prepare_session_source_and_checkpoint_publication(
  f.run_id, '12b2c3d4-0001-4000-8000-000000000001', 'main', repeat('a', 40), repeat('a', 40),
  'Export fixture', 'Private source fixture', '', '', '', 0, '# Exact Markdown'
) from export_run f;
create temp table export_checkpoint_claim as
select f.run_id, public.claim_session_checkpoint_publication(f.run_id) as token
from export_run f;
select public.adopt_session_checkpoint_publication(c.run_id, c.token, null, null)
from export_checkpoint_claim c;

insert into public.agent_run_messages(id, agent_run_id, workspace_id, kind, message_md)
select '53810000-0002-4000-8000-000000000001', f.run_id, f.workspace_id, 'assistant', 'Legacy unsequenced note'
from export_run f;
insert into public.session_artifacts(id, session_id, workspace_id, stage_slug, version, artifact_json)
select '53810000-0003-4000-8000-000000000001', f.session_id, f.workspace_id, 'legacy', 1, '"# Legacy unlinked"'
from export_run f;

insert into public.workspaces(id, name, slug) values
  ('53810000-0004-4000-8000-000000000001', 'Foreign exports fixture', 'foreign-exports-fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('53810000-0004-4000-8000-000000000002', '53810000-0004-4000-8000-000000000001',
    'a1b2c3d4-0002-4000-8000-000000000002', 'human', 'owner');

select ok(not has_function_privilege('authenticated', 'public.claim_run_export()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.request_run_export(uuid,uuid,uuid)', 'EXECUTE')
  and not has_table_privilege('authenticated', 'public.run_export_assets', 'SELECT')
  and not has_table_privilege('service_role', 'public.run_exports', 'UPDATE'),
  'only the service RPCs own the export state machine');

set local role service_role;
select throws_ok($$select public.request_run_export(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0002-4000-8000-000000000002',
  '53810000-0005-4000-8000-000000000001')$$, 'P0002', 'Run export workspace is unavailable.',
  'a regular member cannot export bulk history');

create temp table export_request as select * from public.request_run_export(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001',
  '53810000-0005-4000-8000-000000000001'
);
select is((public.request_run_export(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001',
  '53810000-0005-4000-8000-000000000001')).id, (select id from export_request),
  'a repeat request returns the existing export');
select throws_ok($$select public.request_run_export(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001',
  '53810000-0005-4000-8000-000000000002')$$, '55000', 'A run export is already in progress.',
  'a second request cannot write a duplicate active workspace export');
select is((select status from public.list_run_exports(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001', 50
) where id = (select id from export_request)), 'queued', 'a current owner sees the queued job');
select is((select count(*) from public.get_run_export_access(
  '53810000-0004-4000-8000-000000000001', (select id from export_request),
  'a1b2c3d4-0002-4000-8000-000000000002', '53810000-0006-4000-8000-000000000002'
)), 0::bigint, 'even an owner cannot borrow another workspace export identifier');

create temp table export_claim as select * from public.claim_run_export();
select is((select export_id from export_claim), (select id from export_request), 'worker claims the queued export');
select is((select count(*) from public.claim_run_export()), 0::bigint, 'a live lease prevents duplicate work');
select ok(not public.complete_run_export((select export_id from export_claim), (select lease_token from export_claim)),
  'completion refuses a partial enumeration');

create temp table first_export_page as
select x.* from export_claim c, lateral public.read_run_export_page(c.export_id, c.lease_token, 2) x;
select is((select array_agg(ordinal order by ordinal) from first_export_page), array[1,2]::bigint[],
  'the first bounded page enumerates contiguous snapshot ordinals');

reset role;
select is((select count(*) from internal.run_export_entries e join export_run r on e.run_id = r.run_id
  where e.record_kind = 'event'), 4::bigint, 'all recorded exact-run event identities are enumerated');
select is((select count(*) from internal.run_export_entries e join export_run r on e.run_id = r.run_id
  where e.record_kind = 'legacy_message'), 1::bigint, 'the compatibility projection is deduplicated');
select is((select count(*) from internal.run_export_entries e join export_run r on e.run_id = r.run_id
  where e.record_kind = 'capture_gap' and e.metadata->>'reason' in ('missing_event_sequences', 'capture_interrupted')),
  2::bigint, 'the snapshot labels actual sequence holes and interrupted capture');
select is((select availability from internal.run_export_entries e join export_run r on e.run_id = r.run_id
  where e.record_kind = 'checkpoint'), 'metadata_only', 'worker-only checkpoint bytes are not exported');
select is((select metadata->>'provenance' from internal.run_export_entries
  where record_id = '53810000-0003-4000-8000-000000000001'), 'legacy_unlinked',
  'unlinked legacy Markdown has explicit provenance');
select is((select metadata->>'sha256' from internal.run_export_entries e join export_run r on e.run_id = r.run_id
  where e.record_kind = 'stage_markdown'), encode(sha256(convert_to('# Exact Markdown', 'UTF8')), 'hex'),
  'exact Markdown retains the catalog digest');

select throws_ok($$insert into storage.objects(bucket_id, name, metadata)
  select 'workspace-run-exports', workspace_id::text || '/' || export_id::text || '/manifest.json', '{"size":11}'
  from export_claim$$, '23514', 'Run export object path is invalid.',
  'only content-addressed page and asset paths are admitted');
select throws_ok($$insert into storage.objects(bucket_id, name, metadata)
  select 'workspace-run-exports', '53810000-0004-4000-8000-000000000001/' || export_id::text
    || '/pages/1-' || repeat('a', 64) || '.json', '{"size":11}'
  from export_claim$$, '23514', 'Run export upload lease is inactive.',
  'a valid job ID cannot admit another workspace prefix');
select throws_ok($$select public.commit_run_export_page(export_id, lease_token, 1, repeat('a', 64), 11,
  '[{"ordinal":1,"availability":"available"}]') from export_claim$$,
  '23514', 'Run export page object is missing.', 'an upload must exist before a page can be recorded');

insert into storage.objects(bucket_id, name, metadata)
select 'workspace-run-exports', workspace_id::text || '/' || export_id::text || '/pages/1-'
  || repeat('a', 64) || '.json', '{"size":11}'
from export_claim;
select throws_ok($$select public.commit_run_export_page(export_id, lease_token, 1, repeat('a', 64), 11,
  '[{"ordinal":2,"availability":"available"},{"ordinal":2,"availability":"available"}]') from export_claim$$,
  '23514', 'Run export page omits or mislabels snapshot entries.',
  'a duplicate ordinal cannot hide an omitted entry');

-- A worker dies after writing its page object. Reclaim starts from the durable
-- cursor, recognizes the same immutable object and ignores a new source append.
update public.run_exports set lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select export_id from export_claim);
insert into public.agent_run_messages(id, agent_run_id, workspace_id, kind, message_md)
select '53810000-0002-4000-8000-000000000002', f.run_id, f.workspace_id, 'assistant', 'Post-snapshot note'
from export_run f;
create temp table resume_export_claim as select * from public.claim_run_export();
select isnt((select lease_token from resume_export_claim), (select lease_token from export_claim),
  'a restarted worker receives a new lease');
select is((select snapshot_at from resume_export_claim), (select snapshot_at from export_claim),
  'reclaim retains the initial snapshot timestamp');
select is((select count(*) from internal.run_export_entries
  where record_id = '53810000-0002-4000-8000-000000000002'), 0::bigint,
  'a post-snapshot source append stays out of the original roster');
select ok(not public.commit_run_export_page(export_id, lease_token, 1, repeat('a', 64), 11,
  '[{"ordinal":1,"availability":"available"}]'), 'the prior lease cannot commit even a valid page')
from export_claim;

select ok(public.commit_run_export_page(c.export_id, c.lease_token, 1, repeat('a', 64), 11,
  (select jsonb_agg(jsonb_build_object('ordinal', ordinal, 'availability', availability) order by ordinal)
    from first_export_page)), 'the resumed worker commits the exact prefix')
from resume_export_claim c;
select is((select next_ordinal from public.run_exports where id = (select export_id from resume_export_claim)),
  3::bigint, 'only the committed prefix moves the cursor');

create function pg_temp.commit_remaining_export(p_export_id uuid, p_lease_token uuid, p_workspace_id uuid)
returns integer language plpgsql as $$
declare
  entries jsonb;
  first_ordinal bigint;
  digest text;
  prefix text := p_workspace_id::text || '/' || p_export_id::text;
  pages integer := 0;
begin
  loop
    select min(r.ordinal), jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'ordinal', r.ordinal,
      'availability', case when r.availability <> 'recorded' then r.availability
        when r.source_asset_id in ('53810000-0001-4000-8000-000000000001',
          '53810000-0001-4000-8000-000000000004') then 'available' else 'missing' end,
      'asset_sha256', case when r.source_asset_id in ('53810000-0001-4000-8000-000000000001',
        '53810000-0001-4000-8000-000000000004') then r.metadata->>'sha256' end,
      'asset_size_bytes', case when r.source_asset_id in ('53810000-0001-4000-8000-000000000001',
        '53810000-0001-4000-8000-000000000004') then (r.metadata->>'size_bytes')::integer end,
      'asset_id', r.source_asset_id
    )) order by r.ordinal) into first_ordinal, entries
    from public.read_run_export_page(p_export_id, p_lease_token, 7) r;
    exit when first_ordinal is null;
    digest := encode(sha256(convert_to('page-' || first_ordinal::text, 'UTF8')), 'hex');
    insert into storage.objects(bucket_id, name, metadata)
    values ('workspace-run-exports', prefix || '/pages/' || first_ordinal::text || '-' || digest || '.json',
      '{"size":11}');
    insert into storage.objects(bucket_id, name, metadata)
    select 'workspace-run-exports', prefix || '/assets/' || (x->>'asset_id') || '-' || (x->>'asset_sha256'),
      '{"size":11}'::jsonb from jsonb_array_elements(entries) x where x->>'asset_sha256' is not null;
    if not public.commit_run_export_page(p_export_id, p_lease_token, first_ordinal, digest, 11, entries) then
      raise exception 'Export cursor did not advance';
    end if;
    pages := pages + 1;
  end loop;
  return pages;
end;
$$;

select cmp_ok(pg_temp.commit_remaining_export(c.export_id, c.lease_token, c.workspace_id), '>=', 2,
  'the resumed worker can enumerate every remaining roster page with labelled missing assets')
from resume_export_claim c;
select ok(public.complete_run_export(export_id, lease_token), 'a fully enumerated export completes')
from resume_export_claim;
select is((select sum(last_ordinal - first_ordinal + 1)::bigint from public.run_export_pages
  where export_id = (select id from export_request)),
  (select item_count from public.run_exports where id = (select export_id from resume_export_claim)),
  'manifest page descriptors cover the complete snapshot');
select is((select array_agg(asset_id order by asset_id) from public.run_export_assets
  where export_id = (select id from export_request)),
  array['53810000-0001-4000-8000-000000000001', '53810000-0001-4000-8000-000000000004']::uuid[],
  'only the verified copied assets get downloadable descriptors');

select throws_ok($$insert into storage.objects(bucket_id, name, metadata)
  select 'workspace-run-exports', workspace_id::text || '/' || export_id::text || '/pages/999-'
    || repeat('a', 64) || '.json', '{"size":11}' from export_claim$$, '23514',
  'Run export upload lease is inactive.', 'late storage writes are fenced after completion');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';
select is((select count(*) from storage.objects where bucket_id = 'workspace-run-exports'), 0::bigint,
  'even a workspace owner cannot read export objects directly through Storage');
reset role;
set local request.jwt.claim.role = 'service_role';

select is((select count(*) from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from export_request),
  'a1b2c3d4-0001-4000-8000-000000000001', '53810000-0006-4000-8000-000000000002'
)), 0::bigint, 'another user Auth session cannot authorize the owner export');
select is((select count(*) from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from export_request),
  'a1b2c3d4-0001-4000-8000-000000000001', '53810000-0006-4000-8000-000000000003'
)), 0::bigint, 'the export download denies an expired Auth session');

update public.workspace_members set role = 'admin'
where id = 'c1b2c3d4-0002-4000-8000-000000000002';
select is((select status from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from export_request),
  'a1b2c3d4-0002-4000-8000-000000000002', '53810000-0006-4000-8000-000000000002'
)), 'completed', 'an active workspace administrator can access a completed export');
update public.workspace_members set is_active = false
where id = 'c1b2c3d4-0002-4000-8000-000000000002';
select is((select count(*) from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from export_request),
  'a1b2c3d4-0002-4000-8000-000000000002', '53810000-0006-4000-8000-000000000002'
)), 0::bigint, 'membership revocation closes access immediately');

delete from auth.sessions where id = '53810000-0006-4000-8000-000000000001';
select is((select count(*) from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from export_request),
  'a1b2c3d4-0001-4000-8000-000000000001', '53810000-0006-4000-8000-000000000001'
)), 0::bigint, 'deletion of the current Auth session immediately revokes private downloads');
insert into auth.sessions(id, user_id) values
  ('53810000-0006-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001');

create temp table foreign_request as select * from public.request_run_export(
  '53810000-0004-4000-8000-000000000001', 'a1b2c3d4-0002-4000-8000-000000000002',
  '53810000-0005-4000-8000-000000000003'
);
create temp table foreign_claim as select * from public.claim_run_export();
select is((select item_count from public.run_exports where id = (select id from foreign_request)),
  0::bigint, 'the foreign workspace snapshot excludes all of the first workspace');
insert into storage.objects(bucket_id, name, metadata)
select 'workspace-run-exports', workspace_id::text || '/' || export_id::text || '/pages/1-'
  || repeat('a', 64) || '.json', '{"size":11}'
from foreign_claim;
select ok(public.complete_run_export(export_id, lease_token), 'an empty snapshot completes with zero committed pages')
from foreign_claim;

insert into public.session_validation_asset_withholdings(asset_id, state)
values ('53810000-0001-4000-8000-000000000001', 'redacted');
select is((select status from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from export_request),
  'a1b2c3d4-0001-4000-8000-000000000001', '53810000-0006-4000-8000-000000000001'
)), 'expired', 'a new source withholding revokes an already completed export');
select is((select status from public.run_exports where id = (select id from foreign_request)), 'completed',
  'source withholding cannot revoke another workspace');
select is((select export_id from public.list_run_export_cleanup(1)), (select id from export_request),
  'a revoked export is immediately eligible for physical cleanup');
select ok(not public.finish_run_export_cleanup(export_id, workspace_id),
  'failed object cleanup retains the cleanup obligation') from export_claim;

create temp table other_cleanup_request as select * from public.request_run_export(
  '53810000-0004-4000-8000-000000000001', 'a1b2c3d4-0002-4000-8000-000000000002',
  '53810000-0005-4000-8000-000000000006'
);
update public.run_exports set expires_at = clock_timestamp() - interval '1 second'
where id = (select id from other_cleanup_request);
select is((select export_id from public.list_run_export_cleanup(1)), (select id from other_cleanup_request),
  'a failing oldest prefix cannot monopolize the next bounded cleanup claim');
select ok(public.finish_run_export_cleanup(id, workspace_id), 'the unrelated empty prefix is finalized')
from other_cleanup_request;
update public.run_exports set ready_at = clock_timestamp() - interval '1 second'
where id = (select id from export_request);
select is((select export_id from public.list_run_export_cleanup(1)), (select id from export_request),
  'a failed cleanup becomes eligible again after its retry delay');

delete from storage.objects where bucket_id = 'workspace-run-exports'
  and name like (select workspace_id::text || '/' || export_id::text || '/%' from export_claim);
select ok(public.finish_run_export_cleanup(export_id, workspace_id), 'retry finalizes an empty prefix')
from export_claim;
select ok(public.finish_run_export_cleanup(export_id, workspace_id), 'cleanup is idempotent')
from export_claim;
select is((select count(*) from storage.objects where bucket_id = 'workspace-run-exports'
  and name like '53810000-0004-4000-8000-000000000001/%'), 1::bigint, 'unrelated workspace objects survive cleanup');
select is((select count(*) from public.run_export_pages where export_id = (select id from export_request)),
  0::bigint, 'expired manifest page descriptors are purged');
select is((select count(*) from internal.run_export_entries
  where export_id = (select id from export_request)), 0::bigint, 'the expired export roster is purged');

select public.begin_workspace_deletion('53810000-0004-4000-8000-000000000001',
  '53810000-0004-4000-8000-000000000002', 'Foreign exports fixture');
select is((select count(*) from public.get_run_export_access(
  '53810000-0004-4000-8000-000000000001', (select id from foreign_request),
  'a1b2c3d4-0002-4000-8000-000000000002', '53810000-0006-4000-8000-000000000002'
)), 0::bigint, 'workspace deletion fences previously published export access');
select ok(not public.finish_workspace_deletion('53810000-0004-4000-8000-000000000001'),
  'workspace deletion waits for even uncommitted export objects');
delete from storage.objects where bucket_id = 'workspace-run-exports'
  and name like '53810000-0004-4000-8000-000000000001/%';
select ok(public.finish_workspace_deletion('53810000-0004-4000-8000-000000000001'),
  'workspace deletion completes after removing the exact export prefix');
select is((select count(*) from public.run_exports where id = (select id from foreign_request)),
  0::bigint, 'workspace deletion cascades to the export job');

-- A finite source deadline bounds an already-completed export even if the
-- evidence clean-up daemon has not yet swept the source object.
select public.save_workspace_run_retention(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001', null, 1);
create temp table finite_request as select * from public.request_run_export(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001',
  '53810000-0005-4000-8000-000000000004'
);
create temp table finite_claim as select * from public.claim_run_export();
create temp table source_deadline as select greatest(r.finished_at, e.created_at) + interval '24 hours' as deadline
from export_run f join public.agent_runs r on r.id = f.run_id
join public.session_validation_evidence e on e.run_id = r.id;
select is((select j.source_expires_at from public.run_exports j join finite_claim c on c.export_id = j.id),
  (select deadline from source_deadline), 'the nearest eligible source cutoff is cached during snapshot');
select pg_temp.commit_remaining_export(c.export_id, c.lease_token, c.workspace_id) from finite_claim c;
select ok(public.complete_run_export(export_id, lease_token), 'finite source lifetime still allows completion')
from finite_claim;
select is((select j.expires_at from public.run_exports j join finite_claim c on c.export_id = j.id),
  (select deadline from source_deadline), 'completion clamps the usual week to the source cutoff');

update public.run_exports set source_expires_at = clock_timestamp() - interval '1 second'
where id = (select id from finite_request);
select is((select status from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from finite_request),
  'a1b2c3d4-0001-4000-8000-000000000001', '53810000-0006-4000-8000-000000000001'
)), 'expired', 'natural source expiry denies access before the worker marks the source');
select is((public.request_run_export(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001',
  '53810000-0005-4000-8000-000000000004'
)).status, 'expired', 'idempotent request replay observes the same expiry');
select is((select export_id from public.list_run_export_cleanup(1)), (select id from finite_request),
  'natural source expiry schedules export cleanup without a withholding sweep');

insert into public.session_validation_asset_withholdings(asset_id, state)
values ('53810000-0001-4000-8000-000000000002', 'expired');
create temp table archive_request as select * from public.request_run_export(
  'b1b2c3d4-0001-4000-8000-000000000001', 'a1b2c3d4-0001-4000-8000-000000000001',
  '53810000-0005-4000-8000-000000000005'
);
create temp table archive_claim as select * from public.claim_run_export();
select pg_temp.commit_remaining_export(c.export_id, c.lease_token, c.workspace_id) from archive_claim c;
select ok(public.complete_run_export(export_id, lease_token), 'required active evidence keeps the export available')
from archive_claim;
select is((select j.expires_at - j.completed_at from public.run_exports j join archive_claim c on c.export_id = j.id),
  interval '168 hours', 'protected required evidence alone preserves a full export lifetime');

update public.sessions set archived_at = clock_timestamp() where id = (select session_id from export_run);
select is((select expires_at from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from archive_request),
  'a1b2c3d4-0001-4000-8000-000000000001', '53810000-0006-4000-8000-000000000001'
)), (select deadline from source_deadline), 'a later archive bounds exports of previously protected evidence');

update public.sessions set archived_at = null where id = (select session_id from export_run);
select is((select expires_at from public.get_run_export_access(
  'b1b2c3d4-0001-4000-8000-000000000001', (select id from archive_request),
  'a1b2c3d4-0001-4000-8000-000000000001', '53810000-0006-4000-8000-000000000001'
)), (select deadline from source_deadline), 'restoring a session cannot reopen the earlier export lifetime');

select * from finish();
rollback;
