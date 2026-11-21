begin;
set local request.jwt.claim.role = 'service_role';

create temporary table browser_comparison_scope as
select :'workspace_id'::uuid as workspace_id, :'factory_id'::uuid as factory_id,
  :'owner_id'::uuid as owner_id, :'pipeline_id'::uuid as pipeline_id, :'stage_id'::uuid as stage_id,
  :'stage_slug' as stage_slug, :'repository_id'::uuid as repository_id,
  :'experiment_id'::uuid as experiment_id, :'source_definition_id'::uuid as definition_id,
  gen_random_uuid() as sandbox_revision, gen_random_uuid() as source_session_id,
  gen_random_uuid() as source_job_id, gen_random_uuid() as source_run_id,
  :'excluded_run_id'::uuid as excluded_run_id, :'input_commit_sha' as input_commit_sha,
  :'input_tree_sha' as input_tree_sha, :'output_commit_sha' as output_commit_sha, :'output_tree_sha' as output_tree_sha,
  nullif(:'output_patch','') as output_patch, nullif(:'output_patch_sha256','') as output_patch_sha256;

insert into public.factory_definition_revisions (
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
)
select config.id, scope.workspace_id, scope.factory_id, 1, config.body, config.digest, scope.owner_id
from browser_comparison_scope scope
cross join (values
  (:'source_definition_id'::uuid, :'source_definition_json', :'source_definition_digest'),
  (:'candidate_definition_id'::uuid, :'candidate_definition_json', :'candidate_definition_digest')
) config(id, body, digest);

insert into public.sessions (
  id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id
)
select source_session_id, workspace_id, factory_id, 80, 'Synthetic benchmark source', pipeline_id, stage_id,
  'pinned', definition_id
from browser_comparison_scope;

insert into public.agent_jobs (
  id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count, finished_at
)
select source_job_id, workspace_id, source_session_id, stage_id, stage_slug, 'manual_run', 'success', 1,
  clock_timestamp()
from browser_comparison_scope;

insert into public.agent_runs (
  id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type,
  model_provider, model_name, status, attempt_count, finished_at
)
select source_run_id, workspace_id, source_session_id, source_job_id, stage_id, stage_slug, 'project',
  'codex', 'gpt-4.1-2025-04-14', 'success', 1, clock_timestamp()
from browser_comparison_scope;

create temporary table browser_comparison_tasks as
select revision.* from browser_comparison_scope scope
cross join lateral (values
  (scope.source_run_id, 'Verify invoice reconciliation', 'eligible', null::text),
  (scope.excluded_run_id, 'Verify notification recovery', 'ineligible', 'The original notification inputs were not retained.')
) task(source_run_id, name, eligibility, reason)
cross join lateral public.create_factory_benchmark_task(
  scope.workspace_id, scope.factory_id, scope.owner_id, task.source_run_id, task.name,
  'Preserve the saved acceptance criteria.', '{}', task.eligibility, task.reason
) revision;

insert into public.factory_benchmark_task_inputs (
  task_id, workspace_id, factory_id, source_run_id, source_session_id, source_job_id, source_attempt_count,
  definition_revision_id, repository_id, checkout_sha
)
select task.task_id, scope.workspace_id, scope.factory_id, scope.source_run_id, scope.source_session_id,
  scope.source_job_id, 1, scope.definition_id, scope.repository_id, scope.input_commit_sha
from browser_comparison_scope scope cross join browser_comparison_tasks task
where task.replay_eligibility = 'eligible';

create temporary table browser_comparison_suite as
select suite.* from browser_comparison_scope scope
cross join lateral public.save_factory_benchmark_suite_revision(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'Invoice benchmark snapshot', 'regression',
  p_task_revision_ids => array(select id from browser_comparison_tasks)
) suite;

create temporary table browser_comparison_policy as
select policy.* from browser_comparison_scope scope
cross join lateral public.publish_factory_benchmark_replay_fixture(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'tool_read', repeat('f',64), '{"answer":"frozen"}'
) fixture
cross join lateral public.publish_factory_benchmark_replay_policy(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'blocked'
) base
cross join lateral public.publish_factory_benchmark_replay_policy(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'recorded_fixtures', base.id, array[fixture.id]
) policy;

create temporary table browser_comparison_scorer as
select scorer.* from browser_comparison_scope scope
cross join lateral public.create_factory_scorer(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'Invoice accuracy', 'invoice-accuracy',
  '{"schemaVersion":1,"rubric":"Verify saved totals","requiredEvidence":["artifact"],"scoring":{"kind":"boolean","passValue":true}}'
) scorer;

insert into public.workspace_vercel_sandbox_connections (
  workspace_id, connection_revision, encrypted_token, team_id, project_id
)
select workspace_id, sandbox_revision, 'synthetic-local-token', 'team_benchmark_results', 'prj_benchmark_results'
from browser_comparison_scope;

