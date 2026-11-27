do $$
declare
  action_predicate text;
begin
  select pg_get_expr(conbin, conrelid) into strict action_predicate
  from pg_constraint
  where conrelid = 'public.factory_audit_events'::regclass
    and conname = 'factory_audit_events_action_check';

  alter table public.factory_audit_events drop constraint factory_audit_events_action_check;
  execute format(
    'alter table public.factory_audit_events add constraint factory_audit_events_action_check check ((%s) or action = %L)',
    action_predicate, 'factory.renamed'
  );
end;
$$;

create function public.rename_factory(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid,
  p_expected_name text,
  p_name text
) returns public.factories language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  target public.factories;
  previous_name text;
  normalized_name text := btrim(coalesce(p_name, ''));
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select factory.* into strict target
  from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id);
  if target.status <> 'active' then
    raise exception 'Factory is archived.' using errcode = 'P0011';
  end if;
  if target.name is distinct from p_expected_name then
    raise exception 'The factory name changed.' using errcode = 'PT409';
  end if;
  if char_length(normalized_name) not between 1 and 120 then
    raise exception 'Factory name must be between 1 and 120 characters.' using errcode = '22023';
  end if;
  if target.name = normalized_name then
    return target;
  end if;

  previous_name := target.name;
  update public.factories
  set name = normalized_name, updated_at = clock_timestamp()
  where (workspace_id, id) = (p_workspace_id, p_factory_id)
  returning * into strict target;

  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (
    p_workspace_id, p_factory_id, 'factory.renamed', actor_member_id,
    jsonb_build_object('previousName', previous_name, 'name', normalized_name)
  );
  return target;
end;
$$;
revoke all on function public.rename_factory(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.rename_factory(uuid, uuid, uuid, text, text) to service_role;

create function public.archive_additional_factory(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid,
  p_reason text default null
) returns public.factories
language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if exists (
    select 1 from public.factories factory
    where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id)
      and factory.is_default
  ) then
    raise exception 'The workspace default factory cannot be archived.' using errcode = '23514';
  end if;
  return public.archive_factory(p_workspace_id, p_factory_id, p_actor_user_id, p_reason);
end;
$$;
revoke all on function public.archive_additional_factory(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.archive_additional_factory(uuid, uuid, uuid, text) to service_role;
