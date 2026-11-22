begin;
set local request.jwt.claim.role = 'service_role';

\if :{?cleanup_paths}
set local storage.allow_delete_query = 'true';
with removed as (
  delete from storage.objects object
  where object.bucket_id = 'session-validation-evidence'
    and split_part(object.name, '/', 1) = :'workspace_id'
    and object.name in (select jsonb_array_elements_text(:'cleanup_paths'::jsonb))
    and exists (select 1 from public.workspaces workspace
      where workspace.id = :'workspace_id'::uuid and workspace.slug = :'workspace_slug')
  returning object.id
)
select jsonb_build_object('removed', count(*)) from removed;
delete from public.workspaces where id = :'workspace_id'::uuid and slug = :'workspace_slug';
delete from auth.users
where (id, email) in (
  (:'owner_id'::uuid, :'workspace_slug' || '-owner@example.test'),
  (:'viewer_id'::uuid, :'workspace_slug' || '-viewer@example.test')
);
commit;
\quit
\endif

create function pg_temp.seed_failure_groups(
  p_workspace_id uuid, p_factory_id uuid, p_owner_id uuid, p_owner_member_id uuid, p_pipeline_id uuid, p_stage_id uuid
) returns jsonb language plpgsql as $$
declare
  repo public.github_repositories;
  release_state record;
  next_activation bigint;
  original_definition jsonb;
  definition text;
  revision_id uuid;
  revisions uuid[] := '{}';
  fixture record;
  case_number integer;
  validation_key text;
  fixture_run_id uuid;
  run_ids uuid[] := '{}';
  log_id uuid;
  storage_path text;
  storage_paths text[] := '{}';
  commit_sha text := repeat('a', 40);
  tree_sha text := repeat('b', 40);
  observed_at timestamptz;
  records jsonb;
  assets jsonb;
  publication uuid;
  artifact text := 'Retained verification fixture.';
