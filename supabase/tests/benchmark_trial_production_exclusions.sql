begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.exclusion_id(slot integer) returns uuid language sql immutable as $$
  select ('61610000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.exclusion_id(1), 'benchmark-exclusion-owner@example.test'),
  (pg_temp.exclusion_id(2), 'benchmark-exclusion-reader@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.exclusion_id(10), 'benchmark-exclusion-fixture', 'Benchmark Exclusion Fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.exclusion_id(11), pg_temp.exclusion_id(10), pg_temp.exclusion_id(1), 'human', 'owner'),
  (pg_temp.exclusion_id(12), pg_temp.exclusion_id(10), pg_temp.exclusion_id(2), 'human', 'member');

create function pg_temp.exclusion_factory() returns uuid language sql stable as $$
  select factory.id from public.factories factory
  where factory.workspace_id = pg_temp.exclusion_id(10) and factory.is_default
$$;

select public.grant_factory_membership(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
  pg_temp.exclusion_id(1), pg_temp.exclusion_id(12), 'member');

insert into public.pipelines(id, workspace_id, factory_id, name, is_default) values
  (pg_temp.exclusion_id(20), pg_temp.exclusion_id(10), pg_temp.exclusion_factory(), 'Paired pipeline', true),
  (pg_temp.exclusion_id(21), pg_temp.exclusion_id(10), pg_temp.exclusion_factory(), 'Trial-only pipeline', false);
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name) values
  (pg_temp.exclusion_id(23), pg_temp.exclusion_id(10), pg_temp.exclusion_id(20), 1, 'work', 'Work'),
  (pg_temp.exclusion_id(24), pg_temp.exclusion_id(10), pg_temp.exclusion_id(21), 1, 'trial', 'Trial');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
  target_type, target_name, permissions)
values (pg_temp.exclusion_id(25), pg_temp.exclusion_id(10), 61610025, 'https://github.test/installations/61610025',
  61610, 'Organization', 'fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
values (pg_temp.exclusion_id(26), pg_temp.exclusion_id(10), pg_temp.exclusion_factory(), pg_temp.exclusion_id(25),
  61610026, 'paired', 'fixture/paired', true, 'https://github.test/fixture/paired', 'main');

create temp table exclusion_scorer as
select * from public.create_factory_scorer(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
  pg_temp.exclusion_id(1), 'Paired scorer', 'paired', '{"schemaVersion":1,"rubric":"Retain the output.",
    "requiredEvidence":["artifact"],"scoring":{"kind":"boolean","passValue":true}}');
with definition as (
  select jsonb_build_object('schemaVersion', 2, 'kind', 'serial', 'pipelineId', pg_temp.exclusion_id(20),
    'scorerRevisionIds', jsonb_build_array(id))::text as body from exclusion_scorer
)
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
  canonical_digest, created_by)
select pg_temp.exclusion_id(27), pg_temp.exclusion_id(10), pg_temp.exclusion_factory(), 2,
  body, encode(sha256(convert_to(body, 'UTF8')), 'hex'), pg_temp.exclusion_id(1) from definition;

create temp table exclusion_policy as
select policy.* from exclusion_scorer scorer
cross join lateral public.save_factory_scorer_sampling_policy(scorer.workspace_id, scorer.factory_id,
  pg_temp.exclusion_id(1), scorer.id, 0, 10000, 'paired-production-policy') policy;

insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  github_repository_id, phase_status, factory_definition_provenance, factory_definition_revision_id)
values (pg_temp.exclusion_id(30), pg_temp.exclusion_id(10), pg_temp.exclusion_factory(), 901,
  'Ordinary paired session', pg_temp.exclusion_id(20), pg_temp.exclusion_id(23), pg_temp.exclusion_id(26),
  'in_progress', 'pinned', pg_temp.exclusion_id(27));
insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  execution_purpose, phase_status, factory_definition_provenance, factory_definition_revision_id)
values
  (pg_temp.exclusion_id(31), pg_temp.exclusion_id(10), pg_temp.exclusion_factory(), -901, 'PrivateReplayCanary',
    pg_temp.exclusion_id(20), pg_temp.exclusion_id(23), 'benchmark', 'in_progress', 'pinned', pg_temp.exclusion_id(27)),
  (pg_temp.exclusion_id(32), pg_temp.exclusion_id(10), pg_temp.exclusion_factory(), -902, 'Hidden second lane',
    pg_temp.exclusion_id(21), pg_temp.exclusion_id(24), 'benchmark', 'in_progress', 'pinned', pg_temp.exclusion_id(27));

insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
values (pg_temp.exclusion_id(30), pg_temp.exclusion_id(10), pg_temp.exclusion_id(26), 'fixture/paired', 'main', repeat('a', 40));

insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count, started_at)
select pg_temp.exclusion_id(slot + 10), pg_temp.exclusion_id(10), pg_temp.exclusion_id(slot), pg_temp.exclusion_id(23),
  'work', 'manual_run', 'running', 1, clock_timestamp() - interval '1 minute'
from (values (30), (31)) as paired(slot);
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug,
  run_type, model_provider, model_name, status, attempt_count, started_at)
select pg_temp.exclusion_id(slot + 20), pg_temp.exclusion_id(10), pg_temp.exclusion_id(slot), pg_temp.exclusion_id(slot + 10),
  pg_temp.exclusion_id(23), 'work', 'project', 'codex', 'gpt-5.5', 'running', 1, clock_timestamp() - interval '1 minute'
from (values (30), (31)) as paired(slot);
update public.agent_runs set status = 'success', finished_at = clock_timestamp()
where id in (pg_temp.exclusion_id(50), pg_temp.exclusion_id(51));
update public.agent_jobs set status = 'success', finished_at = clock_timestamp()
where id in (pg_temp.exclusion_id(40), pg_temp.exclusion_id(41));

insert into public.session_artifacts(id, session_id, workspace_id, stage_id, stage_slug, version, artifact_json)
select pg_temp.exclusion_id(slot + 30), pg_temp.exclusion_id(slot), pg_temp.exclusion_id(10), pg_temp.exclusion_id(23),
  'work', 1, to_jsonb('Paired Markdown'::text) from (values (30), (31)) as paired(slot);

select results_eq($$select distinct session_id from internal.factory_outcome_observations
  where workspace_id = pg_temp.exclusion_id(10)$$, $$select pg_temp.exclusion_id(30)$$,
  'production lifecycle capture omits trial creation, jobs, and completed runs');
select results_eq($$select id from internal.factory_session_read_owners where workspace_id = pg_temp.exclusion_id(10)$$,
  $$select pg_temp.exclusion_id(30)$$, 'API, MCP, and the webhook writer share only production session owners');
select is((internal.project_factory_session_read(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
  pg_temp.exclusion_id(26), 'session', pg_temp.exclusion_id(31), null, null, 25, null, null, null, 'before', null))->>'status',
  'not_found', 'an exact private session ID cannot address a trial through the factory API projection');

select ok(internal.session_pr_is_eligible(pg_temp.exclusion_id(30), pg_temp.exclusion_id(10))
  and not internal.session_pr_is_eligible(pg_temp.exclusion_id(31), pg_temp.exclusion_id(10)),
  'the canonical PR worker can claim ordinary sessions only');
select throws_ok($$insert into public.session_pr_refresh_queue(session_id, workspace_id)
  values (pg_temp.exclusion_id(31), pg_temp.exclusion_id(10))$$,
  '42501', 'A production delivery requires a production session.', 'trial cannot enqueue production PR refresh');
select throws_ok($$insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name,
  base_branch, initial_base_sha) values (pg_temp.exclusion_id(31), pg_temp.exclusion_id(10), pg_temp.exclusion_id(26),
    'fixture/paired', 'main', repeat('a', 40))$$,
  '42501', 'A production delivery requires a production session.', 'trial cannot acquire canonical production Git lineage');
select throws_ok($$select internal.session_mutation_human_actor(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
  pg_temp.exclusion_id(11), pg_temp.exclusion_id(31))$$,
  'PT404', 'Session not found.', 'ordinary session commands reject trial IDs');
select ok((internal.session_mutation_human_actor(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
  pg_temp.exclusion_id(11), pg_temp.exclusion_id(30))).member_id = pg_temp.exclusion_id(11),
  'the same actor still addresses the production session');

select results_eq($$select run_id from internal.factory_cost_contributions(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
  statement_timestamp() - interval '1 hour', statement_timestamp() + interval '1 hour', 'operating')$$,
  $$select pg_temp.exclusion_id(50)$$, 'operating cost aggregates include production usage only');
select is((public.enqueue_factory_flow_rebuild(pg_temp.exclusion_id(10), pg_temp.exclusion_factory()))->>'enqueued',
  '1', 'factory flow rebuild considers only the production session');