create temporary table browser_comparison_judge as
select judge.id from browser_comparison_scope scope
cross join lateral public.configure_factory_judge_profile(
  scope.workspace_id, scope.owner_id, 0, 'openai/gpt-example', 'openai', false, false,
  'v2.' || repeat('a', 16) || '.synthetic.' || repeat('b', 22)
) judge;

create temporary table browser_comparison_artifact(path text, trial_id uuid, run_id uuid);

do $$
declare
  scope browser_comparison_scope := (select scope from browser_comparison_scope scope);
  suite browser_comparison_suite := (select suite from browser_comparison_suite suite);
  policy browser_comparison_policy := (select policy from browser_comparison_policy policy);
  scorer browser_comparison_scorer := (select scorer from browser_comparison_scorer scorer);
  selected_trial public.factory_benchmark_trials;
  claim record;
  step text;
  path text;
  upload_id uuid;
  fixture_operation_id uuid := gen_random_uuid();
begin
  perform public.freeze_factory_benchmark_experiment_with_evaluation(
    scope.workspace_id, scope.factory_id, scope.owner_id, scope.experiment_id, suite.id, policy.id,
    (select jsonb_agg(jsonb_build_object(
      'definitionRevisionId', revision.id, 'definitionDigest', revision.canonical_digest,
      'harness', revision.definition_json::jsonb#>>'{agent,provider}',
      'model', revision.definition_json::jsonb#>>'{agent,model}',
      'sandboxProvider', 'vercel', 'workerRuntime', 'node'
    )) from public.factory_definition_revisions revision
      where (revision.workspace_id, revision.factory_id) = (scope.workspace_id, scope.factory_id)),
    20, 31, 60000, jsonb_build_object('scorerRevisionIds', array[scorer.id], 'budgetLimitUsd', 1)
  );
  perform public.configure_factory_benchmark_schedule(
    scope.workspace_id, scope.factory_id, scope.experiment_id, scope.owner_id,
    'recorded-fixture-v1', scope.sandbox_revision,
    (select jsonb_build_array(jsonb_build_object('taskRevisionId', task.id, 'fixtureKey', repeat('f',64)))
      from browser_comparison_tasks task where task.replay_eligibility = 'eligible'),
    0.1, 0.1, 2, 1, 5
  );
  foreach step in array array['success','fail','timeout','cancel'] loop
    if public.reconcile_factory_benchmark_schedules(10) <> 1 then
      raise exception 'Expected one isolated benchmark admission for %.', step;
    end if;
    select trial.* into strict selected_trial
    from public.factory_benchmark_trials trial
    join public.factory_benchmark_schedule_trials scheduled on scheduled.trial_id = trial.id
    where (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id) =
      (scope.workspace_id, scope.factory_id, scope.experiment_id) and trial.status = 'queued';
    if step = 'cancel' then
      if not public.cancel_factory_benchmark_trial(
        scope.workspace_id, scope.factory_id, scope.owner_id, selected_trial.id, selected_trial.run_id
      ) then raise exception 'The fixture trial could not be canceled.'; end if;
      continue;
    end if;
    select * into strict claim from public.claim_next_agent_job(true, 4);
    if claim.id is distinct from selected_trial.job_id then
      raise exception 'The disposable queue contains unexpected runnable work.';
    end if;
    selected_trial := public.start_factory_benchmark_trial(selected_trial.job_id, 1);
    if selected_trial.id is null then raise exception 'The fixture trial was not started.'; end if;
    if step = 'success' then
      perform public.record_session_run_usage(
        selected_trial.job_id, 1, selected_trial.run_id, 3, 5, 'measured', 0.2, 'measured', null, false
      );
      perform public.open_factory_benchmark_replay_execution(
        scope.workspace_id, scope.factory_id, scope.owner_id, selected_trial.replay_execution_id,
        selected_trial.task_revision_id, policy.id, policy.policy_digest, repeat('d',64)
      );
      perform public.record_factory_benchmark_replay_operation(
        scope.workspace_id, scope.factory_id, selected_trial.replay_execution_id,
        fixture_operation_id, 'tool_read', selected_trial.fixture_key
      );
      path := scope.workspace_id::text || '/benchmark/' || selected_trial.id::text || '/'
        || selected_trial.run_id::text || '/' || repeat('e',64) || '.bundle';
      upload_id := public.begin_workspace_resource_operation(
        scope.workspace_id, 'upload', '', path, 'session-source-checkpoints', clock_timestamp() + interval '5 minutes'
      );
      -- Synthetic storage receipt and exact terminal results. No worker, hosted
      -- sandbox, retained source bytes or provider credentials are involved.
      insert into storage.objects(bucket_id, name, metadata)
      values ('session-source-checkpoints', path, '{"mimetype":"application/octet-stream","size":8}');
      insert into browser_comparison_artifact values (path, selected_trial.id, selected_trial.run_id);
      if scope.output_patch is not null then
        if not public.stage_factory_benchmark_trial_diff(
          selected_trial.id, selected_trial.job_id, 1, selected_trial.run_id,
          scope.input_commit_sha, scope.input_tree_sha, scope.output_commit_sha, scope.output_tree_sha,
          scope.output_patch, scope.output_patch_sha256
        ) then raise exception 'Could not stage the exact fixture diff.'; end if;
        for event_number in 1..35 loop
          if not public.append_agent_run_event(
            selected_trial.job_id, selected_trial.run_id, 1, event_number, 'text',
            jsonb_build_object('text', 'Recorded invoice processing step ' || event_number ||
              case when event_number = 35 then ' API_KEY=synthetic-private-fixture-value' else '' end),
            false
          ) then raise exception 'Could not append the fixture transcript.'; end if;
        end loop;
      end if;
      if not public.finish_factory_benchmark_trial(
        selected_trial.id, selected_trial.job_id, 1, selected_trial.run_id, jsonb_build_object(
          'restorationReceiptSha256', repeat('d',64), 'inputBundleSha256', repeat('c',64),
          'inputCommitSha', scope.input_commit_sha, 'inputTreeSha', scope.input_tree_sha,
          'outputCommitSha', scope.output_commit_sha, 'outputTreeSha', scope.output_tree_sha,
          'fixtureOperationId', fixture_operation_id, 'artifactMarkdown', '# Saved invoice result',
          'checkpointBundleSha256', repeat('e',64), 'checkpointStoragePath', path,
          'checkpointUploadOperationId', upload_id, 'runtime', 'node',
          'validation', jsonb_build_object('version',1,'key','recorded-fixture-output','status','passed',
            'commitSha',scope.output_commit_sha,'treeSha',scope.output_tree_sha,'outputSha256',repeat('f',64))
        )
      ) then raise exception 'Could not retain the successful fixture result.'; end if;
    elsif step = 'timeout' then
      -- Advance the started fixture to its deadline and use worker retirement.
      update public.factory_benchmark_trials set deadline_at = clock_timestamp()
      where id = selected_trial.id and workspace_id = scope.workspace_id;
      if public.fail_deadline_session_job_attempt(
        selected_trial.job_id, 1, 'Worker attempt exceeded its 60000ms deadline.', selected_trial.run_id
      ) <> 'error' then raise exception 'Could not retire the expired running fixture.'; end if;
    else
      if not public.fail_factory_benchmark_trial(
        selected_trial.id, selected_trial.job_id, 1, selected_trial.run_id, 'candidate_failed'
      ) then raise exception 'Could not finish the failed fixture result.'; end if;
    end if;
  end loop;

  if public.reconcile_factory_benchmark_evaluations(10) <> 1 then
    raise exception 'Expected one exact benchmark evaluation.';
  end if;
