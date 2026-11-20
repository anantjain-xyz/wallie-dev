begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.sampling_id(p_slot integer) returns uuid language sql immutable as $$
  select ('60300000-0000-4000-8000-' || lpad(p_slot::text, 12, '0'))::uuid;
$$;

insert into auth.users(id, email) values
  (pg_temp.sampling_id(1), 'sampling-owner@example.test'),
  (pg_temp.sampling_id(2), 'sampling-reader@example.test'),
  (pg_temp.sampling_id(3), 'sampling-foreign-owner@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.sampling_id(11), 'sampling-primary', 'Sampling primary'),
  (pg_temp.sampling_id(12), 'sampling-foreign', 'Sampling foreign');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.sampling_id(21), pg_temp.sampling_id(11), pg_temp.sampling_id(1), 'human', 'owner'),
  (pg_temp.sampling_id(22), pg_temp.sampling_id(11), pg_temp.sampling_id(2), 'human', 'member'),
  (pg_temp.sampling_id(23), pg_temp.sampling_id(12), pg_temp.sampling_id(3), 'human', 'owner');
insert into public.factories(id, workspace_id, name, slug, is_default) values
  (pg_temp.sampling_id(20), pg_temp.sampling_id(11), 'Restricted sampling factory', 'restricted', false);

create temp table sample_scope as
select 'primary'::text as key, workspace_id, id as factory_id, pg_temp.sampling_id(1) as owner_id
from public.factories where workspace_id = pg_temp.sampling_id(11) and is_default
union all
select 'sibling', workspace_id, id, pg_temp.sampling_id(1)
from public.factories where id = pg_temp.sampling_id(20)
union all
select 'foreign', workspace_id, id, pg_temp.sampling_id(3)
from public.factories where workspace_id = pg_temp.sampling_id(12) and is_default;

insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
select pg_temp.sampling_id(case key when 'primary' then 31 else 34 end), workspace_id, factory_id,
  'Sampling pipeline', key = 'primary'
from sample_scope where key in ('primary', 'sibling');
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name) values
  (pg_temp.sampling_id(32), pg_temp.sampling_id(11), pg_temp.sampling_id(31), 1, 'build', 'Build'),
  (pg_temp.sampling_id(33), pg_temp.sampling_id(11), pg_temp.sampling_id(31), 2, 'review', 'Review'),
  (pg_temp.sampling_id(35), pg_temp.sampling_id(11), pg_temp.sampling_id(34), 1, 'verify', 'Verify');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type,
  target_name, permissions)
values (pg_temp.sampling_id(40), pg_temp.sampling_id(11), 60300040, 'https://github.test/installations/60300040',
  60300, 'Organization', 'fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
select pg_temp.sampling_id(41), workspace_id, factory_id, pg_temp.sampling_id(40), 60300041,
  'sampling', 'fixture/sampling', true, 'https://github.test/fixture/sampling', 'main'
from sample_scope where key = 'primary';
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.sampling_id(1), 'platform_api_key', 'sampling-fixture-ciphertext');
insert into public.workspace_sandbox_settings(workspace_id, active_provider)
values (pg_temp.sampling_id(11), 'e2b') on conflict (workspace_id) do update set active_provider = excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
values (pg_temp.sampling_id(11), 'sampling-fixture-sandbox');

create temp table sample_scorers as
select spec.key, scorer.id
from (values
  ('exact', 'primary', '["code_diff","artifact"]'::jsonb),
  ('missing', 'primary', '["artifact","validation_report"]'::jsonb),
  ('sibling', 'sibling', '["artifact"]'::jsonb),
  ('foreign', 'foreign', '["artifact"]'::jsonb)
) spec(key, scope_key, evidence)
join sample_scope scope on scope.key = spec.scope_key
cross join lateral public.create_factory_scorer(scope.workspace_id, scope.factory_id, scope.owner_id,
  initcap(spec.key), spec.key, jsonb_build_object('schemaVersion', 1, 'rubric', 'Review the retained output.',
    'requiredEvidence', spec.evidence, 'scoring', '{"kind":"boolean","passValue":true}'::jsonb)) scorer;

