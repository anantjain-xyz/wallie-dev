begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '59500000-0000-4000-8000-000000000001';

select public.set_git_continuity_release(true, revision, 'Factory throughput attribution fixture')
from public.get_git_continuity_release_state() where not enabled;

create function pg_temp.throughput_id(slot integer) returns uuid language sql immutable as $$
  select ('59500000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email) values
  (pg_temp.throughput_id(1), 'throughput-owner@example.test'),
  (pg_temp.throughput_id(4), 'throughput-payer@example.test'),
  (pg_temp.throughput_id(6), 'throughput-reader@example.test');
insert into public.workspaces(id,slug,name) values (pg_temp.throughput_id(2), 'throughput-fixture', 'Factory throughput');
insert into public.workspace_members(id,workspace_id,user_id,kind,role) values
  (pg_temp.throughput_id(3), pg_temp.throughput_id(2), pg_temp.throughput_id(1), 'human', 'owner'),
  (pg_temp.throughput_id(5), pg_temp.throughput_id(2), pg_temp.throughput_id(4), 'human', 'member'),
  (pg_temp.throughput_id(7), pg_temp.throughput_id(2), pg_temp.throughput_id(6), 'human', 'member');

create temp table throughput_factory as
  select * from public.create_factory(pg_temp.throughput_id(2),pg_temp.throughput_id(1),'Throughput factory','throughput-factory');
create temp table throughput_sibling as select id from public.create_factory(
  pg_temp.throughput_id(2), pg_temp.throughput_id(1), 'Restricted throughput factory', 'restricted-throughput');
select public.grant_factory_membership(pg_temp.throughput_id(2), id, pg_temp.throughput_id(1), pg_temp.throughput_id(7))
from throughput_factory;
grant select on throughput_factory, throughput_sibling to authenticated;
create function pg_temp.throughput_factory_id() returns uuid language sql stable as $$
  select id from throughput_factory
$$;
insert into public.pipelines(id,workspace_id,factory_id,name,is_default)
values (pg_temp.throughput_id(10),pg_temp.throughput_id(2),pg_temp.throughput_factory_id(),'Throughput pipeline',false);
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,prompt_template_md,anyone_can_approve)
values (pg_temp.throughput_id(11),pg_temp.throughput_id(10),pg_temp.throughput_id(2),1,'design','Design','Draft the spec',true);

insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values (pg_temp.throughput_id(20),pg_temp.throughput_id(2),59500001,'https://github.test/installations/59500001',595000,
  'Organization','throughput-fixture','{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.throughput_id(slot),pg_temp.throughput_id(2),pg_temp.throughput_factory_id(),pg_temp.throughput_id(20),59500000 + slot,
  name,'fixture/' || name,true,'https://github.test/fixture/' || name,'main'
from (values (21,'writer'),(22,'context')) repository(slot,name);

create temp table throughput_policy as select * from public.save_execution_policy(pg_temp.throughput_id(2),pg_temp.throughput_id(1),0,
  '{"version":1,"maxRepairAttempts":5,"maxExecutionMs":3600000,"maxTotalTokens":null,"maxCostUsd":null}');
create temp table throughput_principal as select * from public.create_service_principal(
  pg_temp.throughput_id(2),pg_temp.throughput_factory_id(),pg_temp.throughput_id(1),'Named machine author','named-machine-author');
create temp table throughput_grant as select approved.* from throughput_principal principal cross join throughput_policy policy
cross join lateral public.approve_factory_execution_grant(principal.workspace_id,principal.factory_id,pg_temp.throughput_id(1),principal.id,
  pg_temp.throughput_id(21),array[pg_temp.throughput_id(22)],'{}',policy.id,pg_temp.throughput_id(5),clock_timestamp()+interval '1 hour',0,null,
  '{sessions:create,sessions:read,sessions:cancel}'::public.factory_command_scope[]) approved;
insert into public.workspace_secrets(id,workspace_id,key,encrypted_value)
values (pg_temp.throughput_id(30),pg_temp.throughput_id(2),'FACTORY_AGENT_KEY','synthetic-worker-secret');
insert into public.workspace_sandbox_settings(workspace_id,active_provider) values (pg_temp.throughput_id(2),'e2b')
on conflict (workspace_id) do update set active_provider=excluded.active_provider;
insert into public.workspace_e2b_sandbox_connections(workspace_id,encrypted_api_key)
values (pg_temp.throughput_id(2),'synthetic-sandbox-provider');

create temp table throughput_agent as
select agent.id,prompt.id prompt_revision_id,prompt.prompt_md,prompt.prompt_sha256
from public.factory_agents agent join public.factory_agent_prompt_revisions prompt on prompt.agent_id=agent.id
where agent.factory_id=pg_temp.throughput_factory_id() and agent.is_default and prompt.revision_number=1;
create temp table throughput_binding as select binding.* from throughput_grant approved cross join throughput_agent agent
cross join lateral public.create_factory_secret_binding(approved.workspace_id,approved.factory_id,pg_temp.throughput_id(1),
  approved.id,approved.version,agent.id,'codex',pg_temp.throughput_id(30)) binding;

create function pg_temp.activate_throughput(activation bigint, p_model text) returns text language sql as $$
  with definition as (
    select (jsonb_build_object('schemaVersion',1,'kind','serial','sandboxProvider','e2b',
      'pipelineId',pg_temp.throughput_id(10),'repositoryId',pg_temp.throughput_id(21),
      'readContextRepositoryIds',jsonb_build_array(pg_temp.throughput_id(22)),
      'executionPolicyRevisionId',policy.id,'deliveryPolicyRevisionId',null,'skillIds','[]'::jsonb,'toolIds','[]'::jsonb,
      'operatingRulesMd','','operatingRuleStageIds','[]'::jsonb,
      'agent',jsonb_build_object('provider','codex','model',p_model,'effort',null,
        'concurrencyLimit',1,'stallTimeoutMs',900000,'maxRetries',3,'maxTurns',5),
      'implementationAgent',jsonb_build_object('agentId',agent.id,'promptRevisionId',agent.prompt_revision_id,
        'promptMd',agent.prompt_md,'promptSha256',agent.prompt_sha256),
      'stages',jsonb_build_array(jsonb_build_object('id',pg_temp.throughput_id(11),'slug','design','name','Design',
        'description','','promptTemplateMd','Draft the spec','anyoneCanApprove',true,
        'previousStageIds','[]'::jsonb,'approverMemberIds','[]'::jsonb)))
      || jsonb_build_object('credentialBindingId',binding.id,
          'executionGrant',jsonb_build_object('id',approved.id,'version',approved.version))
      )::text bytes
    from throughput_agent agent cross join throughput_policy policy cross join throughput_grant approved cross join throughput_binding binding
  ), revision as (
    insert into public.factory_definition_revisions(workspace_id,factory_id,schema_version,definition_json,canonical_digest,created_by)
    select pg_temp.throughput_id(2),pg_temp.throughput_factory_id(),1,bytes,encode(sha256(convert_to(bytes,'UTF8')),'hex'),pg_temp.throughput_id(1)
    from definition returning *
  ), activated as (
    insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
    select workspace_id,factory_id,id,activation,pg_temp.throughput_id(1) from revision returning revision_id
  )
  select revision.canonical_digest from revision join activated on activated.revision_id=revision.id;
$$;
create temp table original_definition as select pg_temp.activate_throughput(1,'gpt-5.5') digest;

select public.issue_factory_machine_token(workspace_id,factory_id,pg_temp.throughput_id(1),id,version,
  pg_temp.throughput_id(31),repeat('a',64),'Creation transport','{sessions:create,sessions:read,sessions:cancel}') from throughput_grant;

create function pg_temp.throughput_machine_mutation(
  p_operation public.factory_session_mutation_operation, p_key integer, p_payload jsonb,
  p_surface public.factory_command_surface default 'api'
) returns jsonb language plpgsql as $$
declare permit record; physical_request uuid := gen_random_uuid(); result jsonb;
begin
  select * into strict permit from public.admit_factory_command(pg_temp.throughput_id(2),pg_temp.throughput_factory_id(),'machine_token',
    pg_temp.throughput_id(31),repeat('a',64),internal.session_mutation_scope(p_operation),physical_request,repeat('b',64),p_surface);
  if permit.status <> 'admitted' then raise exception 'Fixture admission failed: %', permit.status; end if;
  result := public.execute_factory_session_mutation(pg_temp.throughput_id(2),pg_temp.throughput_factory_id(),'machine_token',
    pg_temp.throughput_id(31),repeat('a',64),physical_request,repeat('b',64),p_surface,permit.admission_id,permit.lease_id,
    p_operation,pg_temp.throughput_id(p_key),p_payload);
  perform public.release_factory_command_admission(permit.admission_id,permit.lease_id);
  return result;
end;
$$;

create function pg_temp.throughput_machine_create(
  p_key integer, p_title text default 'Draft a proposal', p_repo uuid default pg_temp.throughput_id(21),
  p_agent uuid default null, p_surface public.factory_command_surface default 'api'
) returns jsonb language sql as $$
  select pg_temp.throughput_machine_mutation('create',p_key,jsonb_build_object('title',p_title,'prompt','Read the request.',
    'agentId',coalesce(p_agent,(select id from throughput_agent)),'repositoryId',p_repo,'draftSpecification',false),p_surface)
$$;

create function pg_temp.throughput_browser_create(
  p_key integer, p_title text default 'Draft a proposal', p_draft boolean default false
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select * from public.create_session_command_once(pg_temp.throughput_id(2),pg_temp.throughput_id(3),pg_temp.throughput_id(p_key),
    repeat('c',64),(select digest from original_definition),p_title,'Read the request.','codex','gpt-5.5','{}',
    session_github_repository_id=>pg_temp.throughput_id(21),target_factory_id=>pg_temp.throughput_factory_id(),draft_specification=>p_draft)
$$;

create temp table throughput_requests(source text primary key, session_id uuid not null);
insert into throughput_requests
select 'browser', session_id from pg_temp.throughput_browser_create(101, 'Browser request')
union all select 'api', (pg_temp.throughput_machine_create(102, 'API request')->>'sessionId')::uuid
union all select 'mcp', (pg_temp.throughput_machine_create(103, 'MCP request', p_surface => 'mcp')->>'sessionId')::uuid;

-- A legacy Linear URL is not a creation receipt or a known person.
insert into public.sessions(id, workspace_id, factory_id, number, title, pipeline_id, current_stage_id,
  github_repository_id, linear_issue_url)
values (pg_temp.throughput_id(80), pg_temp.throughput_id(2), pg_temp.throughput_factory_id(), 80, 'Earlier request',
  pg_temp.throughput_id(10), pg_temp.throughput_id(11), pg_temp.throughput_id(21), 'https://linear.test/example/fixture');
insert into throughput_requests values ('unknown', pg_temp.throughput_id(80));

select ok((pg_temp.throughput_machine_create(102, 'API request', p_surface => 'mcp')->>'replayed')::boolean,
  'a cross-surface retry recovers the original business command');
select results_eq(
  $$select request.source, attribution.source
    from throughput_requests request join internal.factory_request_attribution attribution using (session_id)
    order by request.source$$,
  $$values ('api'::text, 'api'::text), ('browser'::text, 'browser'::text), ('mcp'::text, 'mcp'::text)$$,
  'browser and machine origins use actual original command receipts while an old issue URL remains unknown');

-- Age only this fixture's released transport receipts, then exercise the real
-- pruner. Throughput uses the durable source receipt instead of those leases.
alter table internal.factory_command_admissions disable trigger preserve_factory_command_admission;
update internal.factory_command_admissions admission set admitted_at = clock_timestamp() - interval '8 days'
from internal.factory_request_attribution attribution
where admission.id = attribution.command_admission_id and attribution.workspace_id = pg_temp.throughput_id(2);
alter table internal.factory_command_admissions enable trigger preserve_factory_command_admission;
select public.prune_factory_command_admissions(500);
select ok(not exists (
  select 1 from internal.factory_request_attribution attribution
  join internal.factory_command_admissions admission on admission.id = attribution.command_admission_id
  where attribution.workspace_id = pg_temp.throughput_id(2)
) and (select count(*) from internal.factory_request_attribution where workspace_id = pg_temp.throughput_id(2)) = 3,
  'durable origin facts remain linked after the exact API and MCP transport admissions are pruned');

-- Seed the retained attempt inputs directly at their private boundary. The
-- consumer must not reach for the mutable run model or current configuration.
create temp table throughput_producers as
select request.session_id, setup.* from throughput_requests request join (values
  ('api', 91, 92, 'gpt-5.5', 'codex', 'node'),
  ('api', 93, 94, 'claude-opus-4-6', 'claude-code', 'workerd'),
  ('unknown', 95, 96, null, null, null),
  ('browser', 97, 98, 'gpt-5.5', 'codex', 'node'),
  ('browser', 99, 100, null, null, null)
) setup(source, job_slot, run_slot, model_name, harness, worker_runtime) using (source);
insert into public.agent_jobs(id, workspace_id, session_id, stage_id, trigger_type, status, attempt_count)
select pg_temp.throughput_id(job_slot), pg_temp.throughput_id(2), session_id, pg_temp.throughput_id(11),
  'assignment', 'success', 1 from throughput_producers;
insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, attempt_count, run_type,
  model_provider, model_name, status)
select pg_temp.throughput_id(run_slot), pg_temp.throughput_id(2), session_id, pg_temp.throughput_id(job_slot),
  pg_temp.throughput_id(11), 1, 'code', 'codex', 'gpt-5.6-sol', 'success' from throughput_producers;
insert into public.session_attempt_manifests(run_id, workspace_id, session_id, job_id, attempt_count, stage_id,
  definition_provenance, definition_revision_id, definition_digest, definition_skill_ids, definition_tool_ids,
  repository_id, repository_full_name, base_branch, initial_base_sha, input_sha, checkout_sha, prompt_sha256,
  prompt_utf8_bytes, renderer_version, predecessors, worker_runtime, run_type, model_provider, model_name)
select pg_temp.throughput_id(producer.run_slot), pg_temp.throughput_id(2), producer.session_id,
  pg_temp.throughput_id(producer.job_slot), 1, pg_temp.throughput_id(11), 'pinned', revision.id,
  revision.canonical_digest, '{}', '{}', pg_temp.throughput_id(21), 'fixture/writer', 'main',
  repeat('a', 40), repeat('a', 40), repeat('a', 40), repeat('b', 64), 24, 3, '[]',
  producer.worker_runtime, 'code', producer.harness, producer.model_name
from throughput_producers producer cross join original_definition original
join public.factory_definition_revisions revision on revision.canonical_digest = original.digest
where producer.model_name is not null;

create function pg_temp.throughput_merge(p_session_id uuid, p_pr_number integer) returns boolean language plpgsql as $$
declare
  epoch_id uuid := gen_random_uuid();
  branch_name text := 'wallie/sessions/' || p_session_id::text || '/' || epoch_id::text;
  pr_url text := 'https://github.test/fixture/writer/pull/' || p_pr_number::text;
  source_time timestamptz := clock_timestamp();
begin
  insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
  values(p_session_id, pg_temp.throughput_id(2), pg_temp.throughput_id(21), 'fixture/writer', 'main', repeat('a', 40));
  insert into public.session_pr_epochs(id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
    github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft, pr_head_sha)
  values(epoch_id, p_session_id, pg_temp.throughput_id(2), 1, pg_temp.throughput_id(21), 'fixture/writer',
    59500021, 'main', branch_name, 'refs/wallie/fences/' || epoch_id::text, p_pr_number, pr_url, 'open', false, repeat('e', 40));
  return public.finish_session_pr_observation_with_merge(
    public.begin_session_pr_observation(pg_temp.throughput_id(2), pg_temp.throughput_id(21), branch_name, p_pr_number),
    pr_url, 'merged', false, repeat('e', 40), source_time, source_time, repeat('d', 40), repeat('e', 40));
end;
$$;
select ok(bool_and(pg_temp.throughput_merge(session_id, pr_number)), 'fixture cohort uses exact fenced GitHub merge observations')
from throughput_requests join (values ('browser', 101), ('api', 102), ('mcp', 103), ('unknown', 104)) pr(source, pr_number) using (source);

-- Supply the retained exact source links as input to the dimension projection.
-- The MCP merge is unlinked, the browser merge has partial evidence, and
-- the old merge's only linked run has no immutable manifest.
insert into internal.factory_canonical_pull_request_merge_runs(observation_id, run_id, attempt_count, operation_id)
select merge.observation_id, pg_temp.throughput_id(producer.run_slot), 1, gen_random_uuid()
from internal.current_factory_canonical_pull_request_merges merge
join throughput_producers producer using (session_id)
where merge.workspace_id = pg_temp.throughput_id(2);

select pg_temp.activate_throughput(2, 'gpt-5.6-sol');
create temp table throughput_exact_roles as
select admission.session_id, admission.invoking_actor_service_principal_id as invoker,
  admission.credential_owner_service_principal_id as credential_owner, admission.budget_payer_member_id as payer,
  admission.definition_revision_id, source.creation_receipt_id
from public.session_factory_admission_inputs admission
join internal.factory_request_attribution source using (session_id)
where admission.session_id = (select session_id from throughput_requests where source = 'api');
grant select on throughput_exact_roles to authenticated;

create function pg_temp.throughput_summary(p_dimension text) returns jsonb language sql as $$
  select public.get_factory_throughput_breakdown(pg_temp.throughput_id(2), pg_temp.throughput_factory_id(),
    statement_timestamp() - interval '1 hour', statement_timestamp(), p_dimension)
$$;
create function pg_temp.throughput_page(p_dimension text, p_bucket text default null, p_limit integer default 50)
returns jsonb language sql as $$
  select public.list_factory_throughput_contributions(pg_temp.throughput_id(2), pg_temp.throughput_factory_id(),
    statement_timestamp() - interval '1 hour', statement_timestamp(), p_dimension, p_bucket, p_limit)
$$;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '59500000-0000-4000-8000-000000000006';
select throws_ok($$select public.get_factory_throughput_breakdown(pg_temp.throughput_id(2), id,
  statement_timestamp() - interval '1 hour', statement_timestamp(), 'person') from throughput_sibling$$,
  'PT404', null, 'scoped factory access protects person buckets');
select throws_ok($$select public.list_factory_throughput_contributions(pg_temp.throughput_id(2), id,
  statement_timestamp() - interval '1 hour', statement_timestamp(), 'person') from throughput_sibling$$,
  'PT404', null, 'the contributing identities use the same factory boundary as their counts');
select results_eq(
  $$select bucket->>'key', (bucket->>'mergeCount')::integer
    from jsonb_array_elements(pg_temp.throughput_summary('source')->'buckets') bucket order by bucket->>'key'$$,
  $$values ('api'::text, 1), ('browser'::text, 1), ('mcp'::text, 1), ('unknown'::text, 1)$$,
  'all mutually exclusive original-source buckets reconcile to one canonical count per PR');
select ok((select (result->>'observedMergeCount')::integer = 4 and (result->>'mixedMergeCount')::integer = 1
  and (result->>'partialMergeCount')::integer = 1 and (result->>'bucketMembershipCount')::integer = 4
  from (select pg_temp.throughput_summary('model') result) summary),
  'mixed and partial model histories reconcile to four mutually exclusive canonical PRs');
select results_eq(
  $$select bucket->>'key', (bucket->>'mergeCount')::integer
    from jsonb_array_elements(pg_temp.throughput_summary('model')->'buckets') bucket order by bucket->>'key'$$,
  $$values ('mixed'::text, 1), ('partial'::text, 1), ('unknown'::text, 1), ('unlinked'::text, 1)$$,
  'mixed, partially attributed, unknown and unlinked producer histories receive disjoint buckets');
select results_eq(
  $$select item->>'rawBucketKey', item->>'modelName'
    from jsonb_array_elements(pg_temp.throughput_page('model', 'mixed')->'items') item order by item->>'modelName'$$,
  $$values ('model:claude-opus-4-6'::text, 'claude-opus-4-6'::text),
    ('model:gpt-5.5'::text, 'gpt-5.5'::text)$$,
  'the mixed drilldown retains both historical manifest models independently of the current default');
select results_eq(
  $$select item->>'rawBucketKey'
    from jsonb_array_elements(pg_temp.throughput_page('model', 'partial')->'items') item order by item->>'rawBucketKey'$$,
  $$values ('model:gpt-5.5'::text), ('unknown'::text)$$,
  'the partial drilldown exposes the retained producing model and the missing evidence');
select results_eq(
  $$select bucket->>'key', (bucket->>'mergeCount')::integer
    from jsonb_array_elements(pg_temp.throughput_summary('person')->'buckets') bucket order by bucket->>'key'$$,
  $$select * from (
    select 'member:' || pg_temp.throughput_id(3)::text, 1
    union all select 'service:' || invoker::text, 2 from throughput_exact_roles
    union all select 'unknown'::text, 1
  ) expected(key, count) order by key$$,
  'person buckets use the exact invoker and leave unattributed merged changes visible');
select ok((select count(*) = 1 and bool_and(item->>'runId' is not null and item->>'modelName' is null
  and item->>'agentId' is null and item->>'definitionRevisionId' is null)
  from jsonb_array_elements(pg_temp.throughput_page('model', 'unknown')->'items') item),
  'a linked run without its immutable input manifest keeps unknown producer fields');
select ok((select count(*) = 2 and count(distinct item->>'mergeObservationId') = 1
  and count(distinct item->>'runId') = 2 and count(distinct item->>'agentId') = 1
  and count(distinct item->>'agentPromptRevisionId') = 1 and count(distinct item->>'harness') = 2
  and count(distinct item->>'workerRuntime') = 2 and bool_and(item->>'definitionDigest' is not null)
  from jsonb_array_elements(pg_temp.throughput_page('source', 'api')->'items') item),
  'exact attempt evidence retains both producing runs and their historical named-agent and configuration identities');
select ok((select count(*) = 2 and bool_and(page.result->>'rolesVisibility' = 'redacted'
    and (item->>'invokingActorServicePrincipalId')::uuid = expected.invoker
    and item->'credentialOwnerMemberId' = 'null'::jsonb and item->'credentialOwnerServicePrincipalId' = 'null'::jsonb
    and item->'budgetPayerMemberId' = 'null'::jsonb)
  from (select pg_temp.throughput_page('source', 'api') result) page
  cross join lateral jsonb_array_elements(page.result->'items') item cross join throughput_exact_roles expected),
  'ordinary factory members see the actual invoker while separate credential and payer identities stay private');

set local request.jwt.claim.sub = '59500000-0000-4000-8000-000000000001';
select ok((select count(*) = 2 and bool_and(page.result->>'rolesVisibility' = 'full'
    and (item->>'invokingActorServicePrincipalId')::uuid = expected.invoker
    and (item->>'credentialOwnerServicePrincipalId')::uuid = expected.credential_owner
    and (item->>'budgetPayerMemberId')::uuid = expected.payer
    and (item->>'definitionRevisionId')::uuid = expected.definition_revision_id
    and (item->>'requestSourceReceiptId')::uuid = expected.creation_receipt_id
    and item->'invokingActorMemberId' = 'null'::jsonb and expected.payer = pg_temp.throughput_id(5))
  from (select pg_temp.throughput_page('source', 'api') result) page
  cross join lateral jsonb_array_elements(page.result->'items') item
  cross join throughput_exact_roles expected),
  'the machine invoker, credential owner and human budget payer retain separate exact stored roles');
with first as materialized (
  select pg_temp.throughput_page('source', 'api', 1) result
), next as (
  select public.list_factory_throughput_contributions(pg_temp.throughput_id(2), pg_temp.throughput_factory_id(),
    statement_timestamp() - interval '1 hour', statement_timestamp(), 'source', 'api', 1,
    (result #>> '{nextCursor,at}')::timestamptz, (result #>> '{nextCursor,mergeId}')::uuid,
    (result #>> '{nextCursor,runId}')::uuid, (result #>> '{nextCursor,attemptCount}')::integer) result
  from first
)
select ok((select jsonb_array_length(first.result->'items') = 1 and jsonb_array_length(next.result->'items') = 1
    and first.result #>> '{items,0,mergeId}' = next.result #>> '{items,0,mergeId}'
    and first.result #>> '{items,0,runId}' <> next.result #>> '{items,0,runId}'
    and next.result->'nextCursor' = 'null'::jsonb
  from first cross join next), 'keyset pagination returns both distinct attempts contributing to the same PR once');

reset role;
select * from finish();
rollback;
