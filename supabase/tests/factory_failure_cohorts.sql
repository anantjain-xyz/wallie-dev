begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.cohort_fixture_id(p_slot integer) returns uuid language sql immutable as $$
  select ('63300000-0000-4000-8000-' || lpad(p_slot::text, 12, '0'))::uuid;
$$;

insert into auth.users(id, email) values
  (pg_temp.cohort_fixture_id(1), 'failure-owner@example.test'),
  (pg_temp.cohort_fixture_id(2), 'failure-reader@example.test'),
  (pg_temp.cohort_fixture_id(3), 'failure-other-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.cohort_fixture_id(11), 'failure-fixture', 'Failure cohorts'),
  (pg_temp.cohort_fixture_id(12), 'failure-other', 'Other tenant');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.cohort_fixture_id(21), pg_temp.cohort_fixture_id(11), pg_temp.cohort_fixture_id(1), 'human', 'owner'),
  (pg_temp.cohort_fixture_id(22), pg_temp.cohort_fixture_id(11), pg_temp.cohort_fixture_id(2), 'human', 'member'),
  (pg_temp.cohort_fixture_id(23), pg_temp.cohort_fixture_id(12), pg_temp.cohort_fixture_id(3), 'human', 'owner');
insert into public.factories(id, workspace_id, name, slug, is_default)
values (pg_temp.cohort_fixture_id(30), pg_temp.cohort_fixture_id(11), 'Restricted factory', 'failure-restricted', false);

create temp table failure_scope as
select factory.workspace_id, factory.id as factory_id, pg_temp.cohort_fixture_id(1) as owner_id
from public.factories factory where factory.workspace_id = pg_temp.cohort_fixture_id(11) and factory.is_default;
grant select on failure_scope to authenticated;
select public.grant_factory_membership(workspace_id, factory_id, owner_id, pg_temp.cohort_fixture_id(22), 'member')
from failure_scope;

insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.cohort_fixture_id(31), workspace_id, factory_id, 'Failure fixture pipeline', true
from failure_scope;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name, prompt_template_md)
values (pg_temp.cohort_fixture_id(32), pg_temp.cohort_fixture_id(11), pg_temp.cohort_fixture_id(31),
  1, 'build', 'Build', 'Produce a report.');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type,
  target_name, permissions)
values (pg_temp.cohort_fixture_id(40), pg_temp.cohort_fixture_id(11), 63300040,
  'https://github.test/installations/63300040', 63300, 'Organization', 'fixture',
  '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select pg_temp.cohort_fixture_id(41), workspace_id, factory_id, pg_temp.cohort_fixture_id(40), 63300041,
  'failure', 'fixture/failure', true, 'https://github.test/fixture/failure', 'main' from failure_scope;
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.cohort_fixture_id(1), 'platform_api_key', 'fixture-ciphertext');
insert into public.workspace_sandbox_settings(workspace_id, active_provider)
values (pg_temp.cohort_fixture_id(11), 'e2b') on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values (pg_temp.cohort_fixture_id(11), 'fixture-sandbox-ciphertext');

create temp table failure_scorer as
select scorer.* from failure_scope scope
cross join lateral public.create_factory_scorer(scope.workspace_id, scope.factory_id, scope.owner_id,
  'Delivery quality', 'delivery-quality', '{"schemaVersion":1,"rubric":"Review the retained report.",
    "requiredEvidence":["validation_report"],"scoring":{"kind":"boolean","passValue":true}}') scorer;
create temp table failure_policy as
select policy.id from failure_scope scope cross join failure_scorer scorer
cross join lateral public.save_factory_scorer_sampling_policy(scope.workspace_id, scope.factory_id, scope.owner_id,
  scorer.id, 0, 10000, 'failure-fixture') policy;
create temp table failure_judge as
select profile.id from failure_scope scope cross join lateral public.configure_factory_judge_profile(
  scope.workspace_id, scope.owner_id, 0, 'openai/gpt-4.1-mini', 'openai', false, false,
  'v2.AAAAAAAAAAAAAAAA.YWJj.AAAAAAAAAAAAAAAAAAAAAA') profile;

