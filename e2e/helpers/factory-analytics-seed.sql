begin;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.seed_factory_analytics(
  owner_user uuid, owner_email text, viewer_user uuid, viewer_email text, fixture_slug text,
  numeric_repository bigint, window_days integer
) returns jsonb language plpgsql as $$
declare
  workspace public.workspaces;
  factory public.factories;
  sibling public.factories;
  owner_member uuid;
  viewer_member uuid;
  pipeline uuid := gen_random_uuid();
  stage uuid := gen_random_uuid();
  sibling_pipeline uuid := gen_random_uuid();
  sibling_stage uuid := gen_random_uuid();
  installation uuid := gen_random_uuid();
  repository uuid := gen_random_uuid();
  repo_name text := 'wallie-analytics-fixtures/' || fixture_slug;
  delivered uuid := gen_random_uuid();
  canceled uuid := gen_random_uuid();
  restricted_session uuid := gen_random_uuid();
  job uuid := gen_random_uuid();
  retry_job uuid := gen_random_uuid();
  canceled_job uuid := gen_random_uuid();
  producing_run uuid := gen_random_uuid();
  failed_run uuid := gen_random_uuid();
  epoch uuid := gen_random_uuid();
  branch text := 'wallie/sessions/' || delivered::text || '/' || epoch::text;
  pr_url text := 'https://github.com/' || repo_name || '/pull/314';
  head_sha text := repeat('a', 40);
  merge_sha text := repeat('b', 40);
  today_utc timestamptz := date_trunc('day', now(), 'UTC');
  requested_at timestamptz := today_utc - interval '96 hours' + interval '9 hours';
  prior_requested_at timestamptz := today_utc - (window_days + 3) * interval '24 hours' + interval '9 hours';
  merge_at timestamptz := requested_at + interval '3 hours';
  canonical internal.current_factory_canonical_pull_request_merges;
  request_observation uuid;
  deployment jsonb;
  policy public.execution_policy_revisions;
  reporter public.service_principals;
  approved record;
  permit record;
  deployment_source uuid;
  token_id uuid := gen_random_uuid();
  physical_request uuid := gen_random_uuid();
  token_digest text := encode(sha256(convert_to(token_id::text, 'UTF8')), 'hex');
  command_digest text := encode(sha256(convert_to(physical_request::text, 'UTF8')), 'hex');
  admission_gate record;
  gate_revision bigint;
  batch jsonb;
