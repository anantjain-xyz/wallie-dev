-- A candidate check follows the saved definition and its repository's
-- factory. Keep workspace-manager authority and the existing exact evidence.
create or replace function public.start_factory_definition_capability_check(
  target_workspace_id uuid, target_github_repository_id uuid, target_actor_user_id uuid,
  target_sandbox_provider text, target_agent_provider text, target_agent_model text,
  target_definition_digest text
) returns public.sandbox_capability_checks
language plpgsql security definer set search_path = '' as $$
declare
  result public.sandbox_capability_checks;
  connection_revision uuid;
  repository_factory_id uuid;
  definition jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  perform 1 from public.workspace_members m where m.workspace_id = target_workspace_id
    and m.user_id = target_actor_user_id and m.kind = 'human' and m.is_active and m.role in ('owner', 'admin') for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  select r.factory_id into repository_factory_id
  from public.github_repositories r join public.github_installations i
    on (i.id, i.workspace_id) = (r.github_installation_id, r.workspace_id)
  where (r.id, r.workspace_id) = (target_github_repository_id, target_workspace_id)
    and not r.is_archived and not i.suspended;
  if not found then
    raise exception 'The definition repository is unavailable.' using errcode = 'PT422';
  end if;
  select saved.definition into definition from (
    select d.factory_id, d.definition_json::jsonb as definition from public.factory_definition_drafts d
    where (d.workspace_id, d.canonical_digest) = (target_workspace_id, target_definition_digest)
    union all
    select r.factory_id, r.definition_json::jsonb from public.factory_definition_revisions r
    where (r.workspace_id, r.canonical_digest) = (target_workspace_id, target_definition_digest)
  ) saved join public.factories f on (f.workspace_id, f.id) = (target_workspace_id, saved.factory_id)
  where f.id = repository_factory_id and f.status = 'active'
    and saved.definition->>'sandboxProvider' = target_sandbox_provider
    and saved.definition #>> '{agent,provider}' = target_agent_provider
    and saved.definition #>> '{agent,model}' = target_agent_model
    and internal.factory_allows_writable_repository(saved.definition, target_github_repository_id)
  limit 1 for share of f;
  if not found then
    raise exception 'The selected factory definition is unavailable for this check.' using errcode = 'P0002';
  end if;
  if definition ? 'executionGrant' then
    begin
      perform internal.resolve_definition_execution_grant(target_workspace_id, repository_factory_id, definition,
        target_github_repository_id, (definition->>'executionPolicyRevisionId')::uuid);
    exception when insufficient_privilege then
      raise exception 'The selected factory execution grant is unavailable.' using errcode = 'PT422';
    end;
  end if;
  if exists (
    select 1 from public.workspace_sandbox_connection_mutations m
      where m.workspace_id = target_workspace_id and m.provider = target_sandbox_provider
        and m.expires_at > clock_timestamp()
  ) then
    raise exception 'The sandbox connection is being updated.' using errcode = 'PT409';
  end if;
  connection_revision := internal.factory_connected_sandbox_revision(target_workspace_id, target_sandbox_provider);
  if connection_revision is null then
    raise exception 'The sandbox credential is unavailable.' using errcode = 'PT422';
  end if;
  insert into public.sandbox_capability_checks(
    workspace_id, github_repository_id, status, sandbox_provider, agent_provider, agent_model,
    sandbox_connection_revision, factory_definition_digest
  ) values (target_workspace_id, target_github_repository_id, 'running', target_sandbox_provider,
    target_agent_provider, target_agent_model, connection_revision, target_definition_digest)
  returning * into result;
  return result;
end;
$$;

