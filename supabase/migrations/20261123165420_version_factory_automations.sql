create table internal.factory_automations (
  id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  draft_revision_id uuid not null,
  published_revision_id uuid,
  archived_at timestamptz,
  foreign key (workspace_id, factory_id)
    references public.factories(workspace_id, id) on delete cascade,
  unique (workspace_id, factory_id, id)
);

create table internal.factory_automation_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  automation_id uuid not null,
  revision_number bigint not null check (revision_number between 1 and 9007199254740991),
  definition jsonb not null,
  created_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, factory_id, automation_id)
    references internal.factory_automations(workspace_id, factory_id, id) on delete cascade,
  unique (automation_id, id),
  unique (automation_id, revision_number)
);

alter table internal.factory_automations
  add foreign key (id, draft_revision_id)
    references internal.factory_automation_revisions(automation_id, id) deferrable initially deferred,
  add foreign key (id, published_revision_id)
    references internal.factory_automation_revisions(automation_id, id);

alter table internal.factory_automations enable row level security;
alter table internal.factory_automation_revisions enable row level security;
revoke all on internal.factory_automations, internal.factory_automation_revisions
  from public, anon, authenticated, service_role;

create trigger preserve_factory_automation_revisions
  before update or delete on internal.factory_automation_revisions
  for each row execute function internal.preserve_factory_definition_history();

alter table public.factory_audit_events drop constraint factory_audit_events_action_check;
alter table public.factory_audit_events add constraint factory_audit_events_action_check check (action in (
  'factory.created', 'factory.archived', 'factory.restored',
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
  'automation.created', 'automation.draft_saved', 'automation.published', 'automation.archived'
));

