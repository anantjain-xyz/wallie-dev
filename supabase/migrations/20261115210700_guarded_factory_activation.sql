-- Activation reads current operational authority. The command already holds
-- the workspace lock and the factory mutex before calling this function.
create function internal.assert_factory_activation_authority(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_definition jsonb,
  p_enabled_sandbox_providers text[],
  p_required_probes text[]
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_pipeline_id uuid := (p_definition ->> 'pipelineId')::uuid;
  v_repository_id uuid := (p_definition ->> 'repositoryId')::uuid;
  v_execution_revision_id uuid := (p_definition ->> 'executionPolicyRevisionId')::uuid;
  v_delivery_revision_id uuid := (p_definition ->> 'deliveryPolicyRevisionId')::uuid;
  v_agent_provider text := p_definition #>> '{agent,provider}';
  v_agent_model text := p_definition #>> '{agent,model}';
  v_sandbox_provider text := p_definition ->> 'sandboxProvider';
  v_pipeline_available boolean;
  v_named_approvers uuid[];
  v_eligible_approvers integer;
  v_installation_id uuid;
  v_connection_revision uuid;
  v_capability public.sandbox_capability_checks;
  v_agent_credential_available boolean;
begin
  -- Pipeline rewrites and member removal lock pipelines before membership.
  perform 1 from public.pipelines p
    where p.id = v_pipeline_id and p.workspace_id = p_workspace_id for share;
  v_pipeline_available := found;
  perform 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id
      and m.kind = 'human' and m.is_active and m.role in ('owner', 'admin')
    for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  if not v_pipeline_available then
    raise exception 'The definition pipeline is unavailable.' using errcode = 'PT422';
  end if;

  select array_agg(distinct member_id.value::uuid) into v_named_approvers
    from jsonb_array_elements(p_definition -> 'stages') stage
    cross join lateral jsonb_array_elements_text(stage.value -> 'approverMemberIds') member_id;
  perform m.id from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.id = any(v_named_approvers)
      and m.kind = 'human' and m.is_active
    order by m.id for share;
  get diagnostics v_eligible_approvers = row_count;
  if v_eligible_approvers <> coalesce(cardinality(v_named_approvers), 0) then
    raise exception 'A definition approver is no longer eligible.' using errcode = 'PT422';
  end if;

  if v_execution_revision_id is not null and not exists (
    select 1 from public.execution_policy_revisions r
      where r.id = v_execution_revision_id and r.workspace_id = p_workspace_id
  ) then
    raise exception 'The execution policy revision is unavailable.' using errcode = 'PT422';
  end if;
  if v_delivery_revision_id is not null and not exists (
    select 1 from public.delivery_policy_revisions r
      where r.id = v_delivery_revision_id and r.workspace_id = p_workspace_id
        and r.pipeline_id = v_pipeline_id
  ) then
    raise exception 'The delivery policy revision is unavailable for this pipeline.' using errcode = 'PT422';
  end if;

  -- A GitHub disconnect can cascade to sessions locked by workers waiting for
  -- the workspace fence. Retry if that write already owns either GitHub row.
  begin
    select i.id into v_installation_id from public.github_installations i
      where i.workspace_id = p_workspace_id and not i.suspended for share nowait;
    perform 1 from public.github_repositories r
      where r.id = v_repository_id and r.workspace_id = p_workspace_id
        and r.github_installation_id = v_installation_id and not r.is_archived
      for share nowait;
    if not found then
      raise exception 'The definition repository is unavailable.' using errcode = 'PT422';
    end if;
  exception when lock_not_available then
    raise exception 'Repository access is changing. Reload the factory before retrying.' using errcode = 'PT409';
  end;

  if v_sandbox_provider not in ('vercel', 'e2b', 'daytona')
    or (v_sandbox_provider = any(p_enabled_sandbox_providers)) is distinct from true then
    raise exception 'The sandbox provider is disabled for this deployment.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from public.workspace_sandbox_connection_mutations m
      where m.workspace_id = p_workspace_id and m.provider = v_sandbox_provider
        and m.expires_at > clock_timestamp()
  ) then
    raise exception 'The sandbox connection is being updated.' using errcode = 'PT422';
  end if;

  -- Connection updates already take the workspace lock. A separate connection
  -- row lock here would reverse their row/workspace lock order.
  case v_sandbox_provider
    when 'vercel' then
      select c.connection_revision into v_connection_revision from public.workspace_vercel_sandbox_connections c
        where c.workspace_id = p_workspace_id and c.status = 'connected';
    when 'e2b' then
      select c.connection_revision into v_connection_revision from public.workspace_e2b_sandbox_connections c
        where c.workspace_id = p_workspace_id and c.status = 'connected';
    when 'daytona' then
      select c.connection_revision into v_connection_revision from public.workspace_daytona_sandbox_connections c
        where c.workspace_id = p_workspace_id and c.status = 'connected';
  end case;
  if v_connection_revision is null then
    raise exception 'The sandbox credential is unavailable.' using errcode = 'PT422';
  end if;

  select c.* into v_capability from public.sandbox_capability_checks c
    where c.workspace_id = p_workspace_id and c.github_repository_id = v_repository_id
    order by c.checked_at desc, c.id desc limit 1 for share;
  if not found or v_capability.status is distinct from 'success'
    or v_capability.sandbox_provider is distinct from v_sandbox_provider
    or v_capability.sandbox_connection_revision is distinct from v_connection_revision
    or v_capability.agent_provider is distinct from v_agent_provider
    or v_capability.agent_model is distinct from v_agent_model
    or coalesce(cardinality(p_required_probes), 0) = 0
    or exists (
      select 1 from unnest(p_required_probes) required(probe)
        where v_capability.capabilities #> array[required.probe, 'ok'] is distinct from 'true'::jsonb
    ) then
    raise exception 'A current capability check is required for this repository, sandbox, and agent.' using errcode = 'PT422';
  end if;

  -- Qualify the current actor, without storing their credential on the revision
  -- or giving future sessions access to it. Session execution still authorizes
  -- its own current owner.
  case v_agent_provider
    when 'codex' then
      perform 1 from public.user_codex_credentials c where c.user_id = p_actor_user_id
        and (c.access_token_expires_at is null or c.access_token_expires_at > clock_timestamp())
        and (c.credential_type <> 'chatgpt_auth_json' or not c.auth_reconnect_required)
        for share;
      v_agent_credential_available := found;
    when 'claude-code' then
      perform 1 from public.user_claude_code_credentials c where c.user_id = p_actor_user_id for share;
      v_agent_credential_available := found;
    when 'cursor' then
      perform 1 from public.user_cursor_credentials c where c.user_id = p_actor_user_id
        and not c.reconnect_required and c.api_key_expires_at > clock_timestamp() for share;
      v_agent_credential_available := found;
    when 'opencode' then
      if split_part(v_agent_model, '/', 1) = 'opencode' then
        perform 1 from public.user_opencode_credentials c where c.user_id = p_actor_user_id for share;
      else
        perform 1 from public.user_opencode_provider_credentials c where c.user_id = p_actor_user_id
          and c.provider_id = split_part(v_agent_model, '/', 1) for share;
      end if;
      v_agent_credential_available := found;
    else
      v_agent_credential_available := false;
  end case;
  if not v_agent_credential_available then
    raise exception 'A current personal credential is required for this agent.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_activation_authority(uuid, uuid, jsonb, text[], text[])
  from public, anon, authenticated, service_role;