create function pg_temp.activate_failure_definition(p_revision integer, p_task_class text default 'build')
returns uuid language sql as $$
  with compiled as (
    select scope.*, jsonb_build_object('schemaVersion', 2, 'kind', 'serial', 'sandboxProvider', 'e2b',
      'pipelineId', pg_temp.cohort_fixture_id(31), 'repositoryId', pg_temp.cohort_fixture_id(41),
      'scorerRevisionIds', jsonb_build_array(scorer.id), 'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb,
      'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb, 'agent', jsonb_build_object(
        'provider', 'codex', 'model', 'gpt-5.5', 'concurrencyLimit', 1, 'stallTimeoutMs', 900000,
        'maxRetries', 3, 'maxTurns', 5), 'stages', jsonb_build_array(jsonb_build_object(
          'id', pg_temp.cohort_fixture_id(32), 'slug', 'build', 'name', 'Build', 'description', '',
          'promptTemplateMd', 'Produce report revision ' || p_revision, 'anyoneCanApprove', true,
          'previousStageIds', '[]'::jsonb, 'approverMemberIds', '[]'::jsonb))) ||
      case when p_task_class is null then '{}'::jsonb else jsonb_build_object('modelRouting', jsonb_build_object(
        'version', 1, 'taskClasses', jsonb_build_array(jsonb_build_object(
          'id', pg_temp.cohort_fixture_id(45), 'slug', p_task_class, 'name', initcap(p_task_class))),
        'rules', '[]'::jsonb, 'onUnmatched', '{"kind":"escalate"}'::jsonb)) end as definition
    from failure_scope scope cross join failure_scorer scorer
  ), revision as (
    insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
      definition_json, canonical_digest, created_by)
    select pg_temp.cohort_fixture_id(50 + p_revision), workspace_id, factory_id, 2,
      definition::text, encode(sha256(convert_to(definition::text, 'UTF8')), 'hex'), owner_id from compiled
    returning id, workspace_id, factory_id, created_by
  )
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  select workspace_id, factory_id, id, p_revision, created_by from revision returning revision_id;
$$;
select pg_temp.activate_failure_definition(1);
select public.set_git_continuity_release(true, revision, 'Failure cohort fixture')
from public.get_git_continuity_release_state() where not enabled;

create function pg_temp.publish_failure_run(p_key text, p_validation_status text default 'failed',
  p_with_sibling boolean default false, p_with_log boolean default true, p_with_plan boolean default true)
returns table(session_id uuid, run_id uuid, report_id uuid) language plpgsql as $$
declare
  fixture record;
  fixture_run_id uuid;
  asset_id uuid := gen_random_uuid();
  log_id uuid := gen_random_uuid();
  sibling_log_id uuid := gen_random_uuid();
  report_path text;
  log_path text;
  sibling_log_path text;
  plan jsonb := '{"version":1,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":60,
    "reports":[{"key":"report","path":"report.txt","kind":"report","required":true}]}]}';
  records jsonb;
  assets jsonb;
  publication_claim uuid;
  commit_sha text := repeat('a', 40);
  tree_sha text := repeat('b', 40);
  observed_at timestamptz := clock_timestamp();
  artifact text := 'Retained fixture artifact.';
