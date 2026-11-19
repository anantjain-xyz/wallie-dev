create function internal.valid_factory_scorer_definition(p_definition jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  requirements jsonb;
  rubric_md text;
  scoring jsonb;
  minimum double precision;
  maximum double precision;
  passing double precision;
  failing double precision;
begin
  if jsonb_typeof(p_definition) is distinct from 'object' then return false; end if;
  requirements := p_definition->'requiredEvidence';
  rubric_md := p_definition->>'rubric';
  scoring := p_definition->'scoring';
  if p_definition - array['schemaVersion', 'rubric', 'requiredEvidence', 'scoring'] <> '{}'::jsonb
    or p_definition->'schemaVersion' is distinct from '1'::jsonb
    or jsonb_typeof(p_definition->'rubric') is distinct from 'string'
    or char_length(rubric_md) not between 1 and 20000
    or btrim(rubric_md, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = ''
    or jsonb_typeof(requirements) is distinct from 'array'
    or jsonb_typeof(scoring) is distinct from 'object' then
    return false;
  end if;
  if jsonb_array_length(requirements) not between 1 and 5
    or exists (
      select 1 from jsonb_array_elements(requirements) evidence(value)
      where jsonb_typeof(evidence.value) <> 'string'
        or evidence.value #>> '{}' not in ('code_diff', 'artifact', 'validation_report', 'browser_screenshot', 'browser_recording')
    )
    or jsonb_array_length(requirements) <> (select count(distinct value) from jsonb_array_elements(requirements) evidence(value)) then
    return false;
  end if;
  if scoring->>'kind' = 'boolean' then
    return scoring - array['kind', 'passValue'] = '{}'::jsonb
      and jsonb_typeof(scoring->'passValue') is not distinct from 'boolean';
  end if;
  if scoring->>'kind' is distinct from 'numeric'
    or scoring - array['kind', 'min', 'max', 'direction', 'passThreshold', 'failThreshold'] <> '{}'::jsonb
    or jsonb_typeof(scoring->'min') is distinct from 'number'
    or jsonb_typeof(scoring->'max') is distinct from 'number'
    or jsonb_typeof(scoring->'passThreshold') is distinct from 'number'
    or jsonb_typeof(scoring->'failThreshold') is distinct from 'number' then
    return false;
  end if;
  -- Compare thresholds with the same precision available to the TypeScript evaluator.
  minimum := (scoring->>'min')::double precision;
  maximum := (scoring->>'max')::double precision;
  passing := (scoring->>'passThreshold')::double precision;
  failing := (scoring->>'failThreshold')::double precision;
  return minimum >= -1000000000 and maximum <= 1000000000 and minimum < maximum
    and passing between minimum and maximum and failing between minimum and maximum
    and case scoring->>'direction'
      when 'higher_is_better' then failing < passing
      when 'lower_is_better' then passing < failing
      else false end;
exception when numeric_value_out_of_range then
  return false;
end;
$$;
revoke all on function internal.valid_factory_scorer_definition(jsonb)
  from public, anon, authenticated, service_role;

create table public.factory_scorers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  slug text not null check (char_length(slug) between 1 and 60 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, slug),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table public.factory_scorer_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  scorer_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  definition jsonb not null check (internal.valid_factory_scorer_definition(definition) is true),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, scorer_id, revision_number),
  foreign key (workspace_id, factory_id, scorer_id)
    references public.factory_scorers(workspace_id, factory_id, id) on delete cascade
);

alter table public.factory_scorers enable row level security;
alter table public.factory_scorer_revisions enable row level security;
revoke all on public.factory_scorers, public.factory_scorer_revisions from public, anon, authenticated, service_role;
grant select on public.factory_scorers, public.factory_scorer_revisions to authenticated, service_role;
create policy factory_scorers_member_read on public.factory_scorers
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_scorer_revisions_member_read on public.factory_scorer_revisions
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));

create function internal.preserve_factory_scorer_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factories factory where (factory.workspace_id, factory.id) = (old.workspace_id, old.factory_id)
  ) then
    return old;
  end if;
  raise exception 'Scorer identities and revisions are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_scorer_history() from public, anon, authenticated, service_role;
create trigger factory_scorers_immutable before update or delete on public.factory_scorers
  for each row execute function internal.preserve_factory_scorer_history();
