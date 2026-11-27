create function internal.factory_setup_repository_is_unused(p_workspace_id uuid, p_repository_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select not exists (
    select 1 from public.workspace_repository_profiles where github_repository_id = p_repository_id
    union all select 1 from public.workspace_onboarding where selected_github_repository_id = p_repository_id
    union all select 1 from public.repository_onboarding_status where github_repository_id = p_repository_id
    union all select 1 from public.sandbox_capability_checks where github_repository_id = p_repository_id
    union all select 1 from public.sessions where github_repository_id = p_repository_id
    union all select 1 from public.session_factory_admission_inputs where github_repository_id = p_repository_id
    union all select 1 from public.session_git_roots where repository_id = p_repository_id
    union all select 1 from public.session_pr_epochs where repository_id = p_repository_id
    union all select 1 from public.session_pull_requests where github_repository_id = p_repository_id
    union all select 1 from public.session_source_deliveries where repository_id = p_repository_id
    union all select 1 from public.github_pr_refresh_watermarks where repository_id = p_repository_id
    union all select 1 from public.factory_context_sources where workspace_id = p_workspace_id
      and repository_id = p_repository_id
    union all select 1 from public.factory_execution_grants where workspace_id = p_workspace_id
      and (github_repository_id = p_repository_id or p_repository_id = any(read_context_repository_ids))
    union all select 1 from public.factory_benchmark_task_inputs where workspace_id = p_workspace_id
      and repository_id = p_repository_id
    union all select 1 from internal.factory_deployment_sources where workspace_id = p_workspace_id
      and repository_id = p_repository_id
    union all select 1 from internal.factory_event_subscriptions where workspace_id = p_workspace_id
      and writer_repository_id = p_repository_id
    union all select 1 from public.factory_definition_drafts where workspace_id = p_workspace_id
      and strpos(lower(definition_json), p_repository_id::text) > 0
    union all select 1 from public.factory_definition_revisions where workspace_id = p_workspace_id
      and strpos(lower(definition_json), p_repository_id::text) > 0
    union all select 1 from internal.factory_workflow_authoring_drafts where workspace_id = p_workspace_id
      and strpos(lower(workflow_json), p_repository_id::text) > 0
    union all select 1 from internal.factory_workflow_graph_revisions where workspace_id = p_workspace_id
      and strpos(lower(workflow_json), p_repository_id::text) > 0
  ) and p_repository_id is distinct from (
    select repository.id
    from public.github_repositories repository
    join public.github_installations installation
      on (installation.workspace_id, installation.id) = (repository.workspace_id, repository.github_installation_id)
    join public.factories factory on (factory.workspace_id, factory.id) = (repository.workspace_id, repository.factory_id)
    left join public.workspace_repository_profiles profile
      on (profile.workspace_id, profile.github_repository_id) = (repository.workspace_id, repository.id)
    left join public.workspace_onboarding onboarding on onboarding.workspace_id = repository.workspace_id
    where repository.workspace_id = p_workspace_id and factory.is_default
      and not repository.is_archived and not installation.suspended
    order by case when profile.is_primary then 0
      when onboarding.selected_github_repository_id = repository.id then 1 else 2 end,
      repository.full_name, repository.id
    limit 1
  );
$$;
revoke all on function internal.factory_setup_repository_is_unused(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.list_factory_setup_repositories(p_workspace_id uuid, p_factory_id uuid)
returns table(id uuid, full_name text)
language sql stable security definer set search_path = '' as $$
  select repository.id, repository.full_name
  from public.factories target
  join public.workspaces workspace on workspace.id = target.workspace_id
    and workspace.deletion_requested_at is null
  join public.workspace_members actor on actor.workspace_id = workspace.id and actor.user_id = auth.uid()
    and actor.is_active and actor.kind = 'human' and actor.role in ('owner', 'admin')
  join public.factories source on source.workspace_id = target.workspace_id and source.is_default
  join public.github_repositories repository on (repository.workspace_id, repository.factory_id) = (source.workspace_id, source.id)
  join public.github_installations installation
    on (installation.workspace_id, installation.id) = (repository.workspace_id, repository.github_installation_id)
  where (target.workspace_id, target.id) = (p_workspace_id, p_factory_id)
    and target.status = 'active' and not target.is_default
    and not repository.is_archived and not installation.suspended
    and internal.factory_setup_repository_is_unused(p_workspace_id, repository.id)
  order by repository.full_name, repository.id;
$$;
revoke all on function public.list_factory_setup_repositories(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_setup_repositories(uuid, uuid) to authenticated;

alter table public.factory_audit_events drop constraint factory_audit_events_action_check;
alter table public.factory_audit_events add constraint factory_audit_events_action_check check (action in (
  'factory.created', 'factory.archived', 'factory.restored', 'factory.repository_assigned', 'factory.pipeline_created',
  'membership.granted', 'membership.revoked', 'membership.suspended', 'membership.reinstated',
  'agent.created', 'agent.prompt_revision_created',
  'skill.created', 'skill.revision_created', 'skill.revision_revoked',
  'service_principal.created', 'execution_grant.approved', 'execution_grant.updated', 'execution_grant.revoked',
  'credential_binding.created', 'credential_binding.revoked',
  'mcp_server.created', 'mcp_server.revision_created', 'mcp_server.revision_revoked',
  'mcp_secret_binding.created', 'mcp_secret_binding.revoked',
  'machine_token.issued', 'machine_token.revoked',
  'oauth_client.registered', 'oauth_client.revoked', 'oauth_grant.connected', 'oauth_grant.revoked',
  'scorer.created', 'scorer.revision_created',
  'automation.created', 'automation.draft_saved', 'automation.published', 'automation.archived',
  'automation.admission_configured'
));

create function public.provision_factory_serial_setup(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_expected_activation_number bigint, p_expected_draft_id uuid default null,
  p_repository_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid;
  repository public.github_repositories;
  resource_id uuid;
  event_action text;
  event_detail jsonb;
begin
  perform internal.lock_factory_definition_head(p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  select member.id into actor_id from public.workspace_members member
  where member.workspace_id = p_workspace_id and member.user_id = p_actor_user_id
    and member.is_active and member.kind = 'human' and member.role in ('owner', 'admin')
  for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  if exists (select 1 from public.factories where (workspace_id, id) = (p_workspace_id, p_factory_id) and is_default) then
    raise exception 'This setup command is for non-default factories.' using errcode = 'PT422';
  end if;
  if internal.latest_factory_draft_id(p_workspace_id, p_factory_id, p_expected_activation_number)
    is distinct from p_expected_draft_id then
    raise exception 'The factory draft changed. Reload before continuing setup.' using errcode = 'PT409';
  end if;

  if p_repository_id is null then
    if exists (select 1 from public.pipelines where (workspace_id, factory_id) = (p_workspace_id, p_factory_id)) then
      raise exception 'This factory already has a pipeline. Reload to edit it.' using errcode = 'PT409';
    end if;
    perform repo.id from public.github_repositories repo join public.github_installations installation
      on (installation.workspace_id, installation.id) = (repo.workspace_id, repo.github_installation_id)
    where (repo.workspace_id, repo.factory_id) = (p_workspace_id, p_factory_id)
      and not repo.is_archived and not installation.suspended
    order by repo.id limit 1 for share of repo, installation nowait;
    if not found then
      raise exception 'Assign a connected repository before creating a pipeline.' using errcode = 'PT422';
    end if;
    insert into public.pipelines(workspace_id, factory_id, name, operating_rules_md)
    values (p_workspace_id, p_factory_id, 'Serial pipeline', '') returning id into resource_id;
    event_action := 'factory.pipeline_created';
    event_detail := jsonb_build_object('pipelineId', resource_id);
  else
    select repo.* into repository
    from public.github_repositories repo
    join public.github_installations installation
      on (installation.workspace_id, installation.id) = (repo.workspace_id, repo.github_installation_id)
    join public.factories source on (source.workspace_id, source.id) = (repo.workspace_id, repo.factory_id)
    where (repo.workspace_id, repo.id) = (p_workspace_id, p_repository_id) and source.is_default
      and not repo.is_archived and not installation.suspended
    for share of installation nowait for update of repo nowait;
    if not found then
      raise exception 'This repository is no longer available to assign. Choose a connected repository.' using errcode = 'P0002';
    end if;
    if not internal.factory_setup_repository_is_unused(p_workspace_id, repository.id) then
      raise exception 'This repository is already used by the default factory. Choose an unused repository.' using errcode = 'PT409';
    end if;

    delete from public.github_repositories where id = repository.id;
    insert into public.github_repositories(
      workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url,
      description, default_programming_language, default_branch, is_archived, created_at
    ) values (
      p_workspace_id, p_factory_id, repository.github_installation_id, repository.repo_id,
      repository.name, repository.full_name, repository.private, repository.html_url,
      repository.description, repository.default_programming_language, repository.default_branch,
      repository.is_archived, repository.created_at
    ) returning id into resource_id;
    event_action := 'factory.repository_assigned';
    event_detail := jsonb_build_object('repositoryId', resource_id, 'previousRepositoryId', repository.id);
  end if;

  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (p_workspace_id, p_factory_id, event_action, actor_id, event_detail);
  return resource_id;
exception when lock_not_available then
  raise exception 'Repository access is changing. Reload the factory before retrying.' using errcode = 'PT409';
end;
$$;
revoke all on function public.provision_factory_serial_setup(uuid, uuid, uuid, bigint, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.provision_factory_serial_setup(uuid, uuid, uuid, bigint, uuid, uuid)
  to service_role;