with compiled as (
  select scope.workspace_id, scope.factory_id, scope.owner_id,
    jsonb_build_object('schemaVersion', 2, 'kind', 'serial', 'sandboxProvider', 'e2b',
      'pipelineId', pg_temp.sampling_id(31), 'repositoryId', pg_temp.sampling_id(41),
      'scorerRevisionIds', (select jsonb_agg(id order by id) from sample_scorers where key in ('exact', 'missing')),
      'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
      'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'concurrencyLimit', 1,
        'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
      'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.sampling_id(32), 'slug', 'build', 'name', 'Build',
        'description', '', 'promptTemplateMd', 'Produce a report.', 'anyoneCanApprove', true,
        'previousStageIds', '[]'::jsonb, 'approverMemberIds', '[]'::jsonb)))::text as definition
  from sample_scope scope where scope.key = 'primary'
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.sampling_id(51), workspace_id, factory_id, 2, definition,
    encode(sha256(convert_to(definition, 'UTF8')), 'hex'), owner_id from compiled
  returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 1, created_by from revision;

select public.set_git_continuity_release(true, revision, 'Scorer sampling fixture')
from public.get_git_continuity_release_state() where not enabled;

create function pg_temp.accept_sample_run(p_title text) returns uuid language plpgsql as $$
declare fixture record; run_id uuid; commit_sha text := repeat('a', 40); artifact text := 'Retained sampling artifact.';
begin
  select * into strict fixture from public.create_session_with_first_job(
    pg_temp.sampling_id(11), pg_temp.sampling_id(21), p_title, 'Sample the exact output.', 'codex', 'gpt-5.5');
  update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = 1 where id = fixture.job_id;
  run_id := public.start_session_job_attempt(fixture.job_id, 1, pg_temp.sampling_id(32), 0,
    'codex', 'gpt-5.5', 'project', 'wallie/sampling-' || fixture.job_id::text);
  if run_id is null then raise exception 'Could not start fixture run.'; end if;
  perform public.pin_session_job_git_input(fixture.job_id, 1, run_id, pg_temp.sampling_id(41), 'main', commit_sha);
  if not found or public.prepare_session_source_delivery(run_id, pg_temp.sampling_id(41), 'main',
    commit_sha, commit_sha, 'No code change', artifact, '', '', '') is distinct from true then
    raise exception 'Could not prepare fixture checkpoint.';
  end if;
  if public.publish_session_job_with_source(fixture.job_id, 1, run_id, 0, artifact) is distinct from true then
    raise exception 'Could not publish fixture checkpoint.';
  end if;
  return run_id;
end;
$$;

-- Keep this no-code fixture on the legacy delivery path while exercising the
-- real exact claim, input pin, accepted checkpoint and artifact guards.
alter table public.session_git_heads disable trigger enqueue_session_pr_sync;
create temp table sample_runs(key text primary key, id uuid not null);
insert into sample_runs values ('first', pg_temp.accept_sample_run('First sampling fixture'));
insert into sample_runs values ('second', pg_temp.accept_sample_run('Second sampling fixture'));
alter table public.session_git_heads enable trigger enqueue_session_pr_sync;

with tied as (select clock_timestamp() as finished_at)
update public.agent_runs run set finished_at = tied.finished_at
from tied where run.id in (select id from sample_runs);

-- Model terminal observations from before transaction IDs were recorded. A
-- rollback-only fixture's own writes cannot belong to a closed snapshot.
alter table internal.factory_outcome_observations disable trigger factory_outcome_observations_immutable;
update internal.factory_outcome_observations observation
set recorded_xact_id = null, occurred_at = run.finished_at,
  observed_at = greatest(observation.observed_at, run.finished_at)
