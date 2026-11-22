begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
\ir fixtures/factory_benchmark_frontier.psql
\ir fixtures/factory_improvement_validation.psql

create function pg_temp.start_validation(
  p_key integer default 330, p_holdout text default 'holdout', p_reverse boolean default false,
  p_holdout_budget numeric default 20, p_actor uuid default pg_temp.live_id(1), p_scorer uuid default null,
  p_minimum_independent_tasks integer default 2, p_targeted text default 'targeted'
) returns jsonb language sql as $$
  select public.start_factory_improvement_validation(args.workspace_id, args.factory_id, p_actor, pg_temp.live_id(300),
    pg_temp.live_id(311), pg_temp.live_id(p_key), targeted.id, holdout.id, args.policy_id, coalesce(p_scorer, args.scorer_id),
    axes.value, axes.value, jsonb_set(args.execution, '{holdoutBudgetLimitUsd}', to_jsonb(p_holdout_budget)),
    jsonb_set(args.thresholds, '{minimumIndependentTasks}', to_jsonb(p_minimum_independent_tasks)))
  from validation_arguments args
  join validation_suites targeted on targeted.label = p_targeted
  join validation_suites holdout on holdout.label = p_holdout
  cross join lateral (select case when p_reverse then jsonb_build_array(args.axes->1, args.axes->0)
    else args.axes end) axes(value);
$$;
create function pg_temp.read_validation(p_actor uuid default pg_temp.live_id(1)) returns jsonb language sql stable as $$
  select public.get_factory_improvement_validation(args.workspace_id, args.factory_id, p_actor,
    pg_temp.live_id(300), pg_temp.live_id(311)) from validation_arguments args;
$$;
create function pg_temp.control_validation_experiment(p_split text, p_action text) returns jsonb language sql as $$
  select public.control_factory_benchmark_schedule(args.workspace_id, args.factory_id,
    (pg_temp.read_validation()->p_split->>'experimentId')::uuid, args.owner_id, p_action)
  from validation_arguments args;
$$;

select is(pg_temp.read_validation(), null::jsonb, 'the current compiled proposal starts with no validation');
select throws_ok($$select pg_temp.start_validation(p_actor => pg_temp.live_id(999))$$, '42501', null,
  'an unrelated caller cannot queue a validation');
select throws_ok($$select pg_temp.start_validation(p_reverse => true)$$, 'PT422', null,
  'the exact baseline and candidate pair must be ordered and match the proposal');
select throws_ok($$select pg_temp.start_validation(p_holdout => 'overlap')$$, 'PT422', null,
  'held-out tasks cannot duplicate a targeted source session');
select throws_ok($$select pg_temp.start_validation(p_holdout => 'produced')$$, 'PT422', null,
  'a held-out input already produced under the exact candidate digest is not blind');
select throws_ok($$select pg_temp.start_validation(p_key => 333, p_holdout => 'diagnosed')$$, 'PT422', null,
  'a session used in the original diagnosis cannot become held-out evidence');

insert into validation_suites(label, id)
select split.label, suite.id
from live_scope scope cross join (values
  ('larger-targeted', 'regression', array[1,2,5]), ('larger-holdout', 'holdout', array[3,4,5])
) split(label, purpose, ordinals)
cross join lateral public.save_factory_benchmark_suite_revision(scope.workspace_id, scope.factory_id,
  scope.owner_id, 'Improvement ' || split.label, split.purpose,
  p_task_revision_ids => array(select task.id from validation_source_tasks task
    where task.ordinal = any(split.ordinals) order by task.ordinal)) suite;
select throws_ok($$select pg_temp.start_validation(p_minimum_independent_tasks => 3, p_holdout => 'larger-holdout')$$,
  'PT422', 'Both frozen validation suites must meet the minimum independent task count.',
  'insufficient independent targeted tasks reject an otherwise large enough holdout');