begin
  select * into strict fixture from public.create_session_with_first_job(
    pg_temp.cohort_fixture_id(11), pg_temp.cohort_fixture_id(21), p_key, 'Produce the exact retained report.', 'codex', 'gpt-5.5');
  update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = 1 where id = fixture.job_id;
  fixture_run_id := public.start_session_job_attempt(fixture.job_id, 1, pg_temp.cohort_fixture_id(32), 0,
    'codex', 'gpt-5.5', 'project', 'wallie/cohort-' || fixture.job_id::text);
  if fixture_run_id is null then raise exception 'Could not start fixture run.'; end if;
  perform public.pin_session_job_git_input(fixture.job_id, 1, fixture_run_id, pg_temp.cohort_fixture_id(41), 'main', commit_sha);
  if p_with_sibling then
    plan := jsonb_set(plan, '{commands}', plan->'commands' ||
      '[{"key":"tests/lint","command":"pnpm lint","timeoutSeconds":60,"reports":[]}]'::jsonb);
  end if;
  if p_with_plan then
    perform public.pin_session_validation_plan(fixture_run_id, commit_sha, tree_sha, plan);
  end if;

  report_path := pg_temp.cohort_fixture_id(11)::text || '/' || fixture_run_id::text || '/' || asset_id::text;
  insert into storage.objects(bucket_id, name, metadata)
  values ('session-validation-evidence', report_path, '{"mimetype":"text/plain","size":20}');
  records := jsonb_build_array(jsonb_build_object('key', 'tests', 'command', 'pnpm test', 'provenance', 'harness',
    'status', p_validation_status, 'exitCode', case when p_validation_status = 'failed' then 1 else 0 end,
    'startedAt', observed_at, 'completedAt', observed_at, 'commitSha', commit_sha, 'treeSha', tree_sha,
    'finalCommitSha', commit_sha, 'finalTreeSha', case when p_validation_status = 'stale' then repeat('d', 40) else tree_sha end,
    'reportKeys', '["tests/report"]'::jsonb, 'missingRequiredReports', '[]'::jsonb));
  assets := jsonb_build_array(jsonb_build_object('id', asset_id, 'key', 'tests/report', 'kind', 'report', 'required', true,
    'storagePath', report_path, 'sha256', repeat('e', 64), 'contentType', 'text/plain', 'sizeBytes', 20));
  if p_with_log then
    log_path := pg_temp.cohort_fixture_id(11)::text || '/' || fixture_run_id::text || '/' || log_id::text;
    insert into storage.objects(bucket_id, name, metadata)
    values ('session-validation-evidence', log_path, '{"mimetype":"text/plain","size":20}');
    assets := assets || jsonb_build_object('id', log_id, 'key', 'tests/log', 'kind', 'log', 'required', false,
      'storagePath', log_path, 'sha256', repeat('e', 64), 'contentType', 'text/plain', 'sizeBytes', 20);
  end if;
  if p_with_sibling then
    sibling_log_path := pg_temp.cohort_fixture_id(11)::text || '/' || fixture_run_id::text || '/' || sibling_log_id::text;
    insert into storage.objects(bucket_id, name, metadata)
    values ('session-validation-evidence', sibling_log_path, '{"mimetype":"text/plain","size":20}');
    records := records || (records->0 || '{"key":"tests/lint","command":"pnpm lint","status":"passed",
      "exitCode":0,"reportKeys":[]}'::jsonb);
    assets := assets || jsonb_build_object('id', sibling_log_id, 'key', 'tests/lint/log', 'kind', 'log', 'required', false,
      'storagePath', sibling_log_path, 'sha256', repeat('e', 64), 'contentType', 'text/plain', 'sizeBytes', 20);
  end if;
  perform public.record_session_validation_evidence(fixture_run_id, commit_sha, tree_sha, records, assets);
  perform public.record_session_validation_evidence(fixture_run_id, commit_sha, tree_sha, records, assets);

  if public.prepare_session_source_and_checkpoint_publication(fixture_run_id, pg_temp.cohort_fixture_id(41),
    'main', commit_sha, commit_sha, 'No code change', artifact, '', '', '', 0, artifact) is distinct from true then
    raise exception 'Could not prepare the exact checkpoint.';
  end if;
  publication_claim := public.claim_session_checkpoint_publication(fixture_run_id);
  if publication_claim is null or
    public.adopt_session_checkpoint_publication(fixture_run_id, publication_claim, null, null) is distinct from true then
    raise exception 'Could not adopt the exact checkpoint.';
  end if;
  return query select fixture.session_id, fixture_run_id, asset_id;
end;
$$;

create temp table failure_runs(key text primary key, session_id uuid not null, run_id uuid not null, report_id uuid not null);
create temp table failure_attempts(key text primary key, attempt_id uuid not null);
grant select on failure_runs, failure_attempts to authenticated;

