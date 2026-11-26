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
      'stages', jsonb_build_array(
        jsonb_build_object('id', pg_temp.sampling_id(32), 'slug', 'build', 'name', 'Build',
          'description', '', 'promptTemplateMd', 'Produce a report.', 'anyoneCanApprove', true,
          'previousStageIds', '[]'::jsonb, 'approverMemberIds', '[]'::jsonb),
        jsonb_build_object('id', pg_temp.sampling_id(33), 'slug', 'review', 'name', 'Review',
          'description', '', 'promptTemplateMd', 'Review the report.', 'anyoneCanApprove', true,
          'previousStageIds', jsonb_build_array(pg_temp.sampling_id(32)), 'approverMemberIds', '[]'::jsonb)))::text as definition
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

create function pg_temp.record_judge_report(p_run_id uuid, p_commit_sha text) returns void language plpgsql as $$
declare
  asset_id uuid := gen_random_uuid();
  report_path text := pg_temp.sampling_id(11)::text || '/' || p_run_id::text || '/' || asset_id::text;
  report_body text := 'Retained judge fixture report.';
  tree_sha text := repeat('c', 40);
  observed_at timestamptz := clock_timestamp();
begin
  perform public.pin_session_validation_plan(p_run_id, p_commit_sha, tree_sha,
    '{"version":1,"commands":[{"key":"tests","command":"pnpm test","timeoutSeconds":60,
      "reports":[{"key":"report","path":"report.txt","kind":"report","required":true}]}]}');
  insert into storage.objects(bucket_id, name, metadata)
  values ('session-validation-evidence', report_path,
    jsonb_build_object('size', octet_length(report_body), 'mimetype', 'text/plain'));
  perform public.record_session_validation_evidence(p_run_id, p_commit_sha, tree_sha,
    jsonb_build_array(jsonb_build_object('key', 'tests', 'command', 'pnpm test', 'provenance', 'harness',
      'status', 'passed', 'exitCode', 0, 'startedAt', observed_at, 'completedAt', observed_at,
      'commitSha', p_commit_sha, 'treeSha', tree_sha, 'finalCommitSha', p_commit_sha, 'finalTreeSha', tree_sha,
      'reportKeys', '["tests/report"]'::jsonb, 'missingRequiredReports', '[]'::jsonb)),
    jsonb_build_array(jsonb_build_object('id', asset_id, 'key', 'tests/report', 'kind', 'report', 'required', true,
      'storagePath', report_path, 'sha256', encode(sha256(convert_to(report_body, 'UTF8')), 'hex'),
      'contentType', 'text/plain', 'sizeBytes', octet_length(report_body))));
end;
$$;

create function pg_temp.accept_sample_run(p_title text, p_with_report boolean default false) returns uuid language plpgsql as $$
declare
  fixture record;
  run_id uuid;
  publication_claim uuid;
  commit_sha text := repeat('a', 40);
  artifact text := 'Retained sampling artifact.';
begin
  select * into strict fixture from public.create_session_with_first_job(
    pg_temp.sampling_id(11), pg_temp.sampling_id(21), p_title, 'Sample the exact output.', 'codex', 'gpt-5.5');
  update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
    status = 'running', attempt_count = 1 where id = fixture.job_id;
  run_id := public.start_session_job_attempt(fixture.job_id, 1, pg_temp.sampling_id(32), 0,
    'codex', 'gpt-5.5', 'project', 'wallie/sampling-' || fixture.job_id::text);
  if run_id is null then raise exception 'Could not start fixture run.'; end if;
  perform public.pin_session_job_git_input(fixture.job_id, 1, run_id, pg_temp.sampling_id(41), 'main', commit_sha);
  if not found then raise exception 'Could not pin fixture checkpoint.'; end if;
  if p_with_report then perform pg_temp.record_judge_report(run_id, commit_sha); end if;
  if public.prepare_session_source_and_checkpoint_publication(run_id, pg_temp.sampling_id(41), 'main',
    commit_sha, commit_sha, 'No code change', artifact, '', '', '', 0, artifact) is distinct from true then
    raise exception 'Could not prepare fixture checkpoint.';
  end if;
  publication_claim := public.claim_session_checkpoint_publication(run_id);
  if publication_claim is null or
    public.adopt_session_checkpoint_publication(run_id, publication_claim, null, null) is distinct from true then
    raise exception 'Could not adopt fixture checkpoint.';
  end if;
  return run_id;
end;
$$;

create temp table sample_runs(key text primary key, id uuid not null);
insert into sample_runs values ('first', pg_temp.accept_sample_run('First sampling fixture'));
insert into sample_runs values ('second', pg_temp.accept_sample_run('Second sampling fixture'));

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
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

-- Reuse the accepted runs above for the dedicated queue. The two policies can
-- yield distinct receipts for the same run and immutable scorer revision.
create temp table evaluation_targets as
select fixture.key, job.id as job_id, job.run_id, job.session_id, job.sample_receipt_id,
  job.workspace_id, job.factory_id, job.scorer_revision_id
from sample_runs fixture join public.factory_evaluation_jobs job on job.run_id = fixture.id
join sample_scorers scorer on scorer.id = job.scorer_revision_id and scorer.key = 'exact';
select is((select count(*) from evaluation_targets), 2::bigint,
  'the two eligible sampled outputs enter the evaluation lane');
insert into sample_policies select 'evaluation-replay', id from pg_temp.save_sample_policy('primary', 'exact', 5, 10000);
select isnt((pg_temp.record_sample('primary', 'evaluation-replay', 'first')).id,
  (select sample_receipt_id from evaluation_targets where key = 'first'),
  'a new policy revision delivers a distinct sampled receipt for the same target and scorer');
select (pg_temp.record_sample('primary', 'evaluation-replay', 'first')).id;
select is((select count(*) from public.factory_evaluation_jobs job join evaluation_targets target
  on (target.workspace_id, target.factory_id, target.run_id, target.scorer_revision_id) =
    (job.workspace_id, job.factory_id, job.run_id, job.scorer_revision_id) where target.key = 'first'),
  1::bigint, 'repeated deliveries across policies admit only one evaluation for the run and scorer');
select ok((select job.sample_receipt_id = target.sample_receipt_id and job.status = 'queued' and job.attempt_count = 0
  from public.factory_evaluation_jobs job join evaluation_targets target on job.id = target.job_id where target.key = 'first'),
  'the evaluation keeps the first exact input receipt and waits without a claim');

create temp table published_before_evaluation as
select publication.run_id, to_jsonb(publication) as publication, to_jsonb(checkpoint) as checkpoint
from evaluation_targets target join public.session_checkpoint_publications publication on publication.run_id = target.run_id
join public.session_git_checkpoints checkpoint on checkpoint.run_id = target.run_id;

select ok(not has_table_privilege('authenticated', 'public.factory_evaluation_attempts', 'SELECT')
  and not has_table_privilege('service_role', 'public.factory_evaluation_jobs', 'INSERT,UPDATE,DELETE')
  and not has_function_privilege('authenticated', 'public.claim_factory_evaluation_job()', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.cancel_factory_evaluation_job(uuid,uuid,uuid,uuid)', 'EXECUTE'),
  'attempt leases stay private and queue mutations require the guarded commands');

create function pg_temp.configure_evaluation(p_expected integer, p_paused boolean)
returns public.factory_evaluation_lanes language sql as $$
  select public.configure_factory_evaluation_lane(pg_temp.sampling_id(11), pg_temp.sampling_id(1),
    p_expected, p_paused, 1);
$$;

create function pg_temp.advance_production(p_key text)
returns table(job_id uuid, run_id uuid, current_stage_id uuid, job_created boolean) language sql as $$
  select approved.job_id, approved.run_id, approved.current_stage_id, approved.job_created
  from evaluation_targets target join public.sessions session on session.id = target.session_id
  cross join lateral public.approve_session_stage(session.id, session.workspace_id, session.current_stage_id,
    session.current_artifact_id, session.current_artifact_version, pg_temp.sampling_id(21),
    'codex', 'gpt-5.5', 'project', session.artifact_review_revision) approved
  where target.key = p_key;
$$;

select ok((select lane.revision = 0 and not lane.paused and lane.max_concurrent = 2
  from public.get_factory_evaluation_lane(pg_temp.sampling_id(11), pg_temp.sampling_id(1)) lane),
  'a new workspace has its own default evaluation capacity');
select throws_ok($$select public.configure_factory_evaluation_lane(pg_temp.sampling_id(11),
    pg_temp.sampling_id(2), 0, true, 1)$$, '42501', null,
  'an ordinary workspace member cannot change the lane');
select ok((select paused and revision = 1 and max_concurrent = 1 from pg_temp.configure_evaluation(0, true)),
  'the workspace owner can pause evaluation and set its own limit');
select throws_ok($$select pg_temp.configure_evaluation(0, false)$$, 'PT409', null,
  'an outdated lane editor cannot overwrite the current pause and limit');
select is((select count(*) from public.claim_factory_evaluation_job()), 0::bigint,
  'a paused evaluation lane hands out no new claims');
select ok((select job_created and job_id is not null and run_id is not null and current_stage_id = pg_temp.sampling_id(33)
  from pg_temp.advance_production('second')),
  'the same session can approve its accepted artifact and enqueue the next production stage while evaluation is paused');

select (pg_temp.configure_evaluation(1, false)).revision;
create temp table evaluation_claims as
select 'initial'::text as slot, claim.* from public.claim_factory_evaluation_job() claim;
select ok((select claim.attempt_number = 1 and claim.workspace_id = target.workspace_id
    and claim.factory_id = target.factory_id and claim.session_id = target.session_id and claim.run_id = target.run_id
    and claim.scorer_revision_id = target.scorer_revision_id and claim.sample_receipt_id = target.sample_receipt_id
    and claim.target_commit_sha = repeat('a', 40) and claim.lease_expires_at > clock_timestamp()
  from evaluation_claims claim join evaluation_targets target on claim.job_id = target.job_id and target.key = 'first'
  where claim.slot = 'initial'),
  'the claim returns the immutable evaluation identity and exact accepted commit');
select is((select count(*) from public.claim_factory_evaluation_job()), 0::bigint,
  'an active evaluation lease consumes the single workspace slot');
create temp table production_approval_at_capacity as select * from pg_temp.advance_production('first');
select ok((select job_created and job_id is not null and run_id is not null and current_stage_id = pg_temp.sampling_id(33)
  from production_approval_at_capacity),
  'a saturated evaluation lane leaves the same session free to take its next production job');
create temp table production_claim_at_capacity as select * from public.claim_next_agent_job();
select ok((select claim.id is not null and claim.stage_id = pg_temp.sampling_id(33)
  from production_claim_at_capacity claim join evaluation_targets target on claim.session_id = target.session_id),
  'the production queue still claims a real next-stage job at evaluation capacity');
select ok((select public.start_session_job_attempt(claim.id, claim.attempt_count, claim.stage_id,
    session.current_artifact_version, 'codex', 'gpt-5.5', 'project', 'wallie/sampling-review-' || claim.id::text) is not null
  from production_claim_at_capacity claim join public.sessions session on session.id = claim.session_id),
  'the claimed production attempt starts while the evaluation lease still holds the slot');

select throws_ok($$update public.factory_evaluation_attempts set attempt_number = 9
  where id = (select attempt_id from evaluation_claims where slot = 'initial')$$,
  '23514', null, 'an evaluation attempt cannot be reassigned to another attempt number');
select throws_ok($$update public.factory_evaluation_jobs set target_commit_sha = repeat('b', 40)
  where id = (select job_id from evaluation_claims where slot = 'initial')$$,
  '23514', null, 'the evaluation target cannot move to another commit');

create function pg_temp.settle_evaluation(p_slot text, p_outcome text)
returns boolean language sql as $$
  select public.settle_factory_evaluation_attempt(claim.workspace_id, claim.factory_id,
    claim.job_id, claim.attempt_id, claim.lease_id, p_outcome)
  from evaluation_claims claim where claim.slot = p_slot;
$$;

-- Advance only the owned attempt's fixture clocks, retaining a 90-second lease.
alter table public.factory_evaluation_attempts disable trigger factory_evaluation_attempts_immutable;
with expired as (select clock_timestamp() - interval '1 second' as lease_at)
update public.factory_evaluation_attempts attempt set lease_expires_at = expired.lease_at,
  claimed_at = expired.lease_at - interval '90 seconds' from expired
where attempt.id = (select attempt_id from evaluation_claims where slot = 'initial');
alter table public.factory_evaluation_attempts enable trigger factory_evaluation_attempts_immutable;
select is(pg_temp.settle_evaluation('initial', 'succeeded'), false,
  'an expired worker loses completion authority before a replacement takes the lease');
select is((select public.prepare_factory_judge_invocation(claim.workspace_id, claim.factory_id,
    claim.job_id, claim.attempt_id, claim.lease_id)->>'status'
  from evaluation_claims claim where claim.slot = 'initial'), 'stale_claim',
  'an expired judge lease cannot read evidence before another worker reclaims the job');
select ok((select attempts_recovered = 1 and jobs_requeued = 1 and jobs_failed = 0
  from public.maintain_factory_evaluation_queue(10)), 'the maintenance loop requeues one expired evaluation');
select ok((select attempt.outcome = 'lease_expired' and attempt.settled_at is not null and job.status = 'queued'
  and job.available_at > clock_timestamp() and job.available_at <= clock_timestamp() + interval '5 seconds'
  from evaluation_claims claim join public.factory_evaluation_attempts attempt on attempt.id = claim.attempt_id
  join public.factory_evaluation_jobs job on job.id = claim.job_id where claim.slot = 'initial'),
  'expiry closes the old attempt and places the job behind bounded retry delay');

-- Keep the other fixture idle, then make the exact reclaimed attempt due.
update public.factory_evaluation_jobs set available_at = clock_timestamp() + interval '10 minutes'
where id = (select job_id from evaluation_targets where key = 'second');
select is((select count(*) from public.claim_factory_evaluation_job()), 0::bigint,
  'a retry cannot be claimed until its backoff has elapsed');
update public.factory_evaluation_jobs set available_at = clock_timestamp()
where id = (select job_id from evaluation_claims where slot = 'initial');
insert into evaluation_claims select 'replacement', claim.* from public.claim_factory_evaluation_job() claim;
select ok((select new.attempt_number = 2 and new.job_id = old.job_id and new.attempt_id <> old.attempt_id
    and new.lease_id <> old.lease_id and new.sample_receipt_id = old.sample_receipt_id
  from evaluation_claims new cross join evaluation_claims old
  where new.slot = 'replacement' and old.slot = 'initial'),
  'recovery keeps the target and replaces both attempt and lease identity');
select is(pg_temp.settle_evaluation('initial', 'succeeded'), false,
  'the original worker cannot settle after the replacement receives its own lease');
select is(pg_temp.settle_evaluation('replacement', 'retryable_failure'), true,
  'the current attempt can schedule another bounded retry');
select ok((select status = 'queued' and attempt_count = 2 and available_at > clock_timestamp()
  and available_at <= clock_timestamp() + interval '10 seconds' from public.factory_evaluation_jobs
  where id = (select job_id from evaluation_claims where slot = 'replacement')), 'retry delay grows with the attempt count');
update public.factory_evaluation_jobs set available_at = clock_timestamp()
where id = (select job_id from evaluation_claims where slot = 'replacement');
insert into evaluation_claims select 'final', claim.* from public.claim_factory_evaluation_job() claim;
select is(pg_temp.settle_evaluation('final', 'retryable_failure'), true,
  'the final permitted attempt can settle its retryable failure');
select ok((select status = 'failed' and attempt_count = attempt_limit and attempt_count = 3
  and available_at is null and finished_at is not null from public.factory_evaluation_jobs
  where id = (select job_id from evaluation_claims where slot = 'final')), 'the attempt budget stops retries at the configured limit');

update public.factory_evaluation_jobs set available_at = clock_timestamp()
where id = (select job_id from evaluation_targets where key = 'second');
select (public.archive_factory(workspace_id, factory_id, owner_id, 'Fixture archive')).status
from sample_scope where key = 'primary';
select is((select count(*) from public.claim_factory_evaluation_job()), 0::bigint,
  'an archived factory cannot acquire an evaluation claim');
select (public.restore_factory(workspace_id, factory_id, owner_id)).status from sample_scope where key = 'primary';
insert into evaluation_claims select 'canceled', claim.* from public.claim_factory_evaluation_job() claim;
select (pg_temp.configure_evaluation(2, true)).revision;
select is((select canceled.status from evaluation_claims claim
  cross join lateral public.cancel_factory_evaluation_job(claim.workspace_id, claim.factory_id,
    pg_temp.sampling_id(1), claim.job_id) canceled where claim.slot = 'canceled'),
  'canceled', 'a manager can cancel an active claim while evaluation is paused');
select is(pg_temp.settle_evaluation('canceled', 'succeeded'), false,
  'the holder of a canceled lease cannot publish a completion');
select is((select attempt.outcome from evaluation_claims claim
  join public.factory_evaluation_attempts attempt on attempt.id = claim.attempt_id where claim.slot = 'canceled'),
  'canceled', 'cancellation closes the exact live attempt');
select results_eq($$select p.run_id, to_jsonb(p), to_jsonb(checkpoint)
  from published_before_evaluation frozen join public.session_checkpoint_publications p using (run_id)
  join public.session_git_checkpoints checkpoint using (run_id) order by p.run_id$$,
  $$select run_id, publication, checkpoint from published_before_evaluation order by run_id$$,
  'evaluation scheduling, retry, and cancellation preserve the production publication and checkpoint');

-- A receipt created before the automatic admission trigger remains recoverable.
insert into sample_runs values ('older-receipt', pg_temp.accept_sample_run('Sampling receipt recovery fixture'));
select is((select publication.status from public.session_checkpoint_publications publication
  join sample_runs fixture on publication.run_id = fixture.id where fixture.key = 'older-receipt'),
  'adopted', 'production can adopt an exact checkpoint while evaluation is paused');
alter table public.factory_scorer_sample_receipts disable trigger factory_evaluation_job_from_sample;
create temp table evaluation_backlog as
select receipt.* from pg_temp.record_sample('primary', 'evaluation-replay', 'older-receipt') receipt;
alter table public.factory_scorer_sample_receipts enable trigger factory_evaluation_job_from_sample;
update internal.factory_evaluation_admission_progress progress
set before_created_at = backlog.created_at, before_receipt_id = backlog.id,
  last_created_at = '-infinity', last_receipt_id = '00000000-0000-0000-0000-000000000000', completed = false
from evaluation_backlog backlog where progress.singleton;
select ok((select receipts_processed = 1 and jobs_admitted = 1 from public.maintain_factory_evaluation_queue(1)),
  'bounded maintenance admits an eligible sampled receipt that predates automatic admission');
select ok((select receipts_processed = 0 and jobs_admitted = 0 from public.maintain_factory_evaluation_queue(1)),
  'maintenance replay does not create another evaluation');
select is((select count(*) from public.claim_factory_evaluation_job()), 0::bigint,
  'recovering the backlog does not bypass the workspace pause');
select (pg_temp.configure_evaluation(3, false)).revision;
insert into evaluation_claims select 'success', claim.* from public.claim_factory_evaluation_job() claim;
select ok((select claim.sample_receipt_id = backlog.id and claim.attempt_number = 1
  from evaluation_claims claim cross join evaluation_backlog backlog where claim.slot = 'success'),
  'resuming the lane claims the recovered exact receipt');

create function pg_temp.prepare_judge(p_slot text) returns jsonb language sql as $$
  select public.prepare_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id,
    claim.attempt_id, claim.lease_id)
  from evaluation_claims claim where claim.slot = p_slot;
