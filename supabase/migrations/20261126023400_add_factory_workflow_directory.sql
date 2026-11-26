create index factory_workflow_authoring_directory_name_idx
  on internal.factory_workflow_authoring_workflows (workspace_id, factory_id, lower(display_name), id);

create function public.list_factory_workflow_directory(
  p_workspace_id uuid, p_factory_id uuid, p_after_id uuid default null, p_search text default null
) returns jsonb language sql stable security definer set search_path = '' as $$
  with scope as materialized (
    select factory.workspace_id, factory.id, lower(btrim(coalesce(p_search, ''))) as search
    from public.factories factory
    where (factory.workspace_id, factory.id, factory.status) = (p_workspace_id, p_factory_id, 'active')
      and auth.uid() is not null and internal.can_manage_factory(p_workspace_id, p_factory_id)
      and length(coalesce(p_search, '')) <= 120
  ), cursor_workflow as materialized (
    select lower(workflow.display_name) as sort_name, workflow.id
    from scope
    join internal.factory_workflow_authoring_workflows workflow
      on (workflow.workspace_id, workflow.factory_id) = (scope.workspace_id, scope.id)
    where workflow.id = p_after_id and strpos(lower(workflow.display_name), scope.search) > 0
  ), workflow_page as materialized (
    select workflow.*, lower(workflow.display_name) as sort_name
    from scope
    join internal.factory_workflow_authoring_workflows workflow
      on (workflow.workspace_id, workflow.factory_id) = (scope.workspace_id, scope.id)
    left join cursor_workflow page_cursor on true
    where strpos(lower(workflow.display_name), scope.search) > 0
      and (p_after_id is null or (lower(workflow.display_name), workflow.id) > (page_cursor.sort_name, page_cursor.id))
    order by lower(workflow.display_name), workflow.id
    limit 51
  ), intake as materialized (
    select option.workflow_id, option.activation_id
    from scope
    cross join lateral public.list_factory_workflow_intake_options(scope.workspace_id, scope.id) option
    where exists (select 1 from workflow_page)
  )
  select jsonb_build_object(
    'cursorUnavailable', p_after_id is not null and not exists (select 1 from cursor_workflow),
    'baseDefinition', case when base.id is not null then jsonb_build_object(
      'activationId', base.id, 'revisionId', base.revision_id, 'digest', base.digest
    ) end,
    'workflows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'workflowId', workflow.id, 'displayName', workflow.display_name,
        'createdAt', workflow.created_at,
        'template', case when workflow.template_id is not null then jsonb_build_object(
          'id', workflow.template_id, 'version', workflow.template_version
        ) end,
        'draftRevision', draft.revision_number,
        'publication', case when published.id is not null then jsonb_build_object(
          'activationId', published.id, 'draftId', published.draft_id,
          'draftRevision', published_draft.revision_number, 'number', published.activation_number,
          'intake', case when intake.activation_id is not null then 'eligible'
            when published.base_activation_id is distinct from base.id then 'definition_changed'
            else 'unavailable' end
        ) end
      ) order by workflow.sort_name, workflow.id)
      from workflow_page workflow
      left join lateral (
        select revision.revision_number from internal.factory_workflow_authoring_drafts revision
        where revision.workflow_id = workflow.id order by revision.revision_number desc limit 1
      ) draft on true
      left join lateral (
        select activation.id, activation.draft_id, activation.activation_number, activation.base_activation_id
        from internal.factory_workflow_authoring_activations activation
        where activation.workflow_id = workflow.id order by activation.activation_number desc limit 1
      ) published on true
      left join internal.factory_workflow_authoring_drafts published_draft
        on (published_draft.workflow_id, published_draft.id) = (workflow.id, published.draft_id)
      left join intake on (intake.workflow_id, intake.activation_id) = (workflow.id, published.id)
    ), '[]'::jsonb)
  )
  from scope
  left join lateral internal.factory_workflow_authoring_base(scope.workspace_id, scope.id) base on true
$$;

revoke all on function public.list_factory_workflow_directory(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_workflow_directory(uuid, uuid, uuid, text) to authenticated;
