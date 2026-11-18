begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
select public.set_git_continuity_release(true, revision, 'Pinned dispatch fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into internal.workspace_issue_counters as counters (workspace_id, last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, coalesce(max(number), 0)
from public.sessions where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
on conflict (workspace_id) do update set last_issue_number = greatest(counters.last_issue_number, excluded.last_issue_number);

create function pg_temp.manifest_fixture(label text, existing_predecessor boolean default false)
returns table(session_id uuid, job_id uuid, run_id uuid) language plpgsql as $$
declare fixture record; owner public.sessions; started uuid; build public.pipeline_stages;
begin
  select * into strict fixture from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
    label, 'Manifest fixture', 'codex', 'gpt-5.5',
    session_github_repository_id => '12b2c3d4-0001-4000-8000-000000000001');
  if existing_predecessor then
    -- These manifest checks start at build with prearranged approval history.
    -- The transition suite exercises advancing there through the approval RPC.
    select stage.* into strict build from public.pipeline_stages stage
      join public.sessions session on session.pipeline_id = stage.pipeline_id
      where session.id = fixture.session_id and stage.slug = 'build';
    update public.sessions set current_stage_id = build.id where id = fixture.session_id;
    update public.agent_jobs set stage_id = build.id, stage_slug = build.slug, stage_name = build.name where id = fixture.job_id;
    update public.agent_runs set stage_id = build.id, stage_slug = build.slug, stage_name = build.name where id = fixture.run_id;
  end if;
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
  member_id uuid default 'c1b2c3d4-0001-4000-8000-000000000001', renderer integer default 3)