select is((public.record_factory_scorer_sample(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
  (select id from exclusion_policy), pg_temp.exclusion_id(50))).outcome,
  'excluded', 'ordinary terminal run reaches the scorer and records the absent checkpoint');
select throws_ok($$select public.record_factory_scorer_sample(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
    (select id from exclusion_policy), pg_temp.exclusion_id(51))$$,
  'P0002', 'Terminal run is unavailable for this scorer policy.', 'a production scorer cannot sample an exact completed trial');
select throws_ok($$select public.create_factory_benchmark_task(pg_temp.exclusion_id(10), pg_temp.exclusion_factory(),
    pg_temp.exclusion_id(1), pg_temp.exclusion_id(51), 'Nested trial', 'Check the answer.', '{}')$$,
  'P0002', 'Source run is unavailable in this factory.', 'a trial cannot be captured as a production source run');

create temp table exclusion_export as select * from public.request_run_export(
  pg_temp.exclusion_id(10), pg_temp.exclusion_id(1), pg_temp.exclusion_id(70));
select * from public.claim_run_export();
select results_eq($$select entry.record_id from internal.run_export_entries entry join exclusion_export export on export.id = entry.export_id
  where entry.record_kind = 'run'$$, $$select pg_temp.exclusion_id(50)$$,
  'workspace archive contains the production run and excludes trial run records');
select results_eq($$select entry.record_id from internal.run_export_entries entry join exclusion_export export on export.id = entry.export_id
  where entry.record_kind = 'stage_markdown'$$, $$select pg_temp.exclusion_id(60)$$,
  'workspace archive excludes even unlinked artifacts belonging to the trial');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '61610000-0000-4000-8000-000000000002';

select results_eq($$select number from public.sessions where workspace_id = pg_temp.exclusion_id(10)$$,
  $$values (901)$$, 'direct session activity totals use production scope');
select results_eq($$select run_id from public.list_workspace_run_catalog(pg_temp.exclusion_id(10))$$,
  $$select pg_temp.exclusion_id(50)$$, 'the run catalog still returns the regular run');
select is((select count(*) from public.list_workspace_run_catalog(pg_temp.exclusion_id(10), p_run_id => pg_temp.exclusion_id(51))),
  0::bigint, 'the regular run inspector cannot address the trial by exact run ID');
select is(public.get_session_detail_page('benchmark-exclusion-fixture', 901)#>>'{session,id}',
  pg_temp.exclusion_id(30)::text, 'the normal session detail remains visible');
select is(public.get_session_detail_page('benchmark-exclusion-fixture', -901),
  null::jsonb, 'the internal session number cannot access production session detail');
select is((select count(*) from public.get_session_git_continuity_state(pg_temp.exclusion_id(30))),
  1::bigint, 'the ordinary session retains its continuity state');
select is((select count(*) from public.get_session_git_continuity_state(pg_temp.exclusion_id(31))),
  0::bigint, 'continuity state does not reveal a trial by exact session ID');

create temp table exclusion_session_list as
select public.get_session_list_page('benchmark-exclusion-fixture', page_limit => 1) as page;
select is((select page#>>'{scopeFacets,all}' from exclusion_session_list), '1',
  'session totals exclude trials even with no factory filter');
select is((select page#>>'{stageFacets,0,count}' from exclusion_session_list), '1',
  'stage search facets exclude trials');
select is((select page->>'hasMore' from exclusion_session_list), 'false', 'trials cannot create a hidden page');
select is((select page#>>'{sessions,0,id}' from exclusion_session_list), pg_temp.exclusion_id(30)::text,
  'bounded production pagination retains the ordinary session');
select is(public.get_session_list_page('benchmark-exclusion-fixture', search_query => 'PrivateReplayCanary')->'sessions',
  '[]'::jsonb, 'full text search cannot find the trial title');

create temp table exclusion_board as
select public.get_filtered_pipeline_dashboard_page(pg_temp.exclusion_id(10)) as board;
select is((select jsonb_array_length(board->'lanes') from exclusion_board), 1,
  'a trial cannot make a nondefault pipeline lane visible');
select is((select board#>>'{lanes,0,totalCount}' from exclusion_board), '1', 'pipeline counts exclude trials');
select is((select board#>>'{lanes,0,cards,0,id}' from exclusion_board), pg_temp.exclusion_id(30)::text,
  'the production board still contains its regular session');

reset role;
select * from finish();
rollback;
