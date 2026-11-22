begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
\ir fixtures/factory_improvement_publication.psql

-- Both target configurations have exact measured routing evidence.
select pg_temp.execute_publication_fixture(true);
select public.reconcile_factory_benchmark_evaluations(100);
select pg_temp.frontier_score();
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.live_id(1),'platform_api_key','synthetic-improvement-routing-key');

create function pg_temp.improvement_routing_configuration(p_position integer) returns jsonb language sql as $$
  select jsonb_build_object('agentId',pg_temp.live_id(47),'definitionRevisionId',axis.definition_revision_id,
    'experimentId',axis.experiment_id,'qualificationId',axis.qualification_id,'scorerRevisionId',scorer.id,
    'modelKey',axis.canonical_model_key,'harness',axis.harness,'workerRuntime',axis.worker_runtime)
  from public.factory_benchmark_experiment_candidates axis
  join publication_validation validation on axis.experiment_id::text = validation.receipt#>>'{targeted,experimentId}'
  cross join frontier_scorer scorer where axis.comparison_position = p_position
$$;

create temp table candidate_routing_draft as
with factory_scope as (
  select scope.*, revision.definition_json::jsonb || jsonb_build_object('modelRouting',jsonb_build_object(
    'version',1,'taskClasses',jsonb_build_array(jsonb_build_object(
      'id',pg_temp.live_id(201),'slug','review','name','Review')),
    'rules',jsonb_build_array(jsonb_build_object('id',pg_temp.live_id(202),'taskClassId',pg_temp.live_id(201),
      'configuration',pg_temp.improvement_routing_configuration(1),
      'constraints','{"qualityFloorBps":8000,"maxMeanCostUsd":1,"maxLatencyMs":120000,"minResolvedTrials":2,"minConfidenceBps":null}'::jsonb,
      'onUnavailable',jsonb_build_object('kind','fallback','configuration',pg_temp.improvement_routing_configuration(2)))),
    'onUnmatched','{"kind":"escalate"}'::jsonb)) as body
  from live_scope scope join public.factory_definition_revisions revision on revision.id = pg_temp.live_id(161)
)
select saved.*
from factory_scope scope cross join publication_validation validation cross join frontier_scorer scorer
join public.factory_benchmark_experiment_candidates axis on axis.comparison_position = 1
join public.factory_benchmark_experiments experiment on experiment.id = axis.experiment_id
cross join lateral public.save_factory_routing_draft(scope.workspace_id,scope.factory_id,scope.owner_id,2,
  scope.body::text,encode(sha256(convert_to(scope.body::text,'UTF8')),'hex'),'{"newStageIds":[]}',
  axis.experiment_id,axis.candidate_key,experiment.suite_revision_id,scorer.id,pg_temp.live_id(202),
  pg_temp.live_id(375),repeat('b',64),null) saved
where experiment.id::text = validation.receipt#>>'{targeted,experimentId}';

insert into public.sandbox_capability_checks(workspace_id,github_repository_id,agent_provider,agent_model,
  sandbox_provider,sandbox_id,sandbox_connection_revision,sandbox_vercel_team_id,sandbox_vercel_project_id,status,
  capabilities,factory_definition_digest)
select capability.workspace_id,capability.github_repository_id,capability.agent_provider,capability.agent_model,
  capability.sandbox_provider,capability.sandbox_id,capability.sandbox_connection_revision,capability.sandbox_vercel_team_id,
  capability.sandbox_vercel_project_id,capability.status,capability.capabilities,draft.canonical_digest
from public.sandbox_capability_checks capability cross join candidate_routing_draft draft
where capability.id = pg_temp.live_id(51);
insert into public.factory_definition_smoke_tests(workspace_id,factory_id,target_kind,target_id,definition_digest,
  base_activation_number,sandbox_connection_revision,created_by,lease_expires_at,finished_at,status,evidence)
select draft.workspace_id,draft.factory_id,'draft',draft.id,draft.canonical_digest,2,pg_temp.live_id(50),
  draft.created_by,clock_timestamp()+interval '5 minutes',clock_timestamp(),'passed','{"runtimeProfile":"vercel"}'
from candidate_routing_draft draft;
create temp table prior_routing_activation as
select public.activate_reviewed_factory_routing(workspace_id,factory_id,created_by,2,id,
  array['vercel'],array['agentCli']) as receipt from candidate_routing_draft;

