begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into internal.workspace_issue_counters as counters (workspace_id, last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, coalesce(max(number), 0)
from public.sessions where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
on conflict (workspace_id) do update
set last_issue_number = greatest(counters.last_issue_number, excluded.last_issue_number);

create function pg_temp.start_artifact_run(label text)
returns table (session_id uuid, job_id uuid, run_id uuid) language plpgsql as $$
declare fixture record; owner public.sessions; started uuid;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
    label, 'Artifact catalog fixture', 'codex', 'gpt-5.5', null, null,
    '12b2c3d4-0001-4000-8000-000000000001', null);
  select * into owner from public.sessions s where s.id = fixture.session_id;
  update public.agent_jobs set git_continuity_release_revision = (
    select revision from public.get_git_continuity_release_state()
  ), status = 'running', attempt_count = 1 where id = fixture.job_id;
  started := public.start_session_job_attempt(
    fixture.job_id, 1, owner.current_stage_id, owner.current_artifact_version,
    'codex', 'gpt-5.5', 'project', 'wallie/artifact-catalog-' || fixture.job_id::text);
  perform public.pin_session_job_git_input(fixture.job_id, 1, started,
    '12b2c3d4-0001-4000-8000-000000000001', 'main', repeat('a', 40));
  return query select fixture.session_id, fixture.job_id, started;
end;
$$;

create function pg_temp.finish_artifact_run(target_run uuid, head text, markdown text)
returns uuid language plpgsql as $$
declare r public.agent_runs; prepared boolean; claim uuid; retained text;
begin
  select * into strict r from public.agent_runs where id = target_run;
  prepared := public.prepare_session_source_and_checkpoint_publication(
    r.id, '12b2c3d4-0001-4000-8000-000000000001', 'main', repeat('a', 40), head,
    'Fixture retained source', 'Private draft source', '',
    case when head <> repeat('a', 40)
      then encode(sha256(convert_to('private source fixture', 'UTF8')), 'hex') else '' end,
    case when head <> repeat('a', 40)
      then encode(convert_to('private source fixture', 'UTF8'), 'base64') else '' end,
    0, markdown);
  claim := public.claim_session_checkpoint_publication(r.id);
  select retained_ref into retained from public.session_checkpoint_publications where run_id = r.id;
  if not prepared or claim is null or not public.adopt_session_checkpoint_publication(
    r.id, claim, retained, case when retained is not null then head end
  ) then raise exception 'Could not publish the fixture checkpoint'; end if;
  return (select c.artifact_id from public.session_git_checkpoints c where c.run_id = r.id);
end;
$$;

create temp table catalog_fixture as select * from pg_temp.start_artifact_run('Exact durable history');
create temp table catalog_mismatch as select * from pg_temp.start_artifact_run('Unmatched validation');
create temp table catalog_oversized as select * from pg_temp.start_artifact_run('Oversized Markdown');
create temp table catalog_wrong_attempt as select * from pg_temp.start_artifact_run('Wrong attempt receipt');
create temp table catalog_tree_mismatch as select * from pg_temp.start_artifact_run('Wrong validation tree');

