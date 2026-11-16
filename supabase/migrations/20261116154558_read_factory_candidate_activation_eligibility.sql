-- This read-side check holds the same workspace/factory fence as activation.
-- It validates private draft reservations without materializing them.
create function public.read_factory_candidate_activation_eligibility(
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
    and f.is_default for share;
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
revoke all on function public.read_factory_candidate_activation_eligibility(uuid,uuid,uuid,text,uuid,text,text[],text[])
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_candidate_activation_eligibility(uuid,uuid,uuid,text,uuid,text,text[],text[])
  to service_role;
