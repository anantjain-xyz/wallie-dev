begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.live_id(slot integer) returns uuid language sql immutable as $$
  select ('73500000-0000-4000-9000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values (pg_temp.live_id(1), 'benchmark-live-owner@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.live_id(11), 'benchmark-live-test', 'Live benchmark test');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.live_id(21), pg_temp.live_id(11), pg_temp.live_id(1), 'human', 'owner');

create temp table live_scope as
select workspace_id, id as factory_id, pg_temp.live_id(1) as owner_id
from public.factories where workspace_id = pg_temp.live_id(11) and is_default;

insert into public.pipelines(id, workspace_id, factory_id, name)
select pg_temp.live_id(40), workspace_id, factory_id, 'Live replay pipeline' from live_scope;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name, prompt_template_md)
values (pg_temp.live_id(41), pg_temp.live_id(11), pg_temp.live_id(40), 1, 'review', 'Review', 'Review the task.');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.live_id(35), pg_temp.live_id(11), 73500001, 'https://example.test/install', 7350,
  'Organization', 'Live fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name,
  private, html_url, default_branch)
select pg_temp.live_id(42), workspace_id, factory_id, pg_temp.live_id(35), 73500002,
  'live-fixture', 'fixture/live', true, 'https://example.test/fixture', 'main' from live_scope;
with definition as (
  select scope.*, jsonb_build_object(
    'schemaVersion', 1, 'kind', 'serial', 'pipelineId', pg_temp.live_id(40), 'repositoryId', pg_temp.live_id(42),
    'sandboxProvider', 'vercel', 'agent', jsonb_build_object(
      'provider','codex','model','gpt-4.1-2025-04-14','concurrencyLimit',2),
    'stages', jsonb_build_array(jsonb_build_object('id', pg_temp.live_id(41), 'slug','review'))
  )::text as body from live_scope scope
)
insert into public.factory_definition_revisions(id, workspace_id, factory_id, schema_version, definition_json,
  canonical_digest, created_by)
select pg_temp.live_id(43), workspace_id, factory_id, 1, body,
  encode(sha256(convert_to(body, 'UTF8')), 'hex'), owner_id from definition;

insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  factory_definition_provenance, factory_definition_revision_id)
select pg_temp.live_id(44), workspace_id, factory_id, 1, 'Synthetic replay source', pg_temp.live_id(40),
  pg_temp.live_id(41), 'pinned', pg_temp.live_id(43) from live_scope;
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, stage_slug, trigger_type, status, attempt_count, finished_at)
values (pg_temp.live_id(45), pg_temp.live_id(11), pg_temp.live_id(44), pg_temp.live_id(41),
  'review', 'manual_run', 'success', 1, clock_timestamp());
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, stage_slug, run_type,
  model_provider, model_name, status, attempt_count, finished_at)
values (pg_temp.live_id(46), pg_temp.live_id(11), pg_temp.live_id(44), pg_temp.live_id(45), pg_temp.live_id(41),
  'review', 'project', 'codex', 'gpt-4.1-2025-04-14', 'success', 1, clock_timestamp());
create temp table live_task as
select revision.* from live_scope scope
cross join lateral public.create_factory_benchmark_task(scope.workspace_id, scope.factory_id, scope.owner_id,
  pg_temp.live_id(46), 'Synthetic live replay', 'Keep the frozen acceptance criteria.', '{}', 'eligible') revision;
insert into public.factory_benchmark_task_inputs(task_id, workspace_id, factory_id, source_run_id, source_session_id,
  source_job_id, source_attempt_count, definition_revision_id, repository_id, checkout_sha)
select task_id, workspace_id, factory_id, pg_temp.live_id(46), pg_temp.live_id(44), pg_temp.live_id(45), 1,
  pg_temp.live_id(43), pg_temp.live_id(42), repeat('a', 40) from live_task;