create temp table catalog_assets as
select ('53600000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid as id,
  case when n = 1 then 'tests/log' else 'tests/report-' || lpad(n::text, 3, '0') end as key,
  case when n = 1 then 'log' else 'report' end as kind,
  'b1b2c3d4-0001-4000-8000-000000000001/' || f.run_id::text || '/53600000-0000-4000-8000-'
    || lpad(n::text, 12, '0') as path
from catalog_fixture f cross join generate_series(1, 55) n;
insert into storage.objects (bucket_id, name, metadata)
select 'session-validation-evidence', path, '{"size":20,"mimetype":"text/plain"}'
from catalog_assets;

create temp table catalog_observed as select * from public.record_session_validation_evidence(
  (select f.run_id from catalog_fixture f), repeat('b', 40), repeat('c', 40), '[]'::jsonb,
  (select jsonb_agg(jsonb_build_object('id', a.id, 'key', a.key, 'kind', a.kind, 'required', false,
    'storagePath', a.path, 'sha256', repeat('e', 64), 'contentType', 'text/plain', 'sizeBytes', 20))
  from catalog_assets a)
);
create temp table catalog_observed_mismatch as select * from public.record_session_validation_evidence(
  (select f.run_id from catalog_mismatch f), repeat('c', 40), repeat('d', 40), '[]'::jsonb
);
create temp table catalog_frozen_plan as select * from public.pin_session_validation_plan(
  (select f.run_id from catalog_tree_mismatch f), repeat('b', 40), repeat('c', 40),
  '{"version":1,"commands":[]}'::jsonb
);
create temp table catalog_wrong_tree_receipt as select * from public.record_session_validation_evidence(
  (select f.run_id from catalog_tree_mismatch f), repeat('b', 40), repeat('d', 40), '[]'::jsonb
);
create temp table catalog_tree_published as
select pg_temp.finish_artifact_run(run_id, repeat('b', 40), '# Wrong evidence tree')
from catalog_tree_mismatch;
create temp table catalog_accepted as
select pg_temp.finish_artifact_run(run_id, repeat('b', 40), '# Reviewed 🔍') as id from catalog_fixture;
create temp table catalog_accepted_mismatch as
select pg_temp.finish_artifact_run(run_id, repeat('b', 40), '# Independently reviewed') as id
from catalog_mismatch;
create temp table catalog_accepted_oversized as
select pg_temp.finish_artifact_run(run_id, repeat('a', 40), repeat('界', 349526)) as id
from catalog_oversized;

-- A forged historical fixture models badly associated legacy metadata, rather
-- than weakening the trusted writer to create an otherwise impossible receipt.
insert into public.session_validation_evidence
  (run_id, workspace_id, session_id, job_id, attempt_count, repository_id,
   repository_full_name, commit_sha, validation_tree_sha, records, assets)
select run_id, 'b1b2c3d4-0001-4000-8000-000000000001', session_id, job_id, 2,
  '12b2c3d4-0001-4000-8000-000000000001', 'fixture/history',
  repeat('b', 40), repeat('c', 40), '[]'::jsonb, '[]'::jsonb
from catalog_wrong_attempt;
insert into storage.objects (bucket_id, name, metadata)
select 'session-validation-evidence',
  'b1b2c3d4-0001-4000-8000-000000000001/' || run_id::text || '/53600000-0000-4000-8000-000000000098',
  '{"size":20,"mimetype":"text/plain"}'
from catalog_wrong_attempt;
insert into public.session_validation_assets
  (id, run_id, workspace_id, session_id, evidence_key, kind, required, storage_path,
   sha256, content_type, size_bytes)
select '53600000-0000-4000-8000-000000000098', run_id, 'b1b2c3d4-0001-4000-8000-000000000001',
  session_id, 'tests/wrong-attempt', 'report', false,
  'b1b2c3d4-0001-4000-8000-000000000001/' || run_id::text || '/53600000-0000-4000-8000-000000000098',
  repeat('e', 64), 'text/plain', 20
from catalog_wrong_attempt;

insert into auth.users (id, email) values
  ('53600000-0000-4000-8000-000000000100', 'artifact-catalog-outsider@example.test');
insert into public.workspaces (id, slug, name) values
  ('53600000-0000-4000-8000-000000000099', 'artifact-catalog-foreign', 'Other workspace');
insert into public.workspace_members (workspace_id, user_id, kind, role) values
  ('53600000-0000-4000-8000-000000000099', '53600000-0000-4000-8000-000000000100', 'human', 'owner');

set local role service_role;
insert into public.session_validation_asset_withholdings (asset_id, state) values
  ('53600000-0000-4000-8000-000000000002', 'redacted'),
  ('53600000-0000-4000-8000-000000000003', 'expired');
reset role;

select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where
  oid = 'public.list_run_artifacts(uuid,uuid,text,uuid,text,uuid,integer)'::regprocedure),
  'catalog is security invoker with an empty search path');
select ok(not has_function_privilege(role_name,
  'public.list_run_artifacts(uuid,uuid,text,uuid,text,uuid,integer)', 'EXECUTE'),
  role_name || ' has no catalog execute grant') from (values ('anon'), ('service_role')) roles(role_name);
