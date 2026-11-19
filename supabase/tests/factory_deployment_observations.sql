begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.deployment_id(slot integer) returns uuid language sql immutable as $$
  select ('59200000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
create function pg_temp.deployment_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.deployment_id(4) and is_default
$$;
insert into auth.users(id, email) values
  (pg_temp.deployment_id(1), 'deployment-owner@example.test'),
  (pg_temp.deployment_id(2), 'deployment-member@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.deployment_id(4), 'deployment-observation-fixture', 'Deployment observations');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.deployment_id(11), pg_temp.deployment_id(4), pg_temp.deployment_id(1), 'human', 'owner'),
  (pg_temp.deployment_id(12), pg_temp.deployment_id(4), pg_temp.deployment_id(2), 'human', 'member');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.deployment_id(21), pg_temp.deployment_id(4), 59200001,
  'https://github.test/installations/59200001', 59200, 'Organization', 'deployment-fixture', '{"contents":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
values (pg_temp.deployment_id(22), pg_temp.deployment_id(4), pg_temp.deployment_factory(), pg_temp.deployment_id(21),
  592001, 'deployments', 'fixture/deployments', true, 'https://github.test/fixture/deployments', 'main');
select public.save_execution_policy(pg_temp.deployment_id(4), pg_temp.deployment_id(1), 0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
select public.create_service_principal(pg_temp.deployment_id(4), pg_temp.deployment_factory(),
  pg_temp.deployment_id(1), 'Observer', 'observer');
select public.create_service_principal(pg_temp.deployment_id(4), pg_temp.deployment_factory(),
  pg_temp.deployment_id(1), 'Other observer', 'other-observer');

create temp table deployment_grants as
select principal.slug, approved.* from public.service_principals principal
join public.execution_policies policy on policy.workspace_id = principal.workspace_id
cross join lateral public.approve_factory_execution_grant(pg_temp.deployment_id(4), pg_temp.deployment_factory(),
  pg_temp.deployment_id(1), principal.id, pg_temp.deployment_id(22), '{}', '{}', policy.current_revision_id,
  pg_temp.deployment_id(11), clock_timestamp() + interval '1 hour', 0, null,
  '{deployments:observe,sessions:read}'::public.factory_command_scope[]) approved
where principal.workspace_id = pg_temp.deployment_id(4);

select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.deployment_id(1), id, version,
  pg_temp.deployment_id(case when slug = 'observer' then 31 else 32 end), repeat('a', 64), 'Observation token', '{deployments:observe}')
from deployment_grants;
select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.deployment_id(1), id, version, pg_temp.deployment_id(33),
  repeat('a', 64), 'Read-only factory token', '{sessions:read}') from deployment_grants where slug = 'observer';
select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.deployment_id(1), id, version, pg_temp.deployment_id(34),
  repeat('a', 64), 'Mixed factory token', '{sessions:read,deployments:observe}') from deployment_grants where slug = 'observer';

create function pg_temp.deployment_mcp_resource() returns text language sql stable as $$
  select 'https://wallie.example.test/api/v1/workspaces/' || pg_temp.deployment_id(4)
    || '/factories/' || pg_temp.deployment_factory() || '/mcp'
$$;
select results_eq(
  $$select * from public.inspect_factory_mcp_identity(pg_temp.deployment_id(4), pg_temp.deployment_factory(),
    'machine_token', pg_temp.deployment_id(31), repeat('a',64), pg_temp.deployment_mcp_resource())$$,
  $$values ('forbidden'::text, '{}'::public.factory_command_scope[])$$,
  'observe-only credentials cannot initialize an MCP resource'
);
select results_eq(
  $$select * from public.inspect_factory_mcp_identity(pg_temp.deployment_id(4), pg_temp.deployment_factory(),
    'machine_token', pg_temp.deployment_id(34), repeat('a',64), pg_temp.deployment_mcp_resource())$$,
  $$values ('authorized'::text, '{sessions:read}'::public.factory_command_scope[])$$,
  'mixed credentials expose only their MCP scope at resource discovery'
);
select is((select status::text from public.admit_factory_command(pg_temp.deployment_id(4),
  pg_temp.deployment_factory(), 'machine_token', pg_temp.deployment_id(34), repeat('a',64), 'deployments:observe',
  pg_temp.deployment_id(100), repeat('b',64), 'mcp', pg_temp.deployment_mcp_resource())),
  'forbidden', 'MCP cannot reserve API observation authority even for a mixed credential');