$$;
select is(pg_temp.prepare_judge('success')->>'status', 'profile_unavailable',
  'an eligible claim cannot receive a judge payload before a workspace approves a profile');
select is(pg_temp.settle_evaluation('success', 'succeeded'), true,
  'the current lease can settle the recovered evaluation successfully');
select is(pg_temp.settle_evaluation('success', 'succeeded'), false,
  'a completion replay cannot settle the same lease twice');

select ok(not has_table_privilege('authenticated', 'public.factory_judge_profile_revisions', 'SELECT')
  and not has_table_privilege('service_role', 'internal.factory_judge_credential_heads', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_function_privilege('authenticated',
    'public.prepare_factory_judge_invocation(uuid,uuid,uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.begin_factory_judge_invocation(uuid,uuid,uuid,uuid,uuid,uuid,text,text)', 'EXECUTE'),
  'judge profiles and credential material are available only through fenced commands');

create function pg_temp.judge_ciphertext() returns text language sql immutable as $$
  select 'v2.AAAAAAAAAAAAAAAA.YWJj.AAAAAAAAAAAAAAAAAAAAAA'::text;
$$;
create function pg_temp.configure_judge(p_expected integer, p_actor uuid default pg_temp.sampling_id(1),
  p_ciphertext text default pg_temp.judge_ciphertext())
returns public.factory_judge_profile_revisions language sql as $$
  select public.configure_factory_judge_profile(pg_temp.sampling_id(11), p_actor, p_expected,
    'openai/gpt-4.1-mini', 'openai', false, false, p_ciphertext);
$$;
select throws_ok($$select pg_temp.configure_judge(0, pg_temp.sampling_id(2))$$, '42501', null,
  'an ordinary factory member cannot approve provider access to evidence');
select throws_ok($$select pg_temp.configure_judge(0, pg_temp.sampling_id(3))$$, '42501', null,
  'a foreign workspace owner cannot approve this workspace judge');
select throws_ok($$select pg_temp.configure_judge(0, p_ciphertext => 'unsealed-fixture-key')$$, '22023', null,
  'judge credential configuration rejects unencrypted material');
create temp table judge_owner_approval as select * from pg_temp.configure_judge(0);
select ok((select enabled and revision = 1 and provider = 'openrouter' and approved_by_member_id = pg_temp.sampling_id(21)
  and not (to_jsonb(profile)::text like '%' || pg_temp.judge_ciphertext() || '%') from judge_owner_approval profile),
  'owner approval stores an immutable profile and returns metadata without credential material');
select throws_ok($$select pg_temp.configure_judge(0)$$, 'PT409', null,
  'a stale workspace editor cannot replace an approved judge profile');
select throws_ok($$update public.factory_judge_profile_revisions set model_id = 'openai/gpt-4.1'
  where id = (select id from judge_owner_approval)$$, '23514', null,
  'an approved profile revision cannot change in place');
update public.workspace_members set role = 'admin' where id = pg_temp.sampling_id(22);
create temp table approved_judge as select * from pg_temp.configure_judge(1, pg_temp.sampling_id(2), null);
select ok((select latest.revision = 2 and latest.approved_by_member_id = pg_temp.sampling_id(22)
    and prior.revision = 1 and prior.approved_by_member_id = pg_temp.sampling_id(21)
  from approved_judge latest cross join judge_owner_approval prior),
  'a workspace admin can append an approval while the earlier decision stays immutable');

create function pg_temp.begin_judge(p_slot text, p_profile_id uuid) returns jsonb language sql as $$
  select public.begin_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id,
    claim.lease_id, p_profile_id, repeat('d', 64), 'node')
  from evaluation_claims claim where claim.slot = p_slot;
$$;

create function pg_temp.finish_judge(p_slot text, p_status text, p_result jsonb default null,
  p_input_tokens bigint default null, p_output_tokens bigint default null, p_token_provenance text default 'unavailable',
  p_cost_usd numeric default null, p_cost_provenance text default 'unavailable', p_estimation_revision text default null)
returns boolean language sql as $$
  select public.finish_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id,
    claim.lease_id, p_status, p_result,
    case when p_status = 'completed' then 'openai/gpt-4.1-mini' end,
    case when p_status = 'completed' then 'OpenAI' end,
    case when p_status = 'completed' then 'fixture-request-id' end,
    p_explanation => case when p_status = 'completed' then 'The exact retained evidence supports the rubric.' end,
    p_evidence_locations => case when p_status = 'completed' then jsonb_build_array(jsonb_build_object(
      'reference', p_result->'evidence'->0, 'location', '{"kind":"whole"}'::jsonb)) end,
    p_input_tokens => p_input_tokens, p_output_tokens => p_output_tokens,
    p_token_provenance => p_token_provenance, p_cost_usd => p_cost_usd, p_cost_provenance => p_cost_provenance,
    p_estimation_revision => p_estimation_revision)
  from evaluation_claims claim where claim.slot = p_slot;
$$;

insert into sample_runs values ('judge-report', pg_temp.accept_sample_run('Exact private judge report', true));
select is((pg_temp.record_sample('primary', 'missing', 'judge-report')).outcome, 'sampled',
  'an exact report and accepted artifact warrant a judge evaluation');
insert into evaluation_claims select 'judge-report', claim.* from public.claim_factory_judge_job() claim;
create temp table prepared_judge as select pg_temp.prepare_judge('judge-report') as payload;
select ok((select payload->>'status' = 'ready' and payload->>'sample_receipt_id' = claim.sample_receipt_id::text
    and payload->>'scorer_revision_id' = claim.scorer_revision_id::text
    and payload->>'target_commit_sha' = checkpoint.output_sha
    and payload->'definition' = scorer.definition
    and payload->'evidence' @> jsonb_build_array(
      jsonb_build_object('kind', 'artifact', 'id', checkpoint.artifact_id, 'content_md', 'Retained sampling artifact.'),
      jsonb_build_object('kind', 'validation_report', 'id', report.id, 'workspace_id', claim.workspace_id,
        'session_id', claim.session_id, 'run_id', claim.run_id, 'storage_path', report.storage_path,
        'sha256', report.sha256, 'size_bytes', report.size_bytes, 'content_type', report.content_type))
    and not (payload::text like '%' || pg_temp.judge_ciphertext() || '%')
  from prepared_judge cross join evaluation_claims claim
  join public.session_git_checkpoints checkpoint on checkpoint.run_id = claim.run_id
  join public.session_validation_assets report on report.run_id = claim.run_id
  join public.factory_scorer_revisions scorer on scorer.id = claim.scorer_revision_id
  where claim.slot = 'judge-report'),
  'prepare rehydrates the exact accepted checkpoint, report and scorer without releasing credential material');