begin
  select * into strict repo from public.github_repositories repository
  where (repository.workspace_id, repository.factory_id) = (p_workspace_id, p_factory_id);
  select * into strict release_state from public.get_git_continuity_release_state();
  if not release_state.enabled then
    perform public.set_git_continuity_release(true, release_state.revision, 'Disposable failure groups browser qualification');
  end if;
  select revision.definition_json::jsonb, activation.activation_number + 1
  into strict original_definition, next_activation
  from public.factory_definition_activations activation
  join public.factory_definition_revisions revision
    on (revision.id, revision.workspace_id, revision.factory_id) =
       (activation.revision_id, activation.workspace_id, activation.factory_id)
  where (activation.workspace_id, activation.factory_id) = (p_workspace_id, p_factory_id)
  order by activation.activation_number desc limit 1;
  original_definition := original_definition || jsonb_build_object(
    'scorerRevisionIds', '[]'::jsonb,
    'modelRouting', jsonb_build_object('version', 1, 'taskClasses', jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(), 'slug', 'delivery', 'name', 'Delivery'
    )), 'rules', '[]'::jsonb, 'onUnmatched', '{"kind":"escalate"}'::jsonb)
  );

  for case_number in 1..4 loop
    if case_number in (1, 4) then
      definition := jsonb_set(original_definition, '{operatingRulesMd}',
        to_jsonb('Fixture rules ' || next_activation::text))::text;
      insert into public.factory_definition_revisions (
        workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
      ) values (
        p_workspace_id, p_factory_id, 2, definition, encode(sha256(convert_to(definition, 'UTF8')), 'hex'), p_owner_id
      ) returning id into revision_id;
      insert into public.factory_definition_activations (workspace_id, factory_id, revision_id, activation_number, created_by)
      values (p_workspace_id, p_factory_id, revision_id, next_activation, p_owner_id);
      next_activation := next_activation + 1;
      revisions := array_append(revisions, revision_id);
    end if;

    select * into strict fixture from internal.create_attributed_session(
      p_workspace_id, p_owner_member_id, 'Validation regression ' || case_number, 'Run the pinned validation command.',
      'codex', 'gpt-5.5', session_github_repository_id => repo.id, selected_pipeline_id => p_pipeline_id,
      p_actor => row(p_workspace_id, p_factory_id, p_owner_member_id, null, null, null, null, repo.id, null)
        ::internal.session_mutation_actor,
      p_expected_definition_digest => encode(sha256(convert_to(definition, 'UTF8')), 'hex'));
    update public.agent_jobs set git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()),
      status = 'running', attempt_count = 1 where id = fixture.job_id;
    fixture_run_id := public.start_session_job_attempt(fixture.job_id, 1, p_stage_id, 0,
      'codex', 'gpt-5.5', 'project', 'wallie/failure-groups-' || fixture.job_id::text);
    if fixture_run_id is null then raise exception 'Could not start validation browser fixture run.'; end if;
    perform public.pin_session_job_git_input(fixture.job_id, 1, fixture_run_id, repo.id, 'main', commit_sha);

    validation_key := case when case_number = 4 then 'schema-compatibility' else 'reconciliation-tests' end;
    perform public.pin_session_validation_plan(fixture_run_id, commit_sha, tree_sha, jsonb_build_object('version', 1,
      'commands', jsonb_build_array(jsonb_build_object('key', validation_key, 'command', 'pnpm test',
        'timeoutSeconds', 60, 'reports', '[]'::jsonb))));
    assets := '[]';
    if case_number < 4 then
      log_id := gen_random_uuid();
      storage_path := p_workspace_id::text || '/' || fixture_run_id::text || '/' || log_id::text;
      insert into storage.objects(bucket_id, name, metadata)
      values ('session-validation-evidence', storage_path, '{"mimetype":"text/plain","size":20}');
      assets := jsonb_build_array(jsonb_build_object('id', log_id, 'key', validation_key || '/log', 'kind', 'log',
        'required', false, 'storagePath', storage_path, 'sha256', repeat('e', 64), 'contentType', 'text/plain', 'sizeBytes', 20));
      storage_paths := array_append(storage_paths, storage_path);
    end if;
    observed_at := clock_timestamp();
    records := jsonb_build_array(jsonb_build_object('key', validation_key, 'command', 'pnpm test', 'provenance', 'harness',
      'status', 'failed', 'exitCode', 1, 'startedAt', observed_at, 'completedAt', observed_at, 'commitSha', commit_sha,
      'treeSha', tree_sha, 'finalCommitSha', commit_sha, 'finalTreeSha', tree_sha,
      'reportKeys', '[]'::jsonb, 'missingRequiredReports', '[]'::jsonb));
    perform public.record_session_validation_evidence(fixture_run_id, commit_sha, tree_sha, records, assets);
    if public.prepare_session_source_and_checkpoint_publication(fixture_run_id, repo.id, 'main',
      commit_sha, commit_sha, 'No code change', artifact, '', '', '', 0, artifact) is distinct from true then
      raise exception 'Could not prepare the validation browser fixture checkpoint.';
    end if;
    publication := public.claim_session_checkpoint_publication(fixture_run_id);
    if publication is null or public.adopt_session_checkpoint_publication(fixture_run_id, publication, null, null) is distinct from true then
      raise exception 'Could not adopt the validation browser fixture checkpoint.';
    end if;
    run_ids := array_append(run_ids, fixture_run_id);
  end loop;

  while public.process_factory_failure_cohorts(100) > 0 loop
    null;
  end loop;
  if not release_state.enabled then
    perform public.set_git_continuity_release(false, (select revision from public.get_git_continuity_release_state()),
      'Restore disposable failure groups release state');
  end if;
  return jsonb_build_object('revisions', revisions, 'runs', run_ids, 'storagePaths', storage_paths);
end;
$$;

select pg_temp.seed_failure_groups(:'workspace_id'::uuid, :'factory_id'::uuid, :'owner_id'::uuid,
  :'owner_member_id'::uuid, :'pipeline_id'::uuid, :'stage_id'::uuid);
commit;