select ok((select isfinite(live_from) and live_from <= clock_timestamp()
  from internal.factory_outcome_capture_coverage where source = 'deployments'),
  'the deployment feed has an explicit installation boundary');

create function pg_temp.approve_deployment_source(p_environment text, p_trusted boolean,
  p_user_id uuid default pg_temp.deployment_id(1)) returns jsonb language sql as $$
  select public.approve_factory_deployment_source(workspace_id, factory_id, p_user_id, id, version,
    'test-deployer', 'project-592', p_environment, p_trusted)
  from deployment_grants where slug = 'observer'
$$;

select throws_ok($$select pg_temp.approve_deployment_source('production', true, pg_temp.deployment_id(2))$$,
  '42501', 'Factory manager access is required.', 'ordinary member cannot approve a deployment source');
create temp table deployment_sources as
select pg_temp.approve_deployment_source('production', true) as result
union all select pg_temp.approve_deployment_source('staging', false);
create function pg_temp.deployment_source(p_environment text default 'production') returns uuid language sql stable as $$
  select (result->>'sourceId')::uuid from deployment_sources where result->>'environment' = p_environment
$$;
select is((select result->>'repositoryId' from deployment_sources where result->>'environment' = 'production'),
  pg_temp.deployment_id(22)::text, 'approval pins the repository owned by the exact grant');
select throws_ok($$select pg_temp.approve_deployment_source('production', true)$$,
  'PT409', 'A deployment source is already approved for this environment.', 'one authority owns an active source scope');

create function pg_temp.deployment_admit(
  p_request integer, p_token integer default 31, p_scope public.factory_command_scope default 'deployments:observe',
  p_factory_id uuid default pg_temp.deployment_factory()
) returns table (status public.factory_command_admission_status, admission_id uuid, lease_id uuid) language sql as $$
  select admitted.status, admitted.admission_id, admitted.lease_id
  from public.admit_factory_command(pg_temp.deployment_id(4), p_factory_id, 'machine_token',
    pg_temp.deployment_id(p_token), repeat('a', 64), p_scope, pg_temp.deployment_id(p_request), repeat('b', 64), 'api') admitted
$$;

create function pg_temp.deployment_report(
  p_request integer, p_revision integer, p_outcome text, p_source uuid default pg_temp.deployment_source(),
  p_environment text default 'production', p_token integer default 31, p_external_id text default 'deploy-001',
  p_sha text default repeat('c', 40), p_provider_time timestamptz default '2026-01-01T01:00:00Z'
) returns jsonb language plpgsql as $$
declare permit record; response jsonb;
begin
  select * into strict permit from pg_temp.deployment_admit(p_request, p_token);
  if permit.status <> 'admitted' then raise exception 'Fixture admission failed (%).', permit.status; end if;
  response := public.execute_factory_deployment_observation(pg_temp.deployment_id(4), pg_temp.deployment_factory(),
    'machine_token', pg_temp.deployment_id(p_token), repeat('a', 64), pg_temp.deployment_id(p_request), repeat('b', 64),
    'api', permit.admission_id, permit.lease_id, p_source, p_environment, p_external_id, p_revision, p_outcome,
    p_sha, p_provider_time);
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  return response;
end;
$$;

select is((select status::text from pg_temp.deployment_admit(101, p_token => 33)), 'forbidden',
  'session read authority cannot report deployment evidence');
select is((select status::text from pg_temp.deployment_admit(102, p_scope => 'sessions:cancel')), 'forbidden',
  'an observe-only token cannot cancel a session');
select is((select status::text from pg_temp.deployment_admit(103, p_factory_id => pg_temp.deployment_id(9))), 'unauthorized',
  'credential outside its factory cannot reserve a permit');
select throws_ok($$select pg_temp.deployment_report(104, 1, 'succeeded', p_environment => 'staging')$$,
  'PT403', 'Deployment source or environment is not authorized.', 'factory-issued token cannot report to a different environment');