create trigger factory_scorer_revisions_immutable before update or delete on public.factory_scorer_revisions
  for each row execute function internal.preserve_factory_scorer_history();

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
  'scorer.created', 'scorer.revision_created'
));

create function public.create_factory_scorer(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_name text, p_slug text, p_definition jsonb
) returns public.factory_scorer_revisions
language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; identity_id uuid; result public.factory_scorer_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120
    or p_slug is null or char_length(p_slug) not between 1 and 60 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or internal.valid_factory_scorer_definition(p_definition) is distinct from true then
    raise exception 'Invalid scorer identity or definition.' using errcode = '22023';
  end if;
  insert into public.factory_scorers(workspace_id, factory_id, name, slug, created_by)
  values (p_workspace_id, p_factory_id, btrim(p_name), p_slug, p_actor_user_id) returning id into identity_id;
  insert into public.factory_scorer_revisions(workspace_id, factory_id, scorer_id, revision_number, definition, created_by)
  values (p_workspace_id, p_factory_id, identity_id, 1, p_definition, p_actor_user_id) returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (p_workspace_id, p_factory_id, 'scorer.created', actor_member_id,
    jsonb_build_object('scorerId', identity_id, 'scorerRevisionId', result.id, 'revisionNumber', 1));
  return result;
end;
$$;

create function public.save_factory_scorer_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_scorer_id uuid,
  p_expected_revision integer, p_definition jsonb
) returns public.factory_scorer_revisions
language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; latest_revision integer; result public.factory_scorer_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  perform 1 from public.factory_scorers scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id) = (p_workspace_id, p_factory_id, p_scorer_id)
    for update;
  if not found then raise exception 'Scorer is unavailable in this factory.' using errcode = 'P0002'; end if;
  select max(revision_number) into latest_revision from public.factory_scorer_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.scorer_id) = (p_workspace_id, p_factory_id, p_scorer_id);
  if p_expected_revision is distinct from latest_revision then
    raise exception 'The scorer revision changed. Reload before saving.' using errcode = 'PT409';
  end if;
  if internal.valid_factory_scorer_definition(p_definition) is distinct from true then
    raise exception 'Invalid scorer definition.' using errcode = '22023';
  end if;
  insert into public.factory_scorer_revisions(workspace_id, factory_id, scorer_id, revision_number, definition, created_by)
  values (p_workspace_id, p_factory_id, p_scorer_id, latest_revision + 1, p_definition, p_actor_user_id) returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (p_workspace_id, p_factory_id, 'scorer.revision_created', actor_member_id,
    jsonb_build_object('scorerId', p_scorer_id, 'scorerRevisionId', result.id, 'revisionNumber', result.revision_number));
  return result;