select is(pg_temp.prepare_judge('initial')->>'status', 'stale_claim', 'an expired and replaced claim cannot prepare evidence');
select is(pg_temp.prepare_judge('canceled')->>'status', 'stale_claim', 'a canceled claim cannot prepare evidence');
select is((select public.prepare_factory_judge_invocation(claim.workspace_id, claim.factory_id,
    claim.job_id, claim.attempt_id, gen_random_uuid())->>'status'
  from evaluation_claims claim where claim.slot = 'judge-report'), 'stale_claim',
  'the current job and attempt identities do not authorize a different lease');
create temp table authorized_judge as
select pg_temp.begin_judge('judge-report', approved_judge.id) as payload from approved_judge;
select ok((select payload->>'status' = 'authorized' and payload->>'encrypted_api_key' = pg_temp.judge_ciphertext()
  from authorized_judge), 'the live claim obtains its approved encrypted provider key exactly once');
select ok((select payload->>'status' = 'already_started' and not (payload ? 'encrypted_api_key')
  from (select pg_temp.begin_judge('judge-report', approved_judge.id) as payload from approved_judge) duplicate),
  'repeating an authorized invocation does not release the provider key again');

create temp table judge_pass as
select jsonb_build_object('schemaVersion', 1, 'status', 'pass', 'score', '{"kind":"boolean","value":true}'::jsonb,
  'evidence', receipt.evidence) as result
from evaluation_claims claim join public.factory_scorer_sample_receipts receipt on receipt.id = claim.sample_receipt_id
where claim.slot = 'judge-report';
select throws_ok($$select pg_temp.finish_judge('judge-report', 'completed',
    jsonb_set(result, '{score}', '{"kind":"numeric","value":1}')) from judge_pass$$,
  '22023', null, 'a score of the wrong type for the frozen rubric cannot settle as passing');
select throws_ok($$select pg_temp.finish_judge('judge-report', 'completed',
    jsonb_set(result, '{evidence,0,id}', to_jsonb(pg_temp.sampling_id(100)))) from judge_pass$$,
  '22023', null, 'a structured verdict cannot substitute an evidence reference from outside the sample');
select throws_ok($$select public.finish_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id,
    claim.attempt_id, claim.lease_id, 'completed', outcome.result, 'openai/gpt-4.1', 'OpenAI', 'fixture-request-id')
  from evaluation_claims claim cross join judge_pass outcome where claim.slot = 'judge-report'$$,
  '22023', null, 'a different observed provider model cannot settle as the approved judge');
select throws_ok($$select public.finish_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id,
    claim.attempt_id, claim.lease_id, 'completed', outcome.result, 'openai/gpt-4.1-mini', 'OpenAI', 'fixture-request-id',
    p_evidence_locations => jsonb_build_array(jsonb_build_object(
      'reference', (outcome.result->'evidence'->0) - 'id', 'location', '{"kind":"whole"}'::jsonb)))
  from evaluation_claims claim cross join judge_pass outcome where claim.slot = 'judge-report'$$,
  '22023', 'Invalid evaluation receipt metadata.',
  'a citation specifying only a sampled kind cannot adopt a result without its exact evidence ID');
select is((select pg_temp.finish_judge('judge-report', 'completed', result, 18, 9, 'measured', 0, 'measured') from judge_pass), true,
  'a schema-valid verdict settles the exact judge invocation');
select is((select pg_temp.finish_judge('judge-report', 'completed', result, 99, 99, 'measured', 0.5, 'measured') from judge_pass), false,
  'a settled invocation cannot overwrite its result with a late replay');
select ok((select trace.profile_revision_id = profile.id and trace.evidence_digest = repeat('d', 64)
    and trace.worker_runtime = 'node' and trace.adapter_runtime is not null
    and trace.status = 'completed' and trace.provider_model = 'openai/gpt-4.1-mini'
    and trace.provider_request_id = 'fixture-request-id' and trace.candidate_result = outcome.result
    and not (to_jsonb(trace)::text like '%' || pg_temp.judge_ciphertext() || '%')
    and not (to_jsonb(trace)::text like '%Retained sampling artifact.%')
    and not (to_jsonb(trace)::text like '%Retained judge fixture report.%')
  from evaluation_claims claim join public.factory_judge_invocations trace on trace.attempt_id = claim.attempt_id
  cross join approved_judge profile cross join judge_pass outcome where claim.slot = 'judge-report'),
  'the completed invocation records exact model, runtime, evidence digest and verdict without private source or key bytes');

create temp table first_evaluation_receipt as
select receipt.* from evaluation_claims claim
join public.factory_evaluation_receipts receipt on receipt.attempt_id = claim.attempt_id
where claim.slot = 'judge-report';
select ok((select receipt.status = 'pass' and receipt.reason is null and receipt.attempt_outcome = 'succeeded'
    and (receipt.workspace_id, receipt.factory_id, receipt.session_id, receipt.job_id, receipt.run_id,
      receipt.scorer_revision_id, receipt.sample_receipt_id, receipt.target_commit_sha, receipt.attempt_number) =
      (claim.workspace_id, claim.factory_id, claim.session_id, claim.job_id, claim.run_id,
      claim.scorer_revision_id, claim.sample_receipt_id, claim.target_commit_sha, claim.attempt_number)
    and receipt.profile_revision_id = profile.id and receipt.evidence_digest = repeat('d', 64)
    and receipt.result = outcome.result and receipt.latency_ms >= 0
    and receipt.explanation = 'The exact retained evidence supports the rubric.'
    and receipt.evidence_locations->0->'reference' = outcome.result->'evidence'->0
    and receipt.input_tokens = 18 and receipt.output_tokens = 9 and receipt.token_provenance = 'measured'
    and receipt.cost_usd = 0 and receipt.cost_provenance = 'measured' and receipt.estimation_revision is null
  from first_evaluation_receipt receipt join evaluation_claims claim on claim.attempt_id = receipt.attempt_id
  cross join approved_judge profile cross join judge_pass outcome),
  'exact receipt adoption retains the original verdict, provenance, latency and genuinely measured zero cost');
select is((select count(*) from public.factory_evaluation_receipts receipt
  join first_evaluation_receipt original on receipt.attempt_id = original.attempt_id), 1::bigint,
  'replayed completion with higher spend cannot add another receipt');
select throws_ok($$update public.factory_evaluation_receipts set cost_usd = 0.5
  where attempt_id = (select attempt_id from first_evaluation_receipt)$$,
  '23514', null, 'terminal evaluation usage cannot be rewritten directly');

select results_eq($$select claim.slot, receipt.status, receipt.reason, receipt.cost_usd, receipt.cost_provenance
    from evaluation_claims claim join public.factory_evaluation_receipts receipt on receipt.attempt_id = claim.attempt_id
    where claim.slot in ('initial', 'canceled') order by claim.slot$$,
  $$values ('canceled', 'skipped', 'canceled', null::numeric, 'unavailable'),
    ('initial', 'error', 'lease_expired', null::numeric, 'unavailable')$$,
  'cancellation and recovery without a provider invocation each retain their exact unavailable cost');

insert into sample_runs values ('judge-erased', pg_temp.accept_sample_run('Judge erasure fixture', true));
select (pg_temp.record_sample('primary', 'missing', 'judge-erased')).id;
insert into evaluation_claims select 'judge-erased', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.prepare_judge('judge-erased')->>'status', 'ready', 'the newly sampled judge target is ready before erasure');
update public.sessions session set archived_at = clock_timestamp()
from evaluation_claims claim where claim.slot = 'judge-erased' and session.id = claim.session_id;
create temp table judge_erasure_target as
select session.workspace_id, session.factory_id, session.id, session.archived_at
from evaluation_claims claim join public.sessions session on session.id = claim.session_id where claim.slot = 'judge-erased';
grant select on judge_erasure_target to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000001';
select ok((select erased.erased_at is not null from judge_erasure_target target
  cross join lateral public.erase_session_retained_content(target.workspace_id, target.factory_id, target.id, target.archived_at) erased),
  'the authenticated owner erases the exact already-sampled source');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';
select ok((select payload->>'status' = 'missing_evidence' and not (payload ? 'encrypted_api_key')
  from (select pg_temp.begin_judge('judge-erased', approved_judge.id) as payload from approved_judge) denied),
  'an erasure after prepare prevents opening the provider credential permit');
select is(pg_temp.finish_judge('judge-erased', 'missing_evidence'), true,
  'a withheld source settles as an explicit non-passing invocation');

insert into sample_runs values ('judge-evidence-retry', pg_temp.accept_sample_run('Judge private evidence retry fixture'));
select (pg_temp.record_sample('primary', 'evaluation-replay', 'judge-evidence-retry')).id;
insert into evaluation_claims select 'judge-evidence-retry', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.finish_judge('judge-evidence-retry', 'evidence_unavailable'), true,
  'temporary evidence failure can settle without opening a provider permit');
select ok((select trace.status = 'evidence_unavailable' and trace.started_at is null and trace.evidence_digest is null
    and trace.candidate_result is null and attempt.outcome = 'retryable_failure'
    and job.status = 'queued' and job.available_at > clock_timestamp()
  from evaluation_claims claim join public.factory_judge_invocations trace on trace.attempt_id = claim.attempt_id
  join public.factory_evaluation_attempts attempt on attempt.id = claim.attempt_id
  join public.factory_evaluation_jobs job on job.id = claim.job_id where claim.slot = 'judge-evidence-retry'),
  'the no-send failure records no result and schedules the same evaluation for retry');
select public.cancel_factory_evaluation_job(claim.workspace_id, claim.factory_id, pg_temp.sampling_id(1), claim.job_id)
from evaluation_claims claim where claim.slot = 'judge-evidence-retry';

insert into sample_runs values ('judge-canceled', pg_temp.accept_sample_run('Started judge cancellation fixture'));
select (pg_temp.record_sample('primary', 'evaluation-replay', 'judge-canceled')).id;
insert into evaluation_claims select 'judge-canceled', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.begin_judge('judge-canceled', approved_judge.id)->>'status', 'authorized',
  'the canceled fixture has already obtained its one-shot provider permit') from approved_judge;
select public.cancel_factory_evaluation_job(claim.workspace_id, claim.factory_id, pg_temp.sampling_id(1), claim.job_id)
from evaluation_claims claim where claim.slot = 'judge-canceled';
select ok((select trace.status = 'canceled' and attempt.outcome = 'canceled' and trace.finished_at = attempt.settled_at
    and trace.profile_revision_id = profile.id and trace.evidence_digest = repeat('d', 64)
    and trace.candidate_result is null
  from evaluation_claims claim join public.factory_judge_invocations trace on trace.attempt_id = claim.attempt_id
  join public.factory_evaluation_attempts attempt on attempt.id = claim.attempt_id
  cross join approved_judge profile where claim.slot = 'judge-canceled'),
  'canceling the exact attempt closes its started judge trace while preserving identity');
select is(pg_temp.finish_judge('judge-canceled', 'provider_unavailable'), false,
  'a late provider outcome cannot replace the canceled trace');

insert into sample_runs values ('judge-revoked', pg_temp.accept_sample_run('Judge profile revocation fixture'));
select (pg_temp.record_sample('primary', 'evaluation-replay', 'judge-revoked')).id;
insert into evaluation_claims select 'judge-revoked', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.prepare_judge('judge-revoked')->>'status', 'ready', 'the active approved profile can prepare an exact run');
select ok((select not enabled and revision = 3 from public.revoke_factory_judge_profile(
  pg_temp.sampling_id(11), pg_temp.sampling_id(1), 2)), 'the workspace owner can revoke the current judge profile');
select ok((select payload->>'status' = 'profile_unavailable' and not (payload ? 'encrypted_api_key')
  from (select pg_temp.begin_judge('judge-revoked', approved_judge.id) as payload from approved_judge) denied),
  'an approval revoked after prepare cannot authorize a new provider request');
select is(pg_temp.finish_judge('judge-revoked', 'profile_unavailable'), true,
  'an unavailable profile settles as an explicit non-passing invocation');

-- Leave the first judgment in place while its configured resources move on.
select public.cancel_factory_evaluation_job(claim.workspace_id, claim.factory_id, pg_temp.sampling_id(1), claim.job_id)
from evaluation_claims claim where claim.slot = 'judge-revoked';
create temp table rotated_judge as select * from pg_temp.configure_judge(3);
create temp table revised_rubric as
select new.* from first_evaluation_receipt prior join public.factory_scorer_revisions scorer on scorer.id = prior.scorer_revision_id
cross join lateral public.save_factory_scorer_revision(prior.workspace_id, prior.factory_id, pg_temp.sampling_id(1),
  scorer.scorer_id, scorer.revision_number, jsonb_set(scorer.definition, '{rubric}', to_jsonb('Use the updated rubric.'::text))) new;
select ok((select prior.profile_revision_id <> profile.id and prior.scorer_revision_id <> scorer.id
    and scorer.revision_number = 2 and profile.revision = 4
    and to_jsonb(receipt) = to_jsonb(prior)
  from first_evaluation_receipt prior join public.factory_evaluation_receipts receipt on receipt.attempt_id = prior.attempt_id
  cross join rotated_judge profile cross join revised_rubric scorer),
  'profile and rubric edits cannot reinterpret the original immutable judgment or its evidence identities');
