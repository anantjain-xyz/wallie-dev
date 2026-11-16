-- Candidate UI metadata accompanies the existing manager-readable, immutable
-- draft. No stage or policy history is written until the draft is published.
alter table public.factory_definition_drafts
  add column settings_metadata jsonb not null default '{}'::jsonb
  check (jsonb_typeof(settings_metadata) = 'object');

create function internal.latest_factory_draft_id(
  p_workspace_id uuid, p_factory_id uuid, p_activation_number bigint
) returns uuid language sql stable set search_path = '' as $$
  select d.id from public.factory_definition_drafts d
  where d.workspace_id = p_workspace_id and d.factory_id = p_factory_id
    and d.base_activation_number is not distinct from nullif(p_activation_number, 0)
  order by d.created_at desc, d.id desc limit 1
$$;
revoke all on function internal.latest_factory_draft_id(uuid, uuid, bigint)
  from public, anon, authenticated, service_role;

create function public.save_settings_factory_definition_draft(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_definition_json text, p_canonical_digest text, p_settings_metadata jsonb,
  p_expected_draft_id uuid default null
) returns public.factory_definition_drafts
language plpgsql security definer set search_path = '' as $$
declare
  definition jsonb;
  v_pipeline_id uuid;
  stage_ids uuid[];
  reserved_ids uuid[];
  missing_ids uuid[];
  execution_candidate jsonb := p_settings_metadata->'executionPolicy';
  delivery_candidate jsonb := p_settings_metadata->'deliveryPolicy';
  result public.factory_definition_drafts;