create function pg_temp.request_failure_score(p_run_id uuid) returns uuid language sql as $$
  select (public.record_factory_scorer_sample(scope.workspace_id, scope.factory_id, policy.id, p_run_id)).id
  from failure_scope scope cross join failure_policy policy;
$$;

create function pg_temp.finish_failure_score(p_run_id uuid, p_status text default 'completed', p_score text default 'fail')
returns uuid language plpgsql as $$
declare
  claim record;
  evidence jsonb;
  outcome jsonb;
begin
  select * into strict claim from public.claim_factory_judge_job();
  if claim.run_id is distinct from p_run_id then raise exception 'An unexpected score was queued.'; end if;
  if public.begin_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id,
    claim.lease_id, (select id from failure_judge), repeat('d', 64), 'node')->>'status' is distinct from 'authorized' then
    raise exception 'Could not authorize the exact score attempt.';
  end if;
  if p_status = 'completed' then
    select sample.evidence into strict evidence from public.factory_scorer_sample_receipts sample
    where sample.id = claim.sample_receipt_id;
    outcome := jsonb_build_object('schemaVersion', 1, 'status', p_score, 'score',
      jsonb_build_object('kind', 'boolean', 'value', p_score = 'pass'), 'evidence', evidence);
  end if;
  if public.finish_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id,
    claim.lease_id, p_status, outcome, case when p_status = 'completed' then 'openai/gpt-4.1-mini' end,
    p_explanation => case when p_status = 'completed' then 'Private fixture judgment.' end) is distinct from true then
    raise exception 'Could not finalize the exact score attempt.';
  end if;
  if p_status <> 'completed' then
    update public.factory_evaluation_jobs set available_at = clock_timestamp() where id = claim.job_id and status = 'queued';
  elsif public.finish_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id,
    claim.lease_id, p_status, outcome, 'openai/gpt-4.1-mini') is distinct from false then
    raise exception 'A duplicate callback rewrote the accepted score.';
  end if;
  return claim.attempt_id;
end;
$$;

create function pg_temp.list_failures(p_limit integer default 25, p_after uuid default null)
returns jsonb language sql stable as $$
  select public.list_factory_failure_cohorts(workspace_id, factory_id, p_limit, p_after) from failure_scope;
$$;

create function pg_temp.failure_summary(p_kind text) returns jsonb language sql stable as $$
  select cohort from jsonb_array_elements(pg_temp.list_failures()->'cohorts') cohort
  where cohort->>'symptom_kind' = p_kind and cohort->>'task_class_slug' = 'build'
    and cohort->>'parent_cohort_id' is null;
$$;

create function pg_temp.failure_detail(p_kind text, p_limit integer default 25, p_after uuid default null)
returns jsonb language sql stable as $$
  select public.get_factory_failure_cohort(workspace_id, factory_id,
    (pg_temp.failure_summary(p_kind)->>'id')::uuid, p_limit, p_after) from failure_scope;
$$;

