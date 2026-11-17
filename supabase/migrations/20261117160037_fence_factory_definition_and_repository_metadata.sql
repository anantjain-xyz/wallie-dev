-- Definition storage accepts immutable snapshots, including historical records
-- with missing resources. A resource that still exists must belong to the
-- record's factory. The activation authority also requires live references.
create function internal.assert_factory_definition_resource_scope(
  p_workspace_id uuid, p_factory_id uuid, p_definition jsonb
) returns void language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from public.pipelines pipeline
    where pipeline.id = (p_definition->>'pipelineId')::uuid
      and pipeline.workspace_id = p_workspace_id and pipeline.factory_id <> p_factory_id
  ) then
    raise exception 'The definition pipeline is outside the factory scope.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from public.github_repositories repository
    where repository.id = (p_definition->>'repositoryId')::uuid
      and repository.workspace_id = p_workspace_id and repository.factory_id <> p_factory_id
  ) then
    raise exception 'The definition repository is outside the factory scope.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_definition_resource_scope(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

create function internal.guard_factory_definition_resource_scope()
returns trigger language plpgsql set search_path = '' as $$
declare definition jsonb;
begin
  if tg_table_name = 'factory_definition_activations' then
    select revision.definition_json::jsonb into definition
    from public.factory_definition_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id) =
      (new.workspace_id, new.factory_id, new.revision_id);
  elsif tg_table_name = 'factory_definition_smoke_tests' then
    if new.target_kind = 'draft' then
      select draft.definition_json::jsonb into definition
      from public.factory_definition_drafts draft
      where (draft.workspace_id, draft.factory_id, draft.id) =
        (new.workspace_id, new.factory_id, new.target_id);
    else
      select revision.definition_json::jsonb into definition
      from public.factory_definition_revisions revision
      where (revision.workspace_id, revision.factory_id, revision.id) =
        (new.workspace_id, new.factory_id, new.target_id);
    end if;
  else
    definition := new.definition_json::jsonb;
  end if;
  perform internal.assert_factory_definition_resource_scope(new.workspace_id, new.factory_id, definition);
  return new;
end;
$$;
revoke all on function internal.guard_factory_definition_resource_scope()
  from public, anon, authenticated, service_role;

create trigger factory_definition_drafts_resource_scope
before insert on public.factory_definition_drafts
for each row execute function internal.guard_factory_definition_resource_scope();
create trigger factory_definition_revisions_resource_scope
before insert on public.factory_definition_revisions
for each row execute function internal.guard_factory_definition_resource_scope();
create trigger factory_definition_activations_resource_scope
before insert on public.factory_definition_activations
for each row execute function internal.guard_factory_definition_resource_scope();
create trigger factory_definition_smoke_tests_resource_scope
before insert on public.factory_definition_smoke_tests
for each row execute function internal.guard_factory_definition_resource_scope();

-- Metadata follows its repository. The parent lookup runs under the caller's
-- repository SELECT policy, including the workspace operator exception.
alter policy repository_onboarding_status_select_membership on public.repository_onboarding_status
using (exists (
  select 1 from public.github_repositories repository
  where repository.id = repository_onboarding_status.github_repository_id
    and repository.workspace_id = repository_onboarding_status.workspace_id
));

alter policy workspace_repository_profiles_select_membership on public.workspace_repository_profiles
using (exists (
  select 1 from public.github_repositories repository
  where repository.id = workspace_repository_profiles.github_repository_id
    and repository.workspace_id = workspace_repository_profiles.workspace_id
));

alter policy sandbox_capability_checks_select_membership on public.sandbox_capability_checks
using (factory_definition_digest is null and exists (
  select 1 from public.github_repositories repository
  where repository.id = sandbox_capability_checks.github_repository_id
    and repository.workspace_id = sandbox_capability_checks.workspace_id
));