select ok((select run.input_tokens is null and run.output_tokens is null and run.total_cost_usd is null
  and run.token_provenance = 'unavailable' and run.cost_provenance = 'unavailable'
  from first_evaluation_receipt receipt join public.agent_runs run on run.id = receipt.run_id),
  'evaluator usage stays separate from the production attempt that supplied the evidence');

insert into sample_runs values ('judge-expired', pg_temp.accept_sample_run('Started evaluator lease loss fixture'));
select (pg_temp.record_sample('primary', 'evaluation-replay', 'judge-expired')).id;
insert into evaluation_claims select 'judge-expired', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.begin_judge('judge-expired', rotated_judge.id)->>'status', 'authorized',
  'the lost worker held a real provider permit before its lease elapsed') from rotated_judge;
alter table public.factory_evaluation_attempts disable trigger factory_evaluation_attempts_immutable;
with expired as (select clock_timestamp() - interval '1 second' as lease_at)
update public.factory_evaluation_attempts attempt set lease_expires_at = expired.lease_at,
  claimed_at = expired.lease_at - interval '90 seconds' from expired
where attempt.id = (select attempt_id from evaluation_claims where slot = 'judge-expired');
alter table public.factory_evaluation_attempts enable trigger factory_evaluation_attempts_immutable;
select ok((select attempts_recovered = 1 and jobs_requeued = 1 from public.maintain_factory_evaluation_queue(10)),
  'recovery finalizes the abandoned invocation before requeuing the evaluation');
update public.factory_evaluation_jobs set available_at = clock_timestamp()
where id = (select job_id from evaluation_claims where slot = 'judge-expired');
insert into evaluation_claims select 'judge-estimated', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.begin_judge('judge-estimated', rotated_judge.id)->>'status', 'authorized',
  'the replacement receives a distinct provider permit for the same evaluation') from rotated_judge;
select is(pg_temp.finish_judge('judge-expired', 'provider_unavailable', null, 500, 500, 'measured', 1, 'measured'), false,
  'late usage from an expired invocation cannot charge the current claim or rewrite its own receipt');
select throws_ok($$select pg_temp.finish_judge('judge-estimated', 'provider_unavailable', null,
    22, 4, 'estimated', 0.003, 'estimated')$$, '22023', null,
  'estimated usage without an estimation revision is refused atomically');
select throws_ok($$select pg_temp.finish_judge('judge-estimated', 'provider_unavailable', p_cost_usd => 0)$$,
  '22023', null, 'an unavailable cost cannot be written as zero');
select is(pg_temp.finish_judge('judge-estimated', 'provider_unavailable', null,
    22, 4, 'estimated', 0.003, 'estimated', 'fixture-pricing-v1'), true,
  'the current worker records versioned estimated usage even when the provider failed');
select ok((select receipt.status = 'error' and receipt.reason = 'provider_unavailable'
    and receipt.input_tokens = 22 and receipt.output_tokens = 4 and receipt.token_provenance = 'estimated'
    and receipt.cost_usd = 0.003 and receipt.cost_provenance = 'estimated'
    and receipt.estimation_revision = 'fixture-pricing-v1' and receipt.profile_revision_id = profile.id
    and receipt.attempt_number = 2 and receipt.latency_ms >= 0
  from evaluation_claims claim join public.factory_evaluation_receipts receipt on receipt.attempt_id = claim.attempt_id
  cross join rotated_judge profile where claim.slot = 'judge-estimated'), 'a failed estimate is retained under the replacement attempt');
select ok((select receipt.status = 'error' and receipt.reason = 'lease_expired'
    and receipt.attempt_number = 1 and receipt.evidence_digest = repeat('d', 64) and receipt.profile_revision_id = profile.id
    and receipt.input_tokens is null and receipt.output_tokens is null and receipt.token_provenance = 'unavailable'
    and receipt.cost_usd is null and receipt.cost_provenance = 'unavailable'
  from evaluation_claims claim join public.factory_evaluation_receipts receipt on receipt.attempt_id = claim.attempt_id
  cross join rotated_judge profile where claim.slot = 'judge-expired'), 'lease recovery preserves identity with unavailable usage');

create function pg_temp.evaluation_job(p_slot text) returns uuid language sql stable as $$
  select claim.job_id from evaluation_claims claim where claim.slot = p_slot;
$$;
create function pg_temp.list_evaluation_receipts(p_scope text, p_job_id uuid default null,
  p_actor uuid default pg_temp.sampling_id(1), p_limit integer default 25,
  p_before_finished_at timestamptz default null, p_before_attempt_id uuid default null) returns jsonb language sql as $$
  select public.list_factory_evaluation_receipts(scope.workspace_id, scope.factory_id, p_actor, p_job_id,
    p_limit, p_before_finished_at, p_before_attempt_id)
  from sample_scope scope where scope.key = p_scope;
$$;
select ok(not has_table_privilege('authenticated', 'public.factory_evaluation_receipts', 'SELECT')
  and not has_function_privilege('authenticated',
    'public.list_factory_evaluation_receipts(uuid,uuid,uuid,uuid,integer,timestamptz,uuid)', 'EXECUTE'),
  'the raw immutable receipts and explicit actor read RPC are private');
update public.workspace_members set role = 'member' where id = pg_temp.sampling_id(22);
create temp table visible_judgment as
select pg_temp.list_evaluation_receipts('primary', pg_temp.evaluation_job('judge-report'), pg_temp.sampling_id(2)) as payload;
select ok((select payload#>'{usage,cost_usd}' = '0'::jsonb and payload#>'{usage,cost_unavailable_count}' = '0'::jsonb
    and payload#>'{usage,input_tokens}' = '18'::jsonb and payload#>'{usage,output_tokens}' = '9'::jsonb
    and payload#>>'{receipts,0,evidence_availability}' = 'available'
    and payload#>>'{receipts,0,explanation}' = 'The exact retained evidence supports the rubric.'
  from visible_judgment), 'an ordinary authorized reader sees the measured zero, exact counts and retained explanation');
select ok((select payload#>'{usage,cost_usd}' = 'null'::jsonb and payload#>'{usage,cost_unavailable_count}' = '1'::jsonb
    and payload#>'{usage,cost_estimated_count}' = '1'::jsonb and payload#>'{usage,attempt_count}' = '2'::jsonb
    and payload#>'{usage,input_tokens}' = 'null'::jsonb
  from (select pg_temp.list_evaluation_receipts('primary', pg_temp.evaluation_job('judge-estimated')) as payload) summary),
  'one unknown attempt keeps exact job totals unavailable even when another attempt has estimates');
select ok((select payload#>'{usage,cost_usd}' = 'null'::jsonb and payload#>'{usage,cost_unavailable_count}' = '1'::jsonb
  from (select pg_temp.list_evaluation_receipts('primary', pg_temp.evaluation_job('judge-canceled')) as payload) canceled),
  'an entirely unavailable cost cannot appear as numeric zero');
create temp table evaluation_first_page as
select pg_temp.list_evaluation_receipts('primary', pg_temp.evaluation_job('judge-estimated'), p_limit => 1) as payload;
select ok((select payload#>>'{receipts,0,attempt_number}' = '2'
    and payload->>'next_attempt_id' = payload#>>'{receipts,0,attempt_id}'
    and payload#>'{usage,attempt_count}' = '2'::jsonb from evaluation_first_page),
  'a bounded read returns the latest receipt with the exact continuation and full job usage');
select ok((select page.payload#>>'{receipts,0,attempt_number}' = '1' and page.payload->>'next_attempt_id' is null
    and page.payload->'usage' = first.payload->'usage'
  from evaluation_first_page first cross join lateral (
    select pg_temp.list_evaluation_receipts('primary', pg_temp.evaluation_job('judge-estimated'), p_limit => 1,
      p_before_finished_at => (first.payload->>'next_finished_at')::timestamptz,
      p_before_attempt_id => (first.payload->>'next_attempt_id')::uuid) as payload
  ) page), 'the continuation returns the remaining expired attempt without changing the usage summary');
select throws_ok($$select pg_temp.list_evaluation_receipts('primary', p_actor => pg_temp.sampling_id(3))$$,
  'P0002', null, 'a foreign workspace owner cannot read evaluation receipts');
select throws_ok($$select pg_temp.list_evaluation_receipts('sibling', p_actor => pg_temp.sampling_id(2))$$,
  'P0002', null, 'workspace membership alone cannot expose a restricted sibling factory');
select is(pg_temp.list_evaluation_receipts('sibling', pg_temp.evaluation_job('judge-report'))->'receipts', '[]'::jsonb,
  'a known job ID cannot be rebound to another accessible factory');

-- Erasure withholds private explanation and evidence from reads without
-- mutating the immutable result or usage ledger.
update public.sessions session set archived_at = clock_timestamp()
from first_evaluation_receipt receipt where session.id = receipt.session_id;
truncate judge_erasure_target;
insert into judge_erasure_target
select session.workspace_id, session.factory_id, session.id, session.archived_at
from first_evaluation_receipt receipt join public.sessions session on session.id = receipt.session_id;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000001';
select public.erase_session_retained_content(target.workspace_id, target.factory_id, target.id, target.archived_at)
from judge_erasure_target target;
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';
select ok((select payload#>>'{receipts,0,evidence_availability}' = 'withheld'
    and payload#>>'{receipts,0,explanation}' is null and payload#>>'{receipts,0,evidence_locations,0}' is null
    and payload#>>'{receipts,0,result,evidence,0}' is null and payload#>>'{receipts,0,evidence_digest}' is null
    and payload#>'{receipts,0,score}' = '{"kind":"boolean","value":true}'::jsonb
    and payload#>'{usage,cost_usd}' = '0'::jsonb
  from (select pg_temp.list_evaluation_receipts('primary', pg_temp.evaluation_job('judge-report')) as payload) after_erasure),
  'current erasure hides explanation and evidence locations while leaving score and usage metadata readable');
select ok((select to_jsonb(receipt) = to_jsonb(original)
  from first_evaluation_receipt original join public.factory_evaluation_receipts receipt on receipt.attempt_id = original.attempt_id),
  'a retention-aware read does not rewrite earlier judgments');

-- The trends fixture uses the same genuinely adopted outcomes. Keep one
-- receipt inside this transaction to distinguish closed history from live work.
insert into sample_runs values ('trend-unclosed', pg_temp.accept_sample_run('Unclosed trend receipt fixture'));
select (pg_temp.record_sample('primary', 'missing', 'trend-unclosed')).id;
select (pg_temp.record_sample('primary', 'none', 'trend-unclosed')).id;
select public.cancel_factory_evaluation_job(claim.workspace_id, claim.factory_id, pg_temp.sampling_id(1), claim.job_id)
from evaluation_claims claim where claim.slot = 'judge-estimated';

create temp table numeric_scorer as
select revision.* from revised_rubric prior cross join lateral public.save_factory_scorer_revision(
  prior.workspace_id, prior.factory_id, pg_temp.sampling_id(1), prior.scorer_id, prior.revision_number,
  '{"schemaVersion":1,"rubric":"Rate the retained result from zero to ten.","requiredEvidence":["code_diff","artifact"],
    "scoring":{"kind":"numeric","min":0,"max":10,"direction":"higher_is_better","failThreshold":4,"passThreshold":8}}') revision;
insert into sample_scorers select 'trend-numeric', id from numeric_scorer;
insert into sample_policies select 'trend-numeric', id from pg_temp.save_sample_policy('primary', 'trend-numeric', 0, 10000);
with compiled as (
  select prior.workspace_id, prior.factory_id, prior.created_by,
    jsonb_set(prior.definition_json::jsonb, '{scorerRevisionIds}',
      (select jsonb_agg(id order by id) from sample_scorers where key in ('exact', 'trend-numeric')))::text as definition
  from public.factory_definition_revisions prior where prior.id = pg_temp.sampling_id(51)
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.sampling_id(52), workspace_id, factory_id, 2, definition,
    encode(sha256(convert_to(definition, 'UTF8')), 'hex'), created_by from compiled
  returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 2, created_by from revision;

insert into sample_runs values ('trend-inconclusive', pg_temp.accept_sample_run('Numeric middle band trend fixture'));
select (pg_temp.record_sample('primary', 'trend-numeric', 'trend-inconclusive')).id;
insert into evaluation_claims select 'trend-inconclusive', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.begin_judge('trend-inconclusive', rotated_judge.id)->>'status', 'authorized',
  'the latest rubric revision receives a live judge permit') from rotated_judge;
select is((select pg_temp.finish_judge('trend-inconclusive', 'completed', jsonb_build_object('schemaVersion', 1,
    'status', 'inconclusive', 'reason', 'between_thresholds', 'score', '{"kind":"numeric","value":6}'::jsonb,
    'evidence', receipt.evidence))
  from evaluation_claims claim join public.factory_scorer_sample_receipts receipt on receipt.id = claim.sample_receipt_id
  where claim.slot = 'trend-inconclusive'), true,
  'the judge durably adopts a usable numeric score between the decision thresholds');

insert into sample_runs values ('trend-fail', pg_temp.accept_sample_run('Numeric failed trend fixture'));
select (pg_temp.record_sample('primary', 'trend-numeric', 'trend-fail')).id;
insert into evaluation_claims select 'trend-fail', claim.* from public.claim_factory_judge_job() claim;
select (pg_temp.begin_judge('trend-fail', rotated_judge.id))->>'status' from rotated_judge;
select is((select pg_temp.finish_judge('trend-fail', 'completed', jsonb_build_object('schemaVersion', 1,
    'status', 'fail', 'score', '{"kind":"numeric","value":2}'::jsonb, 'evidence', receipt.evidence))
  from evaluation_claims claim join public.factory_scorer_sample_receipts receipt on receipt.id = claim.sample_receipt_id
  where claim.slot = 'trend-fail'), true, 'the same rubric can adopt a legitimate failing score');
insert into sample_runs values ('trend-unsettled', pg_temp.accept_sample_run('Unsettled trend fixture'));
select (pg_temp.record_sample('primary', 'trend-numeric', 'trend-unsettled')).id;

-- The pgTAP transaction cannot commit. Mark only its named historical rows
-- as predating transaction-ID capture so the real snapshot code can read them.
alter table public.factory_scorer_sample_receipts disable trigger factory_scorer_sample_receipts_immutable;
update public.factory_scorer_sample_receipts receipt set recorded_xact_id = null
from sample_runs fixture where receipt.workspace_id = pg_temp.sampling_id(11) and receipt.run_id = fixture.id
  and fixture.key <> 'trend-unclosed';
alter table public.factory_scorer_sample_receipts enable trigger factory_scorer_sample_receipts_immutable;
alter table public.factory_evaluation_receipts disable trigger factory_evaluation_receipts_immutable;
update public.factory_evaluation_receipts receipt set recorded_xact_id = null
from sample_runs fixture where receipt.workspace_id = pg_temp.sampling_id(11) and receipt.run_id = fixture.id;
alter table public.factory_evaluation_receipts enable trigger factory_evaluation_receipts_immutable;

create temp table trend_window as
select date_trunc('day', min(run_finished_at), 'UTC') as since, clock_timestamp() as until
from public.factory_scorer_sample_receipts where workspace_id = pg_temp.sampling_id(11);
grant select on sample_scope, sample_policies, sample_runs, trend_window, numeric_scorer, evaluation_claims to authenticated;

create function pg_temp.read_score_cohort(p_policy text, p_snapshot text default null,
  p_bucket_at timestamptz default null, p_status text default null,
  p_before_finished_at timestamptz default null, p_before_run_id uuid default null,
  p_limit integer default 25, p_scope text default 'primary') returns jsonb language sql as $$
  select public.read_factory_score_cohort(scope.workspace_id, scope.factory_id, policy.id, bounds.since, bounds.until,
    p_snapshot, p_bucket_at, p_status, p_before_finished_at, p_before_run_id, p_limit)
  from sample_scope scope cross join sample_policies policy cross join trend_window bounds
  where scope.key = p_scope and policy.key = p_policy;
$$;

create function pg_temp.read_run_scores(p_run text, p_attempt_id uuid default null, p_scope text default 'primary')
returns jsonb language sql as $$
  select public.list_factory_run_score_results(scope.workspace_id, scope.factory_id, fixture.id, p_attempt_id)
  from sample_scope scope cross join sample_runs fixture where scope.key = p_scope and fixture.key = p_run;
$$;
select ok(has_function_privilege('authenticated', 'public.list_factory_run_score_results(uuid,uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_factory_run_score_results(uuid,uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.list_factory_run_score_results(uuid,uuid,uuid,uuid)', 'EXECUTE')
  and not has_table_privilege('authenticated', 'public.factory_evaluation_receipts', 'SELECT'),
  'the signed-in read functions do not grant raw receipt access');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
create temp table report_trend as select pg_temp.read_score_cohort('missing') as payload;
select ok((select payload#>>'{cohort,scorer_revision_number}' = '1' and payload#>>'{cohort,policy_revision_number}' = '1'
    and payload->'totals' @> '{"candidate_count":4,"eligible_count":2,"sampled_count":2,"excluded_count":2,
      "usable_count":1,"decided_count":1,"pass_count":1,"fail_count":0,"inconclusive_count":1,"missing_evidence_count":3}'::jsonb
    and payload->>'row_count' = '4' and jsonb_array_length(payload->'rows') = 4 from report_trend),
  'the report cohort reconciles eligible, sampled, usable, decided and missing evidence to closed receipts');