select ok(not has_table_privilege('authenticated', 'public.session_validation_asset_withholdings', 'INSERT')
  and not has_table_privilege('service_role', 'public.session_validation_asset_withholdings', 'UPDATE')
  and not has_table_privilege('service_role', 'public.session_validation_asset_withholdings', 'DELETE'),
  'only trusted inserts may record a permanent withholding');

grant select on catalog_fixture, catalog_mismatch, catalog_oversized, catalog_wrong_attempt, catalog_tree_mismatch,
  catalog_accepted, catalog_accepted_mismatch, catalog_accepted_oversized, catalog_assets to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';

create temp table catalog_first as
select * from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
  (select run_id from catalog_fixture), p_limit => 4);
select is((select array_agg(artifact_kind order by artifact_kind collate "C", artifact_id)
  from catalog_first), array['checkpoint','stage_markdown','validation_log','validation_report'],
  'one bounded page combines accepted Markdown, checkpoint, log and reports in stable order');
select ok((select bool_and(attempt_count = 1 and catalog_first.run_id = x.run_id and catalog_first.session_id = x.session_id
    and checkpoint_run_id = x.run_id and validation_run_id = x.run_id
    and accepted_commit_sha = repeat('b', 40) and validation_commit_sha = repeat('b', 40)
    and validation_tree_sha = repeat('c', 40))
  from catalog_first cross join lateral (select f.run_id, f.session_id from catalog_fixture f) x
  where catalog_first.run_id = x.run_id and catalog_first.session_id = x.session_id),
  'all metadata binds to the producing attempt and matching accepted source and tree');
select ok((select artifact_id = (select id from catalog_accepted) and availability = 'available'
    and digest = encode(sha256(convert_to('# Reviewed 🔍', 'UTF8')), 'hex')
    and digest_algorithm = 'sha256' and content_type = 'text/markdown'
    and size_bytes = octet_length('# Reviewed 🔍') and downloadable
  from catalog_first where artifact_kind = 'stage_markdown'),
  'Markdown metadata hashes the exact downloadable UTF-8 bytes, without JSON quoting');
select ok((select availability = 'retained' and not downloadable and digest_algorithm = 'sha256'
  and digest = encode(sha256(convert_to('private source fixture', 'UTF8')), 'hex')
  from catalog_first where artifact_kind = 'checkpoint'),
  'checkpoint metadata carries bundle digest while source bytes remain private');
select ok((select availability = 'recorded' and downloadable and digest = repeat('e', 64)
  and size_bytes = 20 and content_type = 'text/plain' and validation_tree_sha = repeat('c', 40)
  from catalog_first where artifact_kind = 'validation_log'),
  'validation metadata records the manifest and does not imply verified bytes');
select ok((select octet_length(jsonb_agg(to_jsonb(entry))::text) < 8192
    and jsonb_agg(to_jsonb(entry))::text not like '%Private draft source%'
    and jsonb_agg(to_jsonb(entry))::text not like '%# Reviewed%'
    and jsonb_agg(to_jsonb(entry))::text not like '%storage_path%'
  from catalog_first entry), 'bounded metadata excludes body, path and private source');

select is((select array_agg(artifact_id order by artifact_id)
  from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001', (select run_id from catalog_fixture),
    p_after_kind => 'validation_report', p_after_id => '53600000-0000-4000-8000-000000000002', p_limit => 2)),
  array['53600000-0000-4000-8000-000000000003','53600000-0000-4000-8000-000000000004']::uuid[],
  'keyset cursor resumes after the exact final kind and UUID');
select is((select count(*) from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
  (select run_id from catalog_fixture), p_limit => 999)), 51::bigint, 'limit is capped at 51 rows');
select is((select count(*) from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
  (select run_id from catalog_fixture), p_limit => null)), 21::bigint, 'default includes one pagination sentinel row');
select is((select count(*) from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
  (select run_id from catalog_fixture), p_limit => 0)), 1::bigint, 'nonpositive limit remains bounded');
select throws_ok($$select * from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
  (select run_id from catalog_fixture), p_after_kind => 'checkpoint')$$,
  '22023', 'Invalid run artifact catalog filters.', 'partial cursors cannot return an unintended page');

