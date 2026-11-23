create function internal.normalize_factory_automation_event(p_event jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  kind text := p_event->>'kind';
  scheduled_for text := p_event->>'scheduledFor';
begin
  if jsonb_typeof(p_event) is distinct from 'object' then
    raise exception 'An automation event must be an object.' using errcode = '22023';
  end if;

  case kind
    when 'schedule' then
      if p_event - array['kind','scheduledFor'] <> '{}'::jsonb
        or jsonb_typeof(p_event->'scheduledFor') is distinct from 'string'
        or scheduled_for !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?(Z|[+-](0[0-9]|1[0-5]):[0-5][0-9])$'
        or not pg_input_is_valid(left(scheduled_for, 10), 'date') then
        raise exception 'A schedule event requires a valid ISO date and time with a timezone.' using errcode = '22023';
      end if;
    when 'pull-request' then
      if p_event - array['kind','repositoryId','action','baseBranch'] <> '{}'::jsonb
        or jsonb_typeof(p_event->'action') is distinct from 'string'
        or p_event->>'action' not in ('opened','reopened','synchronize','ready_for_review','closed','merged')
        or not internal.valid_factory_automation_filter_values(jsonb_build_array(p_event->'baseBranch')) then
        raise exception 'A pull request event requires a repository, action and base branch.' using errcode = '22023';
      end if;
      return jsonb_set(p_event, '{repositoryId}', to_jsonb(internal.factory_automation_uuid(p_event->'repositoryId')));
    when 'issue-state' then
      if p_event - array['kind','stateId','teamId','projectId'] <> '{}'::jsonb
        or not (p_event ?& array['teamId','projectId'])
        or not internal.valid_factory_automation_filter_values(jsonb_build_array(p_event->'stateId'))
        or (p_event->'teamId' <> 'null'::jsonb
          and not internal.valid_factory_automation_filter_values(jsonb_build_array(p_event->'teamId')))
        or (p_event->'projectId' <> 'null'::jsonb
          and not internal.valid_factory_automation_filter_values(jsonb_build_array(p_event->'projectId'))) then
        raise exception 'An issue event requires a state and explicit team and project values.' using errcode = '22023';
      end if;
    else
      raise exception 'The automation event kind is invalid.' using errcode = '22023';
  end case;
  return p_event;
end;
$$;

create function internal.factory_automation_filter_check(p_field text, p_actual text, p_expected jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'field', p_field, 'actual', p_actual, 'expected', p_expected,
    'passed', p_expected = '[]'::jsonb or coalesce(p_expected ? p_actual, false))
$$;

-- Match immutable rule data and a normalized event without observing provider
-- state or reading the clock. Admission and preview share these checks.
create function internal.evaluate_factory_automation_event(p_definition jsonb, p_event jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  event jsonb := internal.normalize_factory_automation_event(p_event);
  kind text := event->>'kind';
  trigger_config jsonb := p_definition->'trigger';
  filters jsonb := p_definition->'filters';
  checks jsonb := jsonb_build_array(
    internal.factory_automation_filter_check('kind', kind, jsonb_build_array(trigger_config->>'kind')));
begin
  if kind = trigger_config->>'kind' then
    case kind
      when 'pull-request' then
        checks := checks || jsonb_build_array(
          internal.factory_automation_filter_check('repositoryId', event->>'repositoryId',
            jsonb_build_array(trigger_config->>'repositoryId')),
          internal.factory_automation_filter_check('action', event->>'action', filters->'actions'),
          internal.factory_automation_filter_check('baseBranch', event->>'baseBranch', filters->'baseBranches'));
      when 'issue-state' then
        checks := checks || jsonb_build_array(
          internal.factory_automation_filter_check('stateId', event->>'stateId', filters->'stateIds'),
          internal.factory_automation_filter_check('teamId', event->>'teamId', filters->'teamIds'),
          internal.factory_automation_filter_check('projectId', event->>'projectId', filters->'projectIds'));
      else null;
    end case;
  end if;
  return jsonb_build_object('checks', checks,
    'matched', not exists (
      select 1 from jsonb_array_elements(checks) as item where item->'passed' is distinct from 'true'::jsonb
    ));
end;
$$;

create function public.dry_run_factory_automation(
  p_workspace_id uuid, p_factory_id uuid, p_automation_id uuid, p_revision_id uuid, p_event jsonb
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor_user_id uuid := auth.uid();
  selected_definition jsonb;
  target jsonb;
  evaluation jsonb;
  assignment jsonb;
  archived boolean;
  agent_name text;
  workflow_name text;
  execution_policy_revision_id uuid;
begin
  if actor_user_id is null or not internal.can_manage_factory(p_workspace_id, p_factory_id) then
    return null;
  end if;
  select revision.definition into selected_definition from internal.factory_automation_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.automation_id, revision.id) =
    (p_workspace_id, p_factory_id, p_automation_id, p_revision_id);
  if not found then
    return null;
  end if;

  -- The manager fence locks the factory before reading mutable authority.
  -- The same lock serializes archive and both kinds of definition publication.
  begin
    perform internal.assert_factory_manager(p_workspace_id, p_factory_id, actor_user_id);
  exception when insufficient_privilege or no_data_found then
    return null;
  end;
  evaluation := internal.evaluate_factory_automation_event(selected_definition, p_event);
  target := selected_definition->'target';
  select automation.archived_at is not null or factory.status <> 'active' into strict archived
  from internal.factory_automations automation
  join public.factories factory
    on (factory.workspace_id, factory.id) = (automation.workspace_id, automation.factory_id)
  where (automation.workspace_id, automation.factory_id, automation.id) =
    (p_workspace_id, p_factory_id, p_automation_id);

  if archived then
    assignment := jsonb_build_object('status', 'denied', 'reason', 'archived',
      'message', 'This automation or factory is archived.');
  else
    begin
      perform internal.assert_factory_automation_target(p_workspace_id, p_factory_id, selected_definition);
      select agent.name, workflow.display_name, (base.definition->>'executionPolicyRevisionId')::uuid
      into strict agent_name, workflow_name, execution_policy_revision_id
      from internal.factory_workflow_authoring_base(p_workspace_id, p_factory_id) base
      join public.factory_agents agent on (agent.workspace_id, agent.factory_id, agent.id) =
        (p_workspace_id, p_factory_id, (target->>'agentId')::uuid)
      left join internal.factory_workflow_authoring_workflows workflow
        on (workflow.workspace_id, workflow.factory_id, workflow.id) =
           (p_workspace_id, p_factory_id, (target->>'workflowId')::uuid);
      assignment := jsonb_build_object('status', 'eligible', 'agentName', agent_name, 'workflowName', workflow_name,
        'executionPolicyRevisionId', execution_policy_revision_id);
    exception when sqlstate 'PT409' then
      assignment := jsonb_build_object('status', 'denied', 'reason', 'authority_changing',
        'message', 'The assignment is changing. Preview again shortly.');
    when sqlstate 'PT422' or no_data_found then
      assignment := jsonb_build_object('status', 'denied', 'reason', 'invalid_assignment',
        'message', case sqlerrm
          when 'The automation target does not match the current scoped factory definition.'
            then 'Select the current factory definition and its named agent and credential binding.'
          when 'The automation workflow activation is unavailable for this factory definition.'
            then 'Select the current published workflow activation for the factory definition.'
          when 'The automation execution grant is unavailable.'
            then 'Check that the assigned execution grant is current and its budget payer is active.'
          when 'The automation service authority or budget payer is unavailable.'
            then 'Check the assigned service principal, sessions:create grant, and budget payer.'
          when 'A current scoped credential binding is required.'
            then 'Select a current credential binding for the assigned agent and execution grant.'
          when 'The automation schedule time zone is unavailable.'
            then 'Select an available timezone for the schedule.'
          when 'The automation source repository is unavailable.'
            then 'Select an available repository in this factory.'
          else 'Check that the selected workflow or agent, execution grant, credential binding, and budget payer are current.'
        end);
    end;
  end if;

  return evaluation || jsonb_build_object(
    'automationId', p_automation_id, 'revisionId', p_revision_id,
    'budgetPayerMemberId', selected_definition->'budgetPayerMemberId', 'assignment', assignment);
end;
$$;

revoke all on function
  internal.normalize_factory_automation_event(jsonb),
  internal.factory_automation_filter_check(text, text, jsonb),
  internal.evaluate_factory_automation_event(jsonb, jsonb),
  public.dry_run_factory_automation(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.dry_run_factory_automation(uuid, uuid, uuid, uuid, jsonb) to authenticated;