select ok((select sum(day.candidate_count) = 4 and sum(day.eligible_count) = 2 and sum(day.sampled_count) = 2
    and sum(day.usable_count) = 1 and sum(day.decided_count) = 1 and sum(day.missing_evidence_count) = 3
    and bool_and(day.bucket_at = date_trunc('day', day.bucket_at, 'UTC'))
  from report_trend trend cross join lateral jsonb_to_recordset(trend.payload->'points') day(
    bucket_at timestamptz, candidate_count bigint, eligible_count bigint, sampled_count bigint,
    usable_count bigint, decided_count bigint, missing_evidence_count bigint)),
  'UTC chart points sum to the table denominator and preserve incomplete evidence coverage');
select ok((select pg_temp.read_score_cohort('none')->'totals' @>
  '{"candidate_count":1,"eligible_count":1,"sampled_count":0,"not_sampled_count":1,"usable_count":0}'::jsonb),
  'a zero-percent policy retains its eligible denominator without counting a usable result');

create temp table middle_trend as select pg_temp.read_score_cohort('trend-numeric') as payload;
select ok((select payload#>>'{cohort,scorer_revision_number}' = '3' and payload#>>'{cohort,policy_revision_number}' = '1'
    and payload->'totals' @> '{"candidate_count":3,"eligible_count":3,"sampled_count":3,"usable_count":2,
      "decided_count":1,"pass_count":0,"fail_count":1,"inconclusive_count":1,"unsettled_count":1,"mean_numeric_score":4}'::jsonb
    and payload->'rows' @> '[{"status":"inconclusive","reason":"between_thresholds","score":{"kind":"numeric","value":6}},
      {"status":"fail","score":{"kind":"numeric","value":2}},{"status":"unsettled","score":null}]'::jsonb
  from middle_trend), 'a middle-band score is usable while only the fail counts as decided and active work remains unsettled');
select ok((select jsonb_array_length(catalog.payload->'cohorts') = 2
    and catalog.payload->'cohorts' @> '[{"scorer_revision_number":1,"policy_revision_number":1},
      {"scorer_revision_number":3,"policy_revision_number":1}]'::jsonb
  from sample_scope scope cross join numeric_scorer scorer cross join lateral (
    select public.list_factory_score_cohorts(scope.workspace_id, scope.factory_id, scorer.scorer_id) as payload
  ) catalog where scope.key = 'primary'), 'the cohort list labels two separate rubric revisions for the same scorer');

create temp table replay_trend as select pg_temp.read_score_cohort('evaluation-replay') as payload;
select ok((select payload->'totals' @> '{"candidate_count":6,"sampled_count":6}'::jsonb
    and payload->'rows' @> jsonb_build_array(jsonb_build_object('run_id', claim.run_id,
      'evaluation_attempt_id', claim.attempt_id, 'status', 'error', 'reason', 'provider_unavailable'))
    and (select count(*) from jsonb_array_elements(payload->'rows') row where row->>'run_id' = claim.run_id::text) = 1
  from replay_trend cross join evaluation_claims claim where claim.slot = 'judge-estimated'),
  'a reclaimed run appears once in the cohort with only its latest settled attempt');
select ok((select original.sample_receipt_id <> sample.id
    and payload->'rows' @> jsonb_build_array(jsonb_build_object('run_id', original.run_id,
      'sample_receipt_id', sample.id, 'evaluation_sample_receipt_id', original.sample_receipt_id,
      'evaluation_attempt_id', original.attempt_id))
  from replay_trend cross join evaluation_claims original
  join sample_runs fixture on fixture.id = original.run_id
  cross join lateral (
    select (replayed->>'sample_receipt_id')::uuid as id
    from jsonb_array_elements(payload->'rows') replayed where replayed->>'run_id' = original.run_id::text
  ) sample where original.slot = 'final' and fixture.key = 'first'),
  'a different policy can show the same exact-run judgment with its original winning sample identity');

create temp table score_first_page as
select pg_temp.read_score_cohort('missing', trend.payload->>'snapshot', p_limit => 2) as payload from report_trend trend;
select ok((select ((first.payload->'rows') || (remaining.payload->'rows')) = (trend.payload->'rows')
    and remaining.payload->>'next_run_id' is null and remaining.payload->'totals' = trend.payload->'totals'
    and remaining.payload->'points' = trend.payload->'points'
  from score_first_page first cross join report_trend trend cross join lateral (
    select pg_temp.read_score_cohort('missing', first.payload->>'snapshot',
      p_before_finished_at => (first.payload->>'next_run_finished_at')::timestamptz,
      p_before_run_id => (first.payload->>'next_run_id')::uuid, p_limit => 2) as payload
  ) remaining), 'a signed continuation returns the rest of the exact table without changing the chart or totals');
select ok((select narrowed.payload->>'row_count' = '1' and narrowed.payload#>>'{rows,0,status}' = 'pass'
    and narrowed.payload->'totals' = trend.payload->'totals' and narrowed.payload->'points' = trend.payload->'points'
  from report_trend trend cross join evaluation_claims claim cross join lateral (
    select pg_temp.read_score_cohort('missing', trend.payload->>'snapshot', p_status => 'pass',
      p_bucket_at => date_trunc('day', (select (row_item->>'run_finished_at')::timestamptz
        from jsonb_array_elements(trend.payload->'rows') row_item where row_item->>'run_id' = claim.run_id::text), 'UTC')) as payload
  ) narrowed where claim.slot = 'judge-report'), 'status and UTC bucket filter drilldown rows without changing the signed cohort');
select throws_ok($$select pg_temp.read_score_cohort('trend-numeric', payload->>'snapshot') from report_trend$$,
  '22023', 'Invalid score cohort snapshot.', 'a signed snapshot cannot drift to a different policy or rubric revision');
select throws_ok($$select pg_temp.read_score_cohort('missing', left(payload->>'snapshot', -1)
    || case right(payload->>'snapshot', 1) when '0' then '1' else '0' end) from report_trend$$,
  '22023', 'Invalid score cohort snapshot.', 'a modified signature cannot bypass the closed score horizon');
select throws_ok($$select public.read_factory_score_cohort(scope.workspace_id, scope.factory_id, policy.id,
    bounds.since, bounds.until + interval '1 second', trend.payload->>'snapshot')
  from report_trend trend cross join sample_scope scope cross join sample_policies policy cross join trend_window bounds
  where scope.key = 'primary' and policy.key = 'missing'$$,
  '22023', 'Invalid score cohort snapshot.', 'a signed snapshot cannot be used for a different date window');

select ok((select current.payload#>>'{0,receipt,reason}' = 'provider_unavailable'
    and expired.payload#>>'{0,receipt,reason}' = 'lease_expired'
    and expired.payload#>>'{0,receipt,attempt_id}' = claim.attempt_id::text
  from evaluation_claims claim cross join lateral (select pg_temp.read_run_scores('judge-expired') as payload) current
  cross join lateral (select pg_temp.read_run_scores('judge-expired', claim.attempt_id) as payload) expired
  where claim.slot = 'judge-expired'), 'run results can open the exact earlier attempt without replacing the latest result');
select ok((select payload#>>'{0,receipt,status}' = 'pass' and payload#>>'{0,receipt,evidence_availability}' = 'withheld'
    and payload#>>'{0,receipt,explanation}' is null and payload#>>'{0,receipt,evidence_locations}' is null
    and payload#>>'{0,receipt,result}' is null and payload#>>'{0,diff}' is null
  from (select pg_temp.read_run_scores('judge-report') as payload) erased),
  'a signed-in reader cannot reopen erased evidence or locations even though the original score remains');
select ok((select payload#>>'{0,receipt,evidence_availability}' = 'available'
    and payload#>>'{0,receipt,reason}' = 'between_thresholds' and payload#>>'{0,receipt,evidence_locations,0,reference,id}' = run.id::text
    and payload#>>'{0,diff,repository_full_name}' = 'fixture/sampling' and payload#>>'{0,diff,output_sha}' = repeat('a', 40)
  from sample_runs run cross join lateral (select pg_temp.read_run_scores(run.key) as payload) retained
  where run.key = 'trend-inconclusive'), 'available evidence keeps an exact location and a scope-checked Git comparison');
select ok((select jsonb_array_length(payload) = 2 and payload @> '[
    {"sample_outcome":"excluded","sample_reason":"missing_evidence","evaluation_job_id":null,"receipt":null,"diff":null},
    {"sample_outcome":"not_sampled","sample_reason":null,"evaluation_job_id":null,"receipt":null,"diff":null}]'::jsonb
  from (select pg_temp.read_run_scores('trend-unclosed') as payload) unsampled),
  'live run results explain excluded and unsampled scorers without inventing an evaluation');
select throws_ok($$select pg_temp.read_run_scores('judge-report', claim.attempt_id)
  from evaluation_claims claim where claim.slot = 'trend-inconclusive'$$,
  'P0002', null, 'a retained evaluation attempt cannot be opened through a different run');
select throws_ok($$select pg_temp.read_score_cohort('missing', p_scope => 'sibling')$$,
  'P0002', null, 'ordinary workspace membership cannot read a restricted sibling score cohort');
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000003';
select throws_ok($$select pg_temp.read_run_scores('trend-inconclusive')$$, 'P0002', null,
  'a foreign workspace user cannot open retained score evidence');