select ok(not has_table_privilege('authenticated', 'internal.factory_failure_cohorts', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated', 'internal.factory_failure_cohort_members', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_function_privilege('anon', 'public.list_factory_failure_cohorts(uuid,uuid,integer,uuid,text,uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.process_factory_failure_cohorts(integer)', 'EXECUTE'),
  'browser roles cannot forge or read raw memberships or run backfill');

insert into failure_runs select 'first', fixture.* from pg_temp.publish_failure_run('First failed run', p_with_sibling => true) fixture;
select pg_temp.request_failure_score(run_id) from failure_runs where key = 'first';
insert into failure_attempts select 'retry', pg_temp.finish_failure_score(run_id, 'provider_unavailable')
from failure_runs where key = 'first';
insert into failure_attempts select 'first', pg_temp.finish_failure_score(run_id) from failure_runs where key = 'first';
do $$
begin
  while public.process_factory_failure_cohorts(100) > 0 loop
    null;
  end loop;
end;
$$;
select is(public.process_factory_failure_cohorts(100), 0, 'repeating maintenance after historical catch-up consumes no work');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '63300000-0000-4000-8000-000000000002';
select is(jsonb_array_length(pg_temp.list_failures()->'cohorts'), 2,
  'the trusted validation command and completed failing scorer form separate cohorts');
select ok((select bool_and(summary @> '{"task_class_slug":"build","failure_count":1,"support_count":1,
    "minimum_support":3,"version_count":1,"qualification":"inconclusive","qualification_reasons":["insufficient_support"]}')
  from jsonb_array_elements(pg_temp.list_failures()->'cohorts') summary),
  'receipt and evaluator retries cannot inflate counts or provide independent support');
select ok((select member @> jsonb_build_object('session_id', fixture.session_id, 'run_id', fixture.run_id,
    'run_attempt_count', 1, 'source', jsonb_build_object('kind', 'scorer', 'evaluation_attempt_id', attempt.attempt_id,
      'target_commit_sha', repeat('a',40), 'evidence_state', 'available'),
    'configuration', jsonb_build_object('definition_revision_id', pg_temp.cohort_fixture_id(51), 'model_provider', 'codex',
      'model_name', 'gpt-5.5'))
    and member#>>'{configuration,definition_digest}' ~ '^[0-9a-f]{64}$'
    and member#>>'{configuration,agent_prompt_revision_id}' is not null
  from jsonb_array_elements(pg_temp.failure_detail('scorer')->'members') member
  cross join failure_runs fixture cross join failure_attempts attempt
  where fixture.key = 'first' and attempt.key = 'first'),
  'scorer members identify the exact run, settled attempt, commit and producing configuration');
select ok((select member->'source' @> jsonb_build_object('kind', 'validation', 'validation_run_id', fixture.run_id,
    'validation_record_key', 'tests', 'target_commit_sha', repeat('a',40), 'target_tree_sha', repeat('b',40),
    'evidence_state', 'available')
  from jsonb_array_elements(pg_temp.failure_detail('validation')->'members') member
  cross join failure_runs fixture where fixture.key = 'first'),
  'deterministic members identify the exact run, validation command, commit and tree');
select throws_ok($$select public.list_factory_failure_cohorts(workspace_id, pg_temp.cohort_fixture_id(30)) from failure_scope$$,
  'P0002', null, 'a factory grant does not expose a sibling factory');
set local request.jwt.claim.sub = '63300000-0000-4000-8000-000000000003';
select throws_ok($$select pg_temp.list_failures()$$, 'P0002', null,
  'an owner in another workspace cannot read this factory');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

insert into failure_runs select 'second', fixture.* from pg_temp.publish_failure_run('Second failed run') fixture;
select pg_temp.request_failure_score(run_id) from failure_runs where key = 'second';
insert into failure_attempts select 'second', pg_temp.finish_failure_score(run_id) from failure_runs where key = 'second';
insert into failure_runs select 'third', fixture.* from pg_temp.publish_failure_run('Third failed run') fixture;
select pg_temp.request_failure_score(run_id) from failure_runs where key = 'third';
insert into failure_attempts select 'third', pg_temp.finish_failure_score(run_id) from failure_runs where key = 'third';
insert into failure_runs select 'stale', fixture.* from pg_temp.publish_failure_run('Stale validation', 'stale') fixture;
insert into failure_runs select 'passing', fixture.* from pg_temp.publish_failure_run('Passing run', 'passed') fixture;
select pg_temp.request_failure_score(run_id) from failure_runs where key = 'passing';
insert into failure_attempts select 'passing', pg_temp.finish_failure_score(run_id, 'completed', 'pass')
from failure_runs where key = 'passing';
select is(public.process_factory_failure_cohorts(100), 4,
  'two validation failures and two scorer failures still arrive after historical catch-up finishes');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '63300000-0000-4000-8000-000000000002';
select ok((select bool_and(summary @> '{"failure_count":3,"support_count":3,"version_count":1,
    "qualification":"qualified","qualification_reasons":[]}')
  from jsonb_array_elements(pg_temp.list_failures()->'cohorts') summary),
  'three independent same-version failures qualify while stale observations and passes do not count');
select ok((select jsonb_array_length(first_page->'members') = 1 and jsonb_array_length(next_page->'members') = 2
    and not next_page->'members' @> (first_page->'members')
  from (select pg_temp.failure_detail('scorer', 1) first_page) initial
  cross join lateral pg_temp.failure_detail('scorer', 2, (first_page->>'next_member_id')::uuid) next_page),
  'bounded detail pages expose distinct immutable membership');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

create temp table failure_scorer_second as
select revised.* from failure_scope scope cross join failure_scorer scorer
cross join lateral public.save_factory_scorer_revision(scope.workspace_id, scope.factory_id, scope.owner_id,
  scorer.scorer_id, 1, jsonb_set(scorer.definition, '{rubric}', '"Review the exact report again."')) revised;
select public.request_factory_scorer_reevaluation(scope.workspace_id, scope.factory_id, scope.owner_id,
  prior.attempt_id, revised.id)
from failure_scope scope cross join failure_scorer_second revised cross join failure_attempts prior where prior.key = 'first';
insert into failure_attempts select 'reevaluated', pg_temp.finish_failure_score(run_id) from failure_runs where key = 'first';
select pg_temp.activate_failure_definition(2);
insert into failure_runs select 'changed', fixture.*
from pg_temp.publish_failure_run('Changed definition with unavailable log', p_with_log => false) fixture;
select public.process_factory_failure_cohorts(100);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '63300000-0000-4000-8000-000000000002';
select ok(pg_temp.failure_summary('validation') @> '{"failure_count":4,"support_count":3,"version_count":2,
    "qualification":"inconclusive","qualification_reasons":["mixed_versions","missing_evidence"]}',
  'a changed producing definition marks mixed versions and a missing log contributes no support');
select ok((select member#>>'{source,evidence_state}' = 'unavailable'
    and (member#>>'{source,target_commit_sha}') is null and (member#>>'{source,validation_record_key}') is null
  from jsonb_array_elements(pg_temp.failure_detail('validation')->'members') member
  join failure_runs fixture on member->>'run_id' = fixture.run_id::text where fixture.key = 'changed'),
  'the exact deterministic receipt without its log is visible with protected evidence details concealed');
select ok(pg_temp.failure_summary('scorer') @> '{"failure_count":3,"support_count":3,"version_count":2,
    "qualification":"inconclusive","qualification_reasons":["mixed_versions"]}'
    and jsonb_array_length(pg_temp.failure_detail('scorer')->'members') = 4,
  'a newer verdict for the same run retains both exact receipts and provides no additional independent support');
select ok((select count(*) = 3 from jsonb_array_elements(pg_temp.failure_detail('validation')->'members') member
  where member#>>'{configuration,definition_revision_id}' = pg_temp.cohort_fixture_id(51)::text),
  'historical members still point to their original producing definition after activation changes');

select ok((select page @> '{"cohorts":[{"symptom_kind":"validation","failure_count":1,"support_count":0,
    "version_count":1}],"next_cohort_id":null}' and jsonb_array_length(page->'cohorts') = 1
  from (select public.list_factory_failure_cohorts(workspace_id, factory_id, 1,
    p_symptom_kind => 'validation', p_definition_revision_id => pg_temp.cohort_fixture_id(52)) as page from failure_scope) query),
  'symptom and exact producing definition filters run before list pagination and scope counts');