-- All writers take the workspace fence and then the factory lock. Admission can
-- use the same workspace fence when it begins pinning active revisions.
create function internal.lock_factory_definition_head(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint
) returns public.factory_definition_activations
language plpgsql security invoker set search_path = '' as $$
declare head public.factory_definition_activations;
begin
  if p_expected_activation_number is null or p_expected_activation_number < 0 then
    raise exception 'A valid expected activation number is required.' using errcode = '22023';
  end if;
  perform 1 from public.workspaces where id = p_workspace_id and deletion_requested_at is null
    for no key update;
  if not found then
    raise exception 'Factory workspace is unavailable.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace_id
    and m.user_id = p_actor_user_id and m.kind = 'human' and m.is_active and m.role in ('owner', 'admin')) then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  perform 1 from public.factories f where (f.workspace_id, f.id) = (p_workspace_id, p_factory_id) for update;
  if not found then
    raise exception 'Factory is unavailable.' using errcode = 'P0002';
  end if;
  select * into head from public.factory_definition_activations a
  where (a.workspace_id, a.factory_id) = (p_workspace_id, p_factory_id)
  order by a.activation_number desc limit 1;
  if p_expected_activation_number <> coalesce(head.activation_number, 0) then
    raise exception 'The active definition changed. Reload the factory before retrying.' using errcode = 'PT409';
  end if;
  return head;
end;
$$;
revoke all on function internal.lock_factory_definition_head(uuid,uuid,uuid,bigint)
  from public, anon, authenticated, service_role;