-- Use the named factory's head and candidate history for eligibility.
create or replace function public.read_factory_candidate_activation_eligibility(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_target_kind text, p_target_id uuid, p_definition_digest text,
  p_enabled_sandbox_providers text[], p_required_probes text[]
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  head public.factory_definition_activations;
  draft public.factory_definition_drafts;
  revision public.factory_definition_revisions;
  definition jsonb;
  digest text;
  metadata jsonb := '{}'::jsonb;
  base bigint;
  test_id uuid;
  can_test boolean;
  reason text;
begin
  perform 1 from public.workspaces w where w.id = p_workspace_id
    and w.deletion_requested_at is null for share;
  if not found then
    raise exception 'Factory workspace is unavailable.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace_id
    and m.user_id = p_actor_user_id and m.kind = 'human' and m.is_active
    and m.role in ('owner','admin')) then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  perform 1 from public.factories f where (f.workspace_id, f.id) = (p_workspace_id, p_factory_id)
    and f.status = 'active' for share;
  if not found then
    raise exception 'Factory is unavailable.' using errcode = 'P0002';
  end if;
  select a.* into head from public.factory_definition_activations a
    where (a.workspace_id, a.factory_id) = (p_workspace_id, p_factory_id)
    order by a.activation_number desc limit 1;
  base := coalesce(head.activation_number, 0);

  if p_target_kind = 'draft' then
    select d.* into draft from public.factory_definition_drafts d
      where (d.workspace_id, d.factory_id, d.id) = (p_workspace_id, p_factory_id, p_target_id);
    if not found then
      raise exception 'Factory definition draft is unavailable.' using errcode = 'P0002';
    end if;
    definition := draft.definition_json::jsonb;
    digest := draft.canonical_digest;
    metadata := draft.settings_metadata;
    if coalesce(draft.base_activation_number, 0) <> base then
      reason := 'The draft was saved against a different activation. Save a new draft before publishing.';
    elsif internal.latest_factory_draft_id(p_workspace_id, p_factory_id, base)
      is distinct from draft.id then
      reason := 'A newer draft is available. Reload the definition before publishing.';
    end if;
  elsif p_target_kind = 'revision' then
    select r.* into revision from public.factory_definition_revisions r
      where (r.workspace_id, r.factory_id, r.id) = (p_workspace_id, p_factory_id, p_target_id)
      and exists (select 1 from public.factory_definition_activations a
        where (a.workspace_id, a.factory_id, a.revision_id) = (r.workspace_id, r.factory_id, r.id));
    if not found then
      raise exception 'A previously active factory revision is required.' using errcode = 'P0002';
    end if;
    definition := revision.definition_json::jsonb;
    digest := revision.canonical_digest;
    if head.revision_id = revision.id then
      reason := 'This factory definition is already active.';
    end if;
  else
    raise exception 'A draft or revision is required.' using errcode = '22023';
  end if;

  if digest is distinct from p_definition_digest then
    raise exception 'The factory candidate digest changed. Reload the definition.' using errcode = 'PT409';
  end if;
  can_test := reason is null;
  if can_test then
    begin
      perform internal.assert_factory_skill_bundle_available(p_workspace_id, p_factory_id, definition->'skillIds');
    exception when sqlstate 'PT422' then
      reason := sqlerrm;
      can_test := false;
    end;
  end if;
  if can_test then
    begin
      perform internal.assert_factory_authority(p_workspace_id, p_actor_user_id, definition, digest,
        p_enabled_sandbox_providers, p_required_probes, metadata);
      perform internal.assert_factory_activation_smoke_test(p_workspace_id, p_factory_id, base,
        p_target_kind, p_target_id, digest, definition->>'sandboxProvider');
      -- The guard locks the latest receipt under the factory fence. Return its
      -- ID so the UI can reconcile independently fetched history with this result.
      select t.id into test_id from public.factory_definition_smoke_tests t
        where (t.workspace_id, t.factory_id, t.target_kind, t.target_id, t.base_activation_number, t.policy_version) =
          (p_workspace_id, p_factory_id, p_target_kind, p_target_id, base, 1)
        order by t.created_at desc, t.id desc limit 1;
    exception when sqlstate 'PT409' or sqlstate 'PT422' then
      reason := sqlerrm;
    end;
  end if;
  return jsonb_build_object('eligible', reason is null, 'reason', reason,
    'activationNumber', base, 'testId', test_id, 'canTest', can_test);
end;
$$;

-- All shared definition writes recheck active status under the factory lock.
create or replace function internal.lock_factory_definition_head(
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
  perform 1 from public.factories f where (f.workspace_id, f.id) = (p_workspace_id, p_factory_id) and f.status = 'active' for update;
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