select throws_ok($$select pg_temp.read_score_cohort('missing')$$, 'P0002', null,
  'a foreign workspace user cannot read cohort totals with a known ID');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

create temp table score_cancellation_targets as
select fixture.key, job.id as job_id, job.workspace_id, job.factory_id, job.run_id, job.sample_receipt_id
from sample_runs fixture join public.factory_evaluation_jobs job on job.run_id = fixture.id
join sample_scope scope on (scope.workspace_id, scope.factory_id) = (job.workspace_id, job.factory_id)
where scope.key = 'primary' and fixture.key in ('trend-unsettled', 'judge-expired');
grant select on score_cancellation_targets to authenticated;

select ok((select canceled.status = 'canceled' and canceled.attempt_count = 0
    and canceled.canceled_recorded_xact_id = pg_current_xact_id() and canceled.finished_at is not null
  from score_cancellation_targets target cross join lateral public.cancel_factory_evaluation_job(
    target.workspace_id, target.factory_id, pg_temp.sampling_id(1), target.job_id) canceled
  where target.key = 'trend-unsettled'), 'canceling before claim records the cancellation transaction without an attempt');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select ok((select pg_temp.read_score_cohort('trend-numeric', original.payload->>'snapshot') = original.payload
  from middle_trend original), 'a signed view predating the live cancellation still shows the queued run as unsettled');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

-- Model a cancellation that closed at the boundary of an earlier signed
-- snapshot. The rollback-only fixture cannot commit its own transactions.
create temp table score_cancellation_horizon as
select cutoff.xact_id, internal.factory_score_cohort_snapshot(scope.workspace_id, scope.factory_id,
    policy.id, bounds.since, bounds.until, cutoff.xact_id) as older_snapshot
from middle_trend original cross join sample_scope scope cross join sample_policies policy cross join trend_window bounds
cross join lateral (select (split_part(original.payload->>'snapshot', '.', 1)::numeric - 1)::text as xact_id) cutoff
where scope.key = 'primary' and policy.key = 'trend-numeric';
grant select on score_cancellation_horizon to authenticated;
set constraints factory_evaluation_jobs_source_attempt_id_fkey immediate;
alter table public.factory_evaluation_jobs disable trigger factory_evaluation_jobs_immutable;
update public.factory_evaluation_jobs job set canceled_recorded_xact_id = horizon.xact_id::xid8
from score_cancellation_targets target cross join score_cancellation_horizon horizon
where (job.workspace_id, job.factory_id, job.id) = (target.workspace_id, target.factory_id, target.job_id)
  and job.status = 'canceled';
alter table public.factory_evaluation_jobs enable trigger factory_evaluation_jobs_immutable;
set constraints factory_evaluation_jobs_source_attempt_id_fkey deferred;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select ok((select older.payload->'totals' = original.payload->'totals'
    and older.payload->'points' = original.payload->'points' and older.payload->'rows' = original.payload->'rows'
  from score_cancellation_horizon horizon cross join middle_trend original cross join lateral (
    select pg_temp.read_score_cohort('trend-numeric', horizon.older_snapshot) as payload
  ) older), 'a cancellation at the signed boundary remains unsettled in that earlier view');
select ok((select fresh.payload->'totals' @> '{"candidate_count":3,"sampled_count":3,"usable_count":2,
      "decided_count":1,"skipped_count":1,"unsettled_count":0}'::jsonb
    and fresh.payload->>'row_count' = '1'
    and fresh.payload->'rows' @> jsonb_build_array(jsonb_build_object('run_id', target.run_id,
      'evaluation_job_id', target.job_id, 'evaluation_sample_receipt_id', target.sample_receipt_id,
      'evaluation_attempt_id', null::uuid, 'status', 'skipped', 'reason', 'canceled', 'score', null::jsonb))
    and (select sum((day->>'skipped_count')::integer) from jsonb_array_elements(fresh.payload->'points') day) = 1
  from score_cancellation_targets target cross join lateral (
    select pg_temp.read_score_cohort('trend-numeric', p_status => 'skipped') as payload
  ) fresh where target.key = 'trend-unsettled'),
  'a later view counts a closed queued cancellation as skipped with no fabricated evaluation attempt');
select ok((select fresh.payload->'rows' @> jsonb_build_array(jsonb_build_object('run_id', claim.run_id,
      'evaluation_job_id', claim.job_id, 'evaluation_attempt_id', null::uuid, 'status', 'skipped', 'reason', 'canceled'))
    and history.payload#>>'{0,receipt,attempt_id}' = claim.attempt_id::text
    and history.payload#>>'{0,receipt,reason}' = 'provider_unavailable'
  from evaluation_claims claim cross join lateral (
    select pg_temp.read_score_cohort('evaluation-replay') as payload
  ) fresh cross join lateral (
    select pg_temp.read_run_scores('judge-expired', claim.attempt_id) as payload
  ) history where claim.slot = 'judge-estimated'),
  'cancelling a queued retry records a skipped run while preserving its exact earlier provider failure');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
create temp table governance_prior_trend as select pg_temp.read_score_cohort('trend-numeric') as payload;
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

-- Pin an approver in a new activation without altering the live stage.
with compiled as (
  select prior.workspace_id, prior.factory_id, prior.created_by,
    jsonb_set(jsonb_set(prior.definition_json::jsonb, '{stages,0,anyoneCanApprove}', 'false'),
      '{stages,0,approverMemberIds}', jsonb_build_array(pg_temp.sampling_id(21)))::text as definition
  from public.factory_definition_revisions prior where prior.id = pg_temp.sampling_id(52)
), revision as (
  insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version,
    definition_json, canonical_digest, created_by)
  select pg_temp.sampling_id(53), workspace_id, factory_id, 2, definition,
    encode(sha256(convert_to(definition, 'UTF8')), 'hex'), created_by from compiled
  returning id, workspace_id, factory_id, created_by
)
insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
select workspace_id, factory_id, id, 3, created_by from revision;

create temp table governance_revisions as
select new_revision.* from numeric_scorer scorer cross join lateral public.save_factory_scorer_revision(
  scorer.workspace_id, scorer.factory_id, pg_temp.sampling_id(1), scorer.scorer_id, scorer.revision_number,
  jsonb_set(jsonb_set(jsonb_set(scorer.definition, '{rubric}', '"Use the revised release-quality thresholds."'),
    '{scoring,failThreshold}', '1'), '{scoring,passThreshold}', '2')) new_revision;
insert into governance_revisions
select new_revision.* from governance_revisions scorer cross join lateral public.save_factory_scorer_revision(
  scorer.workspace_id, scorer.factory_id, pg_temp.sampling_id(1), scorer.scorer_id, scorer.revision_number,
  jsonb_set(scorer.definition, '{requiredEvidence}', '["browser_screenshot"]')) new_revision where scorer.revision_number = 4;

create function pg_temp.set_scorer_pause(p_expected integer, p_paused boolean, p_actor uuid default pg_temp.sampling_id(1))
returns jsonb language sql as $$
  select public.configure_factory_scorer_pause(revision.workspace_id, revision.factory_id, p_actor,
    revision.scorer_id, p_expected, p_paused) from numeric_scorer revision;
$$;

create function pg_temp.request_scorer_retry(p_slot text, p_target uuid, p_actor uuid default pg_temp.sampling_id(1))
returns jsonb language sql as $$
  select public.request_factory_scorer_reevaluation(claim.workspace_id, claim.factory_id, p_actor,
    claim.attempt_id, p_target) from evaluation_claims claim where claim.slot = p_slot;
$$;

select public.configure_factory_evaluation_lane(scope.workspace_id, scope.owner_id, lane.revision, false, 2)
from sample_scope scope cross join lateral public.get_factory_evaluation_lane(scope.workspace_id, scope.owner_id) lane
where scope.key = 'primary';
insert into sample_runs values ('governance-held', pg_temp.accept_sample_run('Complete a held scorer attempt'));
select (pg_temp.record_sample('primary', 'trend-numeric', 'governance-held')).id;
insert into evaluation_claims select 'governance-held', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.begin_judge('governance-held', rotated_judge.id)->>'status', 'authorized',
  'the pinned scorer produces a real in-flight provider permit before it is paused') from rotated_judge;
insert into sample_runs values ('governance-expiring', pg_temp.accept_sample_run('Recover a held scorer attempt'));
select (pg_temp.record_sample('primary', 'trend-numeric', 'governance-expiring')).id;
insert into evaluation_claims select 'governance-expiring', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.begin_judge('governance-expiring', rotated_judge.id)->>'status', 'authorized',
  'a second started scorer attempt is independently recoverable') from rotated_judge;

select ok((select bool_and(has_function_privilege('authenticated', signature, 'EXECUTE')
    and not has_function_privilege('service_role', signature, 'EXECUTE')
    and not has_function_privilege('anon', signature, 'EXECUTE'))
  from (values ('public.get_factory_scorer_pause(uuid,uuid,uuid,integer)'),
    ('public.list_factory_scorer_reevaluations(uuid,uuid,uuid,timestamptz,uuid)'),
    ('public.read_factory_evaluation_review(uuid,uuid,uuid,timestamptz,uuid,uuid)'),
    ('public.read_factory_scorer_calibration(uuid,uuid,uuid,uuid,integer,timestamptz,uuid,timestamptz,uuid)')) reads(signature))
    and not has_table_privilege('authenticated', 'public.factory_scorer_pause_transitions', 'SELECT'),
  'governance read functions require a signed-in database role and do not grant raw pause history');
create function pg_temp.scorer_pause_state(p_before integer default null, p_scope text default 'primary')
returns jsonb language sql as $$
  select public.get_factory_scorer_pause(scope.workspace_id, scope.factory_id, revision.scorer_id, p_before)
  from numeric_scorer revision cross join sample_scope scope where scope.key = p_scope;
$$;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select is(pg_temp.scorer_pause_state(),
  '{"paused":false,"revision":0,"updated_at":null,"history":[],"next_before_pause_revision":null}'::jsonb,
  'a signed-in factory reader sees the initial enabled scorer and empty pause history');
select throws_ok($$select pg_temp.scorer_pause_state(p_scope => 'sibling')$$, 'P0002', 'Evaluation factory is unavailable.',
  'ordinary workspace membership does not authorize pause history in a restricted sibling factory');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';
select throws_ok($$select pg_temp.set_scorer_pause(0, true, pg_temp.sampling_id(2))$$,
  '42501', null, 'a permitted factory reader cannot pause a scorer');
select ok(pg_temp.set_scorer_pause(0, true) @> '{"paused":true,"revision":1}'::jsonb,
  'the manager pauses only the target scorer');
select throws_ok($$select pg_temp.set_scorer_pause(0, false)$$, 'PT409', null,
  'a stale pause configuration cannot overwrite the current revision');
select throws_ok($$select pg_temp.request_scorer_retry('trend-fail', id) from governance_revisions where revision_number = 4$$,
  'PT409', null, 'the same scorer pause prevents explicit new re-evaluation admission');

insert into sample_runs values ('governance-paused', pg_temp.accept_sample_run('Publish normally while scorer is paused'));
create temp table paused_score_sample as
select sample.* from pg_temp.record_sample('primary', 'trend-numeric', 'governance-paused') sample;
select ok((select sample.outcome = 'sampled' and skip.pause_revision = 1
    and not exists (select 1 from public.factory_evaluation_jobs job where job.sample_receipt_id = sample.id)
  from paused_score_sample sample join public.factory_scorer_admission_skips skip on skip.sample_receipt_id = sample.id),
  'a paused scorer keeps its deterministic sampled result with a skip fact and creates no job');

select is((select pg_temp.finish_judge('governance-held', 'completed', jsonb_build_object('schemaVersion', 1,
    'status', 'fail', 'score', '{"kind":"numeric","value":2}'::jsonb, 'evidence', receipt.evidence))
  from evaluation_claims claim join public.factory_scorer_sample_receipts receipt on receipt.id = claim.sample_receipt_id
  where claim.slot = 'governance-held'), true, 'pausing admission leaves an in-flight permit able to settle its exact result');
alter table public.factory_evaluation_attempts disable trigger factory_evaluation_attempts_immutable;
update public.factory_evaluation_attempts attempt set claimed_at = clock_timestamp() - interval '91 seconds',
  lease_expires_at = clock_timestamp() - interval '1 second'
from evaluation_claims claim where claim.slot = 'governance-expiring' and claim.attempt_id = attempt.id;
alter table public.factory_evaluation_attempts enable trigger factory_evaluation_attempts_immutable;
select ok((select attempts_recovered = 1 and jobs_requeued = 1 from public.maintain_factory_evaluation_queue(5)),
  'lease recovery still retains an expired attempt and schedules its retry while the scorer is paused');
update public.factory_evaluation_jobs job set available_at = statement_timestamp()
from evaluation_claims claim where claim.slot = 'governance-expiring' and claim.job_id = job.id;
select (pg_temp.record_sample('primary', 'evaluation-replay', 'governance-paused')).id;
insert into evaluation_claims select 'governance-other', claim.* from public.claim_factory_judge_job() claim;
select ok((select claim.run_id = fixture.id and claim.scorer_revision_id = scorer.id
  from evaluation_claims claim cross join sample_runs fixture cross join sample_scorers scorer
  where claim.slot = 'governance-other' and fixture.key = 'governance-paused' and scorer.key = 'exact'),
  'the same factory still claims the other scorer while the paused scorer has a ready retry');