from public.agent_runs run join sample_runs fixture on fixture.id = run.id
where (observation.workspace_id, observation.session_id, observation.run_id) =
  (run.workspace_id, run.session_id, run.id)
  and observation.event_type = 'run.finished' and observation.capture_mode = 'live';
alter table internal.factory_outcome_observations enable trigger factory_outcome_observations_immutable;

create temp table sample_cutoff as select clock_timestamp() as before_finished_at;

create temp table sample_policies(key text primary key, id uuid not null);
grant select on sample_scope, sample_scorers, sample_runs, sample_cutoff to service_role;
grant select, insert on sample_policies to service_role;

create function pg_temp.save_sample_policy(p_scope text, p_scorer text, p_expected integer, p_rate integer,
  p_statuses text[] default array['success']::text[], p_stages uuid[] default '{}'::uuid[], p_actor uuid default null)
returns public.factory_scorer_sampling_policies language sql as $$
  select public.save_factory_scorer_sampling_policy(scope.workspace_id, scope.factory_id,
    coalesce(p_actor, scope.owner_id), scorer.id, p_expected, p_rate, 'balanced-seed', p_statuses, p_stages)
  from sample_scope scope cross join sample_scorers scorer where scope.key = p_scope and scorer.key = p_scorer;
$$;

create function pg_temp.record_sample(p_scope text, p_policy text, p_run text)
returns public.factory_scorer_sample_receipts language sql as $$
  select public.record_factory_scorer_sample(scope.workspace_id, scope.factory_id, policy.id, run.id)
  from sample_scope scope cross join sample_policies policy cross join sample_runs run
  where scope.key = p_scope and policy.key = p_policy and run.key = p_run;
$$;

create function pg_temp.backfill_sample(p_policy text, p_after_finished_at timestamptz default null,
  p_after_run_id uuid default null, p_limit integer default 1, p_closed_before text default null)
returns table(candidate_count integer, eligible_count integer, sampled_count integer, excluded_count integer,
  next_finished_at timestamptz, next_run_id uuid, closed_before text) language sql as $$
  select page.* from sample_scope scope cross join sample_policies policy cross join sample_cutoff cutoff
  cross join lateral public.backfill_factory_scorer_samples(scope.workspace_id, scope.factory_id, policy.id,
    cutoff.before_finished_at, p_after_finished_at, p_after_run_id, p_limit, p_closed_before) page
  where scope.key = 'primary' and policy.key = p_policy;
$$;

select ok(not has_function_privilege('authenticated',
    'public.save_factory_scorer_sampling_policy(uuid,uuid,uuid,uuid,integer,integer,text,text[],uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.record_factory_scorer_sample(uuid,uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.backfill_factory_scorer_samples(uuid,uuid,uuid,timestamptz,timestamptz,uuid,integer,text)', 'EXECUTE')
  and not has_table_privilege('authenticated', 'public.factory_scorer_sample_receipts', 'SELECT'),
  'browser roles cannot write policies, record samples, backfill, or read raw receipts');

set local role service_role;
insert into sample_policies select 'all', id from pg_temp.save_sample_policy('primary', 'exact', 0, 10000);
select throws_ok($$select pg_temp.save_sample_policy('primary', 'exact', 0, 0)$$, 'PT409', null,
  'a stale expected sampling policy revision cannot append');
select throws_ok($$select pg_temp.save_sample_policy('primary', 'exact', 1, 0, p_actor => pg_temp.sampling_id(2))$$,
  '42501', 'Factory manager access is required.', 'an ordinary member cannot change the sampling policy');
select throws_ok($$select pg_temp.save_sample_policy('primary', 'foreign', 0, 0)$$, 'P0002', null,
  'a policy cannot bind a scorer revision from another tenant');
select throws_ok($$select pg_temp.save_sample_policy('primary', 'exact', 1, 0,
    p_stages => array[pg_temp.sampling_id(35)])$$, '22023', null,
  'a policy cannot filter on a stage in a sibling factory');