begin
  select * into strict workspace from public.create_workspace(owner_user, 'Analytics qualification',
    fixture_slug, owner_email, 'Morgan Example');
  select member.id into strict owner_member from public.workspace_members member
  where (member.workspace_id, member.user_id) = (workspace.id, owner_user);
  insert into public.workspace_members(workspace_id, user_id, kind, role, email, full_name)
  values (workspace.id, viewer_user, 'human', 'member', viewer_email, 'Jamie Example') returning id into viewer_member;
  select * into strict factory from public.create_factory(workspace.id, owner_user, 'Product delivery', 'product-delivery');
  select * into strict sibling from public.create_factory(workspace.id, owner_user, 'Restricted delivery', 'restricted-delivery');
  perform public.grant_factory_membership(workspace.id, factory.id, owner_user, viewer_member, 'member');
  update public.workspace_onboarding set status = 'completed', completed_at = now() where workspace_id = workspace.id;

  insert into public.pipelines(id, workspace_id, factory_id, name)
  values (pipeline, workspace.id, factory.id, 'Analytics fixture pipeline'),
    (sibling_pipeline, workspace.id, sibling.id, 'Restricted fixture pipeline');
  insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md)
  values (stage, pipeline, workspace.id, 1, 'delivery', 'Delivery', 'Prepare the verified change.'),
    (sibling_stage, sibling_pipeline, workspace.id, 1, 'delivery', 'Delivery', 'Retain the separate scope.');
  insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id,
    target_type, target_name, permissions)
  values (installation, workspace.id, numeric_repository + 1, 'https://github.com/settings/installations', 597001,
    'Organization', 'wallie-analytics-fixtures', '{"contents":"write","pull_requests":"write"}');
  insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
    name, full_name, private, html_url, default_branch)
  values (repository, workspace.id, factory.id, installation, numeric_repository, fixture_slug, repo_name,
    true, 'https://github.com/' || repo_name, 'main');

  insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id,
    current_stage_id, github_repository_id, created_at)
  values (delivered, workspace.id, factory.id, 71, 'Ship invoice reconciliation', owner_member,
      pipeline, stage, repository, requested_at),
    (canceled, workspace.id, factory.id, 72, 'Canceled reporting request', owner_member,
      pipeline, stage, repository, prior_requested_at);
  insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id, created_at)
  values (restricted_session, workspace.id, sibling.id, 73, 'Restricted outcome canary', owner_member,
    sibling_pipeline, sibling_stage, requested_at);

  -- Seed retained attempts at the database boundary, with actual capture triggers.
  insert into public.agent_jobs(id, workspace_id, session_id, stage_id, requested_by_member_id,
    trigger_type, status, attempt_count, created_at, finished_at)
  values (job, workspace.id, delivered, stage, owner_member, 'assignment', 'error', 1, requested_at,
      requested_at + interval '40 minutes'),
    (retry_job, workspace.id, delivered, stage, owner_member, 'assignment', 'success', 1,
      requested_at + interval '45 minutes', requested_at + interval '2 hours'),
    (canceled_job, workspace.id, canceled, stage, owner_member, 'assignment', 'queued', 0, prior_requested_at, null);
  insert into public.agent_runs(id, workspace_id, session_id, agent_job_id, stage_id, triggered_by_member_id,
    attempt_count, run_type, model_provider, model_name, status, started_at)
  values (failed_run, workspace.id, delivered, job, stage, owner_member, 1, 'code', 'codex', 'gpt-5.5',
      'running', requested_at + interval '10 minutes'),
    (producing_run, workspace.id, delivered, retry_job, stage, owner_member, 1, 'code', 'codex', 'gpt-5.5',
      'running', requested_at + interval '1 hour');
  update public.agent_runs set status = 'error', finished_at = requested_at + interval '40 minutes',
    cost_provenance = 'unavailable' where id = failed_run;
  update public.agent_runs set status = 'success', finished_at = requested_at + interval '2 hours',
    cost_provenance = 'measured', total_cost_usd = 12.5, usage_recorded_at = requested_at + interval '2 hours',
    usage_finalized_at = requested_at + interval '2 hours' where id = producing_run;
  update public.agent_jobs set status = 'canceled', finished_at = prior_requested_at + interval '30 minutes'
  where id = canceled_job;

  select * into strict admission_gate from public.get_git_continuity_release_state();
  if not admission_gate.enabled then
    select revision into strict gate_revision from public.set_git_continuity_release(true, admission_gate.revision,
      'Disposable Analytics browser qualification');
  end if;
  insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name,
    base_branch, initial_base_sha)
  values (delivered, workspace.id, repository, repo_name, 'main', head_sha);
  insert into public.session_pr_epochs(id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
    github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft, pr_head_sha, created_at)
  values (epoch, delivered, workspace.id, 1, repository, repo_name, numeric_repository, 'main', branch,
    'refs/wallie/fences/' || epoch::text, 314, pr_url, 'open', false, head_sha, merge_at - interval '1 hour');
  if not public.finish_session_pr_observation_with_merge(
    public.begin_session_pr_observation(workspace.id, repository, branch, 314),
    pr_url, 'merged', false, head_sha, merge_at, merge_at, merge_sha, head_sha
  ) then raise exception 'The fixture could not observe its canonical merge.'; end if;
  if gate_revision is not null then
    perform public.set_git_continuity_release(false, gate_revision, 'Restore disposable Analytics fixture release state');
  end if;
  select * into strict canonical from internal.current_factory_canonical_pull_request_merges
  where session_id = delivered and status = 'observed';
  insert into internal.factory_canonical_pull_request_merge_runs(observation_id, run_id, attempt_count, operation_id)
  values (canonical.observation_id, producing_run, 1, gen_random_uuid());
  select id into strict request_observation from internal.factory_outcome_observations
  where session_id = delivered and event_type = 'session.created';

  select * into strict policy from public.save_execution_policy(workspace.id, owner_user, 0,
    '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
  select * into strict reporter from public.create_service_principal(workspace.id, factory.id, owner_user,
    'Deployment evidence observer', 'deployment-observer');
  select * into strict approved from public.approve_factory_execution_grant(workspace.id, factory.id, owner_user,
    reporter.id, repository, '{}', '{}', policy.id, owner_member, clock_timestamp() + interval '1 hour', 0, null,
    '{deployments:observe}');
  deployment_source := (public.approve_factory_deployment_source(workspace.id, factory.id, owner_user, approved.id,
    approved.version, 'fixture-provider', fixture_slug, 'production', true)->>'sourceId')::uuid;
  perform public.issue_factory_machine_token(workspace.id, factory.id, owner_user, approved.id, approved.version,
    token_id, token_digest, 'Local deployment observer', '{deployments:observe}');
  select * into strict permit from public.admit_factory_command(workspace.id, factory.id, 'machine_token',
    token_id, token_digest, 'deployments:observe', physical_request, command_digest, 'api');
  deployment := public.execute_factory_deployment_observation(workspace.id, factory.id, 'machine_token',
    token_id, token_digest, physical_request, command_digest, 'api', permit.admission_id, permit.lease_id,
    deployment_source, 'production', 'fixture-314', 1, 'succeeded', merge_sha, merge_at + interval '1 hour');
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  if deployment->>'observationId' is null then raise exception 'The fixture could not observe its deployment.'; end if;

  for iteration in 1..20 loop
    batch := public.process_factory_flow_projection(50);
    exit when not (batch->>'hasMore')::boolean;
  end loop;
  if (batch->>'hasMore')::boolean then raise exception 'The disposable projection queue did not drain.'; end if;

  return jsonb_build_object('workspaceId', workspace.id, 'slug', workspace.slug, 'factoryId', factory.id,
    'siblingFactoryId', sibling.id, 'from', (today_utc at time zone 'UTC')::date - window_days,
    'to', (today_utc at time zone 'UTC')::date, 'comparisonFrom', (today_utc at time zone 'UTC')::date - 2 * window_days,
    'deliveredSessionId', delivered, 'deliveredSessionNumber', 71, 'producingRunId', producing_run,
    'failedRunId', failed_run, 'mergeId', canonical.id, 'mergeObservationId', canonical.observation_id,
    'requestObservationId', request_observation, 'deploymentObservationId', deployment->>'observationId',
    'prUrl', pr_url, 'ownerMemberId', owner_member, 'pipelineId', pipeline, 'stageId', stage);
end;
$$;

select pg_temp.seed_factory_analytics(:'owner_id'::uuid, :'owner_email', :'viewer_id'::uuid, :'viewer_email',
  :'workspace_slug', :'repository_numeric_id'::bigint, :'window_days'::integer);
commit;
