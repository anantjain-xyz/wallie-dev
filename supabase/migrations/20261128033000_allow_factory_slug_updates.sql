create table internal.factory_slug_reservations (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug text not null,
  factory_id uuid not null,
  primary key (workspace_id, slug)
);
alter table internal.factory_slug_reservations enable row level security;
revoke all on table internal.factory_slug_reservations from public, anon, authenticated, service_role;

create function internal.reserve_factory_slug()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.factory_slug_reservations as reservation (workspace_id, slug, factory_id)
  values (new.workspace_id, new.slug, new.id)
  on conflict (workspace_id, slug) do update set factory_id = excluded.factory_id
  where reservation.factory_id = excluded.factory_id;
  if not found then
    raise exception 'Factory slug is reserved in this workspace.' using errcode = '23505';
  end if;
  return null;
end;
$$;
revoke all on function internal.reserve_factory_slug() from public, anon, authenticated, service_role;

create trigger factories_reserve_slug
  after insert or update of slug on public.factories
  for each row execute function internal.reserve_factory_slug();

insert into internal.factory_slug_reservations (workspace_id, slug, factory_id)
select workspace_id, slug, id from public.factories;

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
    'alter table public.factory_audit_events add constraint factory_audit_events_action_check check ((%s) or action = %L) not valid',
    action_predicate, 'factory.slug_changed'
  );
end;
$$;

create function public.set_factory_slug(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid,
  p_expected_slug text,
  p_slug text
) returns public.factories language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  target public.factories;
  normalized_slug text := btrim(coalesce(p_slug, ''));
begin
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select factory.* into strict target
  from public.factories factory
  where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id);
  if target.status <> 'active' then
    raise exception 'Factory is archived.' using errcode = 'P0011';
  end if;
  if target.slug is distinct from p_expected_slug then
    raise exception 'The factory slug changed.' using errcode = 'PT409';
  end if;
  if normalized_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or char_length(normalized_slug) > 60 then
    raise exception 'Factory slug must be a lowercase hyphenated value.' using errcode = '22023';
  end if;
  if target.slug = normalized_slug then
    return target;
  end if;

  update public.factories
  set slug = normalized_slug, updated_at = clock_timestamp()
  where (workspace_id, id) = (p_workspace_id, p_factory_id)
  returning * into strict target;

  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (
    p_workspace_id, p_factory_id, 'factory.slug_changed', actor_member_id,
    jsonb_build_object('previousSlug', p_expected_slug, 'slug', normalized_slug)
  );
  return target;
end;
$$;
revoke all on function public.set_factory_slug(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_factory_slug(uuid, uuid, uuid, text, text) to service_role;