create function internal.factory_automation_uuid(p_value jsonb) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_value) is distinct from 'string'
    or (p_value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'An automation reference is invalid.' using errcode = '22023';
  end if;
  return (p_value #>> '{}')::uuid;
end;
$$;

create function internal.trim_factory_automation_text(p_text text) returns text
language sql immutable strict set search_path = '' as $$
  select btrim(p_text, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;

create function internal.valid_factory_automation_filter_values(p_values jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_values) = 'array' then
    jsonb_array_length(p_values) <= 32
    and jsonb_array_length(p_values) = (
      select count(distinct entry.value) from jsonb_array_elements(p_values) entry
    )
    and not exists (
      select 1 from jsonb_array_elements(p_values) entry
      where jsonb_typeof(entry.value) <> 'string'
        or char_length(entry.value #>> '{}') not between 1 and 120
        or (entry.value #>> '{}') <> internal.trim_factory_automation_text(entry.value #>> '{}')
        or (entry.value #>> '{}') ~ U&'[\0001-\001F\007F-\009F]'
    )
    else false end
$$;

create function internal.valid_factory_automation_cron(p_cron text) returns boolean
language plpgsql immutable strict set search_path = '' as $$
declare
  minimums constant integer[] := array[0, 0, 1, 1, 0];
  maximums constant integer[] := array[59, 23, 31, 12, 7];
  fields text[];
  item text;
  parts text[];
  first_value numeric;
  last_value numeric;
begin
  if char_length(p_cron) > 120 then
    return false;
  end if;
  fields := string_to_array(p_cron, ' ');
  if cardinality(fields) <> 5 or '' = any(fields) then
    return false;
  end if;

  for field_index in 1..5 loop
    foreach item in array string_to_array(fields[field_index], ',') loop
      parts := regexp_match(item, '^([*]|([0-9]+)(?:-([0-9]+))?)(?:/([0-9]+))?$');
      if parts is null then
        return false;
      end if;
      if parts[4] is not null and (parts[4] !~ '[1-9]' or (parts[1] <> '*' and parts[3] is null)) then
        return false;
      end if;
      if parts[2] is not null then
        first_value := parts[2]::numeric;
        last_value := coalesce(parts[3]::numeric, first_value);
        if first_value < minimums[field_index] or last_value > maximums[field_index] or first_value > last_value then
          return false;
        end if;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

create function internal.normalize_factory_automation_definition(p_definition jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  name text := internal.trim_factory_automation_text(p_definition->>'name');
  trigger_config jsonb := p_definition->'trigger';
  filters jsonb := p_definition->'filters';
  target jsonb := p_definition->'target';
  execution_grant jsonb := p_definition->'executionGrant';
  grant_version bigint;
begin
  if jsonb_typeof(p_definition) is distinct from 'object'
    or p_definition - array['name','trigger','filters','target','executionGrant','servicePrincipalId','budgetPayerMemberId','credentialBindingId'] <> '{}'::jsonb
    or jsonb_typeof(p_definition->'name') is distinct from 'string'
    or char_length(name) not between 1 and 120 or name ~ U&'[\0001-\001F\007F-\009F]'
    or jsonb_typeof(trigger_config) is distinct from 'object'
    or jsonb_typeof(filters) is distinct from 'object'
    or jsonb_typeof(target) is distinct from 'object'
    or jsonb_typeof(execution_grant) is distinct from 'object'
    or execution_grant - array['id','version'] <> '{}'::jsonb
    or jsonb_typeof(execution_grant->'version') is distinct from 'number'
    or (execution_grant->>'version') !~ '^[1-9][0-9]{0,15}$' then
    raise exception 'The automation definition is invalid.' using errcode = '22023';
  end if;
  grant_version := (execution_grant->>'version')::bigint;
  if grant_version > 9007199254740991 then
    raise exception 'The automation execution grant version is invalid.' using errcode = '22023';
  end if;

  case trigger_config->>'kind'
    when 'schedule' then
      if trigger_config - array['kind','cron','timeZone'] <> '{}'::jsonb or filters <> '{}'::jsonb
        or jsonb_typeof(trigger_config->'cron') is distinct from 'string'
        or not internal.valid_factory_automation_cron(trigger_config->>'cron')
        or jsonb_typeof(trigger_config->'timeZone') is distinct from 'string'
        or char_length(trigger_config->>'timeZone') > 80
        or (trigger_config->>'timeZone') !~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$' then
        raise exception 'The automation schedule trigger is invalid.' using errcode = '22023';
      end if;
    when 'pull-request' then
      if trigger_config - array['kind','repositoryId'] <> '{}'::jsonb
        or filters - array['actions','baseBranches'] <> '{}'::jsonb
        or not internal.valid_factory_automation_filter_values(filters->'actions')
        or not internal.valid_factory_automation_filter_values(filters->'baseBranches')
        or not (filters->'actions' <@ '["opened","reopened","synchronize","ready_for_review","closed","merged"]'::jsonb) then
        raise exception 'The automation pull request trigger or filters are invalid.' using errcode = '22023';
      end if;
      trigger_config := jsonb_build_object('kind', 'pull-request', 'repositoryId',
        internal.factory_automation_uuid(trigger_config->'repositoryId'));
    when 'issue-state' then
      if trigger_config - 'kind' <> '{}'::jsonb
        or filters - array['stateIds','teamIds','projectIds'] <> '{}'::jsonb
        or not internal.valid_factory_automation_filter_values(filters->'stateIds')
        or not internal.valid_factory_automation_filter_values(filters->'teamIds')
        or not internal.valid_factory_automation_filter_values(filters->'projectIds')
        or filters->'stateIds' = '[]'::jsonb then
        raise exception 'The automation issue-state trigger or filters are invalid.' using errcode = '22023';
      end if;
    else
      raise exception 'The automation trigger kind is invalid.' using errcode = '22023';
  end case;

  case target->>'kind'
    when 'agent' then
      if target - array['kind','definitionRevisionId','agentId'] <> '{}'::jsonb then
        raise exception 'The automation agent target is invalid.' using errcode = '22023';
      end if;
      target := jsonb_build_object('kind', 'agent',
        'definitionRevisionId', internal.factory_automation_uuid(target->'definitionRevisionId'),
        'agentId', internal.factory_automation_uuid(target->'agentId'));
    when 'workflow' then
      if target - array['kind','definitionRevisionId','agentId','workflowId','workflowActivationId'] <> '{}'::jsonb then
        raise exception 'The automation workflow target is invalid.' using errcode = '22023';
      end if;
      target := jsonb_build_object('kind', 'workflow',
        'definitionRevisionId', internal.factory_automation_uuid(target->'definitionRevisionId'),
        'agentId', internal.factory_automation_uuid(target->'agentId'),
        'workflowId', internal.factory_automation_uuid(target->'workflowId'),
        'workflowActivationId', internal.factory_automation_uuid(target->'workflowActivationId'));
    else
      raise exception 'The automation target kind is invalid.' using errcode = '22023';
  end case;

  return jsonb_build_object(
    'name', name, 'trigger', trigger_config, 'filters', filters, 'target', target,
    'executionGrant', jsonb_build_object('id', internal.factory_automation_uuid(execution_grant->'id'),
      'version', grant_version),
    'servicePrincipalId', internal.factory_automation_uuid(p_definition->'servicePrincipalId'),
    'budgetPayerMemberId', internal.factory_automation_uuid(p_definition->'budgetPayerMemberId'),
    'credentialBindingId', internal.factory_automation_uuid(p_definition->'credentialBindingId'));
end;
$$;

-- Publish against the same exact, currently admitted target that unattended
-- session creation must resolve. No credential material is read or returned.
create function internal.assert_factory_automation_target(
  p_workspace_id uuid, p_factory_id uuid, p_definition jsonb
) returns void language plpgsql set search_path = '' as $$
declare
  target jsonb := p_definition->'target';
  trigger_config jsonb := p_definition->'trigger';
  base record;
  workflow_activation internal.factory_workflow_authoring_activations;
  grant_row public.factory_execution_grants;
begin
  select * into base from internal.factory_workflow_authoring_base(p_workspace_id, p_factory_id);
  if base.revision_id::text is distinct from target->>'definitionRevisionId'
    or base.definition#>>'{implementationAgent,agentId}' is distinct from target->>'agentId'
    or base.definition->'executionGrant' is distinct from p_definition->'executionGrant'
    or base.definition->>'credentialBindingId' is distinct from p_definition->>'credentialBindingId' then
    raise exception 'The automation target does not match the current scoped factory definition.' using errcode = 'PT422';
  end if;
  if target->>'kind' = 'workflow' then
    select * into workflow_activation from internal.factory_workflow_authoring_activations activation
    where (activation.workspace_id, activation.factory_id, activation.workflow_id) =
      (p_workspace_id, p_factory_id, (target->>'workflowId')::uuid)
    order by activation.activation_number desc limit 1;
    if workflow_activation.id::text is distinct from target->>'workflowActivationId'
      or workflow_activation.base_activation_id is distinct from base.id then
      raise exception 'The automation workflow activation is unavailable for this factory definition.' using errcode = 'PT422';
    end if;
  end if;

  grant_row := internal.resolve_definition_execution_grant(
    p_workspace_id, p_factory_id, base.definition, (base.definition->>'repositoryId')::uuid,
    (base.definition->>'executionPolicyRevisionId')::uuid
  );
  if (grant_row.service_principal_id::text, grant_row.budget_payer_member_id::text) is distinct from
    (p_definition->>'servicePrincipalId', p_definition->>'budgetPayerMemberId')
    or ('sessions:create'::public.factory_command_scope = any(grant_row.command_scopes)) is not true then
    raise exception 'The automation service authority or budget payer is unavailable.' using errcode = 'PT422';
  end if;
  perform internal.lock_definition_credential_binding(
    p_workspace_id, p_factory_id, base.definition, grant_row.id, grant_row.service_principal_id
  );

  case trigger_config->>'kind'
    when 'schedule' then
      if not exists (select 1 from pg_catalog.pg_timezone_names zone where zone.name = trigger_config->>'timeZone') then
        raise exception 'The automation schedule time zone is unavailable.' using errcode = 'PT422';
      end if;
    when 'pull-request' then
      perform 1 from public.github_repositories repository
      join public.github_installations installation
        on (installation.workspace_id, installation.id) = (repository.workspace_id, repository.github_installation_id)
      where (repository.workspace_id, repository.factory_id, repository.id) =
        (p_workspace_id, p_factory_id, (trigger_config->>'repositoryId')::uuid)
        and not repository.is_archived and not installation.suspended
      for share of repository, installation nowait;
      if not found then
        raise exception 'The automation source repository is unavailable.' using errcode = 'PT422';
      end if;
    else null;
  end case;
exception when lock_not_available then
  raise exception 'Automation target access is changing. Retry shortly.' using errcode = 'PT409';
when insufficient_privilege then
  raise exception 'The automation execution grant is unavailable.' using errcode = 'PT422';
end;
$$;

create function internal.factory_automation_state(
  p_automation internal.factory_automations, p_selected_revision_id uuid
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'automationId', p_automation.id,
    'draftRevisionId', p_automation.draft_revision_id,
    'publishedRevisionId', p_automation.published_revision_id,
    'archivedAt', p_automation.archived_at,
    'revision', jsonb_build_object(
      'id', revision.id, 'revision', revision.revision_number, 'definition', revision.definition,
      'createdAt', revision.created_at, 'createdByMemberId', revision.created_by_member_id))
  from internal.factory_automation_revisions revision
  where (revision.automation_id, revision.id) =
    (p_automation.id, coalesce(p_selected_revision_id, p_automation.draft_revision_id))
$$;

create function internal.factory_automation_actor(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid
) returns uuid language plpgsql set search_path = '' as $$
declare actor uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  -- Definition and authored workflow publication both acquire this factory
  -- row lock. Target lookups remain current through the automation write.
  actor := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  return actor;
end;
$$;

create function internal.lock_factory_automation_head(
  p_workspace_id uuid, p_factory_id uuid, p_automation_id uuid, p_expected_revision_id uuid
) returns internal.factory_automations language plpgsql set search_path = '' as $$
declare automation internal.factory_automations;
begin
  select * into automation from internal.factory_automations candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.id) =
    (p_workspace_id, p_factory_id, p_automation_id)
  for update;
  if not found then
    raise exception 'The automation is unavailable.' using errcode = 'P0002';
  end if;
  if automation.draft_revision_id is distinct from p_expected_revision_id then
    raise exception 'The automation draft changed. Reload before updating it.' using errcode = 'PT409';
  end if;
  return automation;
end;
$$;

create function internal.record_factory_automation_audit(
  p_automation internal.factory_automations, p_action text, p_actor_member_id uuid, p_prior_draft_id uuid default null
) returns void language sql set search_path = '' as $$
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (p_automation.workspace_id, p_automation.factory_id, p_action, p_actor_member_id, jsonb_strip_nulls(jsonb_build_object(
    'automationId', p_automation.id, 'revisionId', p_automation.draft_revision_id,
    'previousDraftRevisionId', p_prior_draft_id, 'publishedRevisionId', p_automation.published_revision_id)))
$$;

create function public.create_factory_automation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_automation_id uuid, p_definition jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  automation internal.factory_automations;
  revision_id uuid := gen_random_uuid();
  definition jsonb;
begin
  actor := internal.factory_automation_actor(p_workspace_id, p_factory_id, p_actor_user_id);
  definition := internal.normalize_factory_automation_definition(p_definition);
  if p_automation_id is null then
    raise exception 'An automation identity is required.' using errcode = '22023';
  end if;

  insert into internal.factory_automations(id, workspace_id, factory_id, draft_revision_id)
  values (p_automation_id, p_workspace_id, p_factory_id, revision_id)
  on conflict (id) do nothing returning * into automation;
  if not found then
    raise exception 'The automation identity is unavailable.' using errcode = 'PT409';
  end if;
  insert into internal.factory_automation_revisions(
    id, workspace_id, factory_id, automation_id, revision_number, definition, created_by_member_id
  ) values (revision_id, p_workspace_id, p_factory_id, p_automation_id, 1, definition, actor);
  perform internal.record_factory_automation_audit(automation, 'automation.created', actor);
  return internal.factory_automation_state(automation, null);
end;
$$;

create function public.save_factory_automation_draft(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_automation_id uuid,
  p_expected_revision_id uuid, p_definition jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  automation internal.factory_automations;
  prior_revision internal.factory_automation_revisions;
  revision_id uuid;
  definition jsonb;
begin
  actor := internal.factory_automation_actor(p_workspace_id, p_factory_id, p_actor_user_id);
  automation := internal.lock_factory_automation_head(p_workspace_id, p_factory_id, p_automation_id, p_expected_revision_id);
  if automation.archived_at is not null then
    raise exception 'The automation is archived.' using errcode = 'PT409';
  end if;
  definition := internal.normalize_factory_automation_definition(p_definition);
  select * into strict prior_revision from internal.factory_automation_revisions
  where id = automation.draft_revision_id;
  if prior_revision.definition = definition then
    return internal.factory_automation_state(automation, null);
  end if;
  insert into internal.factory_automation_revisions(
    workspace_id, factory_id, automation_id, revision_number, definition, created_by_member_id
  ) values (p_workspace_id, p_factory_id, p_automation_id, prior_revision.revision_number + 1, definition, actor)
  returning id into revision_id;

  update internal.factory_automations set draft_revision_id = revision_id
  where id = p_automation_id returning * into automation;
  perform internal.record_factory_automation_audit(automation, 'automation.draft_saved', actor, prior_revision.id);
  return internal.factory_automation_state(automation, null);
end;
$$;

create function public.publish_factory_automation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_automation_id uuid, p_expected_revision_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  automation internal.factory_automations;
  definition jsonb;
begin
  actor := internal.factory_automation_actor(p_workspace_id, p_factory_id, p_actor_user_id);
  automation := internal.lock_factory_automation_head(p_workspace_id, p_factory_id, p_automation_id, p_expected_revision_id);
  if automation.archived_at is not null then
    raise exception 'The automation is archived.' using errcode = 'PT409';
  end if;
  if automation.published_revision_id is distinct from automation.draft_revision_id then
    select revision.definition into strict definition from internal.factory_automation_revisions revision
    where revision.id = automation.draft_revision_id;
    perform internal.assert_factory_automation_target(p_workspace_id, p_factory_id, definition);

    update internal.factory_automations set published_revision_id = draft_revision_id
    where id = p_automation_id returning * into automation;
    perform internal.record_factory_automation_audit(automation, 'automation.published', actor);
  end if;
  return internal.factory_automation_state(automation, null);
end;
$$;

create function public.archive_factory_automation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_automation_id uuid,
  p_expected_revision_id uuid, p_expected_publication jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid;
  automation internal.factory_automations;
  observed_publication uuid;
begin
  actor := internal.factory_automation_actor(p_workspace_id, p_factory_id, p_actor_user_id);
  automation := internal.lock_factory_automation_head(p_workspace_id, p_factory_id, p_automation_id, p_expected_revision_id);
  if jsonb_typeof(p_expected_publication) is distinct from 'object'
    or not (p_expected_publication ? 'revisionId')
    or p_expected_publication - 'revisionId' <> '{}'::jsonb then
    raise exception 'The observed automation publication is required.' using errcode = '22023';
  end if;
  if p_expected_publication->'revisionId' <> 'null'::jsonb then
    observed_publication := internal.factory_automation_uuid(p_expected_publication->'revisionId');
  end if;
  if automation.published_revision_id is distinct from observed_publication then
    raise exception 'The automation publication changed. Reload before archiving.' using errcode = 'PT409';
  end if;
  if automation.archived_at is null then
    update internal.factory_automations set archived_at = clock_timestamp()
    where id = p_automation_id returning * into automation;
    perform internal.record_factory_automation_audit(automation, 'automation.archived', actor);
  end if;
  return internal.factory_automation_state(automation, null);
end;
$$;

create function public.read_factory_automation(
  p_workspace_id uuid, p_factory_id uuid, p_automation_id uuid, p_selected_revision_id uuid default null
) returns jsonb language sql stable security definer set search_path = '' as $$
  select internal.factory_automation_state(automation, p_selected_revision_id)
  from internal.factory_automations automation
  where (automation.workspace_id, automation.factory_id, automation.id) =
    (p_workspace_id, p_factory_id, p_automation_id)
    and auth.uid() is not null
    and internal.can_manage_factory(p_workspace_id, p_factory_id)
$$;

create function public.list_factory_automations(p_workspace_id uuid, p_factory_id uuid, p_after_id uuid default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select (
    with candidates as (
      select automation from internal.factory_automations automation
      where (automation.workspace_id, automation.factory_id) = (p_workspace_id, p_factory_id)
        and (p_after_id is null or automation.id > p_after_id)
      order by automation.id limit 51
    ), page as (
      select automation from candidates order by (automation).id limit 50
    )
    select jsonb_build_object(
      'automations', coalesce(jsonb_agg(internal.factory_automation_state(page.automation, null)
        order by (page.automation).id), '[]'::jsonb),
      'nextCursor', case when (select count(*) from candidates) = 51
        then (select (last_item.automation).id from page last_item order by (last_item.automation).id desc limit 1) end)
    from page
  )
  from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id)
    and auth.uid() is not null
    and internal.can_manage_factory(p_workspace_id, p_factory_id)
$$;

revoke all on function
  internal.factory_automation_uuid(jsonb),
  internal.trim_factory_automation_text(text),
  internal.valid_factory_automation_filter_values(jsonb),
  internal.valid_factory_automation_cron(text),
  internal.normalize_factory_automation_definition(jsonb),
  internal.assert_factory_automation_target(uuid, uuid, jsonb),
  internal.factory_automation_state(internal.factory_automations, uuid),
  internal.factory_automation_actor(uuid, uuid, uuid),
  internal.lock_factory_automation_head(uuid, uuid, uuid, uuid),
  internal.record_factory_automation_audit(internal.factory_automations, text, uuid, uuid),
  public.create_factory_automation(uuid, uuid, uuid, uuid, jsonb),
  public.save_factory_automation_draft(uuid, uuid, uuid, uuid, uuid, jsonb),
  public.publish_factory_automation(uuid, uuid, uuid, uuid, uuid),
  public.archive_factory_automation(uuid, uuid, uuid, uuid, uuid, jsonb),
  public.read_factory_automation(uuid, uuid, uuid, uuid),
  public.list_factory_automations(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.create_factory_automation(uuid, uuid, uuid, uuid, jsonb),
  public.save_factory_automation_draft(uuid, uuid, uuid, uuid, uuid, jsonb),
  public.publish_factory_automation(uuid, uuid, uuid, uuid, uuid),
  public.archive_factory_automation(uuid, uuid, uuid, uuid, uuid, jsonb)
  to service_role;

grant execute on function
  public.read_factory_automation(uuid, uuid, uuid, uuid),
  public.list_factory_automations(uuid, uuid, uuid)
  to authenticated;