select throws_ok($$select pg_temp.deployment_report(105, 1, 'succeeded', p_token => 32)$$,
  'PT403', 'Deployment source or environment is not authorized.', 'another scoped observer cannot impersonate the approved reporter');
select is((select count(*) from internal.factory_deployments where workspace_id = pg_temp.deployment_id(4)),
  0::bigint, 'denied observations create no identity or facts');

create temp table deployment_observed(label text primary key, result jsonb);
insert into deployment_observed values
  ('failed', pg_temp.deployment_report(111, 2, 'failed')),
  ('late success', pg_temp.deployment_report(112, 1, 'succeeded')),
  ('exact replay', pg_temp.deployment_report(113, 2, 'failed'));
select is((select count(*) from internal.factory_deployments where workspace_id = pg_temp.deployment_id(4)),
  1::bigint, 'provider revisions keep one logical deployment');
select is((select count(*) from internal.factory_deployment_observation_revisions where workspace_id = pg_temp.deployment_id(4)),
  2::bigint, 'exact request replay adds no revision');
select is((select count(*) from internal.factory_outcome_observations
  where workspace_id = pg_temp.deployment_id(4) and event_type = 'deployment.observed'),
  2::bigint, 'outcome ledger adds one observation per accepted provider revision');
select is((select outcome from internal.factory_current_deployment_observations where workspace_id = pg_temp.deployment_id(4)),
  'failed', 'reordered stale success cannot replace the effective newer failure');
select is((select result->>'currentRevision' from deployment_observed where label = 'late success'), '2',
  'receipt explicitly identifies a newer current revision');
select is(
  (select result->>'observationId' from deployment_observed where label = 'exact replay'),
  (select result->>'observationId' from deployment_observed where label = 'failed'),
  'exact replay returns the original immutable receipt');
select throws_ok($$select pg_temp.deployment_report(114, 2, 'succeeded')$$,
  'PT409', 'This deployment revision identifies a different observation.', 'different payload for existing revision is rejected');

insert into deployment_observed values
  ('untrusted success', pg_temp.deployment_report(115, 1, 'succeeded',
    p_source => pg_temp.deployment_source('staging'), p_environment => 'staging', p_sha => repeat('d', 40))),
  ('changed success', pg_temp.deployment_report(116, 3, 'succeeded', p_sha => repeat('d', 40),
    p_provider_time => '2026-01-02T03:00:00Z')),
  ('unknown', pg_temp.deployment_report(117, 1, 'unknown', p_external_id => 'deploy-002',
    p_sha => null, p_provider_time => null)),
  ('pending', pg_temp.deployment_report(118, 1, 'pending', p_external_id => 'deploy-003',
    p_provider_time => clock_timestamp() + interval '1 day'));
select ok((select authoritative_occurred_at = '2026-01-02T03:00:00Z'::timestamptz
  and provider_occurred_at < observed_at and repository_id = pg_temp.deployment_id(22) and source_sha = repeat('d',40)
  from internal.factory_current_deployment_observations where workspace_id = pg_temp.deployment_id(4)
    and environment = 'production' and external_deployment_id = 'deploy-001' and revision = 3 and outcome = 'succeeded'),
  'correction preserves authoritative source time and exact source-change key beside distinct receipt time');
select ok((select provider_occurred_at is not null and authoritative_occurred_at is null
  from internal.factory_current_deployment_observations where workspace_id = pg_temp.deployment_id(4) and environment = 'staging'),
  'an unauthorized source clock remains visible without qualifying as an authoritative timestamp');
select ok((select source_sha is null and provider_occurred_at is null and authoritative_occurred_at is null and observed_at is not null
  from internal.factory_current_deployment_observations where workspace_id = pg_temp.deployment_id(4) and external_deployment_id = 'deploy-002'),
  'unknown source identity and time remain unknown');
select ok((select outcome = 'pending' and provider_occurred_at > observed_at and authoritative_occurred_at is null
  from internal.factory_current_deployment_observations where workspace_id = pg_temp.deployment_id(4) and external_deployment_id = 'deploy-003'),
  'a future provider time cannot be accepted as authoritative');
select isnt(
  (select result->>'deploymentId' from deployment_observed where label = 'untrusted success'),
  (select result->>'deploymentId' from deployment_observed where label = 'changed success'),
  'the same provider identity in two environments cannot share evidence');