select is((select count(*) from public.claim_factory_judge_job()), 0::bigint,
  'pausing blocks new claims of already admitted work for the same scorer');
select public.cancel_factory_evaluation_job(claim.workspace_id, claim.factory_id, pg_temp.sampling_id(1), claim.job_id)
from evaluation_claims claim where claim.slot in ('governance-expiring', 'governance-other');
select ok(pg_temp.set_scorer_pause(1, false) @> '{"paused":false,"revision":2}'::jsonb,
  'the manager resumes future admission through a new pause revision');
select ok((select (pg_temp.record_sample('primary', 'trend-numeric', 'governance-paused')).id = sample.id
    and not exists (select 1 from public.factory_evaluation_jobs job where job.sample_receipt_id = sample.id)
  from paused_score_sample sample), 'an already skipped sample does not enqueue when its exact receipt is replayed after resume');

do $$
declare revision integer;
begin
  for revision in 2..21 loop
    perform pg_temp.set_scorer_pause(revision, revision % 2 = 0);
  end loop;
end;
$$;
update public.workspace_members set full_name = 'Sampling owner' where id = pg_temp.sampling_id(21);
select ok((select count(*) = 22 and bool_and(transition.actor_user_id = pg_temp.sampling_id(1))
    and bool_and(transition.paused = (transition.revision % 2 = 1))
  from numeric_scorer scorer join public.factory_scorer_pause_transitions transition
    on (transition.workspace_id, transition.factory_id, transition.scorer_id) = (scorer.workspace_id, scorer.factory_id, scorer.scorer_id)),
  'each actual state change durably records its scoped actor, revision and disposition');
select throws_ok($$update public.factory_scorer_pause_transitions transition set actor_user_id = pg_temp.sampling_id(2)
  from numeric_scorer scorer where (transition.workspace_id, transition.factory_id, transition.scorer_id, transition.revision) =
    (scorer.workspace_id, scorer.factory_id, scorer.scorer_id, 1)$$, '23514', null,
  'the original actor of a pause transition cannot be rewritten');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select ok((select payload @> '{"paused":false,"revision":22,"next_before_pause_revision":3}'::jsonb
    and jsonb_array_length(payload->'history') = 20 and payload#>>'{history,0,revision}' = '22'
    and payload#>>'{history,19,revision}' = '3' and payload#>>'{history,0,actor_name}' = 'Sampling owner'
    and (pg_temp.scorer_pause_state((payload->>'next_before_pause_revision')::integer))
      @> '{"paused":false,"revision":22,"next_before_pause_revision":null,"history":[{"revision":2,"paused":false},{"revision":1,"paused":true}]}'::jsonb
  from (select pg_temp.scorer_pause_state() as payload) recent),
  'pause history pages keep current state while returning older immutable transitions and display-safe actor labels');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

insert into sample_scorers select 'governance-manual-target', id from governance_revisions where revision_number = 4;
insert into sample_policies select 'governance-manual-target', id
from pg_temp.save_sample_policy('primary', 'governance-manual-target', 0, 10000);

select throws_ok($$select pg_temp.request_scorer_retry('trend-fail', id, pg_temp.sampling_id(2))
  from governance_revisions where revision_number = 4$$, '42501', null,
  'a factory reader cannot request a manual re-evaluation');
select throws_ok($$select pg_temp.request_scorer_retry('trend-fail', id) from numeric_scorer$$,
  'P0002', null, 'a manual re-evaluation must select a genuinely newer rubric revision');
select throws_ok($$select pg_temp.request_scorer_retry('trend-fail', id) from sample_scorers where key = 'exact'$$,
  'P0002', null, 'a manual re-evaluation cannot replace the original scorer identity');
select throws_ok($$select pg_temp.request_scorer_retry('judge-report', id) from governance_revisions where revision_number = 4$$,
  'PT422', null, 'erased retained evidence blocks re-evaluation despite unchanged original score metadata');
select throws_ok($$select pg_temp.request_scorer_retry('trend-fail', id) from governance_revisions where revision_number = 5$$,
  'PT422', null, 'new evidence requirements are checked against the exact retained source');

create temp table original_manual_score as
select receipt.* from public.factory_evaluation_receipts receipt join evaluation_claims claim on claim.attempt_id = receipt.attempt_id
where claim.slot = 'trend-fail';
create temp table requested_manual_score as
select pg_temp.request_scorer_retry('trend-fail', id) as payload from governance_revisions where revision_number = 4;
select ok((select requested.payload = pg_temp.request_scorer_retry('trend-fail', revision.id)
    and requested.payload @> jsonb_build_object('prior_attempt_id', original.attempt_id,
      'target_scorer_revision_id', revision.id, 'status', 'queued')
    and (job.run_id, job.target_commit_sha, job.scorer_revision_id, job.source_attempt_id) =
      (original.run_id, original.target_commit_sha, revision.id, original.attempt_id)
    and sample.policy_id is null and sample.outcome = 'sampled'
  from requested_manual_score requested cross join original_manual_score original cross join governance_revisions revision
  join public.factory_evaluation_jobs job on job.scorer_revision_id = revision.id
  join public.factory_scorer_sample_receipts sample on sample.id = job.sample_receipt_id
  where revision.revision_number = 4 and job.id = (requested.payload->>'job_id')::uuid),
  'replaying the explicit non-latest revision request admits one policy-free exact run and commit with source provenance');

insert into evaluation_claims select 'governance-manual', claim.* from public.claim_factory_judge_job() claim;
select is(pg_temp.begin_judge('governance-manual', rotated_judge.id)->>'status', 'authorized',
  'the same worker claims and prepares the manual job through the retained evidence fence') from rotated_judge;
select is((select pg_temp.finish_judge('governance-manual', 'completed', jsonb_build_object('schemaVersion', 1,
    'status', 'pass', 'score', '{"kind":"numeric","value":2}'::jsonb, 'evidence', sample.evidence))
  from evaluation_claims claim join public.factory_scorer_sample_receipts sample on sample.id = claim.sample_receipt_id
  where claim.slot = 'governance-manual'), true, 'the chosen historical rubric gives a distinct receipt under its own thresholds');

-- Make only the manual fixture facts visible to online cohort queries. Their
-- exact source run was already part of the original closed history.
alter table public.factory_scorer_sample_receipts disable trigger factory_scorer_sample_receipts_immutable;
update public.factory_scorer_sample_receipts sample set recorded_xact_id = null
from evaluation_claims claim where claim.slot = 'governance-manual' and sample.id = claim.sample_receipt_id;
alter table public.factory_scorer_sample_receipts enable trigger factory_scorer_sample_receipts_immutable;
alter table public.factory_evaluation_receipts disable trigger factory_evaluation_receipts_immutable;
update public.factory_evaluation_receipts receipt set recorded_xact_id = null
from evaluation_claims claim where claim.slot = 'governance-manual' and receipt.attempt_id = claim.attempt_id;
alter table public.factory_evaluation_receipts enable trigger factory_evaluation_receipts_immutable;
select ok((select to_jsonb(original) = to_jsonb(retained)
  from original_manual_score original join public.factory_evaluation_receipts retained on retained.attempt_id = original.attempt_id),
  'the manual result does not alter the original judgment');
create temp table manual_history_position as
select job.created_at, job.id from original_manual_score original join public.factory_evaluation_jobs job
  on (job.workspace_id, job.factory_id, job.source_attempt_id) = (original.workspace_id, original.factory_id, original.attempt_id);
grant select (workspace_id, factory_id, attempt_id, run_id, finished_at) on original_manual_score to authenticated;
grant select on manual_history_position to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select ok((select judgment.payload->'jobs' @> jsonb_build_array(jsonb_build_object('job_id', claim.job_id,
      'prior_attempt_id', original.attempt_id, 'target_scorer_revision_id', claim.scorer_revision_id,
      'receipt', jsonb_build_object('attempt_id', claim.attempt_id, 'status', 'pass')))
    and judgment.payload @> '{"next_before_created_at":null,"next_before_job_id":null}'::jsonb
  from original_manual_score original join evaluation_claims claim on claim.run_id = original.run_id cross join lateral (
    select public.list_factory_scorer_reevaluations(original.workspace_id, original.factory_id, original.attempt_id) as payload
  ) judgment where claim.slot = 'governance-manual'),
  'a factory reader can inspect the manual result and its exact source provenance');
select is((select public.list_factory_scorer_reevaluations(original.workspace_id, original.factory_id,
    original.attempt_id, job.created_at, job.id)
  from original_manual_score original cross join manual_history_position job),
  '{"jobs":[],"next_before_created_at":null,"next_before_job_id":null}'::jsonb,
  'the exact timestamp and job keyset boundary excludes the already listed re-evaluation');
select throws_ok($$select public.list_factory_scorer_reevaluations(original.workspace_id, original.factory_id,
    original.attempt_id, p_before_created_at => original.finished_at)
  from original_manual_score original$$, '22023', null, 'manual history rejects a partially specified keyset cursor');
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000003';
select throws_ok($$select public.list_factory_scorer_reevaluations(workspace_id, factory_id, attempt_id)
  from original_manual_score$$, 'P0002', 'Evaluation factory is unavailable.', 'foreign users cannot read known manual evaluation lineage');
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select ok((select pg_temp.read_run_scores('governance-paused') @> jsonb_build_array(jsonb_build_object(
    'scorer_revision_id', revision.id, 'admission_paused', true, 'evaluation_job_id', null::uuid))
  from numeric_scorer revision), 'an ordinary authorized reader can distinguish a skipped paused sample from awaiting work');
select ok((select pg_temp.read_score_cohort('trend-numeric', original.payload->>'snapshot') = original.payload
    and pg_temp.read_score_cohort('governance-manual-target')->'totals' @> '{"candidate_count":0,"usable_count":0}'::jsonb
  from governance_prior_trend original), 'manual adjudication work does not enter either rubric’s online sampling denominator');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

create temp table scorer_review_before as
select receipt.attempt_id, to_jsonb(receipt) as judgment, session.id as session_id, session.phase_status,
  session.factory_definition_revision_id, session.current_artifact_id, session.artifact_review_revision
from evaluation_claims claim join public.factory_evaluation_receipts receipt on receipt.attempt_id = claim.attempt_id
join public.sessions session on session.id = claim.session_id where claim.slot = 'governance-held';

create function pg_temp.review_held_score(p_selected uuid default null)
returns jsonb language sql as $$
  select public.read_factory_evaluation_review(claim.workspace_id, claim.factory_id, claim.attempt_id,
    p_selected_adjudication_id => p_selected)
  from evaluation_claims claim where claim.slot = 'governance-held';
$$;
create function pg_temp.adjudicate_held_score(p_id uuid, p_disposition text, p_note text,
  p_expected text default null, p_actor uuid default pg_temp.sampling_id(1)) returns jsonb language sql as $$
  select public.adjudicate_factory_evaluation_receipt(claim.workspace_id, claim.factory_id, p_actor,
    claim.attempt_id, p_id, p_disposition, p_note, p_expected)
  from evaluation_claims claim where claim.slot = 'governance-held';
$$;

grant select (factory_definition_revision_id) on scorer_review_before to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select ok((select session.factory_definition_revision_id = pg_temp.sampling_id(53) and live.anyone_can_approve
    and pg_temp.review_held_score() @> '{"can_adjudicate":false,"adjudications":[]}'::jsonb
  from scorer_review_before session cross join public.pipeline_stages live where live.id = pg_temp.sampling_id(32)),
  'the live stage may allow everyone while only the frozen approver can adjudicate the exact judged run');
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000003';
select throws_ok($$select pg_temp.review_held_score()$$,
  'P0002', 'Evaluation factory is unavailable.', 'a foreign signed-in user cannot read a known exact adjudication target');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';
select throws_ok($$select pg_temp.adjudicate_held_score(pg_temp.sampling_id(142), 'confirmed', 'Unlisted reviewer',
    p_actor => pg_temp.sampling_id(2))$$, '42501', null, 'the pinned approver gate applies to an ordinary in-factory reader');
select throws_ok($$select public.adjudicate_factory_evaluation_receipt(claim.workspace_id, pg_temp.sampling_id(20),
    pg_temp.sampling_id(1), claim.attempt_id, pg_temp.sampling_id(142), 'confirmed', 'Different factory')
  from evaluation_claims claim where claim.slot = 'governance-held'$$, 'P0002', null,
  'an owner cannot bind the exact attempt to a different factory');

create temp table confirmed_scorer_review as
select pg_temp.adjudicate_held_score(pg_temp.sampling_id(141), 'confirmed', 'The recorded capacity checks agree.') as payload;
select ok((select original.payload = pg_temp.adjudicate_held_score(pg_temp.sampling_id(141), 'confirmed',
    'The recorded capacity checks agree.') and original.payload @> '{"disposition":"confirmed","expected_status":null}'::jsonb
  from confirmed_scorer_review original), 'the author can safely deliver an exact confirmation twice');