select public.set_git_continuity_release(true,revision,'Reviewed improvement routing fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into internal.workspace_issue_counters as counters(workspace_id,last_issue_number)
select session.workspace_id,max(session.number) from public.sessions session
join live_scope scope on scope.workspace_id = session.workspace_id group by session.workspace_id
on conflict(workspace_id) do update set last_issue_number = greatest(counters.last_issue_number,excluded.last_issue_number);

create function pg_temp.admit_improvement_routing(p_title text) returns uuid language sql as $$
  select accepted.session_id from live_scope scope
  cross join lateral public.create_session_with_first_job(scope.workspace_id,pg_temp.live_id(21),p_title,
    'Handle the pinned review task.','codex','gpt-4.1-2025-04-14',
    session_github_repository_id=>pg_temp.live_id(42),selected_pipeline_id=>pg_temp.live_id(40),
    selected_stage_ids=>array[pg_temp.live_id(41)]) accepted
$$;
create temp table admitted_before_improvement as
select pg_temp.admit_improvement_routing('Before reviewed improvement') as id;

-- The adoption CAS is tested separately. This fixture supplies its frozen
-- publication/definition records to exercise the real routing hook.
insert into internal.factory_improvement_publications(id,workspace_id,factory_id,proposal_id,proposal_revision_id,
  validation_id,author_member_id,target,base,candidate,cohort,comparisons)
select pg_temp.live_id(376),scope.workspace_id,scope.factory_id,pg_temp.live_id(300),pg_temp.live_id(312),
  (validation.receipt->>'id')::uuid,pg_temp.live_id(21),'{}','{}','{}','{}','{}'
from live_scope scope cross join publication_validation validation;

create function pg_temp.record_improvement_routing(p_replace_primary boolean) returns uuid language plpgsql as $$
declare
  prior public.factory_definition_revisions;
  candidate public.factory_definition_revisions;
  adoption internal.factory_improvement_adoptions;
  body jsonb;
  edits jsonb := '[]';
begin
  select revision.* into strict prior from public.factory_definition_revisions revision
  join prior_routing_activation activation on revision.id::text = activation.receipt->>'revisionId';
  body := jsonb_set(prior.definition_json::jsonb,'{stages,0,promptTemplateMd}',
    '"Review the task against its acceptance criteria."',true);
  if p_replace_primary then
    body := jsonb_set(body,'{modelRouting,rules,0,configuration}',pg_temp.improvement_routing_configuration(2) - 'scorerRevisionId');
    edits := jsonb_build_array(jsonb_build_object('kind','routing_target','ruleId',pg_temp.live_id(202),
      'from',prior.definition_json::jsonb#>'{modelRouting,rules,0,configuration}',
      'to',body#>'{modelRouting,rules,0,configuration}'));
  end if;
  insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
  values(prior.workspace_id,prior.factory_id,1,body::text,encode(sha256(convert_to(body::text,'UTF8')),'hex'),prior.created_by)
  returning * into candidate;
  insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
  values(prior.workspace_id,prior.factory_id,candidate.id,4,prior.created_by);
  insert into internal.factory_improvement_adoptions(workspace_id,factory_id,proposal_id,proposal_revision_id,
    publication_id,validation_id,actor_member_id,baseline_activation_number,baseline_revision_id,baseline_digest,
    activation_number,adopted_revision_id,adopted_digest,review,comparisons)
  select prior.workspace_id,prior.factory_id,pg_temp.live_id(300),pg_temp.live_id(312),pg_temp.live_id(376),
    (validation.receipt->>'id')::uuid,pg_temp.live_id(21),3,prior.id,prior.canonical_digest,
    4,candidate.id,candidate.canonical_digest,'{}','{}' from publication_validation validation returning * into adoption;
  perform internal.record_factory_improvement_routing(adoption,prior.created_by,prior.definition_json::jsonb,body,edits);
  return adoption.id;
end;
$$;

savepoint before_improvement_canary;
insert into public.factory_routing_canaries(workspace_id,factory_id,activation_number,baseline_activation_number,
  candidate_revision_id,baseline_revision_id,task_class_id,task_class_slug,candidate_bps)
select head.workspace_id,head.factory_id,3,2,head.revision_id,prior.revision_id,
  pg_temp.live_id(201),'review',500
from public.factory_definition_activations head join public.factory_definition_activations prior
  on (head.workspace_id,head.factory_id) = (prior.workspace_id,prior.factory_id)
where head.workspace_id = pg_temp.live_id(11) and head.activation_number = 3 and prior.activation_number = 2;
create function pg_temp.improvement_routing_error() returns text language plpgsql as $$
begin
  perform pg_temp.record_improvement_routing(false);
  return '00000';
exception when others then return sqlstate;
end;
$$;
select pg_temp.improvement_routing_error() as canary_sqlstate \gset
rollback to savepoint before_improvement_canary;
release savepoint before_improvement_canary;
select is(:'canary_sqlstate'::text,'PT409','an unrelated improvement cannot promote an active routing canary');

savepoint before_unchanged_improvement;
select pg_temp.record_improvement_routing(false) as carried_adoption \gset
select (adopted.source_improvement_adoption_id::text = :'carried_adoption'
  and (adopted.draft_id,adopted.benchmark_evidence_draft_id) is not distinct from (null::uuid,null::uuid)
  and adopted.reviewed_targets = prior.reviewed_targets) as preserved_targets
from public.factory_routing_activations adopted join public.factory_routing_activations prior
  on (adopted.workspace_id,adopted.factory_id) = (prior.workspace_id,prior.factory_id)
where adopted.workspace_id = pg_temp.live_id(11) and adopted.activation_number = 4 and prior.activation_number = 3 \gset
rollback to savepoint before_unchanged_improvement;
release savepoint before_unchanged_improvement;
select ok(:'preserved_targets'::boolean,'a prompt edit preserves exact reviewed targets and records its adoption source');

select pg_temp.record_improvement_routing(true) as target_adoption \gset
set constraints factory_routing_activation_improvement_source_fk immediate;
create temp table admitted_after_improvement as
select pg_temp.admit_improvement_routing('After reviewed improvement') as id;
select ok((select before_pin.activation_number = 3 and after_pin.activation_number = 4
  and before_pin.routing_decision->>'mode' = 'active' and after_pin.routing_decision->>'mode' = 'active'
  and before_pin.routing_execution->'configuration' = pg_temp.improvement_routing_configuration(1)
  and after_pin.routing_execution->'configuration' = pg_temp.improvement_routing_configuration(2) - 'scorerRevisionId'
  from admitted_before_improvement old_pin join public.session_factory_admission_inputs before_pin on before_pin.session_id = old_pin.id
  cross join admitted_after_improvement new_pin join public.session_factory_admission_inputs after_pin on after_pin.session_id = new_pin.id),
  'only future admissions use the newly qualified primary while the old pin stays exact');
select ok((select review.source_improvement_adoption_id::text = :'target_adoption'
  and review.reviewed_targets @> jsonb_build_array(jsonb_build_object('ruleId',pg_temp.live_id(202),
    'target','rule_fallback','configuration',pg_temp.improvement_routing_configuration(2)))
  from public.factory_routing_activations review where review.workspace_id = pg_temp.live_id(11)
    and review.activation_number = 4), 'changing the reviewed primary retains its unchanged fallback');

create temp table adopted_routing_revision as
select revision.*
from live_scope scope
join public.factory_definition_activations activation using (workspace_id,factory_id)
join public.factory_definition_revisions revision on (revision.workspace_id,revision.factory_id,revision.id) =
  (activation.workspace_id,activation.factory_id,activation.revision_id)
where activation.activation_number = 4;

-- Move the exact same workflow to a new reviewed routing head before restoring the adopted target.
create temp table later_routing_draft as
select saved.*
from live_scope scope
cross join adopted_routing_revision revision
cross join publication_validation validation
cross join frontier_scorer scorer
join public.factory_benchmark_experiment_candidates axis on axis.comparison_position = 1
join public.factory_benchmark_experiments experiment on experiment.id = axis.experiment_id
cross join lateral (
  select jsonb_set(revision.definition_json::jsonb,'{modelRouting,rules,0,configuration}',
    pg_temp.improvement_routing_configuration(1))::text as body
) definition
cross join lateral public.save_factory_routing_draft(scope.workspace_id,scope.factory_id,scope.owner_id,4,
  definition.body,encode(sha256(convert_to(definition.body,'UTF8')),'hex'),'{"newStageIds":[]}',
  axis.experiment_id,axis.candidate_key,experiment.suite_revision_id,scorer.id,pg_temp.live_id(202),
  pg_temp.live_id(377),repeat('c',64),null) saved
where experiment.id::text = validation.receipt#>>'{targeted,experimentId}';

insert into public.sandbox_capability_checks(workspace_id,github_repository_id,agent_provider,agent_model,
  sandbox_provider,sandbox_id,sandbox_connection_revision,sandbox_vercel_team_id,sandbox_vercel_project_id,status,
  capabilities,factory_definition_digest)
select capability.workspace_id,capability.github_repository_id,capability.agent_provider,capability.agent_model,
  capability.sandbox_provider,capability.sandbox_id,capability.sandbox_connection_revision,capability.sandbox_vercel_team_id,
  capability.sandbox_vercel_project_id,capability.status,capability.capabilities,target.canonical_digest
from public.sandbox_capability_checks capability
cross join (select canonical_digest from later_routing_draft union select canonical_digest from adopted_routing_revision) target
where capability.id = pg_temp.live_id(51);

create function pg_temp.pass_restore_smoke(p_expected bigint,p_kind text,p_id uuid,p_digest text)
returns boolean language sql as $$
  select public.finish_factory_definition_smoke_test(scope.workspace_id,test.id,'passed',
    jsonb_build_object('runtimeProfile','vercel','stageCount',1,'completedStageCount',1,
      'stages',jsonb_build_array(jsonb_build_object('stageId',pg_temp.live_id(41),'promptDigest',repeat('a',64)))),
    null)
  from live_scope scope
  cross join lateral public.start_factory_definition_smoke_test(scope.workspace_id,scope.factory_id,scope.owner_id,
    p_expected,p_kind,p_id,p_digest,array['vercel'],array['agentCli']) test
$$;

select ok(pg_temp.pass_restore_smoke(4,'draft',id,canonical_digest),'the later routing-only draft passes its own smoke')
from later_routing_draft;
create temp table later_routing_activation as
select public.activate_reviewed_factory_routing(workspace_id,factory_id,created_by,4,id,
  array['vercel'],array['agentCli']) as receipt from later_routing_draft;

create temp table adoption_pin_before_restore as
select to_jsonb(input) as receipt from public.session_factory_admission_inputs input
join admitted_after_improvement admitted on admitted.id = input.session_id;

create function pg_temp.restore_adopted_routing(p_expected bigint)
returns public.factory_definition_activations language sql as $$
  select public.rollback_factory_routing_activation(scope.workspace_id,scope.factory_id,scope.owner_id,
    p_expected,4,target.id,array['vercel'],array['agentCli'])
  from live_scope scope cross join adopted_routing_revision target
$$;
select throws_ok($$select pg_temp.restore_adopted_routing(6)$$,'PT409',null,
  'a stale head cannot restore adoption-backed routing');
select throws_ok($$select pg_temp.restore_adopted_routing(5)$$,'PT422',
  'A current passing smoke test is required for the exact factory candidate.',
  'the adoption-backed target still requires an exact fresh restoration smoke');
select ok(pg_temp.pass_restore_smoke(5,'revision',id,canonical_digest),'the restored revision passes smoke at the later head')
from adopted_routing_revision;

create temp table restored_adoption_routing as select restored.* from pg_temp.restore_adopted_routing(5) restored;
select ok((select restored.activation_number = 6 and restored.previous_activation_number = 5
  and restored.revision_id = target.id and receipt.target_activation_number = 4 and receipt.restored_mode = 'reviewed'
  and review.source_improvement_adoption_id::text = :'target_adoption'
  and (review.draft_id,review.benchmark_evidence_draft_id) is not distinct from (null::uuid,null::uuid)
  and review.reviewed_targets = adopted.reviewed_targets
  from restored_adoption_routing restored
  join public.factory_routing_rollbacks receipt using (workspace_id,factory_id,activation_number)
  join public.factory_routing_activations review using (workspace_id,factory_id,activation_number)
  join public.factory_routing_activations adopted using (workspace_id,factory_id)
  cross join adopted_routing_revision target
  where adopted.activation_number = 4),
  'the canonical rollback appends the exact reviewed adoption provenance and rollback receipt');

create temp table admitted_after_restore as select pg_temp.admit_improvement_routing('After adopted routing restore') as id;
select ok((select input.activation_number = 6 and input.definition_revision_id = target.id
  and input.definition_digest = target.canonical_digest and input.routing_decision->>'mode' = 'active'
  and input.routing_execution->'configuration' = pg_temp.improvement_routing_configuration(2) - 'scorerRevisionId'
  from public.session_factory_admission_inputs input join admitted_after_restore admitted on admitted.id = input.session_id
  cross join adopted_routing_revision target),'a new admission uses the restored reviewed target and exact revision');
select is((select to_jsonb(input) from public.session_factory_admission_inputs input
  join admitted_after_improvement admitted on admitted.id = input.session_id),
  (select receipt from adoption_pin_before_restore),'restoration preserves the original adoption admission pin');

select workspace_id as status_workspace_id, factory_id as status_factory_id from live_scope \gset
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '62300000-0000-4000-9000-000000000001';
set local role authenticated;
select public.get_factory_routing_qualification_status(:'status_workspace_id',:'status_factory_id',4,null)->>'status' as routed_status \gset
select public.get_factory_routing_qualification_status(:'status_workspace_id',:'status_factory_id',6,null)->>'status' as restored_status \gset
reset role;
select is(:'routed_status'::text,'current','routing status recognizes exact adopted benchmark provenance');
select is(:'restored_status'::text,'current','routing qualification recognizes the restored adoption provenance');

select * from finish();
rollback;