create temp table live_suite as
select suite.* from live_scope scope cross join live_task task
cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id, scope.factory_id,
  scope.owner_id, 'Live replay suite', 'regression', p_task_revision_ids => array[task.id]) suite;
create temp table live_policy as
select policy.* from live_scope scope
cross join lateral public.publish_factory_benchmark_replay_policy(scope.workspace_id, scope.factory_id,
  scope.owner_id, 'blocked') policy;

insert into public.workspace_vercel_sandbox_connections(workspace_id, connection_revision, encrypted_token, team_id, project_id)
values (pg_temp.live_id(11), pg_temp.live_id(50), 'synthetic-encrypted-token', 'team_live', 'prj_live');
insert into public.sandbox_capability_checks(id, workspace_id, github_repository_id, agent_provider, agent_model,
  sandbox_provider, sandbox_id, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id, status, capabilities)
select pg_temp.live_id(config.slot), pg_temp.live_id(11), pg_temp.live_id(42), config.harness, config.model,
  'vercel', 'sbx_live_capability', pg_temp.live_id(50), 'team_live', 'prj_live', 'success',
  (select jsonb_object_agg(key, jsonb_build_object('ok', true, 'detail', config.cli))
    from unnest(array['agentCli','git','node','packageManager','playwrightPackage','chromium',
      'screenshotSmoke','codexExternalSandbox']) capability(key))
from (values (51, 'codex', 'gpt-4.1-2025-04-14', 'codex-cli 0.88.0'),
  (52, 'opencode', 'openai/gpt-4.1-2025-04-14', '1.2.27')) config(slot, harness, model, cli);

create temp table live_connection as
select public.configure_factory_benchmark_inference_connection(scope.workspace_id, scope.factory_id, scope.owner_id,
  'synthetic-encrypted-key', jsonb_build_object(
    'image', 'vcr.vercel.com/example/managed@sha256:' || repeat('d', 64),
    'codex', jsonb_build_object('cliVersion','0.88.0','cliDigest',repeat('c',64)),
    'opencode', jsonb_build_object('cliVersion','1.2.27','cliDigest',repeat('e',64)))) as receipt
from live_scope scope;
select ok(not (receipt ? 'encryptedApiKey'), 'provisioning does not return the configured key') from live_connection;
select ok(
  not has_function_privilege('authenticated','public.begin_factory_benchmark_inference_request(text,text,text,text)','EXECUTE')
  and not has_table_privilege('service_role','internal.factory_benchmark_inference_connections','SELECT'),
  'the inference key is reachable only through authorized service operations');

create function pg_temp.freeze_live(slot integer, runtime text) returns jsonb language sql as $$
  select public.freeze_factory_benchmark_experiment_axes(scope.workspace_id, scope.factory_id, scope.owner_id,
    pg_temp.live_id(slot), suite.id, policy.id,
    (select jsonb_agg(jsonb_build_object('definitionRevisionId', pg_temp.live_id(43),
      'qualificationId', pg_temp.live_id(qualification), 'workerRuntime', runtime) order by qualification)
     from (values (51),(52)) checked(qualification)), 2, 211, 120000)
  from live_scope scope cross join live_suite suite cross join live_policy policy
$$;
create function pg_temp.configure_live(slot integer, reserve numeric default 0.50,
  connection uuid default null) returns jsonb language sql as $$
  select public.configure_factory_benchmark_live_schedule(scope.workspace_id, scope.factory_id, pg_temp.live_id(slot),
    scope.owner_id, coalesce(connection, (key.receipt->>'id')::uuid), reserve, 0, 1.00, 3, 4)
  from live_scope scope cross join live_connection key
$$;
create function pg_temp.live_snapshot() returns jsonb language sql as $$
  select public.read_factory_benchmark_schedule(scope.workspace_id, scope.factory_id, pg_temp.live_id(80), scope.owner_id)
  from live_scope scope
$$;

