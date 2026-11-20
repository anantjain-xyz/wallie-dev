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

create function pg_temp.finish_judge(p_slot text, p_status text, p_result jsonb default null)
returns boolean language sql as $$
  select public.finish_factory_judge_invocation(claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id,
    claim.lease_id, p_status, p_result,
    case when p_status = 'completed' then 'openai/gpt-4.1-mini' end,
    case when p_status = 'completed' then 'OpenAI' end,
    case when p_status = 'completed' then 'fixture-request-id' end)
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
select is((select pg_temp.finish_judge('judge-report', 'completed', result) from judge_pass), true,
  'a schema-valid verdict settles the exact judge invocation');
select is((select pg_temp.finish_judge('judge-report', 'completed', result) from judge_pass), false,
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
