begin;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.seed_scorer_trends(
  workspace_id uuid, factory_id uuid, owner_id uuid, owner_member uuid, pipeline_id uuid, stage_id uuid
) returns jsonb language plpgsql as $$
declare
  scorer public.factory_scorer_revisions;
  revised public.factory_scorer_revisions;
  profile public.factory_judge_profile_revisions;
  repo public.github_repositories;
  policy public.factory_scorer_sampling_policies;
  membership public.factory_scorer_sample_receipts;
  activated_revision uuid;
  source_definition text;
  accepted record;
  scenario record;
  claim record;
  target_run uuid;
  publication uuid;
  judge_result jsonb;
  target_sha text := repeat('a', 40);
  rubric jsonb := '{
    "schemaVersion":1, "rubric":"Score the retained reconciliation checks on a scale from zero to ten.",
    "requiredEvidence":["artifact"],
    "scoring":{"kind":"numeric","min":0,"max":10,"direction":"higher_is_better","passThreshold":8,"failThreshold":4}
  }';
  artifact_md text := 'Retained reconciliation checks for the exact commit.';
  title text;
  normalized_status text;
  score integer;
  run_info jsonb := '[]';
  policies jsonb := '[]';
  release_state record;
begin
  select * into strict repo from public.github_repositories repository
  where (repository.workspace_id, repository.factory_id) =
    (seed_scorer_trends.workspace_id, seed_scorer_trends.factory_id);
  insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
    values (owner_id, 'platform_api_key', 'fixture-credential');
  insert into public.workspace_e2b_sandbox_connections(workspace_id, encrypted_api_key)
    values (workspace_id, 'fixture-e2b-connection');
  insert into public.workspace_sandbox_settings(workspace_id, active_provider) values (workspace_id, 'e2b')
    on conflict on constraint workspace_sandbox_settings_pkey do update set active_provider = excluded.active_provider;

  select * into strict release_state from public.get_git_continuity_release_state();
  if not release_state.enabled then
    perform public.set_git_continuity_release(true, release_state.revision, 'Disposable scorer trend qualification');
  end if;

  select * into strict scorer from public.create_factory_scorer(workspace_id, factory_id,
    owner_id, 'Reconciliation quality', 'reconciliation-quality', rubric);
  select * into strict revised from public.save_factory_scorer_revision(workspace_id,factory_id,owner_id,
    scorer.scorer_id,1,jsonb_set(rubric,'{requiredEvidence}','["artifact","validation_report"]'));
  select * into strict profile from public.configure_factory_judge_profile(workspace_id, owner_id, 0,
    'openai/gpt-4.1-mini', 'openai', false, false, 'v2.AAAAAAAAAAAAAAAA.YWJj.AAAAAAAAAAAAAAAAAAAAAA');

  for rubric_version in 1..2 loop
    source_definition := jsonb_build_object(
      'schemaVersion', 2, 'kind', 'serial', 'sandboxProvider', 'e2b', 'pipelineId', pipeline_id, 'repositoryId', repo.id,
      'scorerRevisionIds', jsonb_build_array(case rubric_version when 1 then scorer.id else revised.id end),
      'executionPolicyRevisionId', null, 'deliveryPolicyRevisionId', null,
      'skillIds', '[]'::jsonb, 'toolIds', '[]'::jsonb, 'operatingRulesMd', '', 'operatingRuleStageIds', '[]'::jsonb,
      'agent', jsonb_build_object('provider', 'codex', 'model', 'gpt-5.5', 'concurrencyLimit', 1,
        'stallTimeoutMs', 900000, 'maxRetries', 3, 'maxTurns', 5),
      'stages', jsonb_build_array(jsonb_build_object('id', stage_id, 'slug', 'delivery', 'name', 'Delivery',
        'description', '', 'promptTemplateMd', 'Prepare the verified change.', 'anyoneCanApprove', true,
        'previousStageIds', '[]'::jsonb, 'approverMemberIds', '[]'::jsonb))
    )::text;
    insert into public.factory_definition_revisions(workspace_id, factory_id, schema_version, definition_json,
      canonical_digest, created_by)
    values (workspace_id, factory_id, 2, source_definition, encode(sha256(convert_to(source_definition, 'UTF8')), 'hex'), owner_id)
    returning id into activated_revision;
    insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
    values (workspace_id, factory_id, activated_revision, rubric_version, owner_id);

    select * into strict policy from public.save_factory_scorer_sampling_policy(workspace_id, factory_id,
      owner_id, case rubric_version when 1 then scorer.id else revised.id end, 0, 10000, 'qualification-cohort');
    policies := policies || jsonb_build_array(policy.id);

    for scenario in (select value from unnest(case rubric_version
        when 1 then array['Reconciliation regression','Reconciliation edge case'] else array['Reconciliation without report'] end) value)
    loop
      title := scenario.value;
      select * into strict accepted from internal.create_attributed_session(
        workspace_id, owner_member, title, 'Evaluate the observed reconciliation behavior.', 'codex', 'gpt-5.5',
        session_github_repository_id => repo.id, selected_pipeline_id => pipeline_id,
        p_actor => row(workspace_id, factory_id, owner_member, null, null, null, null, repo.id, null)
          ::internal.session_mutation_actor,
        p_expected_definition_digest => encode(sha256(convert_to(source_definition, 'UTF8')), 'hex'));
      update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
        status = 'running', attempt_count = 1 where id = accepted.job_id;
      target_run := public.start_session_job_attempt(accepted.job_id, 1, stage_id, 0, 'codex', 'gpt-5.5',
        'project', 'wallie/scorer-trends-' || accepted.job_id::text);
      if target_run is null then raise exception 'Could not start scorer browser fixture run.'; end if;
      perform public.pin_session_job_git_input(accepted.job_id, 1, target_run, repo.id, 'main', target_sha);
      if public.prepare_session_source_and_checkpoint_publication(target_run, repo.id, 'main',
        target_sha, target_sha, 'No code change', artifact_md, '', '', '', 0, artifact_md) is distinct from true then
        raise exception 'Could not prepare scorer browser fixture checkpoint.';
      end if;
      publication := public.claim_session_checkpoint_publication(target_run);
      if publication is null or public.adopt_session_checkpoint_publication(target_run, publication, null, null)
        is distinct from true then raise exception 'Could not adopt scorer browser fixture checkpoint.'; end if;
      membership := public.record_factory_scorer_sample(workspace_id, factory_id, policy.id, target_run);
      if rubric_version = 2 then
        if membership.reason is distinct from 'missing_evidence' then raise exception 'Expected report exclusion.'; end if;
        run_info := run_info || jsonb_build_array(jsonb_build_object('runId', target_run, 'sessionId', accepted.session_id));
        continue;
      end if;
      if membership.outcome is distinct from 'sampled' then
        raise exception 'Fixture run was not sampled (%).', membership.reason;
      end if;
      -- This fixture creates and claims the job in a single SQL statement.
      update public.factory_evaluation_jobs queued set available_at = statement_timestamp()
      where queued.sample_receipt_id = membership.id and queued.status = 'queued';
      select * into strict claim from public.claim_factory_judge_job();
      if claim.run_id is distinct from target_run
        or public.begin_factory_judge_invocation(workspace_id, factory_id, claim.job_id, claim.attempt_id, claim.lease_id,
          profile.id, repeat('d', 64), 'node')->>'status' is distinct from 'authorized'
      then raise exception 'Could not authorize the exact browser fixture evaluation.'; end if;
      normalized_status := case title when 'Reconciliation regression' then 'fail' else 'inconclusive' end;
      score := case normalized_status when 'fail' then 3 else 6 end;
      judge_result := jsonb_build_object('schemaVersion', 1, 'status', normalized_status,
        'evidence', membership.evidence, 'score', jsonb_build_object('kind', 'numeric', 'value', score))
        || case normalized_status when 'inconclusive' then '{"reason":"between_thresholds"}'::jsonb else '{}'::jsonb end;
      if not public.finish_factory_judge_invocation(workspace_id, factory_id, claim.job_id, claim.attempt_id, claim.lease_id,
        'completed', judge_result, profile.model_id, profile.provider_route, 'browser-fixture-judge',
        p_explanation => case normalized_status when 'fail' then 'The retained checks show a reconciliation regression.'
          else 'The score falls between the two rubric thresholds.' end,
        p_evidence_locations => jsonb_build_array(jsonb_build_object('reference', membership.evidence->0, 'location', '{"kind":"whole"}'::jsonb))
      ) then raise exception 'Could not adopt the scored browser fixture.'; end if;
      run_info := run_info || jsonb_build_array(jsonb_build_object(
        'runId', target_run, 'sessionId', accepted.session_id, 'jobId', claim.job_id));
    end loop;
  end loop;

  if not release_state.enabled then
    perform public.set_git_continuity_release(false, (select revision from public.get_git_continuity_release_state()),
      'Restore disposable scorer trend release state');
  end if;
  return jsonb_build_object('scorerId', scorer.scorer_id, 'revisions', jsonb_build_array(scorer.id, revised.id),
    'policies', policies, 'runs', run_info);
end;
$$;

select pg_temp.seed_scorer_trends(:'workspace_id'::uuid, :'factory_id'::uuid, :'owner_id'::uuid,
  :'owner_member_id'::uuid, :'pipeline_id'::uuid, :'stage_id'::uuid);
commit;