insert into sample_policies select 'none', id from pg_temp.save_sample_policy('primary', 'exact', 1, 0);
insert into sample_policies select 'partial', id from pg_temp.save_sample_policy('primary', 'exact', 2, 5000);
insert into sample_policies select 'status', id from pg_temp.save_sample_policy('primary', 'exact', 3, 10000, array['canceled']);
insert into sample_policies select 'stage', id from pg_temp.save_sample_policy('primary', 'exact', 4, 10000,
  p_stages => array[pg_temp.sampling_id(33)]);
insert into sample_policies select 'missing', id from pg_temp.save_sample_policy('primary', 'missing', 0, 10000);
insert into sample_policies select 'sibling', id from pg_temp.save_sample_policy('sibling', 'sibling', 0, 10000);
insert into sample_policies select 'foreign', id from pg_temp.save_sample_policy('foreign', 'foreign', 0, 10000);
select throws_ok($$select pg_temp.record_sample('primary', 'sibling', 'first')$$, 'P0002', null,
  'sample recording refuses a policy ID from a different factory');
select throws_ok($$select pg_temp.record_sample('sibling', 'sibling', 'first')$$, 'P0002', null,
  'sample recording refuses a run from a different factory than the policy');

select is((pg_temp.record_sample('primary', 'all', 'first')).outcome, 'sampled',
  'eligible output is sampled at 100 percent');
select is((pg_temp.record_sample('primary', 'none', 'first')).outcome, 'not_sampled',
  'eligible output is recorded without entering a zero-percent sample');
select is((pg_temp.record_sample('primary', 'status', 'first')).reason, 'status_excluded',
  'a terminal status outside the policy is excluded regardless of rate');
select is((pg_temp.record_sample('primary', 'stage', 'first')).reason, 'stage_excluded',
  'a stage outside the policy is excluded regardless of rate');
select is((pg_temp.record_sample('primary', 'missing', 'first')).reason, 'missing_evidence',
  'a bound scorer that lacks the required validation report is excluded');
select (pg_temp.record_sample('primary', 'partial', 'first')).id;
select (pg_temp.record_sample('primary', 'partial', 'second')).id;
reset role;

select ok((select receipt.workspace_id = checkpoint.workspace_id and receipt.session_id = checkpoint.session_id
    and receipt.attempt_count = checkpoint.attempt_count and receipt.target_commit_sha = checkpoint.output_sha
    and receipt.definition_revision_id = pg_temp.sampling_id(51) and receipt.scorer_revision_id = scorer.id
    and receipt.evidence = jsonb_build_array(jsonb_build_object('kind', 'code_diff', 'id', checkpoint.run_id),
      jsonb_build_object('kind', 'artifact', 'id', checkpoint.artifact_id)) and receipt.missing_evidence = '{}'::text[]
  from public.factory_scorer_sample_receipts receipt
  join public.session_git_checkpoints checkpoint on checkpoint.run_id = receipt.run_id
  join sample_policies policy on receipt.policy_id = policy.id and policy.key = 'all'
  join sample_scorers scorer on scorer.key = 'exact'),
  'the receipt pins the accepted attempt, commit, artifact, factory definition and scorer revision');
select is((select missing_evidence from public.factory_scorer_sample_receipts receipt
  join sample_policies policy on receipt.policy_id = policy.id where policy.key = 'missing'),
  array['validation_report']::text[], 'missing evidence does not fabricate a validation asset');

select is(internal.factory_scorer_sample_draw('balanced-seed', pg_temp.sampling_id(100)), 4119917134::bigint,
  'seeded draw matches the fixed out-of-sample vector');
select is(internal.factory_scorer_sample_draw('balanced-seed', pg_temp.sampling_id(102)), 1544669318::bigint,
  'seeded draw matches the fixed in-sample vector');
