begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

insert into internal.workspace_issue_counters as counters (workspace_id, last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, coalesce(max(number), 0)
from public.sessions where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
on conflict (workspace_id) do update set last_issue_number = greatest(counters.last_issue_number, excluded.last_issue_number);

create function pg_temp.manifest_fixture(label text, existing_predecessor boolean default false)
returns table(session_id uuid, job_id uuid, run_id uuid) language plpgsql as $$
declare fixture record; owner public.sessions; started uuid; selected uuid[];
begin
  if existing_predecessor then
    select array[s.id] into strict selected from public.pipeline_stages s join public.pipelines p on p.id = s.pipeline_id
      where p.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001' and p.is_default and s.slug = 'build';
  end if;
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
    label, 'Manifest fixture', 'codex', 'gpt-5.5',
    session_github_repository_id => '12b2c3d4-0001-4000-8000-000000000001', selected_stage_ids => selected);
  select * into owner from public.sessions s where s.id = fixture.session_id;
  update public.agent_jobs j set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = 1 where j.id = fixture.job_id;
  started := public.start_session_job_attempt(fixture.job_id, 1, owner.current_stage_id, owner.current_artifact_version,
    'codex', 'gpt-5.5', 'project', 'wallie/manifest-' || fixture.job_id::text);
  perform public.pin_session_job_git_input(fixture.job_id, 1, started,
    '12b2c3d4-0001-4000-8000-000000000001', 'main', repeat('a', 40));
  return query select fixture.session_id, fixture.job_id, started;
end;
$$;
create function pg_temp.pin_manifest(job_id uuid, run_id uuid, predecessors jsonb default '[]',
  prompt_digest text default repeat('b', 64), checkout_sha text default repeat('a', 40), attempt integer default 1,
  member_id uuid default 'c1b2c3d4-0001-4000-8000-000000000001') returns boolean language sql as $$
  select public.pin_session_attempt_manifest(job_id, run_id, attempt, prompt_digest, 24, 1,
    checkout_sha, predecessors, 'workerd', 7, 'high', member_id);
$$;
create temp table legacy as select * from pg_temp.manifest_fixture('Legacy manifest');

select is(pg_temp.pin_manifest(job_id, gen_random_uuid()), false, 'a different run cannot pin the claim') from legacy;
select is(pg_temp.pin_manifest(job_id, run_id, attempt => 2), false, 'a stale attempt cannot pin the claim') from legacy;
select is(pg_temp.pin_manifest(job_id, run_id, member_id => null), false, 'a changed credential owner selector loses the fence') from legacy;
select throws_ok($$select pg_temp.pin_manifest(job_id,run_id,prompt_digest => 'invalid') from legacy$$, '23514',
  'Invalid attempt input manifest.', 'the manifest accepts only prompt digest metadata');
select throws_ok($$select pg_temp.pin_manifest(job_id,run_id,checkout_sha => repeat('d',40)) from legacy$$, '23514',
  'The checkout does not match the attempt source input.', 'an unrelated checkout cannot be recorded');
select ok(pg_temp.pin_manifest(job_id, run_id), 'the exact run can pin its inputs') from legacy;
create temp table first_manifest as select m.* from public.session_attempt_manifests m join legacy l using (run_id);
select ok(pg_temp.pin_manifest(job_id, run_id), 'the same input envelope can be replayed') from legacy;
select is(m.created_at, first_manifest.created_at, 'an exact replay preserves the original receipt')
  from public.session_attempt_manifests m join first_manifest using (run_id);
select throws_ok($$select pg_temp.pin_manifest(job_id,run_id,prompt_digest => repeat('c',64)) from legacy$$, 'PT409',
  'Attempt inputs have already been pinned.', 'an active attempt cannot repin a different prompt');
select is(definition_provenance, 'legacy', 'legacy runs do not claim an admitted definition') from first_manifest;
select is(prompt_utf8_bytes, 24, 'the manifest retains the UTF-8 prompt length') from first_manifest;
select is(checkout_sha, repeat('a',40), 'the persisted checkout binds to exact pinned source') from first_manifest;
select is(model_name, 'gpt-5.5', 'the manifest copies the actual run model') from first_manifest;
select is(credential_owner_member_id, 'c1b2c3d4-0001-4000-8000-000000000001'::uuid,
  'the manifest retains the actual credential selector') from first_manifest;

