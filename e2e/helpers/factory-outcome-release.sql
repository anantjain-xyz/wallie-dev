begin;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.observe_release_merge(p_epoch public.session_pr_epochs, p_updated timestamptz,
  p_merged timestamptz, p_sha text) returns boolean language sql as $$
  select public.finish_session_pr_observation_with_merge(
    public.begin_session_pr_observation(p_epoch.workspace_id, p_epoch.repository_id, p_epoch.branch_name, p_epoch.pr_number),
    p_epoch.pr_url, 'merged', false, p_epoch.pr_head_sha, p_updated, p_merged, p_sha, p_epoch.pr_head_sha)
$$;

create function pg_temp.release_deployment(p_workspace uuid, p_factory uuid, p_external_id text,
  p_revision integer, p_sha text, p_time timestamptz) returns uuid language plpgsql as $$
declare source_id uuid; token_id uuid; token_digest text; permit record; result jsonb;
  physical_id uuid := gen_random_uuid();
  request_hash text := encode(sha256(convert_to(physical_id::text, 'UTF8')), 'hex');
begin
  select source.id, token.id, digest.digest into strict source_id, token_id, token_digest
  from internal.factory_deployment_sources source
  join public.factory_machine_tokens token on (token.workspace_id, token.factory_id, token.name) =
    (source.workspace_id, source.factory_id, 'Local deployment observer')
  join internal.factory_machine_token_digests digest on digest.token_id = token.id
  where (source.workspace_id, source.factory_id, source.environment) = (p_workspace, p_factory, 'production');
  select * into strict permit from public.admit_factory_command(p_workspace, p_factory, 'machine_token',
    token_id, token_digest, 'deployments:observe', physical_id, request_hash, 'api');
  if permit.status <> 'admitted' then raise exception 'Local deployment command was not admitted.'; end if;
  result := public.execute_factory_deployment_observation(p_workspace, p_factory, 'machine_token',
    token_id, token_digest, physical_id, request_hash, 'api', permit.admission_id, permit.lease_id,
    source_id, 'production', p_external_id, p_revision, 'succeeded', p_sha, p_time);
  perform public.release_factory_command_admission(permit.admission_id, permit.lease_id);
  return (result->>'observationId')::uuid;
end;
$$;

create function pg_temp.seed_outcome_release(
  p_workspace uuid, p_factory uuid, p_owner uuid, p_owner_email text, p_slug text, p_today date
) returns jsonb language plpgsql as $$
declare
  delivered public.sessions;
  repository public.github_repositories;
  canceled public.sessions;
  factory_owner uuid;
  today timestamptz := make_timestamptz(extract(year from p_today)::int, extract(month from p_today)::int,
    extract(day from p_today)::int, 0, 0, 0, 'UTC');
  example record;
  new_session uuid;
  new_epoch uuid;
  epoch public.session_pr_epochs;
  current_merge internal.current_factory_canonical_pull_request_merges;
  sha text;
  requested_at timestamptz;
  merged_at timestamptz;
  approval_artifact uuid := gen_random_uuid();
  clarification_id uuid := gen_random_uuid();
  estimated_run uuid := gen_random_uuid();
  producing_attempt public.agent_runs;
  original_attempt public.agent_runs;
  browser_request uuid := gen_random_uuid();
  browser_receipt uuid;
  unknown_session uuid;
  confirmed_merge uuid;
  ambiguous_merge uuid;
  confirmed_relationship uuid;
  coverage_id uuid;
  unlinked_deployment uuid;
  other_workspace public.workspaces;
  other_factory uuid;