select throws_ok($$update internal.factory_deployment_observation_revisions set outcome = 'unknown'
  where workspace_id = pg_temp.deployment_id(4)$$, '23514', 'Factory deployment evidence is immutable.',
  'subsequent observations cannot overwrite evidence');

insert into public.pipelines(id, workspace_id, factory_id, name, is_default) values
  (pg_temp.deployment_id(40), pg_temp.deployment_id(4), pg_temp.deployment_factory(), 'Linkage fixture', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md) values
  (pg_temp.deployment_id(41), pg_temp.deployment_id(40), pg_temp.deployment_id(4), 1, 'review', 'Review', 'Review the change.');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
values (pg_temp.deployment_id(23), pg_temp.deployment_id(4), pg_temp.deployment_factory(), pg_temp.deployment_id(21),
  592002, 'other-deployments', 'fixture/other-deployments', true, 'https://github.test/fixture/other-deployments', 'main');

create function pg_temp.observe_deployment_merge(p_number integer, p_repository_id uuid, p_merge_time timestamptz)
returns boolean language plpgsql as $$
declare
  repository public.github_repositories;
  session_id uuid := pg_temp.deployment_id(1000 + p_number);
  epoch_id uuid := pg_temp.deployment_id(2000 + p_number);
  branch_name text := 'wallie/sessions/' || session_id::text || '/' || epoch_id::text;
  pr_url text;
  observation_id uuid;
begin
  select * into strict repository from public.github_repositories where id = p_repository_id;
  pr_url := 'https://github.test/' || repository.full_name || '/pull/' || p_number::text;
  insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id,
    current_stage_id, github_repository_id, created_at)
  values(session_id, repository.workspace_id, repository.factory_id, p_number, 'Deployment linkage session',
    pg_temp.deployment_id(11), pg_temp.deployment_id(40), pg_temp.deployment_id(41), repository.id,
    '2026-01-01T00:00:00Z');
  insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
  values(session_id, repository.workspace_id, repository.id, repository.full_name, 'main', repeat('a', 40));
  insert into public.session_pr_epochs(id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
    github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft, pr_head_sha)
  values(epoch_id, session_id, repository.workspace_id, 1, repository.id, repository.full_name, repository.repo_id,
    'main', branch_name, 'refs/wallie/fences/' || epoch_id::text, p_number, pr_url, 'open', false, repeat('e', 40));
  observation_id := public.begin_session_pr_observation(repository.workspace_id, repository.id, branch_name, p_number);
  return public.finish_session_pr_observation_with_merge(
    observation_id, pr_url, 'merged', false, repeat('e', 40), p_merge_time + interval '1 minute',
    p_merge_time, repeat('d', 40), repeat('e', 40));
end;
$$;

select pg_temp.deployment_report(119, 1, 'succeeded', p_external_id => 'before-merge',
  p_sha => repeat('d', 40), p_provider_time => '2026-01-01T12:00:00Z');
select pg_temp.deployment_report(120, 1, 'pending', p_external_id => 'pending-exact',
  p_sha => repeat('d', 40), p_provider_time => '2026-01-02T03:00:00Z');
select is((select count(*) from internal.current_factory_linked_deployment_deliveries
  where workspace_id = pg_temp.deployment_id(4)), 0::bigint,
  'trusted deployment arriving before merge proof stays unlinked');
select ok(pg_temp.observe_deployment_merge(201, pg_temp.deployment_id(23), '2026-01-02T01:00:00Z'),
  'the actual fenced observer accepts the other repository merge');
select is((select count(*) from internal.current_factory_linked_deployment_deliveries
  where workspace_id = pg_temp.deployment_id(4)), 0::bigint, 'an identical commit in another repository stays unlinked');
select ok(pg_temp.observe_deployment_merge(202, pg_temp.deployment_id(22), '2026-01-02T01:00:00Z'),
  'fenced canonical proof links the exact commit in the approved repository');
select results_eq(
  $$select delivery.session_id, delivery.deployment_observation_id, delivery.deployed_at - session.created_at
    from internal.current_factory_linked_deployment_deliveries delivery
    join public.sessions session on session.id = delivery.session_id
    where delivery.workspace_id = pg_temp.deployment_id(4)$$,
  $$select pg_temp.deployment_id(1202), (result->>'observationId')::uuid, interval '27 hours'
    from deployment_observed where label = 'changed success'$$,
  'only an exact authoritative post-merge success contributes source-time delivery duration');