with definition as (
  select f.workspace_id, f.id as factory_id,
    '{"schemaVersion":1,"kind":"serial","skillIds":["skill-test"],"toolIds":["tool-test"],"executionPolicyRevisionId":null,"deliveryPolicyRevisionId":"54100000-0000-4000-8000-000000000001"}'::text as body
  from public.factories f
  where f.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001' and f.is_default
), revision as (
  insert into public.factory_definition_revisions (workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by)
  select workspace_id, factory_id, 1, body, encode(sha256(convert_to(body,'UTF8')),'hex'),
    'c1b2c3d4-0001-4000-8000-000000000001' from definition
  returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations (workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, created_by from revision;

create temp table approval_target as select * from pg_temp.manifest_fixture('Manifest with exact predecessor', true);
create temp table legacy_target as select * from pg_temp.manifest_fixture('Manifest with older predecessor', true);
insert into public.session_phase_completions (workspace_id, session_id, stage_id, stage_slug, completed_by_member_id)
select owner.workspace_id, owner.id, stage.id, stage.slug, owner.creator_member_id
from public.sessions owner join public.pipeline_stages stage on stage.pipeline_id = owner.pipeline_id and stage.slug = 'plan'
where owner.id in (select session_id from approval_target union all select session_id from legacy_target);

insert into public.session_artifacts (workspace_id, session_id, stage_id, stage_slug, version, artifact_json)
select c.workspace_id, c.session_id, c.stage_id, c.stage_slug, v.version, to_jsonb(v.body)
from public.session_phase_completions c join approval_target a using (session_id)
cross join (values (1, 'The approved plan λ'), (2, 'A later retained version')) as v(version,body);
insert into public.session_stage_approval_receipts (
  workspace_id, session_id, completion_id, stage_id, artifact_id, artifact_version, artifact_digest, approved_by_member_id
)
select c.workspace_id, c.session_id, c.id, c.stage_id, a.id, a.version,
  encode(sha256(convert_to(a.artifact_json #>> '{}','UTF8')),'hex'), c.completed_by_member_id
from public.session_artifacts a join public.session_phase_completions c using (workspace_id, session_id, stage_id)
join approval_target target using (session_id)
where a.version = 1;

create temp table exact_input as
select jsonb_build_array(jsonb_build_object('status','approved','stageId',r.stage_id,'stageSlug','plan',
  'approvalReceiptId',r.id,'artifactId',r.artifact_id,'artifactVersion',r.artifact_version,'artifactDigest',r.artifact_digest)) as value
from public.session_stage_approval_receipts r join approval_target target using (session_id);
create temp table legacy_input as
select jsonb_build_array(jsonb_build_object('status','legacy_unverified','stageId',c.stage_id,'stageSlug',c.stage_slug)) as value
from public.session_phase_completions c join legacy_target target using (session_id);

select throws_ok($$select pg_temp.pin_manifest(job_id,run_id,jsonb_set(exact_input.value,'{0,artifactVersion}','2'))
  from approval_target cross join exact_input$$, '23514', 'The predecessor is not the exact approved artifact.',
  'a newer unapproved artifact version cannot replace the reviewed version');
select throws_ok($$select pg_temp.pin_manifest(job_id,run_id,jsonb_set(exact_input.value,'{0,artifactText}','"private body"'))
  from approval_target cross join exact_input$$, '23514', 'The predecessor is not the exact approved artifact.',
  'predecessor metadata cannot persist raw artifact text');
select throws_ok($$select pg_temp.pin_manifest(job_id,run_id,legacy_input.value)
  from approval_target cross join legacy_input$$, '23514', 'The predecessor has no matching unverified legacy completion.',
  'a known exact approval cannot be downgraded to unverified');
select throws_ok($$select pg_temp.pin_manifest(job_id,run_id,exact_input.value)
  from legacy_target cross join exact_input$$, '23514', 'The predecessor is not the exact approved artifact.',
  'an approval receipt cannot cross sessions');
update public.pipeline_stages set slug = 'plan-renamed'
where id = (select (value #>> '{0,stageId}')::uuid from exact_input);
select ok(pg_temp.pin_manifest(job_id,run_id,legacy_input.value), 'a legacy completion can keep the prompt key captured before a rename')
  from legacy_target cross join legacy_input;
select ok(pg_temp.pin_manifest(job_id,run_id,exact_input.value), 'the exact approval is pinned with the actual attempt')
  from approval_target cross join exact_input;
select is(m.predecessors, exact_input.value, 'the manifest freezes the reviewed artifact and pre-rename prompt key')
  from public.session_attempt_manifests m join approval_target using (run_id) cross join exact_input;
select is(m.definition_digest, revision.canonical_digest, 'the admitted definition digest is copied from the immutable revision')
  from public.session_attempt_manifests m join approval_target using (run_id)
  join public.factory_definition_revisions revision on revision.id = m.definition_revision_id;
select is(m.definition_skill_ids, array['skill-test'], 'resolved skills are copied from the admitted definition')
  from public.session_attempt_manifests m join approval_target using (run_id);
select is(m.definition_delivery_policy_revision_id, '54100000-0000-4000-8000-000000000001'::uuid,
  'the manifest preserves the delivery policy reference from the definition')
  from public.session_attempt_manifests m join approval_target using (run_id);

select throws_ok($$update public.session_attempt_manifests set prompt_utf8_bytes = 99$$, '23514',
  null, 'privileged SQL cannot rewrite attempt manifests');
select throws_ok($$delete from public.session_attempt_manifests$$, '23514',
  null, 'privileged SQL cannot erase attempt manifests');

set local role service_role;
select is((select count(*) from public.session_attempt_manifests), 3::bigint, 'service readers can inspect dispatch receipts');
select throws_ok($$insert into public.session_attempt_manifests select * from public.session_attempt_manifests limit 1$$,
  '42501', null, 'service writers must use the fenced RPC');
reset role;
set local role authenticated;
select throws_ok($$select * from public.session_attempt_manifests$$, '42501', null, 'the browser cannot read internal receipts');
reset role;

select lives_ok($$delete from public.sessions where id = (select session_id from legacy)$$,
  'owning-session deletion cascades immutable manifests');
select is((select count(*) from public.session_attempt_manifests m join legacy using (run_id)), 0::bigint,
  'a deleted session retains no manifests');
select * from finish();
rollback;