begin
  select * into strict delivered from public.sessions where (workspace_id, factory_id, number) = (p_workspace, p_factory, 71);
  select * into strict canceled from public.sessions where (workspace_id, factory_id, number) = (p_workspace, p_factory, 72);
  select * into strict repository from public.github_repositories where id = delivered.github_repository_id;
  factory_owner := delivered.creator_member_id;
  select * into strict original_attempt from public.agent_runs where session_id = delivered.id and status = 'error';
  select * into strict producing_attempt from public.agent_runs where session_id = delivered.id and status = 'success';
  insert into internal.session_creation_requests(workspace_id, creator_member_id, request_id, request_hash,
    session_id, job_id, run_id)
  values (p_workspace, factory_owner, browser_request, repeat('a', 64), delivered.id, original_attempt.agent_job_id,
    original_attempt.id);
  browser_receipt := (internal.record_session_mutation_receipt(
    internal.session_mutation_human_actor(p_workspace, p_factory, factory_owner, delivered.id), 'create',
    browser_request, jsonb_build_object('title', delivered.title), delivered.id,
    jsonb_build_object('jobId', original_attempt.agent_job_id, 'runId', original_attempt.id))->>'receiptId')::uuid;
  insert into public.session_attempt_manifests(run_id, workspace_id, session_id, job_id, attempt_count, stage_id,
    definition_provenance, definition_skill_ids, definition_tool_ids, repository_id, repository_full_name,
    base_branch, initial_base_sha, input_sha, checkout_sha, prompt_sha256, prompt_utf8_bytes, renderer_version,
    predecessors, worker_runtime, run_type, model_provider, model_name)
  values (producing_attempt.id, p_workspace, delivered.id, producing_attempt.agent_job_id, producing_attempt.attempt_count,
    delivered.current_stage_id, 'legacy', '{}', '{}', repository.id, repository.full_name, 'main', repeat('a', 40),
    repeat('a', 40), repeat('a', 40), repeat('b', 64), 48, 3, '[]', 'node', 'code', 'codex', 'gpt-5.5');
  perform internal.record_factory_outcome_observation(p_workspace, p_factory, 'job.queued', 'job',
    original_attempt.agent_job_id::text || ':1', delivered.created_at, p_session_id => delivered.id,
    p_job_id => original_attempt.agent_job_id, p_attempt_count => 1, p_stage_id => delivered.current_stage_id,
    p_actor_member_id => factory_owner, p_status => 'queued');
  perform internal.record_factory_outcome_observation(p_workspace, p_factory, 'job.queued', 'job',
    producing_attempt.agent_job_id::text || ':1', delivered.created_at + interval '45 minutes', p_session_id => delivered.id,
    p_job_id => producing_attempt.agent_job_id, p_attempt_count => 1, p_stage_id => delivered.current_stage_id,
    p_actor_member_id => factory_owner, p_status => 'queued');

  -- Keep an exact estimate and a missing attempt alongside measured retry usage.
  insert into public.agent_runs(id, workspace_id, session_id, stage_id, triggered_by_member_id,
    attempt_count, run_type, model_provider, model_name, status, started_at)
  values (estimated_run, p_workspace, delivered.id, delivered.current_stage_id, factory_owner,
    1, 'code', 'codex', 'gpt-5.5', 'running', delivered.created_at + interval '42 minutes');
  update public.agent_runs set status = 'error', finished_at = delivered.created_at + interval '44 minutes',
    cost_provenance = 'estimated', total_cost_usd = 2.5, usage_recorded_at = delivered.created_at + interval '44 minutes',
    usage_finalized_at = delivered.created_at + interval '44 minutes', usage_estimation_revision = 'outcome-release-price-v1'
  where id = estimated_run;

  -- These retained phase receipts represent historical input at the event boundary.
  perform internal.record_factory_outcome_observation(p_workspace, p_factory, 'review.ready', 'artifact',
    approval_artifact::text, delivered.created_at + interval '2 hours', p_session_id => delivered.id,
    p_stage_id => delivered.current_stage_id, p_artifact_id => approval_artifact, p_status => 'awaiting_review');
  perform internal.record_factory_outcome_observation(p_workspace, p_factory, 'review.clarification_requested', 'clarification',
    clarification_id::text, delivered.created_at + interval '2 hours 10 minutes', p_session_id => delivered.id,
    p_stage_id => delivered.current_stage_id, p_artifact_id => approval_artifact);
  perform internal.record_factory_outcome_observation(p_workspace, p_factory, 'review.clarification_answered', 'clarification',
    clarification_id::text, delivered.created_at + interval '2 hours 20 minutes', p_session_id => delivered.id,
    p_stage_id => delivered.current_stage_id, p_artifact_id => approval_artifact, p_actor_member_id => factory_owner);
  perform internal.record_factory_outcome_observation(p_workspace, p_factory, 'review.approved', 'approval_receipt',
    gen_random_uuid()::text, delivered.created_at + interval '2 hours 30 minutes', p_session_id => delivered.id,
    p_stage_id => delivered.current_stage_id, p_artifact_id => approval_artifact, p_actor_member_id => factory_owner,
    p_status => 'approved');

  for example in select * from (values
    (81, 45, 2, 'Verified mature revert'), (82, 42, 5, 'Ambiguous mature revert'),
    (83, 40, 6, 'Covered mature change'), (84, 38, null, 'Historical merge with missing provider time')
  ) cases(number, days_ago, merge_hours, title)
  loop
    new_session := gen_random_uuid();
    new_epoch := gen_random_uuid();
    requested_at := today - example.days_ago * interval '24 hours' + interval '9 hours';
    merged_at := requested_at + example.merge_hours * interval '1 hour';
    sha := lpad(to_hex(example.number), 40, '0');
    insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id,
      current_stage_id, github_repository_id, created_at)
    values (new_session, p_workspace, p_factory, example.number, example.title, factory_owner,
      delivered.pipeline_id, delivered.current_stage_id, repository.id, requested_at);
    insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name,
      base_branch, initial_base_sha)
    values (new_session, p_workspace, repository.id, repository.full_name, 'main', repeat('a', 40));
    insert into public.session_pr_epochs(id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
      github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft,
      pr_head_sha, created_at, pr_updated_at)
    values (new_epoch, new_session, p_workspace, 1, repository.id, repository.full_name, repository.repo_id, 'main',
      'wallie/sessions/' || new_session::text || '/' || new_epoch::text, 'refs/wallie/fences/' || new_epoch::text,
      314 + example.number, 'https://github.com/' || repository.full_name || '/pull/' || (314 + example.number)::text,
      case when merged_at is null then 'merged' else 'open' end, false, repeat('a', 40), requested_at,
      case when merged_at is null then requested_at + interval '2 hours' end)
    returning * into epoch;
    if merged_at is null then
      unknown_session := new_session;
      continue;
    end if;
    if not pg_temp.observe_release_merge(epoch, merged_at, merged_at, sha) then
      raise exception 'The release fixture could not record an exact original merge.';
    end if;
    select * into strict current_merge from internal.current_factory_canonical_pull_request_merges
    where session_id = new_session and status = 'observed';
    if example.number = 81 then
      confirmed_merge := current_merge.id;
      confirmed_relationship := (public.save_factory_revert_relationship(p_workspace, p_factory, p_owner,
        current_merge.id, 601, 0, gen_random_uuid(), 'confirmed', current_merge.observation_id,
        jsonb_build_object('repositoryNumericId', repository.repo_id, 'baseBranch', 'main', 'pullRequestNumber', 601,
          'mergeCommitSha', repeat('d', 40), 'mergedAt', merged_at + interval '192 hours',
          'updatedAt', merged_at + interval '193 hours'))->>'id')::uuid;
    elsif example.number = 82 then
      ambiguous_merge := current_merge.id;
      perform public.save_factory_revert_relationship(p_workspace, p_factory, p_owner, current_merge.id, 602,
        0, gen_random_uuid(), 'candidate', current_merge.observation_id);
    end if;
  end loop;

  insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
  values (canceled.id, p_workspace, repository.id, repository.full_name, 'main', repeat('a', 40));
  new_epoch := gen_random_uuid();
  insert into public.session_pr_epochs(id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
    github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft,
    pr_head_sha, created_at, pr_updated_at)
  values (new_epoch, canceled.id, p_workspace, 1, repository.id, repository.full_name, repository.repo_id, 'main',
    'wallie/sessions/' || canceled.id::text || '/' || new_epoch::text, 'refs/wallie/fences/' || new_epoch::text, 6023,
    'https://github.com/' || repository.full_name || '/pull/6023', 'closed', false, repeat('a', 40), canceled.created_at,
    canceled.created_at + interval '45 minutes');

  coverage_id := (public.record_factory_revert_coverage(p_workspace, p_factory, p_owner, repository.id, 'main',
    today - interval '1200 hours', today - interval '192 hours', gen_random_uuid())->>'id')::uuid;
  unlinked_deployment := pg_temp.release_deployment(p_workspace, p_factory, 'fixture-unlinked', 1,
    repeat('0', 40), delivered.created_at + interval '3 hours 45 minutes');
  select * into strict other_workspace from public.create_workspace(p_owner, 'Other outcomes workspace',
    p_slug || '-other', p_owner_email, 'Morgan Example');
  select id into strict other_factory from public.factories where workspace_id = other_workspace.id and is_default;
  return jsonb_build_object('verifiedRevertMergeId', confirmed_merge, 'ambiguousRevertMergeId', ambiguous_merge,
    'verifiedRelationshipId', confirmed_relationship, 'revertCoverageId', coverage_id, 'estimatedRunId', estimated_run,
    'browserRequestReceiptId', browser_receipt,
    'unknownSessionId', unknown_session, 'unknownSessionNumber', 84, 'unlinkedDeploymentObservationId', unlinked_deployment,
    'otherWorkspaceId', other_workspace.id, 'otherWorkspaceSlug', other_workspace.slug, 'otherFactoryId', other_factory);