end;
$$;
revoke all on function public.create_factory_scorer(uuid, uuid, uuid, text, text, jsonb),
  public.save_factory_scorer_revision(uuid, uuid, uuid, uuid, integer, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.create_factory_scorer(uuid, uuid, uuid, text, text, jsonb),
  public.save_factory_scorer_revision(uuid, uuid, uuid, uuid, integer, jsonb) to service_role;

create function internal.assert_factory_scorer_bindings(p_workspace_id uuid, p_factory_id uuid, p_definition jsonb)
returns void language plpgsql stable set search_path = '' as $$
declare bindings jsonb := p_definition->'scorerRevisionIds'; requested uuid[]; found_count integer;
begin
  -- Missing parents are handled by their existing scoped foreign keys.
  if p_definition is null then return; end if;
  if coalesce(p_definition->'schemaVersion', '1'::jsonb) = '1'::jsonb
    and not (p_definition ? 'scorerRevisionIds') then return; end if;
  if p_definition->'schemaVersion' is distinct from '2'::jsonb or jsonb_typeof(bindings) is distinct from 'array' then
    raise exception 'Scorer bindings require a version 2 serial definition.' using errcode = 'PT422';
  end if;
  if jsonb_array_length(bindings) > 32 or exists (
    select 1 from jsonb_array_elements(bindings) ref(value)
    where jsonb_typeof(ref.value) <> 'string' or ref.value #>> '{}' !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Invalid scorer revision bindings.' using errcode = 'PT422';
  end if;
  requested := array(
    select distinct value::uuid from jsonb_array_elements_text(bindings) ref(value) order by value::uuid
  );
  if to_jsonb(requested) is distinct from bindings then
    raise exception 'Scorer revision bindings must be unique and sorted.' using errcode = 'PT422';
  end if;
  select count(*) into found_count from public.factory_scorer_revisions revision
  where (revision.workspace_id, revision.factory_id) = (p_workspace_id, p_factory_id) and revision.id = any(requested);
  if found_count <> cardinality(requested) then
    raise exception 'A bound scorer revision is unavailable in this factory.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_scorer_bindings(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.guard_factory_definition_resource_scope()
returns trigger language plpgsql set search_path = '' as $$
declare
  definition jsonb;
  bound_repository_ids uuid[];
  available_repositories integer;
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
    if (new.schema_version <> 1 or definition ? 'schemaVersion')
      and to_jsonb(new.schema_version) is distinct from definition->'schemaVersion' then
      raise exception 'The stored and compiled schema versions must match.' using errcode = 'PT422';
    end if;
  end if;
  perform internal.assert_factory_scorer_bindings(new.workspace_id, new.factory_id, definition);
  perform internal.assert_factory_definition_resource_scope(new.workspace_id, new.factory_id, definition);

  if tg_table_name = 'factory_definition_activations' and (
    definition ? 'writableRepositoryIds' or definition ? 'readContextRepositoryIds'
  ) then
    select array_agg(binding.id::uuid) into bound_repository_ids
    from (
      select definition->>'repositoryId' as id
      union all
      select writable.id from jsonb_array_elements_text(definition->'writableRepositoryIds') as writable(id)
      union all
      select context.id from jsonb_array_elements_text(definition->'readContextRepositoryIds') as context(id)
    ) binding;
    -- GitHub disconnect can hold these rows while waiting on session locks.
    begin
      perform installation.id from public.github_installations installation
      where installation.workspace_id = new.workspace_id and not installation.suspended
      for share nowait;
      perform repository.id from public.github_repositories repository
      join public.github_installations installation
        on (installation.id, installation.workspace_id) = (repository.github_installation_id, repository.workspace_id)
      where repository.id = any(bound_repository_ids)
        and (repository.workspace_id, repository.factory_id) = (new.workspace_id, new.factory_id)
        and not repository.is_archived and not installation.suspended
      order by repository.id for share of repository nowait;
      get diagnostics available_repositories = row_count;
      if available_repositories <> cardinality(bound_repository_ids) then
        raise exception 'A bound repository is unavailable.' using errcode = 'PT422';
      end if;
    exception when lock_not_available then
      raise exception 'Repository access is changing. Reload the factory before retrying.' using errcode = 'PT409';
    end;
  end if;
  return new;
end;
$$;

create or replace function public.save_factory_definition_draft(
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
  if coalesce(definition->'schemaVersion' not in ('1'::jsonb, '2'::jsonb), true)
    or definition->>'kind' is distinct from 'serial' then
    raise exception 'A supported serial definition version is required.' using errcode = '22023';
  end if;
  insert into public.factory_definition_drafts(
    workspace_id, factory_id, base_activation_number, schema_version, definition_json, canonical_digest, created_by
  ) values (p_workspace_id, p_factory_id, nullif(p_expected_activation_number, 0), (definition->'schemaVersion')::integer,
    p_definition_json, p_canonical_digest, p_actor_user_id) returning * into result;
  return result;
end;
$$;

create or replace function public.save_settings_factory_definition_draft(
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
  if coalesce(definition->'schemaVersion' not in ('1'::jsonb, '2'::jsonb), true) or definition->>'kind' is distinct from 'serial'
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
  ) values (p_workspace_id, p_factory_id, nullif(p_expected_activation_number, 0), (definition->'schemaVersion')::integer,
    p_definition_json, p_canonical_digest, p_actor_user_id, p_settings_metadata) returning * into result;
  return result;
end;
$$;

create or replace function internal.pinned_session_execution_definition(p_session public.sessions)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare definition jsonb;
begin
  if not p_session.execute_pinned_definition then return null; end if;
  select r.definition_json::jsonb into definition
  from public.factory_definition_revisions r
  where (r.workspace_id, r.id) = (p_session.workspace_id, p_session.factory_definition_revision_id);
  if not found
     or coalesce(definition->'schemaVersion' not in ('1'::jsonb, '2'::jsonb), true)
     or definition->>'kind' is distinct from 'serial'
     or definition->>'pipelineId' is distinct from p_session.pipeline_id::text then
    raise exception 'Pinned factory definition is unavailable.' using errcode = '55000';
  end if;
  return definition;
end;
$$;