create function public.save_factory_definition_draft(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_definition_json text, p_canonical_digest text
) returns public.factory_definition_drafts
language plpgsql security definer set search_path = '' as $$
declare result public.factory_definition_drafts; definition jsonb;
begin
  perform internal.lock_factory_definition_head(p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  perform 1 from public.workspace_members m where m.workspace_id = p_workspace_id
    and m.user_id = p_actor_user_id and m.kind = 'human' and m.is_active and m.role in ('owner', 'admin') for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  if p_definition_json is null or not (p_definition_json is json object with unique keys) or p_canonical_digest is null then
    raise exception 'A compiled definition and digest are required.' using errcode = '22023';
  end if;
  definition := p_definition_json::jsonb;
  if definition->'schemaVersion' is distinct from '1'::jsonb
    or definition->>'kind' is distinct from 'serial' then
    raise exception 'A version 1 serial definition is required.' using errcode = '22023';
  end if;
  insert into public.factory_definition_drafts(
    workspace_id, factory_id, base_activation_number, schema_version, definition_json, canonical_digest, created_by
  ) values (p_workspace_id, p_factory_id, nullif(p_expected_activation_number, 0), 1,
    p_definition_json, p_canonical_digest, p_actor_user_id) returning * into result;
  return result;
end;
$$;

create function public.publish_factory_definition_draft(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_draft_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[]
) returns public.factory_definition_activations
language plpgsql security definer set search_path = '' as $$
declare draft public.factory_definition_drafts; published_id uuid; result public.factory_definition_activations;
begin
  perform internal.lock_factory_definition_head(p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  select * into draft from public.factory_definition_drafts d
  where (d.workspace_id, d.factory_id, d.id) = (p_workspace_id, p_factory_id, p_draft_id);
  if not found then
    raise exception 'Factory definition draft is unavailable.' using errcode = 'P0002';
  end if;
  if coalesce(draft.base_activation_number, 0) <> p_expected_activation_number then
    raise exception 'The draft was saved against a different activation. Save a new draft before publishing.' using errcode = 'PT409';
  end if;
  perform internal.assert_factory_activation_authority(p_workspace_id, p_actor_user_id,
    draft.definition_json::jsonb, p_enabled_sandbox_providers, p_required_probes);
  insert into public.factory_definition_revisions(
    workspace_id, factory_id, source_draft_id, schema_version, definition_json, canonical_digest, created_by
  ) values (p_workspace_id, p_factory_id, draft.id, draft.schema_version, draft.definition_json,
    draft.canonical_digest, p_actor_user_id) returning id into published_id;
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  values (p_workspace_id, p_factory_id, published_id, p_expected_activation_number + 1, p_actor_user_id)
  returning * into result;
  return result;
end;
$$;

create function public.rollback_factory_definition(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_revision_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[]
) returns public.factory_definition_activations
language plpgsql security definer set search_path = '' as $$
declare head public.factory_definition_activations; revision public.factory_definition_revisions;
  result public.factory_definition_activations;
begin
  head := internal.lock_factory_definition_head(p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  select r.* into revision from public.factory_definition_revisions r
  where (r.workspace_id, r.factory_id, r.id) = (p_workspace_id, p_factory_id, p_revision_id)
    and exists (select 1 from public.factory_definition_activations a
      where (a.workspace_id, a.factory_id, a.revision_id) = (r.workspace_id, r.factory_id, r.id));
  if not found then
    raise exception 'A previously active factory revision is required.' using errcode = 'P0002';
  end if;
  if revision.id = head.revision_id then
    raise exception 'This factory definition is already active.' using errcode = 'PT409';
  end if;
  perform internal.assert_factory_activation_authority(p_workspace_id, p_actor_user_id,
    revision.definition_json::jsonb, p_enabled_sandbox_providers, p_required_probes);
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  values (p_workspace_id, p_factory_id, revision.id, p_expected_activation_number + 1, p_actor_user_id)
  returning * into result;
  return result;
end;
$$;

revoke all on function public.save_factory_definition_draft(uuid,uuid,uuid,bigint,text,text),
  public.publish_factory_definition_draft(uuid,uuid,uuid,bigint,uuid,text[],text[]),
  public.rollback_factory_definition(uuid,uuid,uuid,bigint,uuid,text[],text[])
  from public, anon, authenticated, service_role;
grant execute on function public.save_factory_definition_draft(uuid,uuid,uuid,bigint,text,text),
  public.publish_factory_definition_draft(uuid,uuid,uuid,bigint,uuid,text[],text[]),
  public.rollback_factory_definition(uuid,uuid,uuid,bigint,uuid,text[],text[]) to service_role;