select ok((select count(*) = 2 and bool_and(receipt.outcome = case when get_byte(sha256(convert_to(
      'wallie:factory-scorer-sampling:v1' || chr(10) || 'balanced-seed' || chr(10) || receipt.run_id::text,
      'UTF8')), 0) < 128 then 'sampled' else 'not_sampled' end)
  from public.factory_scorer_sample_receipts receipt
  join sample_policies policy on receipt.policy_id = policy.id where policy.key = 'partial'),
  'both 50 percent receipts agree with the deterministic seeded threshold');

create temp table sample_first_page as select * from pg_temp.backfill_sample('all');
select ok((select candidate_count = 1 and eligible_count = 1 and sampled_count = 1 and excluded_count = 0
    and next_finished_at is not null and next_run_id = (select id from sample_runs order by id limit 1)
    and closed_before is not null
  from sample_first_page), 'a bounded page returns the closed horizon and breaks timestamp ties by run ID');
select results_eq($$select candidate_count, eligible_count, sampled_count, excluded_count, next_finished_at, next_run_id
    from pg_temp.backfill_sample('all')$$,
  $$select candidate_count, eligible_count, sampled_count, excluded_count, next_finished_at, next_run_id
    from sample_first_page$$, 'replaying the bounded page returns the same keyset and counts');
select ok((select final.candidate_count = 1 and final.eligible_count = 1
    and final.sampled_count = 1 and final.excluded_count = 0
    and final.next_finished_at is null and final.next_run_id is null and final.closed_before is null
  from sample_first_page first cross join lateral
    pg_temp.backfill_sample('all', first.next_finished_at, first.next_run_id,
      p_closed_before => first.closed_before) final),
  'the original horizon lets the next page visit the tied second run and finish');
select throws_ok($$select pg_temp.backfill_sample('all', next_finished_at, next_run_id) from sample_first_page$$,
  '22023', null, 'a continuation must carry the closed horizon with the keyset');
select throws_ok($$select pg_temp.backfill_sample('all', next_finished_at, next_run_id,
    p_closed_before => 'invalid-horizon') from sample_first_page$$,
  '22023', null, 'a malformed closed horizon is rejected');
select throws_ok($$select pg_temp.backfill_sample('all', next_finished_at, next_run_id,
    p_closed_before => left(closed_before, -1) || case right(closed_before, 1) when '0' then '1' else '0' end)
  from sample_first_page$$, '22023', 'Invalid scorer sampling backfill cursor.',
  'a well-formed token with a modified signature is rejected');
select throws_ok($$select pg_temp.backfill_sample('none', next_finished_at, next_run_id,
    p_closed_before => closed_before) from sample_first_page$$,
  '22023', 'Invalid scorer sampling backfill cursor.', 'a closed horizon cannot be replayed for another policy');
select is((select count(*) from public.factory_scorer_sample_receipts receipt
  join sample_policies policy on receipt.policy_id = policy.id where policy.key = 'all'),
  2::bigint, 'backfill replay preserves one immutable receipt per policy and run');
select ok((select candidate_count = 2 and eligible_count = 0 and sampled_count = 0 and excluded_count = 2
  from pg_temp.backfill_sample('missing', p_limit => 2)), 'backfill counts missing-evidence runs as excluded');
select throws_ok($$select pg_temp.backfill_sample('all', p_after_finished_at => '-infinity')$$, '22023', null,
  'backfill rejects a partially specified cursor');
select throws_ok($$update public.factory_scorer_sample_receipts set outcome = 'not_sampled'
  where policy_id = (select id from sample_policies where key = 'all')$$,
  '23514', 'Scorer sampling history is immutable.', 'even privileged SQL cannot rewrite cohort membership');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select is((select count(*) from public.factory_scorer_sampling_policies), 6::bigint,
  'policy RLS exposes the reader’s factory and conceals sibling and foreign policies');
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000003';
select is((select count(*) from public.factory_scorer_sampling_policies), 1::bigint,
  'the foreign tenant can read only its own policy');
reset role;

select * from finish();
rollback;