select is(pg_temp.freeze_live(80,'workerd')->>'expectedTrialCount', '4', 'a pinned managed runner freezes both harnesses');
select is(pg_temp.freeze_live(81,'node')->>'expectedTrialCount', '4', 'existing Node axes can still be frozen');
select throws_ok($$select pg_temp.configure_live(81)$$, 'PT422', null, 'a live schedule rejects Node-only axes');
select throws_ok($$select pg_temp.configure_live(80, 0)$$, '22023', null, 'execution requires a positive reserve');
select throws_ok($$select pg_temp.configure_live(80, connection => pg_temp.live_id(700))$$,
  'PT422', null, 'the schedule rejects an unavailable connection');
select is(pg_temp.configure_live(80)->>'runnerRevision', 'openai-responses-v1', 'the schedule accepts the exact live pin');
update public.agent_jobs set scheduled_at = clock_timestamp() + interval '1 hour' where status = 'queued';
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'one reconciliation admits one eligible cell');
select is(public.reconcile_factory_benchmark_schedules(10), 1, 'one more cell fits the shared execution reserve');
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'the aggregate reserve stops further admission');
select is((pg_temp.live_snapshot()->>'reservedUsd')::numeric, 1.00::numeric, 'both admissions reserve before claim');
select is((select count(*) from public.claim_next_agent_job(true, 3, 'node')), 0::bigint,
  'the Node queue cannot claim Workerd trials');

create temp table live_claims(seq integer primary key, job_id uuid not null, attempt_count integer not null, workflow_id text not null);
insert into live_claims
select 1, job_id, attempt_count, workflow_id from public.claim_next_worker_dispatch(true, 10, 3, 120000);

create function pg_temp.start_live(seq integer, runtime text, attempt integer default 1) returns jsonb language sql as $$
  select public.start_factory_benchmark_live_trial(claim.job_id, attempt,
    clock_timestamp() + interval '2 minutes', runtime)
  from live_claims claim where claim.seq = start_live.seq
$$;
select is(pg_temp.start_live(1,'workerd'), null::jsonb, 'the job cannot start before its workflow execution begins');
select ok(public.begin_worker_dispatch(job_id, attempt_count, workflow_id), 'the exact Workerd dispatch starts')
from live_claims where seq = 1;
select is(pg_temp.start_live(1,'node'), null::jsonb, 'a started Workerd dispatch cannot substitute a Node runner');
select is(pg_temp.start_live(1,'workerd',2), null::jsonb, 'another attempt cannot use this dispatch');
select is((public.start_factory_benchmark_trial(job_id,attempt_count)).run_id, null::uuid,
  'the recorded runner RPC cannot start a live trial') from live_claims where seq = 1;

create temp table live_trials(seq integer primary key, trial_id uuid not null, job_id uuid not null, run_id uuid not null,
  attempt_count integer not null, signed_id text not null, nonce text not null, claim jsonb not null);
