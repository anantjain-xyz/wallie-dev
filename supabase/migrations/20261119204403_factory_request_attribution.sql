-- The original creation command fixes request provenance for the session.
create table internal.factory_request_attribution (
  session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  source text not null check (source in ('browser', 'api', 'mcp')),
  creation_receipt_id uuid not null unique,
  command_admission_id uuid,
  observed_at timestamptz not null default clock_timestamp(),
  check ((command_admission_id is null) = (source = 'browser')),
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions (id, workspace_id, factory_id) on delete cascade
);
alter table internal.factory_request_attribution enable row level security;
revoke all on internal.factory_request_attribution from public, anon, authenticated, service_role;

comment on column internal.factory_request_attribution.command_admission_id is
  'Retained identity of the exact original command admission. The attribution survives admission pruning.';

create function internal.preserve_factory_request_attribution()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.sessions session
    where (session.id, session.workspace_id, session.factory_id) =
      (old.session_id, old.workspace_id, old.factory_id)
  ) then return old; end if;
  raise exception 'Factory request attribution is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_request_attribution()
  from public, anon, authenticated, service_role;
create trigger factory_request_attribution_immutable
  before update or delete on internal.factory_request_attribution
  for each row execute function internal.preserve_factory_request_attribution();

create function internal.factory_creation_receipt_source(p_receipt internal.session_mutation_receipts)
returns text language sql stable set search_path = '' as $$
  select case
    when p_receipt.operation = 'create' and p_receipt.actor_member_id is not null and exists (
      select 1 from internal.session_creation_requests browser
      where (browser.workspace_id, browser.creator_member_id, browser.request_id, browser.session_id) =
        (p_receipt.workspace_id, p_receipt.actor_member_id, p_receipt.request_id, p_receipt.session_id)
    ) then 'browser'
    when p_receipt.operation = 'create' and p_receipt.actor_service_principal_id is not null then (
      select admission.surface::text
      from internal.factory_command_admissions admission
      where (admission.id, admission.workspace_id, admission.factory_id, admission.service_principal_id,
        admission.execution_grant_id, admission.execution_grant_version, admission.scope) =
        (p_receipt.admission_id, p_receipt.workspace_id, p_receipt.factory_id, p_receipt.actor_service_principal_id,
          p_receipt.grant_id, p_receipt.grant_version, 'sessions:create')
        and admission.consenting_member_id is not distinct from p_receipt.consenting_member_id
    )
  end
$$;
revoke all on function internal.factory_creation_receipt_source(internal.session_mutation_receipts)
  from public, anon, authenticated, service_role;

create function internal.capture_factory_request_attribution()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  proved_source text := internal.factory_creation_receipt_source(new);
begin
  if proved_source is not null and new.id = (
    select original.id from internal.session_mutation_receipts original
    where (original.session_id, original.workspace_id, original.factory_id, original.operation) =
      (new.session_id, new.workspace_id, new.factory_id, 'create')
    order by original.created_at, original.id limit 1
  ) then
    insert into internal.factory_request_attribution (
      session_id, workspace_id, factory_id, source, creation_receipt_id, command_admission_id
    ) values (
      new.session_id, new.workspace_id, new.factory_id, proved_source, new.id, new.admission_id
    ) on conflict (session_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function internal.capture_factory_request_attribution()
  from public, anon, authenticated, service_role;
create trigger capture_factory_request_attribution
  after insert on internal.session_mutation_receipts
  for each row when (new.operation = 'create')
  execute function internal.capture_factory_request_attribution();

-- Recover origins whose exact original proof still exists at this boundary.
with originals as materialized (
  select distinct on (receipt.session_id) receipt
  from internal.session_mutation_receipts receipt
  where receipt.operation = 'create'
  order by receipt.session_id, receipt.created_at, receipt.id
), proved as materialized (
  select original.receipt, internal.factory_creation_receipt_source(original.receipt) as source
  from originals original
)
insert into internal.factory_request_attribution (
  session_id, workspace_id, factory_id, source, creation_receipt_id, command_admission_id
)
select (receipt).session_id, (receipt).workspace_id, (receipt).factory_id, source, (receipt).id, (receipt).admission_id
from proved
where source is not null
on conflict (session_id) do nothing;