select ok((select detail @> '{"cohort":{"failure_count":3,"support_count":3,"version_count":1,"qualification":"qualified"}}'
    and jsonb_array_length(detail->'members') = 2 and detail->>'next_member_id' is not null
    and detail->>'membership_digest' = pg_temp.failure_detail('validation')->>'membership_digest'
  from (select public.get_factory_failure_cohort(workspace_id, factory_id,
    (pg_temp.failure_summary('validation')->>'id')::uuid, 2,
    p_definition_revision_id => pg_temp.cohort_fixture_id(51)) as detail from failure_scope) query),
  'detail paginates only matching producing versions while retaining the full review snapshot');
select throws_ok($$select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('validation')->>'id')::uuid, 0, pg_temp.cohort_fixture_id(71), 'label', 'Delivery checks')
  from failure_scope$$, '42501', null, 'a factory member can inspect review state but cannot write it');

set local request.jwt.claim.sub = '63300000-0000-4000-8000-000000000001';
select ok((select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('validation')->>'id')::uuid, 0, pg_temp.cohort_fixture_id(71), 'label', 'Delivery checks')
  @> '{"review":{"revision":1,"label":"Delivery checks","disposition":"open","can_review":true},"split_cohort_ids":[]}'
  from failure_scope), 'an authorized label creates one reviewed revision');
