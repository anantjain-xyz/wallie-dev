-- Settings publication must reject stale drafts atomically if another draft
-- was saved against the same activation head after the client loaded state.

create function public.publish_settings_factory_definition_draft(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid,
  p_expected_activation_number bigint,
  p_draft_id uuid,
  p_enabled_sandbox_providers text[],
  p_required_probes text[]
) returns public.factory_definition_activations
language plpgsql security definer set search_path = '' as $$
declare
  latest_draft_id uuid;
begin
  perform internal.lock_factory_definition_head(
    p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number
  );

  select d.id into latest_draft_id
  from public.factory_definition_drafts d
  where d.workspace_id = p_workspace_id
    and d.factory_id = p_factory_id
    and d.base_activation_number is not distinct from nullif(p_expected_activation_number, 0)
  order by d.created_at desc, d.id desc
  limit 1;

  if latest_draft_id is null or latest_draft_id is distinct from p_draft_id then
    raise exception 'A newer configuration draft or activation exists. Reload before publishing.'
      using errcode = 'PT409';
  end if;

  return public.publish_factory_definition_draft(
    p_workspace_id,
    p_factory_id,
    p_actor_user_id,
    p_expected_activation_number,
    p_draft_id,
    p_enabled_sandbox_providers,
    p_required_probes
  );
end;
$$;

revoke all on function public.publish_settings_factory_definition_draft(
  uuid, uuid, uuid, bigint, uuid, text[], text[]
) from public, anon, authenticated, service_role;

grant execute on function public.publish_settings_factory_definition_draft(
  uuid, uuid, uuid, bigint, uuid, text[], text[]
) to service_role;