returns boolean language sql as $$
  select public.pin_session_attempt_manifest(job_id, run_id, attempt, prompt_digest, 24, renderer,
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

insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values ('a1b2c3d4-0001-4000-8000-000000000001', 'platform_api_key', 'manifest-test-ciphertext')
on conflict (user_id) do nothing;
insert into public.delivery_policy_revisions(id, workspace_id, pipeline_id, revision, requirements, created_by)
values ('54100000-0000-4000-8000-000000000001', 'b1b2c3d4-0001-4000-8000-000000000001',
  'd1b2c3d4-0001-4000-8000-000000000001', 54101,
  '{"version":1,"deliveryMode":"code","requireCodeOwnerReview":false,"requireResolvedThreads":false,"requireArtifactApprovalForDelivery":false,"minimumApprovals":0,"freshnessSeconds":60,"requiredChecks":[],"requiredEvidence":[]}',
  'c1b2c3d4-0001-4000-8000-000000000001');
create temporary table manifest_skill as
select revision.id
from public.factory_skill_revisions revision
join public.factory_skills skill on skill.id = revision.skill_id
join public.factories factory on factory.id = revision.factory_id
where factory.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
  and factory.is_default and skill.slug = 'commit' and revision.revision_number = 1;

with definition as (
  select f.workspace_id, f.id as factory_id, jsonb_build_object(
    'schemaVersion',1,'kind','serial','pipelineId',p.id,'repositoryId','12b2c3d4-0001-4000-8000-000000000001',
    'sandboxProvider','e2b','executionPolicyRevisionId',null,'deliveryPolicyRevisionId','54100000-0000-4000-8000-000000000001',
    'skillIds',jsonb_build_array((select id from manifest_skill)),'toolIds',jsonb_build_array('tool-test'),
    'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
    'agent',jsonb_build_object('provider','codex','model','gpt-5.5','effort','high','maxTurns',7,
      'concurrencyLimit',1,'maxRetries',1,'stallTimeoutMs',720000),
    'stages',(select jsonb_agg(jsonb_build_object('id',s.id,'slug',s.slug,'name',s.name,
      'description','','promptTemplateMd','{{session.prompt}}','anyoneCanApprove',true,
      'approverMemberIds','[]'::jsonb,'previousStageIds','[]'::jsonb) order by s.position)
      from public.pipeline_stages s where s.pipeline_id=p.id and s.slug in ('plan','build'))
  )::text as body
  from public.factories f join public.pipelines p on p.workspace_id=f.workspace_id and p.is_default
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
select throws_ok($$select pg_temp.pin_manifest(job_id,run_id,exact_input.value,renderer => 2)
  from approval_target cross join exact_input$$, 'PT422', 'This worker cannot execute the pinned skill revisions.',
  'an older renderer cannot start a pinned skill attempt');
select ok(pg_temp.pin_manifest(job_id,run_id,exact_input.value), 'the exact approval is pinned with the actual attempt')
  from approval_target cross join exact_input;
select is(m.predecessors, exact_input.value, 'the manifest freezes the reviewed artifact and pre-rename prompt key')
  from public.session_attempt_manifests m join approval_target using (run_id) cross join exact_input;
select is(m.definition_digest, revision.canonical_digest, 'the admitted definition digest is copied from the immutable revision')
  from public.session_attempt_manifests m join approval_target using (run_id)
  join public.factory_definition_revisions revision on revision.id = m.definition_revision_id;
select is(m.definition_skill_ids, array[(select id::text from manifest_skill)], 'resolved skills are copied from the admitted definition')
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

insert into public.workspace_agent_config(workspace_id,key,value_json) values
  ('b1b2c3d4-0001-4000-8000-000000000001','concurrency_limit','20'),
  ('b1b2c3d4-0001-4000-8000-000000000001','max_retries','9'),
  ('b1b2c3d4-0001-4000-8000-000000000001','stall_timeout_ms','900000')
on conflict (workspace_id,key) do update set value_json=excluded.value_json;
insert into public.workspace_sandbox_settings(workspace_id,active_provider)
values ('b1b2c3d4-0001-4000-8000-000000000001','vercel')
on conflict (workspace_id) do update set active_provider=excluded.active_provider;
create temp table dispatch_target as select * from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
  'Pinned dispatch fixture','Try dispatch','claude-code','a-live-model');
update public.agent_jobs set status='canceled' where status='queued' and id<>(select job_id from dispatch_target);
select is((select count(*) from public.claim_next_agent_job(20)),0::bigint,
  'the pinned concurrency cap blocks a new claim while the workspace is above it');
update public.agent_jobs set status='canceled' where status in ('started','running');
insert into public.workspace_sandbox_connection_mutations(workspace_id,provider)
values ('b1b2c3d4-0001-4000-8000-000000000001','e2b');
select is((select count(*) from public.claim_next_agent_job(20)),0::bigint,
  'a mutation of the pinned sandbox provider fences claim even if the live provider is different');
delete from public.workspace_sandbox_connection_mutations
where workspace_id='b1b2c3d4-0001-4000-8000-000000000001' and provider='e2b';
select is((select job_id from public.claim_next_worker_dispatch(20,20,300000)),
  (select job_id from dispatch_target), 'native dispatch shares the pinned claim guard');

set local role service_role;
select results_eq(
  $$select stall_timeout_ms, max_retries from public.pinned_job_recovery_settings where job_id = (
    select j.id from public.agent_jobs j join public.sessions s on s.id=j.session_id where s.title='Pinned dispatch fixture')$$,
  $$values (720000,1)$$, 'recovery reads only the dispatched job revision limits');
reset role;
set local role authenticated;
select throws_ok($$select * from public.pinned_job_recovery_settings$$,'42501',null,
  'browser clients cannot read the worker recovery settings view');
reset role;

select is(public.start_session_job_attempt(f.job_id,1,s.current_stage_id,s.current_artifact_version,
  'codex','gpt-5.5','code','wallie/pinned-dispatch'),f.run_id,'the claimed pinned attempt starts')
from dispatch_target f join public.sessions s on s.id=f.session_id;
select is(public.fail_session_job_attempt(f.job_id,1,'Fixture failure',true,20,f.run_id),'error',
  'the authoritative cap prevents the caller or edited workspace from retrying the attempt') from dispatch_target f;

with revision as (
  insert into public.factory_definition_revisions (workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
  select prior.workspace_id,prior.factory_id,1,updated.body,encode(sha256(convert_to(updated.body,'UTF8')),'hex'),prior.created_by
  from public.factory_definition_revisions prior
  join public.sessions old on old.factory_definition_revision_id=prior.id
  cross join lateral (select jsonb_set(prior.definition_json::jsonb,'{agent,model}','"gpt-5"')::text as body) updated
  where old.id=(select session_id from dispatch_target)
  returning workspace_id,factory_id,id,created_by
)
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,2,created_by from revision;

update public.sessions set linear_issue_id='MANIFEST-544', linear_issue_url='https://linear.app/test/issue/MANIFEST-544'
where id=(select session_id from dispatch_target);
create function pg_temp.restart_manifest_session(source_id uuid, request uuid, fingerprint text,
  issue_url text default 'https://linear.app/test/issue/MANIFEST-544')
returns table(session_id uuid, job_id uuid, run_id uuid) language sql as $$
  select fresh.session_id,fresh.job_id,fresh.run_id from public.restart_session_once_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001','c1b2c3d4-0001-4000-8000-000000000001',
    request,fingerprint,source_id,'Deliberate restart','Try a fresh plan','claude-code','a-live-model','{}',
    'MANIFEST-544',issue_url) fresh;
$$;
create temp table restarted as select fresh.* from dispatch_target old cross join lateral
  pg_temp.restart_manifest_session(old.session_id,'54400000-0000-4000-8000-000000000001',repeat('a',64)) fresh;
select ok(fresh.session_id<>old.session_id and fresh.job_id<>old.job_id and fresh.run_id<>old.run_id and
  new_owner.factory_definition_revision_id<>old_owner.factory_definition_revision_id,
  'an explicit restart admits distinct work against the newly activated definition')
from restarted fresh cross join dispatch_target old join public.sessions old_owner on old_owner.id=old.session_id
join public.sessions new_owner on new_owner.id=fresh.session_id;
select is(r.model_name,'gpt-5','the restarted first run uses the new definition model')
from restarted fresh join public.agent_runs r on r.id=fresh.run_id;
select is(lineage.source_session_id,old.session_id,'the new session preserves the explicit source session ID')
from restarted fresh join public.session_restart_lineages lineage using (session_id) cross join dispatch_target old;
select ok(new_owner.linear_issue_id is null and old_owner.linear_issue_id='MANIFEST-544'
  and new_owner.linear_issue_url=old_owner.linear_issue_url,
  'same-issue restart preserves context while Linear routing remains on the source session')
from restarted fresh cross join dispatch_target old join public.sessions old_owner on old_owner.id=old.session_id
join public.sessions new_owner on new_owner.id=fresh.session_id;
select is((select count(*) from public.session_job_git_inputs i join restarted fresh using (job_id)),0::bigint,
  'restart has no inherited Git input or prior approved checkpoint');
select throws_ok($$select * from pg_temp.restart_manifest_session(
    '54400000-0000-4000-8000-000000000010','54400000-0000-4000-8000-000000000002',repeat('a',64))$$,
  'PT404','Source session is unavailable in this workspace.','unavailable restart source rolls back admission');
select is((select count(*) from public.sessions where title='Deliberate restart'),1::bigint,
  'an origin failure leaves only the previously accepted restart');
select throws_ok($$select * from pg_temp.restart_manifest_session(
    (select session_id from legacy_target),'54400000-0000-4000-8000-000000000001',repeat('a',64))$$,
  'P0005','This creation request was already used for different session input',
  'a reused request cannot rewrite the source lineage');
select throws_ok($$update public.session_restart_lineages set source_session_id=gen_random_uuid()$$,
  '23514','Session restart lineage is immutable.','restart origin cannot be rewritten');
create temp table restarted_again as select fresh.* from restarted prior cross join lateral
  pg_temp.restart_manifest_session(prior.session_id,'54400000-0000-4000-8000-000000000004',repeat('d',64),
    'https://linear.app/test/issue/MANIFEST-544/updated-title') fresh;
select ok(s.linear_issue_id is null and s.linear_issue_url='https://linear.app/test/issue/MANIFEST-544/updated-title'
  and lineage.linear_issue_context_id='MANIFEST-544' and lineage.source_session_id=prior.session_id,
  'repeated restarts keep the issue as context even when its canonical URL changes')
from restarted_again newest join public.sessions s on s.id=newest.session_id
join public.session_restart_lineages lineage on lineage.session_id=s.id cross join restarted prior;
delete from public.sessions where id=(select session_id from dispatch_target);
select is((select f.session_id from dispatch_target old cross join lateral
    pg_temp.restart_manifest_session(old.session_id,'54400000-0000-4000-8000-000000000001',repeat('a',64)) f),
  (select session_id from restarted),'a same-intent restart replay returns the committed child after deleting its origin');

create temp table confirmation_revisions as
select a.activation_number, a.workspace_id, a.factory_id, a.revision_id, a.created_by, r.canonical_digest
from public.factory_definition_activations a join public.factory_definition_revisions r on r.id=a.revision_id
where a.workspace_id='b1b2c3d4-0001-4000-8000-000000000001';
create function pg_temp.confirm_factory(p_revision bigint) returns uuid language sql as $$
  select admitted.session_id from confirmation_revisions revision
  cross join lateral public.create_confirmed_factory_session_once_with_first_job(
    revision.workspace_id, 'c1b2c3d4-0001-4000-8000-000000000001',
    '54400000-0000-4000-8000-000000000003', repeat('c',64), revision.canonical_digest,
    'Confirmed definition', 'Run the displayed revision', 'claude-code', 'a-live-model', '{}') admitted
  where revision.activation_number=p_revision;
$$;
select throws_ok($$select pg_temp.confirm_factory(1)$$, 'P0003', 'The active factory definition changed.',
  'a different revision with the same stable stages cannot be admitted from a stale confirmation');
create temp table confirmed as select pg_temp.confirm_factory(2) as session_id;
select is((select s.factory_definition_revision_id from public.sessions s join confirmed c on c.session_id=s.id),
  (select revision_id from confirmation_revisions where activation_number=2),
  'the confirmed revision is pinned to the committed session');
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,revision_id,3,created_by from confirmation_revisions where activation_number=1;
select is(pg_temp.confirm_factory(2), (select session_id from confirmed),
  'an accepted confirmation replays under its original revision after another activation');

create temp table inspector_skill_evidence as
select target.run_id, revision.workspace_id, revision.factory_id, revision.skill_id, revision.id as revision_id,
  jsonb_build_array(jsonb_build_object(
    'skillId', skill.id, 'revisionId', revision.id, 'name', skill.name,
    'version', revision.revision_number, 'contentSha256', revision.content_sha256,
    'sourceKind', revision.source_kind
  )) as expected
from approval_target target
join public.session_attempt_manifests manifest on manifest.run_id = target.run_id
join public.factory_skill_revisions revision on revision.id::text = manifest.definition_skill_ids[1]
join public.factory_skills skill on skill.id = revision.skill_id;
select is((select count(*) from inspector_skill_evidence), 1::bigint,
  'the inspector scope fixture has one recorded skill revision');
grant select on inspector_skill_evidence to authenticated;
select ok(not has_function_privilege('anon', 'public.get_run_skill_revisions(uuid,uuid,integer)', 'execute'),
  'anonymous callers cannot request skill revision evidence');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0002-4000-8000-000000000002';
select is(public.get_run_skill_revisions(workspace_id, run_id, 1), expected,
  'a factory reader sees exact revision metadata without the prompt or credential binding')
from inspector_skill_evidence;
select is(public.get_run_skill_revisions(workspace_id, run_id, 2), null::jsonb,
  'the inspector never substitutes evidence from another attempt')
from inspector_skill_evidence;
select is(public.get_run_skill_revisions(gen_random_uuid(), run_id, 1), null::jsonb,
  'a different workspace cannot yield run evidence')
from inspector_skill_evidence;
reset role;

set local request.jwt.claim.role = 'service_role';
select public.revoke_factory_membership(
  workspace_id, factory_id, 'a1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0002-4000-8000-000000000002'
) from inspector_skill_evidence;
select public.revoke_factory_skill_revision(
  workspace_id, factory_id, 'a1b2c3d4-0001-4000-8000-000000000001', skill_id, revision_id
) from inspector_skill_evidence;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select is(public.get_run_skill_revisions(workspace_id, run_id, 1), null::jsonb,
  'a workspace member loses visibility after their factory grant is revoked')
from inspector_skill_evidence;
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';
select is(public.get_run_skill_revisions(workspace_id, run_id, 1), expected,
  'revoking future skill use preserves evidence of the recorded attempt')
from inspector_skill_evidence;
reset role;

select * from finish();
rollback;