select ok((select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('validation')->>'id')::uuid, 0, pg_temp.cohort_fixture_id(71), 'label', 'Delivery checks')
  @> '{"review":{"revision":1,"label":"Delivery checks"}}' from failure_scope),
  'an exact retry returns the original label receipt before checking the current revision');
select throws_ok($$select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('validation')->>'id')::uuid, 0, pg_temp.cohort_fixture_id(71), 'label', 'Different label')
  from failure_scope$$, 'PT409', null, 'a request ID cannot be reused with a different label');
select throws_ok($$select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('validation')->>'id')::uuid, 0, pg_temp.cohort_fixture_id(72), 'dismiss')
  from failure_scope$$, 'PT409', null, 'a stale revision cannot dismiss a reviewed cohort');
select ok((select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('validation')->>'id')::uuid, 1, pg_temp.cohort_fixture_id(72), 'dismiss')
  @> '{"review":{"revision":2,"label":"Delivery checks","disposition":"dismissed","can_review":false}}'
  from failure_scope), 'dismissal records a decision separately from the reviewed label');
select ok((select public.list_factory_failure_cohorts(workspace_id, factory_id, p_disposition => 'dismissed')
  @> '{"cohorts":[{"failure_count":4,"qualification":"inconclusive","review":{"disposition":"dismissed"}}]}'
  from failure_scope) and jsonb_array_length(pg_temp.failure_detail('validation')->'members') = 4,
  'dismissed cohorts remain directly inspectable with their original attribution and qualification');

select throws_ok($$select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('scorer')->>'id')::uuid, 0, pg_temp.cohort_fixture_id(73), 'split',
  p_selected_run_ids => array[(select run_id from failure_runs where key = 'first')],
  p_expected_membership_digest => repeat('0', 64)) from failure_scope$$, 'PT409', null,
  'a split waits for the user to review current membership');
select throws_ok($$select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('scorer')->>'id')::uuid, 0, pg_temp.cohort_fixture_id(73), 'split',
  p_selected_run_ids => array[(select run_id from failure_runs where key = 'changed')],
  p_expected_membership_digest => pg_temp.failure_detail('scorer')->>'membership_digest') from failure_scope$$,
  '22023', null, 'a split cannot import another cohort member');
select ok((select public.review_factory_failure_cohort(workspace_id, factory_id,
  (pg_temp.failure_summary('scorer')->>'id')::uuid, 0, pg_temp.cohort_fixture_id(73), 'split',
  p_selected_run_ids => array[(select run_id from failure_runs where key = 'first')],
  p_expected_membership_digest => pg_temp.failure_detail('scorer')->>'membership_digest')
  @> '{"review":{"revision":1,"disposition":"split","can_review":false}}' from failure_scope),
  'a split records the investigated subset in one reviewed revision');