select throws_ok($$select pg_temp.adjudicate_held_score(pg_temp.sampling_id(141), 'disputed', 'Different adjudication.', 'pass')$$,
  'PT409', null, 'the same request identity cannot rewrite a retained adjudication');
select ok(pg_temp.adjudicate_held_score(pg_temp.sampling_id(142), 'disputed', 'The held case is a valid release.', 'pass')
    @> '{"disposition":"disputed","expected_status":"pass"}'::jsonb,
  'a later independent reviewer dispute retains its expected status separately from the model verdict');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000001';
create temp table retained_score_review as select pg_temp.review_held_score() as payload;
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';
select ok((select review.payload @> jsonb_build_object('can_adjudicate', true, 'adjudications', jsonb_build_array(
      jsonb_build_object('id', pg_temp.sampling_id(141), 'disposition', 'confirmed', 'note', 'The recorded capacity checks agree.'),
      jsonb_build_object('id', pg_temp.sampling_id(142), 'disposition', 'disputed', 'expected_status', 'pass',
        'note', 'The held case is a valid release.')))
    and to_jsonb(receipt) = before_review.judgment and receipt.status = 'fail' and session.phase_status = 'awaiting_review'
    and (session.phase_status, session.current_artifact_id, session.artifact_review_revision) is not distinct from
      (before_review.phase_status, before_review.current_artifact_id, before_review.artifact_review_revision)
  from scorer_review_before before_review join public.factory_evaluation_receipts receipt on receipt.attempt_id = before_review.attempt_id
  join public.sessions session on session.id = before_review.session_id cross join retained_score_review review),
  'both adjudications remain inspectable without changing the original result or approving the production stage');

create function pg_temp.save_scorer_calibration(p_expected integer, p_pin uuid, p_adjudication uuid,
  p_actor uuid default pg_temp.sampling_id(1)) returns jsonb language sql as $$
  select public.save_factory_scorer_calibration_revision(scorer.workspace_id, scorer.factory_id, p_actor,
    scorer.scorer_id, pg_temp.sampling_id(140), p_expected, p_pin, 'Release calibration', array[p_adjudication])
  from numeric_scorer scorer;
$$;
select throws_ok($$select pg_temp.save_scorer_calibration(0, id, pg_temp.sampling_id(141), pg_temp.sampling_id(2))
  from numeric_scorer$$, '42501', null, 'factory read access cannot write a calibration version');
select throws_ok($$select pg_temp.save_scorer_calibration(0, id, pg_temp.sampling_id(143)) from numeric_scorer$$,
  '22023', null, 'a calibration set cannot include an unknown adjudication');
create temp table first_scorer_calibration as
select pg_temp.save_scorer_calibration(0, id, pg_temp.sampling_id(141)) as payload from numeric_scorer;
select throws_ok($$select pg_temp.save_scorer_calibration(0, id, pg_temp.sampling_id(142)) from numeric_scorer$$,
  'PT409', null, 'a stale calibration edit cannot replace the published reference list');
create temp table second_scorer_calibration as
select pg_temp.save_scorer_calibration(1, id, pg_temp.sampling_id(142)) as payload
from governance_revisions where revision_number = 4;
grant select on first_scorer_calibration, second_scorer_calibration to authenticated;
grant select (id, revision_number) on governance_revisions to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000001';
select ok((select first.payload @> jsonb_build_object('revision', 1, 'scorer_revision_id', scorer.id,
      'adjudication_ids', jsonb_build_array(pg_temp.sampling_id(141)))
    and second.payload @> jsonb_build_object('revision', 2, 'scorer_revision_id', revision.id,
      'adjudication_ids', jsonb_build_array(pg_temp.sampling_id(142)))
    and versions.payload->'versions' @> jsonb_build_array(first.payload, second.payload)
    and versions.payload->'versions' @> jsonb_build_array(
      jsonb_build_object('revision', 1, 'scorer_revision_number', 3, 'case_refs', jsonb_build_array(
        jsonb_build_object('adjudication_id', pg_temp.sampling_id(141), 'attempt_id', claim.attempt_id, 'run_id', claim.run_id))),
      jsonb_build_object('revision', 2, 'scorer_revision_number', 4, 'case_refs', jsonb_build_array(
        jsonb_build_object('adjudication_id', pg_temp.sampling_id(142), 'attempt_id', claim.attempt_id, 'run_id', claim.run_id))))
  from first_scorer_calibration first cross join second_scorer_calibration second
  cross join numeric_scorer scorer cross join governance_revisions revision cross join evaluation_claims claim cross join lateral (
    select public.read_factory_scorer_calibration(scorer.workspace_id, scorer.factory_id,
      scorer.scorer_id, pg_temp.sampling_id(140)) as payload
  ) versions where revision.revision_number = 4 and claim.slot = 'governance-held'),
  'each calibration version retains its rubric number and exact adjudication, attempt, and run references');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';
select throws_ok($$update public.factory_scorer_adjudications set note = 'Rewritten' where id = pg_temp.sampling_id(142)$$,
  '23514', null, 'an adjudication cannot be updated after it is retained');
select throws_ok($$update public.factory_scorer_calibration_revisions set name = 'Rewritten'
  where id = (select (payload->>'id')::uuid from first_scorer_calibration)$$,
  '23514', null, 'the earlier calibration version remains immutable');

-- Fill the first candidate page without adding cases to the existing sets.
do $$
begin
  perform public.adjudicate_factory_evaluation_receipt(original.workspace_id, original.factory_id,
    pg_temp.sampling_id(1), original.attempt_id, pg_temp.sampling_id(slot), 'confirmed', 'Additional calibration case.')
  from original_manual_score original cross join generate_series(401, 439) slots(slot);
end;
$$;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000001';
create temp table first_calibration_candidates as
select public.read_factory_scorer_calibration(scorer.workspace_id, scorer.factory_id,
  scorer.scorer_id, pg_temp.sampling_id(140)) as payload from numeric_scorer scorer;
select ok((select jsonb_array_length(payload->'candidates') = 40
    and payload->>'next_before_candidate_at' is not null
    and payload->>'next_before_candidate_id' = payload#>>'{candidates,39,id}'
    and not (payload->'candidates' @> jsonb_build_array(jsonb_build_object('id', pg_temp.sampling_id(141))))
  from first_calibration_candidates), 'the first candidate page exposes its exact boundary and omits an older valid case');
select ok((select jsonb_array_length(older.payload->'candidates') = 1
    and older.payload#>>'{candidates,0,id}' = pg_temp.sampling_id(141)::text
    and older.payload#>>'{candidates,0,session_title}' = 'Complete a held scorer attempt'
    and older.payload#>>'{candidates,0,run_id}' = older.payload#>>'{versions,1,case_refs,0,run_id}'
    and older.payload#>>'{versions,1,case_refs,0,session_title}' = 'Complete a held scorer attempt'
    and older.payload @> '{"next_before_candidate_at":null,"next_before_candidate_id":null}'::jsonb
    and older.payload->'versions' = first.payload->'versions'
  from first_calibration_candidates first cross join numeric_scorer scorer cross join lateral (
    select public.read_factory_scorer_calibration(scorer.workspace_id, scorer.factory_id,
      scorer.scorer_id, pg_temp.sampling_id(140),
      p_before_candidate_at => (first.payload->>'next_before_candidate_at')::timestamptz,
      p_before_candidate_id => (first.payload->>'next_before_candidate_id')::uuid) as payload
  ) older), 'the saved case has the same authorized run identity before and after its candidate page loads');
select throws_ok($$select public.read_factory_scorer_calibration(scorer.workspace_id, scorer.factory_id,
    scorer.scorer_id, p_before_candidate_id => pg_temp.sampling_id(141))
  from numeric_scorer scorer$$, '22023', null, 'calibration candidates require both keyset cursor fields');

set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select ok((select reader.payload->'candidates' = '[]'::jsonb and jsonb_array_length(reader.payload->'versions') = 2
  from numeric_scorer scorer cross join lateral (
    select public.read_factory_scorer_calibration(scorer.workspace_id, scorer.factory_id,
      scorer.scorer_id, pg_temp.sampling_id(140)) as payload
  ) reader), 'the signed-in reader can inspect retained versions but cannot fetch the manager’s candidate pool');
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000003';
select throws_ok($$select public.read_factory_scorer_calibration(workspace_id, factory_id, scorer_id)
  from numeric_scorer$$, 'P0002', 'Evaluation factory is unavailable.', 'a foreign signed-in user cannot list exact calibration history');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

do $$
begin
  perform pg_temp.adjudicate_held_score(pg_temp.sampling_id(slot), 'confirmed', 'Newer adjudication on the same receipt.')
  from generate_series(501, 520) slots(slot);
end;
$$;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000002';
select ok((select jsonb_array_length(payload->'adjudications') = 20 and payload->>'has_more' = 'true'
    and not (payload->'adjudications' @> jsonb_build_array(jsonb_build_object('id', pg_temp.sampling_id(142))))
    and payload->'selected_adjudication' @> jsonb_build_object('id', pg_temp.sampling_id(142),
      'attempt_id', before_review.attempt_id, 'expected_status', 'pass', 'note', 'The held case is a valid release.')
  from (select pg_temp.review_held_score(pg_temp.sampling_id(142)) as payload) exact
  cross join evaluation_claims before_review where before_review.slot = 'governance-held'),
  'a saved exact adjudication links beyond the latest twenty decisions on the same attempt');
select is((select public.read_factory_evaluation_review(workspace_id, factory_id, attempt_id,
    p_selected_adjudication_id => pg_temp.sampling_id(142))->'selected_adjudication' from original_manual_score),
  'null'::jsonb, 'an exact adjudication ID from another attempt is not returned on this receipt');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

update public.sessions session set archived_at = clock_timestamp()
from scorer_review_before original where session.id = original.session_id;
create temp table reviewed_erasure_target as
select session.workspace_id, session.factory_id, session.id, session.archived_at
from scorer_review_before original join public.sessions session on session.id = original.session_id;
grant select on reviewed_erasure_target to authenticated;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '60300000-0000-4000-8000-000000000001';
select (public.erase_session_retained_content(target.workspace_id, target.factory_id, target.id, target.archived_at)).erased_at
from reviewed_erasure_target target;
create temp table withheld_scorer_review as
select pg_temp.review_held_score(pg_temp.sampling_id(141))->'selected_adjudication' as confirmed,
  pg_temp.review_held_score(pg_temp.sampling_id(142))->'selected_adjudication' as disputed;
select ok((select payload->'versions' @> jsonb_build_array(jsonb_build_object(
      'revision', 1, 'case_refs', jsonb_build_array(jsonb_build_object(
        'adjudication_id', pg_temp.sampling_id(141), 'session_title', null::text, 'disposition', 'confirmed'))))
    and payload->'candidates' @> jsonb_build_array(jsonb_build_object(
      'id', pg_temp.sampling_id(142), 'session_title', null::text, 'note', null::text))
  from numeric_scorer scorer cross join lateral (
    select public.read_factory_scorer_calibration(scorer.workspace_id, scorer.factory_id,
      scorer.scorer_id, pg_temp.sampling_id(140)) as payload
  ) calibration), 'session erasure withholds case names and notes while keeping the saved adjudication and verdict');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';
select ok((select review.confirmed @> jsonb_build_object('id', pg_temp.sampling_id(141), 'disposition', 'confirmed', 'note', null::text)
    and review.disputed @> jsonb_build_object('id', pg_temp.sampling_id(142), 'disposition', 'disputed', 'expected_status', 'pass', 'note', null::text)
    and to_jsonb(receipt) = original.judgment
  from scorer_review_before original join public.factory_evaluation_receipts receipt on receipt.attempt_id = original.attempt_id
  cross join withheld_scorer_review review),
  'erasure withholds even exact-linked adjudication prose while preserving its disposition and immutable original receipt');

-- Model a historical receipt selected for admission as its workspace retires.
insert into sample_runs values ('retiring-receipt', pg_temp.accept_sample_run('Retiring workspace receipt fixture'));
alter table public.factory_scorer_sample_receipts disable trigger factory_evaluation_job_from_sample;
create temp table retiring_evaluation_backlog as
select receipt.id, receipt.run_id, receipt.created_at
from pg_temp.record_sample('primary', 'evaluation-replay', 'retiring-receipt') receipt;
alter table public.factory_scorer_sample_receipts enable trigger factory_evaluation_job_from_sample;
update internal.factory_evaluation_admission_progress progress
set before_created_at = backlog.created_at, before_receipt_id = backlog.id, completed = false
from retiring_evaluation_backlog backlog where progress.singleton;
select ok(public.begin_workspace_deletion(pg_temp.sampling_id(11), pg_temp.sampling_id(21), 'Sampling primary') is not null,
  'the owner opens the workspace deletion fence before recovery');
select ok((select receipts_processed = 0 and jobs_admitted = 0 from public.maintain_factory_evaluation_queue(1)),
  'backlog maintenance skips evaluation admission for a deleting workspace');
select ok((select progress.completed
    and not exists (select 1 from public.factory_evaluation_jobs job where job.run_id = backlog.run_id)
  from internal.factory_evaluation_admission_progress progress cross join retiring_evaluation_backlog backlog),
  'the deleting workspace leaves no evaluation and cannot keep the backlog open');

select * from finish();
rollback;