end;
$$;

do $$
declare
  scope browser_comparison_scope := (select scope from browser_comparison_scope scope);
  claim record;
  receipt jsonb;
begin
  select * into strict claim from public.claim_factory_judge_job();
  if (claim.workspace_id, claim.factory_id) is distinct from (scope.workspace_id, scope.factory_id) then
    raise exception 'The disposable judge queue contains unrelated runnable work.';
  end if;
  perform public.prepare_factory_judge_invocation(
    claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id, claim.lease_id
  );
  receipt := public.begin_factory_judge_invocation(
    claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id, claim.lease_id,
    (select id from browser_comparison_judge), repeat('a',64), 'node'
  );
  if receipt->>'status' is distinct from 'authorized' then
    raise exception 'The synthetic judge attempt was not authorized: %.', receipt->>'status';
  end if;
  if not public.finish_factory_judge_invocation(
    claim.workspace_id, claim.factory_id, claim.job_id, claim.attempt_id, claim.lease_id,
    'completed', jsonb_build_object('schemaVersion',1,'status','pass',
      'score',jsonb_build_object('kind','boolean','value',true),
      'evidence',(select sample.evidence from public.factory_scorer_sample_receipts sample
        where sample.id = claim.sample_receipt_id)),
    p_provider_model => 'openai/gpt-example', p_cost_usd => 0.3, p_cost_provenance => 'estimated',
    p_estimation_revision => 'synthetic-result-cost-v1',
    p_explanation => 'The isolated invoice output preserves the saved total.'
  ) then raise exception 'Could not retain the synthetic score.'; end if;
end;
$$;

select jsonb_build_object(
  'suiteId', suite.suite_id, 'suiteRevisionId', suite.id, 'scorerRevisionId', scorer.id,
  'taskRevisionIds', array(select id from browser_comparison_tasks order by id),
  'storagePath', artifact.path, 'successfulTrialId', artifact.trial_id, 'successfulRunId', artifact.run_id
)
from browser_comparison_suite suite cross join browser_comparison_scorer scorer
cross join browser_comparison_artifact artifact;

commit;