end;
$$;

create function pg_temp.apply_outcome_release_correction(p_workspace uuid, p_factory uuid) returns jsonb language plpgsql as $$
declare
  delivered public.sessions;
  epoch public.session_pr_epochs;
  current_merge internal.current_factory_canonical_pull_request_merges;
  original internal.current_factory_canonical_pull_request_merges;
  original_time timestamptz;
  corrected_time timestamptz;
  corrected_sha text := repeat('e', 40);
  corrected_deployment uuid;
begin
  select * into strict delivered from public.sessions where (workspace_id, factory_id, number) = (p_workspace, p_factory, 71);
  select * into strict epoch from public.session_pr_epochs where session_id = delivered.id;
  select * into strict original from internal.current_factory_canonical_pull_request_merges where session_id = delivered.id;
  original_time := delivered.created_at + interval '3 hours';
  corrected_time := delivered.created_at + interval '3 hours 30 minutes';
  if original.merge_commit_sha <> corrected_sha then
    if not pg_temp.observe_release_merge(epoch, original_time, original_time, repeat('b', 40)) then
      raise exception 'The identical GitHub merge replay was rejected.';
    end if;
    perform pg_temp.observe_release_merge(epoch, original_time - interval '1 minute',
      original_time - interval '2 minutes', repeat('c', 40));
    select * into strict current_merge from internal.current_factory_canonical_pull_request_merges where session_id = delivered.id;
    if (current_merge.status, current_merge.observation_id) is distinct from ('observed', original.observation_id) then
      raise exception 'Duplicate or older GitHub evidence changed the settled merge.';
    end if;
    if not pg_temp.observe_release_merge(epoch, original_time, original_time, repeat('c', 40)) then
      raise exception 'The equal-time conflicting GitHub observation was rejected.';
    end if;
    select * into strict current_merge from internal.current_factory_canonical_pull_request_merges where session_id = delivered.id;
    if current_merge.status <> 'conflicting' or current_merge.observation_id is not null then
      raise exception 'Conflicting GitHub evidence was incorrectly counted.';
    end if;
  end if;
  if not pg_temp.observe_release_merge(epoch, corrected_time, corrected_time, corrected_sha) then
    raise exception 'The newer GitHub merge correction was rejected.';
  end if;
  select * into strict current_merge from internal.current_factory_canonical_pull_request_merges where session_id = delivered.id;
  if (current_merge.id, current_merge.status, current_merge.merge_commit_sha) is distinct from
      (original.id, 'observed', corrected_sha) then raise exception 'The corrected merge changed canonical identity.'; end if;
  -- The provider corrected only merge SHA/time. The source head and exact
  -- producing attempt remain the same throughout this retained fixture.
  insert into internal.factory_canonical_pull_request_merge_runs(observation_id, run_id, attempt_count, operation_id)
  select current_merge.observation_id, source.run_id, source.attempt_count, source.operation_id
  from internal.factory_canonical_pull_request_merge_runs source where source.observation_id = original.observation_id
  on conflict do nothing;
  corrected_deployment := pg_temp.release_deployment(p_workspace, p_factory, 'fixture-314', 2,
    corrected_sha, delivered.created_at + interval '5 hours');
  return jsonb_build_object('mergeObservationId', current_merge.observation_id,
    'deploymentObservationId', corrected_deployment);
end;
$$;

\if :qualify_seed
  select pg_temp.seed_outcome_release(:'workspace_id'::uuid, :'factory_id'::uuid, :'owner_id'::uuid,
    :'owner_email', :'slug', :'today'::date);
\elif :qualify_correct
  select pg_temp.apply_outcome_release_correction(:'workspace_id'::uuid, :'factory_id'::uuid);
\elif :qualify_sibling
  insert into public.sessions(workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id)
  select workspace_id, factory_id, 75, 'A pending sibling outcome request', creator_member_id, pipeline_id, current_stage_id
  from public.sessions where (workspace_id, factory_id, number) = (:'workspace_id'::uuid, :'sibling_factory_id'::uuid, 73);
  select jsonb_build_object('sessionId', id) from public.sessions
  where (workspace_id, factory_id, number) = (:'workspace_id'::uuid, :'sibling_factory_id'::uuid, 75);
\else
  delete from public.workspaces where created_by = :'owner_id'::uuid and slug = :'slug' || '-other';
  select to_jsonb(true);
\endif
commit;