select throws_ok($$select pg_temp.start_validation(p_minimum_independent_tasks => 3, p_targeted => 'larger-targeted')$$,
  'PT422', 'Both frozen validation suites must meet the minimum independent task count.',
  'insufficient independent holdout tasks reject an otherwise large enough targeted suite');
select ok(not exists (select 1 from internal.factory_improvement_validations where workspace_id = pg_temp.live_id(11))
  and not exists (select 1 from public.factory_benchmark_experiments where workspace_id = pg_temp.live_id(11))
  and not exists (select 1 from public.factory_benchmark_experiment_candidates where workspace_id = pg_temp.live_id(11))
  and not exists (select 1 from public.factory_benchmark_schedules where workspace_id = pg_temp.live_id(11)),
  'underpowered requests leave no validation, experiment, candidate arm, or schedule');

create temp table unsupported_validation_scorer as
select scorer.id from live_scope scope cross join lateral public.create_factory_scorer(
  scope.workspace_id, scope.factory_id, scope.owner_id, 'Unsupported benchmark evidence', 'unsupported-benchmark-evidence',
  '{"schemaVersion":1,"rubric":"Inspect the code diff.","requiredEvidence":["code_diff"],
    "scoring":{"kind":"boolean","passValue":true}}') scorer;
select throws_ok($$select pg_temp.start_validation(p_scorer => (select id from unsupported_validation_scorer))$$,
  'PT422', null, 'a scorer requiring evidence absent from M08 evaluations is rejected before scheduling');

select public.freeze_factory_benchmark_experiment_axes_with_evaluation(args.workspace_id, args.factory_id, args.owner_id,
  pg_temp.live_id(350), exposed.id, args.policy_id, args.axes, 1, 211, 120000,
  jsonb_build_object('scorerRevisionIds',jsonb_build_array(args.scorer_id),'budgetLimitUsd',20))
from validation_arguments args join validation_suites exposed on exposed.label = 'exposed';
select throws_ok($$select pg_temp.start_validation(p_holdout => 'exposed')$$, 'PT422', null,
  'a previously exposed candidate at the exact held-out sources cannot be rebound');
select throws_ok($$select pg_temp.start_validation(p_holdout_budget => 0)$$, '22023', null,
  'a bad second schedule rejects the paired validation');
select ok((select count(*) = 1 from public.factory_benchmark_experiments where workspace_id = pg_temp.live_id(11))
  and not exists (select 1 from public.factory_benchmark_schedules where workspace_id = pg_temp.live_id(11))
  and pg_temp.read_validation() is null, 'a later scheduling error rolls back both new experiments and their binding');

create function pg_temp.start_validation_sqlstate() returns text language plpgsql as $$
begin
  perform pg_temp.start_validation();
  return '00000';
exception when others then return sqlstate;
end;
$$;
savepoint before_withheld_diagnosis_start;
insert into public.session_retained_content_erasures(session_id,workspace_id,factory_id,archived_at,actor_member_id)
select pg_temp.live_id(2008), workspace_id, factory_id, statement_timestamp(), pg_temp.live_id(21) from live_scope;
select pg_temp.start_validation_sqlstate() as withheld_start \gset
rollback to savepoint before_withheld_diagnosis_start;
release savepoint before_withheld_diagnosis_start;
select is(:'withheld_start'::text, 'PT422', 'an erased diagnosis is rejected before either schedule can spend');

create temp table validation_start as select pg_temp.start_validation() as receipt;
select ok(receipt @> '{"validation":{"status":"inconclusive","targeted":{"status":"inconclusive","plannedPairs":2},
    "holdout":{"status":"inconclusive","plannedPairs":2}},"replay":false}'
  and receipt#>>'{validation,targeted,experimentId}' is distinct from receipt#>>'{validation,holdout,experimentId}',
  'the fresh receipt binds two exact frozen matrices and reports pending evidence')
