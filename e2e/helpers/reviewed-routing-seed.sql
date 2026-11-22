begin;
set local request.jwt.claim.role = 'service_role';

create function pg_temp.prepare_reviewed_routing(
  p_workspace_id uuid, p_workspace_slug text, p_factory_id uuid, p_owner_id uuid, p_draft_id uuid
) returns jsonb language plpgsql as $$
declare
  draft public.factory_definition_drafts;
  connection_revision uuid;
  repository_id uuid;
  test_id uuid;
begin
  if not exists (
    select 1 from public.workspaces workspace
    join public.factories factory on factory.workspace_id = workspace.id
    join public.workspace_members member on member.workspace_id = workspace.id
    join auth.users actor on actor.id = member.user_id
    where (workspace.id, workspace.slug, factory.id, actor.id) =
      (p_workspace_id, p_workspace_slug, p_factory_id, p_owner_id)
      and workspace.slug ~ '^analytics-proof-[a-f0-9]{12}$'
      and factory.slug = 'product-delivery'
      and actor.email = workspace.slug || '-owner@example.test'
      and member.is_active and member.kind = 'human' and member.role = 'owner'
  ) then
    raise exception 'The reviewed-routing seed requires its disposable browser workspace.';
  end if;

  select * into strict draft from public.factory_definition_drafts saved
  where (saved.workspace_id, saved.factory_id, saved.id, saved.created_by) =
    (p_workspace_id, p_factory_id, p_draft_id, p_owner_id);
  if not exists (
    select 1 from public.factory_routing_draft_evidence evidence
    where (evidence.workspace_id, evidence.factory_id, evidence.draft_id) =
      (p_workspace_id, p_factory_id, draft.routing_evidence_source_draft_id)
  ) then
    raise exception 'The exact draft did not retain benchmark evidence after saving the fallback.';
  end if;

  repository_id := (draft.definition_json::jsonb->>'repositoryId')::uuid;
  connection_revision := internal.factory_connected_sandbox_revision(p_workspace_id,
    draft.definition_json::jsonb->>'sandboxProvider');
  if connection_revision is null then raise exception 'The fixture sandbox is unavailable.'; end if;

  -- Session creation in the shell admits through the workspace's default factory.
  update public.factories set is_default = false
  where workspace_id = p_workspace_id and is_default and id <> p_factory_id;
  update public.factories set is_default = true
  where (workspace_id, id) = (p_workspace_id, p_factory_id) and not is_default;
  update public.workspace_onboarding set selected_github_repository_id = repository_id
  where workspace_id = p_workspace_id;

  -- Seed only the local smoke result. Publication rechecks current authority,
  -- the exact saved draft and each reviewed benchmark target through the real RPC.
  insert into public.factory_definition_smoke_tests(workspace_id, factory_id,
    target_kind, target_id, definition_digest, base_activation_number, sandbox_connection_revision,
    created_by, lease_expires_at, finished_at, status, evidence)
  values (p_workspace_id, p_factory_id, 'draft', draft.id, draft.canonical_digest,
    draft.base_activation_number, connection_revision, p_owner_id, clock_timestamp() + interval '5 minutes',
    clock_timestamp(), 'passed', jsonb_build_object('runtimeProfile', draft.definition_json::jsonb->>'sandboxProvider',
      'stageCount', 1, 'completedStageCount', 1, 'cleanupPending', false))
  returning id into test_id;

  return jsonb_build_object('testId', test_id, 'repositoryId', repository_id);
end;
$$;

select pg_temp.prepare_reviewed_routing(:'workspace_id', :'workspace_slug', :'factory_id', :'owner_id', :'draft_id');
commit;
