-- The default factory anchors new definition history without reassigning existing
-- pipelines, stages, or sessions.
create table public.factories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  is_default boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id)
);
create unique index factories_one_default_idx on public.factories(workspace_id) where is_default;

create function internal.provision_default_factory()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.factories(workspace_id) values (new.id);
  return new;
end;
$$;
revoke all on function internal.provision_default_factory() from public, anon, authenticated, service_role;

-- Install the trigger before the backfill so a concurrent workspace creation
-- cannot miss both provisioning paths.
create trigger workspaces_provision_default_factory after insert on public.workspaces
  for each row execute function internal.provision_default_factory();
insert into public.factories(workspace_id) select id from public.workspaces;

-- Keep the exact UTF-8 JSON bytes the definition compiler will provide. The
-- schema version and digest together identify the content across revisions.
create table public.factory_definition_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  base_activation_number bigint,
  schema_version integer not null check (schema_version > 0),
  definition_json text not null check (definition_json is json object with unique keys),
  canonical_digest text not null check (canonical_digest = encode(sha256(convert_to(definition_json, 'UTF8')), 'hex')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table public.factory_definition_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  source_draft_id uuid,
  schema_version integer not null check (schema_version > 0),
  definition_json text not null check (definition_json is json object with unique keys),
  canonical_digest text not null check (canonical_digest = encode(sha256(convert_to(definition_json, 'UTF8')), 'hex')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, id),
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, source_draft_id)
    references public.factory_definition_drafts(workspace_id, factory_id, id)
);
create index factory_definition_revisions_source_draft_idx
  on public.factory_definition_revisions(workspace_id, factory_id, source_draft_id)
  where source_draft_id is not null;

-- Appending N+1 requires the exact activation N to exist and N+1 to be free.
-- A rollback appends a new activation even when it points to an older revision.
create table public.factory_definition_activations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  revision_id uuid not null,
  activation_number bigint not null check (activation_number > 0),
  previous_activation_number bigint generated always as (nullif(activation_number - 1, 0)) stored,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, activation_number),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, revision_id)
    references public.factory_definition_revisions(workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id, previous_activation_number)
    references public.factory_definition_activations(workspace_id, factory_id, activation_number)
);
create index factory_definition_activations_revision_idx
  on public.factory_definition_activations(workspace_id, factory_id, revision_id);
create index factory_definition_activations_previous_idx
  on public.factory_definition_activations(workspace_id, factory_id, previous_activation_number)
  where previous_activation_number is not null;

alter table public.factory_definition_drafts add constraint factory_definition_drafts_base_fk
  foreign key (workspace_id, factory_id, base_activation_number)
  references public.factory_definition_activations(workspace_id, factory_id, activation_number);
create index factory_definition_drafts_base_idx
  on public.factory_definition_drafts(workspace_id, factory_id, base_activation_number)
  where base_activation_number is not null;

create function internal.preserve_factory_definition_history()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.workspaces where id = old.workspace_id) then
    return old;
  end if;
  raise exception 'Factory definition records are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_definition_history() from public, anon, authenticated, service_role;
create trigger preserve_factory_definition_drafts before update or delete on public.factory_definition_drafts
  for each row execute function internal.preserve_factory_definition_history();
create trigger preserve_factory_definition_revisions before update or delete on public.factory_definition_revisions
  for each row execute function internal.preserve_factory_definition_history();
create trigger preserve_factory_definition_activations before update or delete on public.factory_definition_activations
  for each row execute function internal.preserve_factory_definition_history();

-- Author UUIDs are attribution captured at write time. Future publication
-- commands validate current authority without rewriting records on revocation.
alter table public.factories enable row level security;
alter table public.factory_definition_drafts enable row level security;
alter table public.factory_definition_revisions enable row level security;
alter table public.factory_definition_activations enable row level security;
revoke all on public.factories, public.factory_definition_drafts, public.factory_definition_revisions,
  public.factory_definition_activations from public, anon, authenticated, service_role;
grant select on public.factories, public.factory_definition_drafts, public.factory_definition_revisions,
  public.factory_definition_activations to authenticated, service_role;

create policy factories_select_membership on public.factories for select to authenticated using (
  workspace_id in (select internal.current_user_workspace_ids())
  and exists (select 1 from public.workspaces w where w.id = factories.workspace_id and w.deletion_requested_at is null)
);
create policy factory_definition_drafts_select_manager on public.factory_definition_drafts for select to authenticated using (
  internal.can_manage_workspace(workspace_id)
  and exists (select 1 from public.workspaces w
    where w.id = factory_definition_drafts.workspace_id and w.deletion_requested_at is null)
);
create policy factory_definition_revisions_select_membership on public.factory_definition_revisions for select to authenticated using (
  workspace_id in (select internal.current_user_workspace_ids())
  and exists (select 1 from public.workspaces w
    where w.id = factory_definition_revisions.workspace_id and w.deletion_requested_at is null)
);
create policy factory_definition_activations_select_membership on public.factory_definition_activations for select to authenticated using (
  workspace_id in (select internal.current_user_workspace_ids())
  and exists (select 1 from public.workspaces w
    where w.id = factory_definition_activations.workspace_id and w.deletion_requested_at is null)
);

-- A constant default labels old and interim sessions without updating their
-- rows or claiming a historical snapshot. Admission will supply pins in OP-543.
alter table public.sessions
  add column factory_definition_provenance text not null default 'legacy',
  add column factory_definition_revision_id uuid,
  add constraint sessions_factory_definition_provenance_check check (
    (factory_definition_provenance = 'legacy' and factory_definition_revision_id is null)
    or (factory_definition_provenance = 'pinned' and factory_definition_revision_id is not null)
  ),
  add constraint sessions_factory_definition_revision_fk foreign key (workspace_id, factory_definition_revision_id)
    references public.factory_definition_revisions(workspace_id, id);
create index sessions_factory_definition_revision_idx on public.sessions(workspace_id, factory_definition_revision_id)
  where factory_definition_revision_id is not null;

create function internal.preserve_session_factory_definition_pin()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.factory_definition_provenance is distinct from old.factory_definition_provenance
    or new.factory_definition_revision_id is distinct from old.factory_definition_revision_id then
    raise exception 'Session factory definition provenance is immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.preserve_session_factory_definition_pin() from public, anon, authenticated, service_role;
create trigger preserve_session_factory_definition_pin
  before update of factory_definition_provenance, factory_definition_revision_id on public.sessions
  for each row execute function internal.preserve_session_factory_definition_pin();