select ok((select delivery.merge_observation_id = merge.observation_id and delivery.canonical_merge_id = merge.id
    and delivery.deployed_at < delivery.deployment_observed_at
  from internal.current_factory_linked_deployment_deliveries delivery
  join internal.current_factory_canonical_pull_request_merges merge on merge.session_id = delivery.session_id
  where delivery.workspace_id = pg_temp.deployment_id(4)),
  'linked delivery retains both exact source observations and the distinct receipt clock');

select pg_temp.deployment_report(123, 4, 'failed', p_sha => repeat('d', 40),
  p_provider_time => '2026-01-02T04:00:00Z');
select is((select count(*) from internal.current_factory_linked_deployment_deliveries
  where workspace_id = pg_temp.deployment_id(4)), 0::bigint,
  'a newer failed correction retracts the effective successful link');
select pg_temp.deployment_report(124, 5, 'succeeded', p_sha => repeat('d', 40),
  p_provider_time => '2026-01-02T05:00:00Z');
select is((select revision from internal.current_factory_linked_deployment_deliveries
  where workspace_id = pg_temp.deployment_id(4)), 5, 'a later restored success links its own current revision');
select ok(pg_temp.observe_deployment_merge(203, pg_temp.deployment_id(22), '2026-01-02T07:00:00Z'),
  'a second authoritative PR may report the same repository commit');
select is((select count(*) from internal.current_factory_linked_deployment_deliveries
  where workspace_id = pg_temp.deployment_id(4)), 0::bigint,
  'competing canonical matches stay ambiguous before any time filter');
select ok((select count(*) > 0 from internal.factory_current_deployment_observations
  where workspace_id = pg_temp.deployment_id(4) and outcome = 'succeeded'),
  'ambiguous association leaves raw successful reports available');

create temp table deployment_prior_permit as select * from pg_temp.deployment_admit(121);
select public.revoke_factory_deployment_source(pg_temp.deployment_id(4), pg_temp.deployment_factory(),
  pg_temp.deployment_id(1), pg_temp.deployment_source());
select throws_ok($$select public.execute_factory_deployment_observation(pg_temp.deployment_id(4), pg_temp.deployment_factory(),
  'machine_token', pg_temp.deployment_id(31), repeat('a',64), pg_temp.deployment_id(121), repeat('b',64), 'api',
  prior.admission_id, prior.lease_id, pg_temp.deployment_source(), 'production', 'deploy-001', 6, 'succeeded')
  from deployment_prior_permit prior$$,
  'PT403', 'Deployment source or environment is not authorized.', 'revocation denies a previously reserved permit');
select public.release_factory_command_admission(admission_id, lease_id) from deployment_prior_permit;
select ok((select outcome = 'succeeded' and revision = 5 from internal.factory_current_deployment_observations
  where workspace_id = pg_temp.deployment_id(4) and environment = 'production' and external_deployment_id = 'deploy-001'),
  'revocation preserves previously committed history');
create temp table replacement_source as select pg_temp.approve_deployment_source('production', true) as result;
select is((pg_temp.deployment_report(122, 6, 'succeeded',
  p_source => (select (result->>'sourceId')::uuid from replacement_source))
  ->>'deploymentId'), (select result->>'deploymentId' from deployment_observed where label = 'changed success'),
  'replacement source approval preserves the logical deployment identity');

select ok(not has_table_privilege('authenticated', 'internal.factory_deployment_sources', 'select')
  and not has_table_privilege('service_role', 'internal.factory_deployment_observation_revisions', 'insert')
  and not has_table_privilege('service_role', 'internal.factory_current_deployment_observations', 'select')
  and not has_table_privilege('service_role', 'internal.current_factory_linked_deployment_deliveries', 'select')
  and not has_function_privilege('authenticated', 'public.approve_factory_deployment_source(uuid,uuid,uuid,uuid,bigint,text,text,text,boolean)', 'execute'),
  'source identities and observations stay behind the privileged boundaries');

select * from finish();
rollback;