from validation_start;
select ok((select count(*) = 4 and count(distinct candidate.definition_digest) = 2
  and bool_and(candidate.worker_runtime = 'workerd')
  from public.factory_benchmark_experiment_candidates candidate
  join internal.factory_improvement_validations receipt on (candidate.workspace_id, candidate.factory_id) =
    (receipt.workspace_id, receipt.factory_id) and candidate.experiment_id in (receipt.targeted_experiment_id,receipt.holdout_experiment_id)
  where receipt.workspace_id = pg_temp.live_id(11))
  and (select count(*) = 2 from public.factory_benchmark_schedules where workspace_id = pg_temp.live_id(11)),
  'both schedules use the exact same frozen revisions and runner');
select ok((select replay @> '{"replay":true}' and replay#>>'{validation,id}' = receipt#>>'{validation,id}'
  and replay#>>'{validation,targeted,experimentId}' = receipt#>>'{validation,targeted,experimentId}'
  and replay#>>'{validation,holdout,experimentId}' = receipt#>>'{validation,holdout,experimentId}'
  and replay#>'{validation,thresholds}' = receipt#>'{validation,thresholds}'
  from validation_start cross join lateral (select pg_temp.start_validation()) retry(replay)),
  'an exact authorized retry returns the original two experiment IDs and reviewed thresholds');
select throws_ok($$select pg_temp.start_validation(p_holdout_budget => 21)$$, 'PT409', null,
  'a reused request key cannot change its reviewed workload or threshold inputs');
select throws_ok($$select pg_temp.start_validation(331)$$, 'PT409', null,
  'a new key cannot replace the holdout for an already-bound proposal revision');

update public.agent_jobs set scheduled_at = clock_timestamp() + interval '1 hour'
where workspace_id <> pg_temp.live_id(11) and status = 'queued';
select is(pg_temp.control_validation_experiment('holdout','pause')->>'state', 'paused', 'the held-out schedule can pause independently');
select pg_temp.frontier_execute(p_latency_floor_ms => 2000) from generate_series(1,4);
select ok(pg_temp.read_validation() @> '{"status":"inconclusive","targeted":{"reasons":["unknown_quality"],"baseline":{"passRateBps":null}}}',
  'executed outputs without completed scores keep quality unknown');
select is(public.reconcile_factory_benchmark_evaluations(100), 4, 'the targeted frozen scorer admits its four exact outputs');
select pg_temp.frontier_score(p_fail_position => 1);
select ok(pg_temp.read_validation()#>'{targeted}' @>
  '{"resolvedPairs":2,"independentTasks":2,"regressions":0,"baseline":{"passes":0},"candidate":{"passes":2}}',
  'targeted results retain the exact independent pair support and observed improvement');

select is(pg_temp.control_validation_experiment('targeted','pause')->>'state', 'paused', 'targeted admissions can pause after evaluation');
select is(pg_temp.control_validation_experiment('holdout','resume')->>'state', 'active', 'resume reuses the already frozen holdout');
savepoint before_mismatched_holdout;
select pg_temp.frontier_execute(p_latency_floor_ms => 2000, p_mismatched_position => 2) from generate_series(1,4);
select public.reconcile_factory_benchmark_evaluations(100);
select pg_temp.frontier_score();
select pg_temp.read_validation() @>
  '{"status":"inconclusive","holdout":{"reasons":["mismatched_input_identity"]}}' as mismatched_input \gset
rollback to savepoint before_mismatched_holdout;
release savepoint before_mismatched_holdout;
select ok(:'mismatched_input'::boolean, 'different restored bundles on the same frozen task cannot qualify');
savepoint before_unpriced_holdout;
select pg_temp.frontier_execute(p_latency_floor_ms => 2000, p_unpriced_position => 2) from generate_series(1,4);
select public.reconcile_factory_benchmark_evaluations(100);
select pg_temp.frontier_score();
select pg_temp.read_validation() @> '{"status":"inconclusive","holdout":{"reasons":["unknown_cost"],
    "candidate":{"passRateBps":10000,"meanCostUsd":null}}}' as incomplete_cost \gset
