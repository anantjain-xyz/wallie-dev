create or replace function public.read_factory_workflow_authoring(
  p_workspace_id uuid,p_factory_id uuid,p_workflow_id uuid,p_selected_draft_id uuid default null
) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('workflowId',workflow.id,'displayName',workflow.display_name,
    'template',case when workflow.template_id is not null then jsonb_build_object(
      'id',workflow.template_id,'version',workflow.template_version) end,
    'baseDefinition',jsonb_build_object('activationId',base.id,'revisionId',base.revision_id,'digest',base.digest),
    'draftId',draft.id,'activationId',published.id,'draftDigest',draft.workflow_digest,'publishedDraftId',published.draft_id,
    'draftBaseDefinition',case when draft.id is not null then jsonb_build_object('activationId',draft.base_activation_id,
      'revisionId',draft.base_definition_revision_id,'digest',draft.base_definition_digest) end,
    'graph',draft.workflow_json::jsonb,'selectedDraftId',selected.id,
    'selectedDraftGraph',selected.workflow_json::jsonb,'selectedDraftDigest',selected.workflow_digest,
    'selectedDraftBaseDefinition',case when selected.id is not null then jsonb_build_object('activationId',selected.base_activation_id,
      'revisionId',selected.base_definition_revision_id,'digest',selected.base_definition_digest) end,
    'publishedGraphRevisionId',published.graph_revision_id,'recentDrafts',history.drafts)
  from internal.factory_workflow_authoring_workflows workflow
  join public.factories factory on (factory.workspace_id,factory.id)=(workflow.workspace_id,workflow.factory_id)
  left join lateral internal.factory_workflow_authoring_base(workflow.workspace_id,workflow.factory_id) base on true
  left join lateral (select * from internal.factory_workflow_authoring_drafts candidate
    where candidate.workflow_id=workflow.id order by revision_number desc limit 1) draft on true
  left join lateral (select * from internal.factory_workflow_authoring_activations candidate
    where candidate.workflow_id=workflow.id order by activation_number desc limit 1) published on true
  left join internal.factory_workflow_authoring_drafts selected on (selected.workflow_id,selected.id)=(workflow.id,p_selected_draft_id)
  left join internal.factory_workflow_authoring_drafts live on (live.workflow_id,live.id)=(workflow.id,published.draft_id)
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id',candidate.id,'revision',candidate.revision_number)
      order by candidate.revision_number desc),'[]'::jsonb) as drafts
    from (
      select candidates.id,candidates.revision_number
      from (
        (select recent.id,recent.revision_number from internal.factory_workflow_authoring_drafts recent
          where recent.workflow_id=workflow.id order by recent.revision_number desc limit 20)
        union select selected.id,selected.revision_number where selected.id is not null
        union select live.id,live.revision_number where live.id is not null
      ) candidates
      order by (candidates.id in (live.id,selected.id)) desc nulls last,candidates.revision_number desc
      limit 20
    ) candidate
  ) history
  where (workflow.workspace_id,workflow.factory_id,workflow.id)=(p_workspace_id,p_factory_id,p_workflow_id)
    and factory.status='active' and auth.uid() is not null and internal.can_manage_factory(p_workspace_id,p_factory_id)
    and (p_selected_draft_id is null or selected.id is not null)
$$;