select is((select count(*) from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
  (select run_id from catalog_mismatch), p_kind => 'stage_markdown', p_artifact_id => (select id from catalog_accepted))),
  0::bigint, 'same-workspace artifact ID from another execution cannot be substituted');
select ok((select validation_run_id is null and validation_tree_sha is null and validation_commit_sha is null
  from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
    (select run_id from catalog_mismatch), p_kind => 'stage_markdown', p_artifact_id => (select id from catalog_accepted_mismatch))),
  'different receipt commit cannot be attributed to the accepted checkpoint');
select ok((select validation_run_id is null and validation_tree_sha is null
  from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
    (select run_id from catalog_tree_mismatch), p_kind => 'checkpoint')),
  'matching commit with a different pinned-plan tree cannot be attributed to the accepted checkpoint');
select is((select count(*) from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
  (select run_id from catalog_wrong_attempt))), 0::bigint, 'a mismatched attempt receipt does not expose its content');
select is((select count(*) from storage.objects
  where bucket_id = 'session-validation-evidence' and name like '%53600000-0000-4000-8000-000000000098'),
  0::bigint, 'direct storage reads also require exact receipt ownership');

select ok((select availability = 'inaccessible' and digest is null and not downloadable
    and size_bytes = 1048578
  from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
    (select run_id from catalog_oversized), p_kind => 'stage_markdown')),
  'oversized historical Markdown is catalogued without an unbounded read');
select ok((select digest = repeat('a', 40) and digest_algorithm = 'git_sha1' and not downloadable
  from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
    (select run_id from catalog_oversized), p_kind => 'checkpoint')), 'no-code checkpoint retains its Git identity');

select is((select array_agg(availability order by artifact_id)
  from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
    (select run_id from catalog_fixture), p_kind => 'validation_report', p_limit => 3)),
  array['redacted','expired','recorded'], 'authoritative withholdings remain distinct from recorded assets');
select ok((select not bool_or(downloadable)
  from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
    (select run_id from catalog_fixture), p_kind => 'validation_report', p_limit => 2)), 'withheld rows have no download');
select is((select count(*) from storage.objects
  where bucket_id = 'session-validation-evidence' and name in (select path from catalog_assets)), 53::bigint,
  'withholding blocks both exact object paths via private storage RLS');
select is((select count(*) from public.session_validation_asset_withholdings), 2::bigint,
  'workspace members can read withdrawal metadata, even though its bytes stay private');
select throws_ok($$select * from public.list_run_artifacts('53600000-0000-4000-8000-000000000099',
  (select run_id from catalog_fixture))$$, 'P0002', 'Run artifact workspace is unavailable.',
  'foreign workspace IDs disclose no catalog metadata');

set local request.jwt.claim.sub = '53600000-0000-4000-8000-000000000100';
select is((select count(*) from public.session_validation_asset_withholdings), 0::bigint,
  'nonmembers cannot inspect which assets are withheld');
select is((select count(*) from storage.objects
  where bucket_id = 'session-validation-evidence' and name in (select path from catalog_assets)), 0::bigint,
  'nonmembers cannot read persisted evidence objects');
select is((select count(*) from public.list_run_artifacts('53600000-0000-4000-8000-000000000099',
  (select run_id from catalog_fixture))), 0::bigint, 'a run ID from another tenant cannot pivot into its catalog');

reset role;
set local request.jwt.claim.role = 'service_role';
update public.workspaces set deletion_requested_at = clock_timestamp()
  where id = 'b1b2c3d4-0001-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';
select throws_ok($$select * from public.list_run_artifacts('b1b2c3d4-0001-4000-8000-000000000001',
  (select run_id from catalog_fixture))$$, 'P0002', 'Run artifact workspace is unavailable.',
  'a deleting workspace cannot serve catalog rows');
select is((select count(*) from storage.objects
  where bucket_id = 'session-validation-evidence' and name in (select path from catalog_assets)), 0::bigint,
  'a deleting workspace cannot serve previously authorized storage paths');

select * from finish();
rollback;