select ok((select count(*) = 2 and bool_and(jsonb_array_length(detail->'members') = 2)
    and sum((detail#>>'{cohort,failure_count}')::integer) = 3
    and bool_and((detail#>>'{cohort,parent_cohort_id}') = parent->>'id')
  from failure_scope
  cross join lateral (select pg_temp.failure_summary('scorer') as parent) original
  cross join lateral jsonb_array_elements_text(parent->'split_cohort_ids') split(cohort_id)
  cross join lateral (select public.get_factory_failure_cohort(workspace_id, factory_id, split.cohort_id::uuid) as detail) child
  ) and jsonb_array_length(pg_temp.failure_detail('scorer')->'members') = 4,
  'both sides use frozen source references and repeated receipts for one run stay in the same partition');
reset role;

insert into public.session_validation_asset_withholdings(asset_id, state)
select report_id, 'redacted' from failure_runs where key = 'second';
insert into public.session_validation_asset_withholdings(asset_id, state)
select asset.id, 'redacted' from failure_runs fixture join public.session_validation_assets asset on asset.run_id = fixture.run_id
where fixture.key = 'first' and asset.evidence_key = 'tests/lint/log';
set local role authenticated;
select ok((select member#>>'{source,evidence_state}' = 'available' and member#>>'{source,validation_record_key}' = 'tests'
  from jsonb_array_elements(pg_temp.failure_detail('validation')->'members') member
  join failure_runs fixture on member->>'run_id' = fixture.run_id::text where fixture.key = 'first'),
  'withholding a slash-prefixed sibling command log does not hide the failed command evidence');
select ok((select member#>>'{source,evidence_state}' = 'withheld'
    and (member#>>'{source,target_commit_sha}') is null
  from jsonb_array_elements(pg_temp.failure_detail('scorer')->'members') member
  join failure_attempts attempt on member#>>'{source,evaluation_attempt_id}' = attempt.attempt_id::text
  where attempt.key = 'second'),
  'a withheld report immediately conceals protected scorer evidence details');
select ok(pg_temp.failure_summary('scorer') @> '{"failure_count":3,"support_count":2,
    "qualification_reasons":["missing_evidence","insufficient_support"]}',
  'withholding a scorer report reduces available support without erasing the observed failure');
reset role;

create temp table erased_fixture as
select fixture.session_id, clock_timestamp() archived_at from failure_runs fixture where fixture.key = 'first';
grant select on erased_fixture to authenticated;
update public.sessions owner set archived_at = fixture.archived_at from erased_fixture fixture where owner.id = fixture.session_id;
set local role authenticated;
set local request.jwt.claim.sub = '63300000-0000-4000-8000-000000000001';
select public.erase_session_retained_content(scope.workspace_id, scope.factory_id, fixture.session_id, fixture.archived_at)
from failure_scope scope cross join erased_fixture fixture;
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.failure_detail('scorer')->'members') member
  join erased_fixture fixture on member->>'session_id' = fixture.session_id::text)
  and not exists (select 1 from jsonb_array_elements(pg_temp.failure_detail('validation')->'members') member
  join erased_fixture fixture on member->>'session_id' = fixture.session_id::text)
  and pg_temp.failure_summary('scorer') @> '{"failure_count":2,"support_count":1}',
  'content erasure immediately hides source members and adjusts displayed support');
select is(jsonb_array_length(pg_temp.failure_summary('scorer')->'split_cohort_ids'), 1,
  'erasure hides a reviewed partition whose original source members are all withheld');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

select pg_temp.activate_failure_definition(3, null);
insert into failure_runs select 'legacy', fixture.*
from pg_temp.publish_failure_run('Older definition without task routing or a frozen plan',
  p_with_log => false, p_with_plan => false) fixture;
select pg_temp.activate_failure_definition(4, 'review');
insert into failure_runs select 'unmatched', fixture.* from pg_temp.publish_failure_run('Unmatched task class') fixture;
select public.process_factory_failure_cohorts(100);
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '63300000-0000-4000-8000-000000000002';
select ok(pg_temp.failure_summary('validation') @> '{"failure_count":3,"support_count":1}',
  'the build stage name cannot add unclassified runs to the matched build class');
select ok((select summary @> '{"failure_count":2,"support_count":2,"task_class_slug":null,
    "qualification":"inconclusive","qualification_reasons":["missing_identity"]}'
  from jsonb_array_elements(pg_temp.list_failures()->'cohorts') summary
  where summary->>'symptom_kind' = 'validation' and summary->>'task_class_slug' is null),
  'unmatched runs retain unknown task class and legacy receipts without a frozen plan retain exact report support');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

select public.revoke_factory_membership(workspace_id, factory_id, owner_id, pg_temp.cohort_fixture_id(22)) from failure_scope;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '63300000-0000-4000-8000-000000000002';
select throws_ok($$select pg_temp.list_failures()$$, 'P0002', null,
  'revoking the grant prevents an existing caller from reading cohorts');
reset role;
select * from finish();
rollback;