begin
  perform internal.lock_factory_definition_head(
    p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  if internal.latest_factory_draft_id(p_workspace_id, p_factory_id, p_expected_activation_number)
    is distinct from p_expected_draft_id then
    raise exception 'The factory draft changed. Reload before saving.' using errcode = 'PT409';
  end if;
  if p_definition_json is null or not (p_definition_json is json object with unique keys)
    or p_canonical_digest is null or jsonb_typeof(p_settings_metadata) is distinct from 'object' then
    raise exception 'A compiled definition, digest, and settings metadata are required.' using errcode = '22023';
  end if;
  definition := p_definition_json::jsonb;
  if definition->'schemaVersion' is distinct from '1'::jsonb or definition->>'kind' is distinct from 'serial'
    or jsonb_typeof(definition->'stages') is distinct from 'array'
    or exists (select 1 from jsonb_object_keys(p_settings_metadata) as metadata(key)
      where metadata.key not in ('newStageIds','pipelineName','archivedStages','executionPolicy','deliveryPolicy'))
    or p_settings_metadata ? 'newStageIds' and jsonb_typeof(p_settings_metadata->'newStageIds') is distinct from 'array'
    or p_settings_metadata ? 'archivedStages' and jsonb_typeof(p_settings_metadata->'archivedStages') is distinct from 'array'
    or p_settings_metadata ? 'pipelineName' and (jsonb_typeof(p_settings_metadata->'pipelineName') is distinct from 'string'
      or char_length(btrim(p_settings_metadata->>'pipelineName')) not between 1 and 80) then
    raise exception 'Invalid factory settings draft.' using errcode = '22023';
  end if;

  v_pipeline_id := (definition->>'pipelineId')::uuid;
  perform 1 from public.pipelines p where p.id = v_pipeline_id and p.workspace_id = p_workspace_id for share;
  if not found then
    raise exception 'The definition pipeline is unavailable.' using errcode = 'PT422';
  end if;
  -- Same order as membership removal and canonical activation.
  perform 1 from public.workspace_members m where m.workspace_id = p_workspace_id
    and m.user_id = p_actor_user_id and m.kind = 'human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;

  select array_agg((s.value->>'id')::uuid) into stage_ids from jsonb_array_elements(definition->'stages') s;
  reserved_ids := array(select value::uuid from jsonb_array_elements_text(
    coalesce(p_settings_metadata->'newStageIds', '[]'::jsonb)) order by value::uuid);
  if coalesce(cardinality(stage_ids), 0) = 0 or array_position(stage_ids, null) is not null
    or cardinality(stage_ids) <> (select count(distinct id) from unnest(stage_ids) as stage(id))
    or exists (select 1 from public.pipeline_stages s where s.id = any(stage_ids)
      and (s.workspace_id, s.pipeline_id) is distinct from (p_workspace_id, v_pipeline_id)) then
    raise exception 'The definition has invalid stage identities.' using errcode = 'PT422';
  end if;
  missing_ids := array(select stage.id from unnest(stage_ids) as stage(id)
    where not exists (select 1 from public.pipeline_stages s where s.id = stage.id) order by stage.id);
  if reserved_ids is distinct from missing_ids then
    raise exception 'New stage reservations do not match the definition.' using errcode = 'PT422';
  end if;

  if execution_candidate is not null and (jsonb_typeof(execution_candidate) is distinct from 'object'
    or (execution_candidate->>'id')::uuid is null
    or (execution_candidate->>'id')::uuid is distinct from (definition->>'executionPolicyRevisionId')::uuid
    or internal.valid_execution_requirements(execution_candidate->'requirements') is distinct from true
    or exists (select 1 from public.execution_policy_revisions r where r.id = (execution_candidate->>'id')::uuid)) then
    raise exception 'Invalid execution policy candidate.' using errcode = 'PT422';
  end if;
  if delivery_candidate is not null and (jsonb_typeof(delivery_candidate) is distinct from 'object'
    or (delivery_candidate->>'id')::uuid is null
    or (delivery_candidate->>'id')::uuid is distinct from (definition->>'deliveryPolicyRevisionId')::uuid
    or internal.valid_delivery_requirements(delivery_candidate->'requirements') is distinct from true
    or exists (select 1 from public.delivery_policy_revisions r where r.id = (delivery_candidate->>'id')::uuid)) then
    raise exception 'Invalid delivery policy candidate.' using errcode = 'PT422';
  end if;

  insert into public.factory_definition_drafts(
    workspace_id, factory_id, base_activation_number, schema_version, definition_json,
    canonical_digest, created_by, settings_metadata
  ) values (p_workspace_id, p_factory_id, nullif(p_expected_activation_number, 0), 1,
    p_definition_json, p_canonical_digest, p_actor_user_id, p_settings_metadata) returning * into result;
  return result;
end;
$$;
revoke all on function public.save_settings_factory_definition_draft(uuid, uuid, uuid, bigint, text, text, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_settings_factory_definition_draft(uuid, uuid, uuid, bigint, text, text, jsonb, uuid)
  to service_role;

-- The transaction already holds the workspace and factory fence. Allocate
-- stable, archived backing identities for enrolled stages only at activation.
-- The definition owns all execution-visible names, prompts, and approvers.
create function internal.materialize_factory_settings_draft(
  p_draft public.factory_definition_drafts, p_actor_user_id uuid
) returns void language plpgsql set search_path = '' as $$
declare
  metadata jsonb := p_draft.settings_metadata;
  v_pipeline_id uuid := (p_draft.definition_json::jsonb->>'pipelineId')::uuid;
  execution_candidate jsonb := metadata->'executionPolicy';
  delivery_candidate jsonb := metadata->'deliveryPolicy';
begin
  if not (metadata ?| array['newStageIds','pipelineName','executionPolicy','deliveryPolicy']) then return; end if;
  perform 1 from public.pipelines p where p.id = v_pipeline_id and p.workspace_id = p_draft.workspace_id for update;
  if not found then
    raise exception 'The definition pipeline is unavailable.' using errcode = 'PT422';
  end if;
  perform 1 from public.workspace_members m where m.workspace_id = p_draft.workspace_id
    and m.user_id = p_actor_user_id and m.kind = 'human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;

  insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name, archived_at)
  select stage.id_text::uuid, p_draft.workspace_id, v_pipeline_id,
    (select coalesce(max(s.position), 0) from public.pipeline_stages s where s.pipeline_id = v_pipeline_id) + stage.position::integer,
    'factory-stage-' || stage.id_text::uuid::text, 'Factory stage', clock_timestamp()
  from jsonb_array_elements_text(coalesce(metadata->'newStageIds', '[]'::jsonb))
    with ordinality as stage(id_text, position);

  if execution_candidate is not null then
    insert into public.execution_policy_revisions(id, workspace_id, revision, requirements, created_by)
    values ((execution_candidate->>'id')::uuid, p_draft.workspace_id,
      (select coalesce(max(r.revision), 0) + 1 from public.execution_policy_revisions r where r.workspace_id = p_draft.workspace_id),
      execution_candidate->'requirements', p_actor_user_id);
  end if;
  if delivery_candidate is not null then
    insert into public.delivery_policy_revisions(id, workspace_id, pipeline_id, revision, requirements, created_by)
    values ((delivery_candidate->>'id')::uuid, p_draft.workspace_id, v_pipeline_id,
      (select coalesce(max(r.revision), 0) + 1 from public.delivery_policy_revisions r where r.pipeline_id = v_pipeline_id),
      delivery_candidate->'requirements', p_actor_user_id);
  end if;
  if metadata ? 'pipelineName' then
    update public.pipelines p set name = metadata->>'pipelineName' where p.id = v_pipeline_id;
  end if;
end;
$$;
revoke all on function internal.materialize_factory_settings_draft(public.factory_definition_drafts, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.publish_factory_definition_draft(
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
  perform internal.materialize_factory_settings_draft(draft, p_actor_user_id);
  perform internal.assert_factory_activation_authority(p_workspace_id, p_actor_user_id,
    draft.definition_json::jsonb, draft.canonical_digest, p_enabled_sandbox_providers, p_required_probes);
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

-- The Settings client publishes its current shared draft. The declarative
-- publisher also supports selecting an explicit candidate at the same base.
create function public.publish_settings_factory_definition_draft(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_draft_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[]
) returns public.factory_definition_activations
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.lock_factory_definition_head(
    p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  if p_draft_id is null or internal.latest_factory_draft_id(p_workspace_id, p_factory_id, p_expected_activation_number)
    is distinct from p_draft_id then
    raise exception 'The factory draft changed. Reload before publishing.' using errcode = 'PT409';
  end if;
  return public.publish_factory_definition_draft(p_workspace_id, p_factory_id, p_actor_user_id,
    p_expected_activation_number, p_draft_id, p_enabled_sandbox_providers, p_required_probes);
end;
$$;
revoke all on function public.publish_settings_factory_definition_draft(uuid, uuid, uuid, bigint, uuid, text[], text[])
  from public, anon, authenticated, service_role;
grant execute on function public.publish_settings_factory_definition_draft(uuid, uuid, uuid, bigint, uuid, text[], text[])
  to service_role;

-- Factory publications allocate immutable revisions while leaving the legacy
-- current pointers in place. A legacy save advances from its expected
-- pointer to the next unused history number under the same write locks.
create or replace function internal.guard_execution_policy()
returns trigger language plpgsql security invoker set search_path='' as $$
declare revision public.execution_policy_revisions;
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id) then return old; end if;
    raise exception 'Execution policy history is immutable.' using errcode='23514';
  end if;
  if tg_table_name='execution_policy_revisions' then
    if tg_op='UPDATE' then raise exception 'Execution policy history is immutable.' using errcode='23514'; end if;
    return new;
  end if;
  select * into revision from public.execution_policy_revisions where id=new.current_revision_id;
  if revision.workspace_id is distinct from new.workspace_id or revision.revision is distinct from new.revision
    or (tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.revision<=old.revision)) then
    raise exception 'Execution policy revision does not match the current policy.' using errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function public.save_execution_policy(p_workspace_id uuid,p_actor_user_id uuid,
  p_expected_revision bigint,p_requirements jsonb)
returns public.execution_policy_revisions language plpgsql security definer set search_path='' as $$
declare current_policy public.execution_policies; result public.execution_policy_revisions;
begin
  -- Start with the exclusive workspace fence used by factory publication.
  perform 1 from public.workspaces where id=p_workspace_id for no key update;
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=p_actor_user_id
    and m.kind='human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then raise exception 'Active workspace manager required.' using errcode='42501'; end if;
  select * into current_policy from public.execution_policies where workspace_id=p_workspace_id;
  if p_expected_revision is null or p_expected_revision<>coalesce(current_policy.revision,0) then
    raise exception 'Execution policy changed. Reload before saving.' using errcode='PT409'; end if;
  if not internal.valid_execution_requirements(p_requirements) then
    raise exception 'Invalid execution requirements.' using errcode='23514'; end if;
  insert into public.execution_policy_revisions(workspace_id,revision,requirements,created_by)
    values(p_workspace_id,
      (select coalesce(max(r.revision),0)+1 from public.execution_policy_revisions r where r.workspace_id=p_workspace_id),
      p_requirements,p_actor_user_id) returning * into result;
  insert into public.execution_policies(workspace_id,current_revision_id,revision)
    values(p_workspace_id,result.id,result.revision)
    on conflict(workspace_id) do update set current_revision_id=excluded.current_revision_id,revision=excluded.revision;
  return result;
end;
$$;

create function internal.guard_current_delivery_policy()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare revision public.delivery_policy_revisions;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.workspaces w where w.id = old.workspace_id)
      or not exists (select 1 from public.pipelines p where p.id = old.pipeline_id) then
      return old;
    end if;
    raise exception 'Delivery verification history is immutable.' using errcode = '23514';
  end if;
  select * into revision from public.delivery_policy_revisions r where r.id = new.current_revision_id;
  if (revision.workspace_id, revision.pipeline_id, revision.revision)
      is distinct from (new.workspace_id, new.pipeline_id, new.revision)
    or (tg_op = 'UPDATE' and ((new.workspace_id, new.pipeline_id) is distinct from (old.workspace_id, old.pipeline_id)
      or new.revision <= old.revision)) then
    raise exception 'Delivery policy revision does not match the current policy.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_current_delivery_policy() from public, anon, authenticated, service_role;
create or replace trigger guard_delivery_policies before insert or update or delete on public.delivery_policies
  for each row execute function internal.guard_current_delivery_policy();

create or replace function public.save_delivery_policy(p_workspace_id uuid,p_pipeline_id uuid,p_actor_user_id uuid,
  p_expected_revision bigint,p_requirements jsonb)
returns public.delivery_policy_revisions language plpgsql security definer set search_path='' as $$
declare current_policy public.delivery_policies; result public.delivery_policy_revisions;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.pipelines p where p.id=p_pipeline_id and p.workspace_id=p_workspace_id for update;
  if not found then raise exception 'Delivery policy pipeline is unavailable.' using errcode='42501'; end if;
  perform 1 from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=p_actor_user_id
    and m.kind='human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then raise exception 'Active workspace manager required.' using errcode='42501'; end if;
  select * into current_policy from public.delivery_policies where pipeline_id=p_pipeline_id;
  if p_expected_revision is null or p_expected_revision<>coalesce(current_policy.revision,0) then
    -- Semantic optimistic-concurrency conflict, not a retryable serialization failure.
    raise exception 'Delivery policy changed. Reload before saving.' using errcode='PT409'; end if;
  if not internal.valid_delivery_requirements(p_requirements) then
    raise exception 'Invalid delivery requirements.' using errcode='23514'; end if;
  insert into public.delivery_policy_revisions(workspace_id,pipeline_id,revision,requirements,created_by)
    values(p_workspace_id,p_pipeline_id,
      (select coalesce(max(r.revision),0)+1 from public.delivery_policy_revisions r where r.pipeline_id=p_pipeline_id),
      p_requirements,p_actor_user_id) returning * into result;
  insert into public.delivery_policies(pipeline_id,workspace_id,current_revision_id,revision)
    values(p_pipeline_id,p_workspace_id,result.id,result.revision)
    on conflict(pipeline_id) do update set current_revision_id=excluded.current_revision_id,revision=excluded.revision;
  return result;
end;
$$;