rollback to savepoint before_unpriced_holdout;
release savepoint before_unpriced_holdout;
select ok(:'incomplete_cost'::boolean, 'unknown spend blocks qualification even with complete passing scores');
select pg_temp.frontier_execute(p_latency_floor_ms => 2000) from generate_series(1,4);
select is(public.reconcile_factory_benchmark_evaluations(100), 4, 'the held-out frozen scorer admits its four exact outputs');
-- Observe a matched-score holdout, then restore the outstanding jobs so the
-- same exact frozen inputs can demonstrate the regression veto independently.
savepoint before_holdout_scores;
select pg_temp.frontier_score();
select pg_temp.read_validation()->>'status' as parity_status \gset
savepoint before_erased_source;
insert into public.session_retained_content_erasures(session_id,workspace_id,factory_id,archived_at,actor_member_id)
select pg_temp.live_id(2003), workspace_id, factory_id, statement_timestamp(), pg_temp.live_id(21) from live_scope;
select pg_temp.read_validation() @>
  '{"status":"inconclusive","holdout":{"reasons":["source_unavailable"]}}' as erased_source \gset
rollback to savepoint before_erased_source;
release savepoint before_erased_source;
savepoint before_erased_diagnosis;
insert into public.session_retained_content_erasures(session_id,workspace_id,factory_id,archived_at,actor_member_id)
select pg_temp.live_id(2008), workspace_id, factory_id, statement_timestamp(), pg_temp.live_id(21) from live_scope;
select pg_temp.read_validation() @>
  '{"status":"inconclusive","reasons":["diagnosis_evidence_unavailable"]}' as erased_diagnosis \gset
rollback to savepoint before_erased_diagnosis;
release savepoint before_erased_diagnosis;
select internal.factory_improvement_validation_split(
    jsonb_populate_record(validation, jsonb_build_object('intent',
      jsonb_set(validation.intent, '{thresholds,minimumIndependentTasks}', '3'))),
    validation.holdout_experiment_id, false) @>
  '{"status":"inconclusive","reasons":["insufficient_independent_tasks"]}' as low_support
from internal.factory_improvement_validations validation where validation.workspace_id = pg_temp.live_id(11) \gset
rollback to savepoint before_holdout_scores;
release savepoint before_holdout_scores;
select is(:'parity_status'::text, 'qualified', 'targeted improvement and matched held-out results qualify with complete measured support');
select ok(:'low_support'::boolean, 'complete equal measurements cannot qualify below the reviewed independent-source minimum');
select ok(:'erased_source'::boolean, 'erasing a retained held-out source invalidates earlier successful evidence');
select ok(:'erased_diagnosis'::boolean, 'erasing diagnosis evidence invalidates an otherwise qualified proposal');
select pg_temp.frontier_score(p_fail_position => 2);
select ok(pg_temp.read_validation() @>
  '{"status":"failed","holdout":{"status":"failed","regressions":2,"reasons":["known_regression"]}}',
  'paired held-out failures veto validation even when the targeted suite records improvement');

select is(pg_temp.control_validation_experiment('holdout','cancel')->>'state', 'canceled', 'cancellation is retained by the existing schedule');
select throws_ok($$select pg_temp.control_validation_experiment('holdout','resume')$$, 'PT409', null,
  'a terminal cancel cannot be restarted with a substituted holdout');
select ok((select pg_temp.read_validation()#>>'{holdout,experimentId}' = receipt#>>'{validation,holdout,experimentId}'
  and pg_temp.read_validation()#>>'{holdout,scheduleState}' = 'canceled'
  from validation_start), 'schedule controls keep the original immutable validation identity');

select pg_temp.validation_proposal_revision(2, 103);
select ok(pg_temp.read_validation() @> '{"status":"stale","reasons":["stale_proposal"]}',
  'appending a new proposal revision makes historical comparison evidence non-qualifying');
select throws_ok($$select pg_temp.read_validation(pg_temp.live_id(999))$$, '42501', null,
  'an unrelated caller cannot read the historical comparison');

select * from finish();
rollback;