with started as materialized (select pg_temp.start_live(1,'workerd') as receipt)
insert into live_trials
select 1, (receipt#>>'{identity,trialId}')::uuid, (receipt#>>'{identity,jobId}')::uuid, (receipt#>>'{identity,runId}')::uuid,
  (receipt#>>'{identity,attemptCount}')::integer, 'sbx_signed_live_one', repeat('1',64), receipt from started;
select is((select claim->>'workerRuntime' from live_trials), 'workerd', 'the exact claim returns the frozen runtime');
select is((select claim#>>'{candidate,upstreamModel}' from live_trials), 'gpt-4.1-2025-04-14',
  'the claim returns the same dated provider snapshot for both native aliases');

create function pg_temp.arm_live(seq integer, attempt integer default 1) returns boolean language sql as $$
  select public.arm_factory_benchmark_live_sandbox_binding(trial_id, job_id, run_id, attempt, nonce,
    clock_timestamp() + interval '20 seconds') from live_trials trial where trial.seq = arm_live.seq
$$;
create function pg_temp.bind_live(seq integer, team text default 'team_live', project text default 'prj_live',
  nonce_override text default null, signed_override text default null) returns boolean language sql as $$
  select public.consume_factory_benchmark_live_sandbox_binding(coalesce(nonce_override, trial.nonce), team, project,
    coalesce(signed_override, trial.signed_id)) from live_trials trial where trial.seq = bind_live.seq
$$;
create function pg_temp.enable_live(seq integer, restore_digest text default repeat('a',64)) returns boolean language sql as $$
  select public.enable_factory_benchmark_live_inference(trial_id,job_id,run_id,attempt_count,signed_id,
    repeat('b',64),repeat('c',64),restore_digest) from live_trials trial where trial.seq = enable_live.seq
$$;
create function pg_temp.request_live(seq integer, team text default 'team_live', project text default 'prj_live',
  signed_override text default null) returns jsonb language sql as $$
  select public.begin_factory_benchmark_inference_request(team,project,coalesce(signed_override,signed_id),repeat('d',64))
  from live_trials trial where trial.seq = request_live.seq
$$;
create function pg_temp.open_live(seq integer) returns uuid language sql as $$
  select (public.open_factory_benchmark_replay_execution(t.workspace_id,t.factory_id,t.actor_user_id,
    t.id,t.task_revision_id,t.policy_revision_id,t.policy_digest,repeat('a',64))).id
  from live_trials trial join public.factory_benchmark_trials t on t.id = trial.trial_id where trial.seq = open_live.seq
$$;

select is(pg_temp.request_live(1), null::jsonb, 'inference is unavailable before the canary is armed');
select is(pg_temp.arm_live(1,2), false, 'a stale attempt cannot arm the canary');
select ok(pg_temp.arm_live(1), 'the current attempt arms a single nonce');
select is(pg_temp.arm_live(1), false, 'the same trial cannot arm a second binding');
select is(pg_temp.bind_live(1, team => 'team_foreign'), false, 'the wrong team cannot consume a valid nonce');
select is(pg_temp.bind_live(1, project => 'prj_foreign'), false, 'the wrong project cannot consume a valid nonce');
select is(pg_temp.bind_live(1, nonce_override => repeat('f',64)), false, 'an unrelated nonce cannot bind a sandbox');
select ok(pg_temp.bind_live(1), 'the signed sandbox identity can redeem the exact nonce');
select is(pg_temp.bind_live(1, signed_override => 'sbx_substituted'), false, 'a redeemed nonce cannot bind a second sandbox');
select is(public.read_factory_benchmark_live_sandbox_binding(trial_id,job_id,run_id,attempt_count)->>'signedSandboxId',
  signed_id, 'the worker reads back the exact signed ID') from live_trials where seq = 1;
select is(pg_temp.request_live(1), null::jsonb, 'a bound sandbox has no inference permit until enabled');
select is(pg_temp.enable_live(1), false, 'a permit requires the exact restored source receipt');
select is(pg_temp.open_live(1), (select trial_id from live_trials where seq = 1), 'the exact blocked replay opens');
select is(pg_temp.enable_live(1,repeat('f',64)), false, 'an unrelated restoration receipt cannot enable inference');
select ok(pg_temp.enable_live(1), 'a matching restored replay and signed sandbox enable inference once');
select is(pg_temp.request_live(1, team => 'team_foreign'), null::jsonb, 'a different team cannot authorize inference');
select is(pg_temp.request_live(1, project => 'prj_foreign'), null::jsonb, 'a different project cannot authorize inference');
select is(pg_temp.request_live(1, signed_override => 'sbx_substituted'), null::jsonb, 'a different sandbox cannot authorize inference');

create temp table live_requests(key text primary key, receipt jsonb not null);
insert into live_requests values ('completed', pg_temp.request_live(1)),
  ('late_before_adoption', pg_temp.request_live(1)), ('late_after_adoption', pg_temp.request_live(1));
select is(receipt->>'model', 'gpt-4.1-2025-04-14', 'the relay gets the exact provider model')
from live_requests where key = 'completed';
select ok(public.is_factory_benchmark_inference_request_open((receipt->>'requestId')::uuid),
  'an active request can check its current authorization') from live_requests where key = 'completed';
select is(public.finish_factory_benchmark_inference_request((receipt->>'requestId')::uuid,'completed','gpt-5-2025-08-07',40,12),
  false, 'another upstream model cannot supply successful usage') from live_requests where key = 'completed';
select ok(public.finish_factory_benchmark_inference_request((receipt->>'requestId')::uuid,'completed','gpt-4.1-2025-04-14',40,12),
  'the exact upstream model records observed usage') from live_requests where key = 'completed';

create temp table live_closed as
select trial.*, public.close_factory_benchmark_live_inference(trial_id,job_id,run_id,attempt_count) as inference
from live_trials trial where seq = 1;
select is(inference->>'observedModel', 'gpt-4.1-2025-04-14', 'close returns the observed provider snapshot') from live_closed;
select is(public.close_factory_benchmark_live_inference(trial_id,job_id,run_id,attempt_count), inference,
  'closing twice returns the same immutable receipt') from live_closed;
select is(pg_temp.request_live(1), null::jsonb, 'closed inference cannot authorize new requests');
select results_eq(
  $$select request_count, unavailable_usage_count, input_tokens, output_tokens
    from internal.factory_benchmark_inference_receipts where trial_id = (select trial_id from live_closed)$$,
  $$values (3,2,40::bigint,12::bigint)$$,
  'the durable receipt preserves observed tokens alongside incomplete usage without claiming completeness');
select is(public.finish_factory_benchmark_inference_request((receipt->>'requestId')::uuid,'completed',
  'gpt-4.1-2025-04-14',8,3), false, 'late usage never permits completed response delivery')
from live_requests where key = 'late_before_adoption';
select is(public.finish_factory_benchmark_inference_request((receipt->>'requestId')::uuid,'completed',
  'gpt-4.1-2025-04-14',8,3), false, 'an identical late retry remains closed')
from live_requests where key = 'late_before_adoption';
select is(public.finish_factory_benchmark_inference_request((receipt->>'requestId')::uuid,'unavailable',
  'gpt-4.1-2025-04-14',90,99), false, 'a contradictory late retry cannot replace known usage')
from live_requests where key = 'late_before_adoption';
select ok(public.finish_factory_benchmark_inference_request((receipt->>'requestId')::uuid,'failed',
  'gpt-4.1-2025-04-14',8,3), 'a late accounting retry acknowledges already recorded usage')
from live_requests where key = 'late_before_adoption';
select results_eq(
  $$select status,observed_model,input_tokens,output_tokens from internal.factory_benchmark_inference_requests
    where id = (select (receipt->>'requestId')::uuid from live_requests where key = 'late_before_adoption')$$,
  $$values ('unavailable'::text,'gpt-4.1-2025-04-14'::text,8,3)$$,
  'the closed request retains the late exact model and tokens');
select results_eq(
  $$select request_count,unavailable_usage_count,input_tokens,output_tokens
    from internal.factory_benchmark_inference_receipts where trial_id = (select trial_id from live_closed)$$,
  $$values (3,1,48::bigint,15::bigint)$$,
  'the retained receipt records the late tokens exactly once');

create temp table live_checkpoint as
select closed.*, (claim#>>'{identity,workspaceId}')::uuid as workspace_id,
  (claim#>>'{identity,workspaceId}') || '/benchmark/' || trial_id::text || '/' || run_id::text
    || '/' || repeat('e',64) || '.bundle' as path from live_closed closed;
create temp table live_upload as
select checkpoint.*, public.begin_workspace_resource_operation(workspace_id,'upload','',path,
  'session-source-checkpoints',clock_timestamp() + interval '5 minutes') as operation_id
from live_checkpoint checkpoint;
create temp table live_output as
select upload.*, jsonb_build_object(
  'input',jsonb_build_object('restorationReceiptSha256',repeat('a',64),'replayPromptSha256',repeat('b',64),
    'inputBundleSha256',repeat('c',64),'commitSha',repeat('a',40),'treeSha',repeat('b',40),'rendererRevision',1),
  'output',jsonb_build_object('artifactMarkdown','Changed the synthetic fixture.', 'commitSha',repeat('c',40),
    'treeSha',repeat('d',40),'validation',jsonb_build_object('version',1,'key','qualified-replay-source',
      'status','passed','commitSha',repeat('c',40),'treeSha',repeat('d',40)),
    'checkpoint',jsonb_build_object('kind','bundle','sha256',repeat('e',64),'storagePath',path,'uploadOperationId',operation_id)),
  'inferenceReceiptId',inference->>'inferenceReceiptId') as payload
from live_upload upload;

create function pg_temp.finish_live(patch jsonb default '{}'::jsonb) returns boolean language sql as $$
  select public.finish_factory_benchmark_live_trial(trial_id,job_id,attempt_count,run_id,payload || patch) from live_output
$$;
select throws_ok($$select pg_temp.finish_live()$$, '23514', null, 'the private checkpoint must exist before adoption');
insert into storage.objects(bucket_id,name,metadata)
select 'session-source-checkpoints',path,'{"mimetype":"application/octet-stream","size":8}'::jsonb from live_checkpoint;
select throws_ok($$select pg_temp.finish_live(jsonb_build_object('inferenceReceiptId',pg_temp.live_id(900)))$$,
  '23514', null, 'a foreign inference receipt cannot enter the result');
select throws_ok($$select pg_temp.finish_live(jsonb_build_object('output',
  jsonb_set(payload->'output','{artifactMarkdown}',to_jsonb(repeat('é',131073))))) from live_output$$,
  '22023', null, 'the artifact limit applies to UTF-8 bytes');
select ok(pg_temp.finish_live(), 'the exact receipt and retained checkpoint finish the live trial');
select ok(pg_temp.finish_live(), 'an identical result can be safely retried');
select is(pg_temp.finish_live(jsonb_build_object('output',
  jsonb_set(payload->'output','{artifactMarkdown}','"Changed after finish"'::jsonb))),false,
  'a finish retry cannot replace the retained result') from live_output;
select is((select result.artifact_markdown from public.factory_benchmark_trial_results result
  join live_output output using (trial_id)), 'Changed the synthetic fixture.', 'the private result retains the submitted artifact');
select is((select result.fixture_revision_id from public.factory_benchmark_trial_results result
  join live_output output using (trial_id)), null::uuid, 'live evidence cannot acquire recorded fixture provenance');
select is((select token_provenance from public.agent_runs run join live_output output on output.run_id = run.id),
  'unavailable', 'public run telemetry marks partial provider usage unavailable as an aggregate');
select is(public.finish_factory_benchmark_inference_request((receipt->>'requestId')::uuid,'completed',
  'gpt-4.1-2025-04-14',2,5), false, 'the exact late provider result cannot reopen a finished trial')
from live_requests where key = 'late_after_adoption';
select results_eq(
  $$select request_count,unavailable_usage_count,input_tokens,output_tokens
    from internal.factory_benchmark_inference_receipts where trial_id = (select trial_id from live_closed)$$,
  $$values (3,0,50::bigint,20::bigint)$$,
  'late usage after adoption completes the same retained receipt');
select results_eq(
  $$select token_provenance,cost_provenance,input_tokens,output_tokens
    from public.agent_runs run join live_output output on output.run_id = run.id$$,
  $$values ('measured'::text,'unavailable'::text,50::bigint,20::bigint)$$,
  'complete late token usage corrects the exact run while dollar cost stays unavailable');
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'unknown cost cannot reopen spent admission headroom');
select is((pg_temp.live_snapshot()->>'executionSpentUsd')::numeric, 0::numeric,
  'observed tokens do not fabricate an actual dollar amount');
select is((pg_temp.live_snapshot()->>'unavailableExecutionCount')::integer, 1, 'unavailable cost is explicitly counted');
select is((pg_temp.live_snapshot()->>'reservedUsd')::numeric, 1.00::numeric,
  'the first trial keeps its reserve while actual execution cost is unavailable');

insert into live_claims
select 2,job_id,attempt_count,workflow_id from public.claim_next_worker_dispatch(true,10,3,120000);
select ok(public.begin_worker_dispatch(job_id,attempt_count,workflow_id), 'the second Workerd job starts')
from live_claims where seq = 2;
with started as materialized (select pg_temp.start_live(2,'workerd') as receipt)
insert into live_trials
select 2,(receipt#>>'{identity,trialId}')::uuid,(receipt#>>'{identity,jobId}')::uuid,(receipt#>>'{identity,runId}')::uuid,
  (receipt#>>'{identity,attemptCount}')::integer,'sbx_signed_live_two',repeat('2',64),receipt from started;
select ok(pg_temp.arm_live(2), 'the independent trial can arm its own nonce');
select ok(pg_temp.bind_live(2), 'the second sandbox can redeem its own nonce');
select is(pg_temp.open_live(2), (select trial_id from live_trials where seq = 2), 'the second replay has its own restoration');
select ok(pg_temp.enable_live(2), 'the second trial gets an independent inference permit');
select is(public.fail_factory_benchmark_trial(trial_id,job_id,attempt_count + 1,run_id,'cli_pin_mismatch'),
  false, 'a stale attempt cannot persist a qualified failure classification') from live_trials where seq = 2;
create function pg_temp.test_live_diagnostic() returns text language plpgsql as $$
declare observed text;
begin
  begin
    perform public.fail_factory_benchmark_trial(trial_id,job_id,attempt_count,run_id,'cli_pin_mismatch')
    from live_trials where seq = 2;
    select trial.failure_code into observed from public.factory_benchmark_trials trial
    where trial.id = (select trial_id from live_trials where seq = 2);
    raise exception using errcode = 'QF001', message = 'Rollback diagnostic fixture to exercise cancellation next.';
  exception when sqlstate 'QF001' then
    return observed;
  end;
end;
$$;
select is(pg_temp.test_live_diagnostic(),'cli_pin_mismatch', 'the exact live attempt retains its safe diagnostic');
insert into live_requests values ('canceled',pg_temp.request_live(2));
select is(public.control_factory_benchmark_schedule(scope.workspace_id,scope.factory_id,pg_temp.live_id(80),
  scope.owner_id,'cancel')->>'state','canceled','cancel fences queued and running schedule work') from live_scope scope;
select is(pg_temp.request_live(2), null::jsonb, 'inference refuses new requests from the canceled sandbox');
select is(public.is_factory_benchmark_inference_request_open((receipt->>'requestId')::uuid),
  false, 'an in-flight relay stream loses authorization when canceled') from live_requests where key = 'canceled';
select ok(public.finish_factory_benchmark_inference_request((receipt->>'requestId')::uuid,'unavailable',null,8,3),
  'the relay can still record observed usage for a request interrupted by cancellation')
from live_requests where key = 'canceled';
select results_eq(
  $$select status,input_tokens,output_tokens from internal.factory_benchmark_inference_requests
    where id = (select (receipt->>'requestId')::uuid from live_requests where key = 'canceled')$$,
  $$values ('unavailable'::text,8,3)$$,
  'interrupted usage remains available in the durable request record');
select is(pg_temp.start_live(2,'workerd'), null::jsonb, 'the canceled dispatch cannot start another live attempt');
select is((select count(*) from public.claim_next_worker_dispatch(true,10,3,120000)),0::bigint,
  'the canceled schedule cannot issue additional workflow claims');
select is(public.reconcile_factory_benchmark_schedules(10), 0, 'cancellation is terminal for further admissions');

select * from finish();
rollback;
