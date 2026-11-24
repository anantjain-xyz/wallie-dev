create type public.connector_outbound_operation as enum ('reply', 'edit');
create type public.connector_outbound_status as enum ('queued', 'sending', 'unknown', 'observing', 'blocked', 'delivered', 'failed');
create type public.connector_outbound_result as enum (
  'sent', 'not_sent', 'uncertain', 'rate_limited', 'credential_unavailable', 'rejected', 'found', 'absent', 'inconclusive'
);

create table internal.connector_outbound_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  resource_id uuid not null,
  installation_id uuid not null references internal.connector_installations(id) on delete cascade,
  session_id uuid not null,
  source_id uuid not null,
  provider public.connector_provider not null,
  logical_key text not null check (length(logical_key) between 1 and 160 and logical_key !~ '[[:cntrl:]]'),
  operation public.connector_outbound_operation not null,
  edited_delivery_id uuid references internal.connector_outbound_deliveries(id) on delete cascade,
  edit_target text,
  actor_link_id uuid,
  actor_kind public.connector_actor_kind,
  initiating_member_id uuid,
  initiating_service_principal_id uuid,
  content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 16384),
  status public.connector_outbound_status not null default 'queued',
  created_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null,
  next_action_at timestamptz,
  send_attempts integer not null default 0 check (send_attempts between 0 and 6),
  observation_attempts integer not null default 0 check (observation_attempts between 0 and 8),
  uncertain boolean not null default false,
  lease_id uuid,
  lease_expires_at timestamptz,
  blocked_generation bigint,
  provider_reply_id text check (length(provider_reply_id) between 1 and 256 and provider_reply_id !~ '[[:space:][:cntrl:]]'),
  last_result public.connector_outbound_result,
  unique (workspace_id, factory_id, resource_id, source_id, logical_key),
  foreign key (workspace_id, factory_id, resource_id)
    references public.factory_connector_resources(workspace_id, factory_id, id) on delete cascade,
  foreign key (session_id, source_id)
    references public.session_conversation_sources(session_id, id) on delete cascade,
  check ((operation = 'edit') = (edited_delivery_id is not null and edit_target is not null)),
  check ((status in ('sending', 'observing')) = (lease_id is not null and lease_expires_at is not null)),
  check ((lease_id is null) = (lease_expires_at is null)),
  check ((status = 'delivered') = (provider_reply_id is not null)),
  check (status not in ('unknown', 'observing') or uncertain),
  check (blocked_generation is null or status = 'blocked')
);

create index connector_outbound_ready_idx on internal.connector_outbound_deliveries(provider, next_action_at, id)
  where next_action_at is not null;
create index connector_outbound_source_idx on internal.connector_outbound_deliveries(session_id, source_id);
create index connector_outbound_installation_idx on internal.connector_outbound_deliveries(installation_id, lease_expires_at);
create unique index connector_outbound_edit_successor_idx on internal.connector_outbound_deliveries(edited_delivery_id)
  where edited_delivery_id is not null and status <> 'failed';
create index connector_outbound_edit_history_idx on internal.connector_outbound_deliveries(edited_delivery_id)
  where edited_delivery_id is not null;

create table internal.connector_outbound_attempts (
  lease_id uuid primary key,
  delivery_id uuid not null references internal.connector_outbound_deliveries(id) on delete cascade,
  operation public.connector_outbound_status not null check (operation in ('sending', 'observing')),
  installation_generation bigint not null,
  mapping_revision bigint not null,
  started_at timestamptz not null,
  authorized_at timestamptz,
  settled_at timestamptz,
  result public.connector_outbound_result,
  check ((settled_at is null) = (result is null))
);
create index connector_outbound_attempt_delivery_idx on internal.connector_outbound_attempts(delivery_id);

create table internal.connector_outbound_cooldowns (
  installation_id uuid primary key references internal.connector_installations(id) on delete cascade,
  retry_at timestamptz not null
);

alter table internal.connector_outbound_deliveries enable row level security;
alter table internal.connector_outbound_attempts enable row level security;
alter table internal.connector_outbound_cooldowns enable row level security;
revoke all on internal.connector_outbound_deliveries, internal.connector_outbound_attempts, internal.connector_outbound_cooldowns
  from public, anon, authenticated, service_role;

create function public.enqueue_connector_outbound_delivery(
  p_workspace_id uuid, p_factory_id uuid, p_resource_id uuid, p_session_id uuid, p_source_id uuid,
  p_logical_key text, p_operation public.connector_outbound_operation, p_content jsonb,
  p_actor_link_id uuid default null, p_edited_delivery_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  resource public.factory_connector_resources;
  actor internal.connector_actor_links;
  existing internal.connector_outbound_deliveries;
  target_reply text;
  delivery_id uuid;
  now_at timestamptz := clock_timestamp();
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select target.* into resource from public.factory_connector_resources target
  join public.session_conversation_sources source
    on (source.workspace_id, source.factory_id, source.provider, source.source_namespace) =
      (target.workspace_id, target.factory_id, target.provider::text, target.id::text)
  where (target.workspace_id, target.factory_id, target.id, source.session_id, source.id) =
    (p_workspace_id, p_factory_id, p_resource_id, p_session_id, p_source_id);
  if not found then
    raise exception 'Connector delivery source is unavailable.' using errcode = '42501';
  end if;
  if p_operation is null or (p_operation = 'edit') is distinct from (p_edited_delivery_id is not null) then
    raise exception 'Connector delivery operation is invalid.' using errcode = '22023';
  end if;

  select delivery.* into existing from internal.connector_outbound_deliveries delivery
  where (delivery.workspace_id, delivery.factory_id, delivery.resource_id, delivery.source_id, delivery.logical_key) =
    (p_workspace_id, p_factory_id, p_resource_id, p_source_id, p_logical_key);
  if existing.id is null then
    if p_actor_link_id is not null then
      select link.* into actor from internal.connector_actor_links link
      where (link.id, link.workspace_id, link.installation_id) =
        (p_actor_link_id, p_workspace_id, resource.installation_id)
        and (link.factory_id is null or link.factory_id = p_factory_id);
      if not found then
        raise exception 'Connector delivery actor is unavailable.' using errcode = '42501';
      end if;
    end if;
    if p_edited_delivery_id is not null then
      select prior.provider_reply_id into target_reply from internal.connector_outbound_deliveries prior
      where (prior.id, prior.workspace_id, prior.factory_id, prior.resource_id, prior.source_id) =
        (p_edited_delivery_id, p_workspace_id, p_factory_id, p_resource_id, p_source_id)
        and prior.status = 'delivered';
      if not found then
        raise exception 'Connector reply has no confirmed edit target.' using errcode = 'PT409';
      end if;
    end if;
    insert into internal.connector_outbound_deliveries (
      workspace_id, factory_id, resource_id, installation_id, session_id, source_id, provider, logical_key, operation,
      edited_delivery_id, edit_target, actor_link_id, actor_kind, initiating_member_id,
      initiating_service_principal_id, content, deadline_at, next_action_at
    ) values (p_workspace_id, p_factory_id, p_resource_id, resource.installation_id, p_session_id, p_source_id, resource.provider, p_logical_key,
      p_operation, p_edited_delivery_id, target_reply, actor.id, actor.actor_kind, actor.member_id,
      actor.service_principal_id, p_content, now_at + interval '24 hours', now_at)
    on conflict (workspace_id, factory_id, resource_id, source_id, logical_key) do nothing
    returning id into delivery_id;
    if found then return delivery_id; end if;
    select delivery.* into strict existing from internal.connector_outbound_deliveries delivery
    where (delivery.workspace_id, delivery.factory_id, delivery.resource_id, delivery.source_id, delivery.logical_key) =
      (p_workspace_id, p_factory_id, p_resource_id, p_source_id, p_logical_key);
  end if;
  if (existing.operation, existing.edited_delivery_id, existing.actor_link_id, existing.content) is distinct from
    (p_operation, p_edited_delivery_id, p_actor_link_id, p_content) then
    raise exception 'Connector delivery identity already has different input.' using errcode = 'PT409';
  end if;
  return existing.id;
exception when unique_violation then
  raise exception 'Connector reply already has a newer edit.' using errcode = 'PT409';
when check_violation or not_null_violation then
  raise exception 'Connector delivery input is invalid.' using errcode = '22023';
end;
$$;

create function internal.lock_connector_outbound_authority(p_delivery internal.connector_outbound_deliveries)
returns table (
  installation_generation bigint, mapping_revision bigint, credential_ref uuid, credential_material_revision bigint,
  external_resource_id text
) language plpgsql set search_path = '' set lock_timeout = '100ms' as $$
declare
  resource public.factory_connector_resources;
  installation internal.connector_installations;
begin
  perform 1 from public.workspaces workspace
  join public.factories factory on factory.workspace_id = workspace.id
  where (workspace.id, factory.id) = (p_delivery.workspace_id, p_delivery.factory_id)
    and workspace.deletion_requested_at is null and factory.status = 'active'
  for share of workspace, factory nowait;
  if not found then return; end if;
  select mapped.* into strict resource from public.factory_connector_resources mapped
  where (mapped.workspace_id, mapped.factory_id, mapped.id) =
    (p_delivery.workspace_id, p_delivery.factory_id, p_delivery.resource_id);
  select target.* into strict installation from internal.connector_installations target
  where (target.workspace_id, target.id) = (resource.workspace_id, p_delivery.installation_id)
  for update nowait;
  perform internal.lock_connector_authority(installation, resource.factory_id, resource.external_resource_id);
  return query select subscription.installation_generation, subscription.mapping_revision, subscription.credential_ref,
    subscription.credential_material_revision, resource.external_resource_id
  from public.read_connector_subscription(resource.workspace_id, resource.factory_id, resource.id) subscription;
end;
$$;
revoke all on function internal.lock_connector_outbound_authority(internal.connector_outbound_deliveries)
  from public, anon, authenticated, service_role;

create function public.claim_connector_outbound_delivery(p_provider public.connector_provider)
returns table (
  delivery_id uuid, lease_id uuid, lease_expires_at timestamptz, kind public.connector_outbound_status,
  provider public.connector_provider, operation public.connector_outbound_operation,
  external_resource_id text, external_thread_id text, edit_target text, content jsonb,
  installation_id uuid, installation_generation bigint, mapping_revision bigint, credential_ref uuid,
  credential_material_revision bigint
) language plpgsql security definer set search_path = '' as $$
declare
  candidate internal.connector_outbound_deliveries;
  expired_result public.connector_outbound_result;
  authority record;
  now_at timestamptz;
  cooldown timestamptz;
begin
  for candidate in
    select pending.* from internal.connector_outbound_deliveries pending
    where pending.provider = p_provider and pending.next_action_at <= clock_timestamp()
    order by pending.next_action_at, pending.id limit 24 for update skip locked
  loop
    now_at := clock_timestamp();
    if candidate.status in ('sending', 'observing') then
      select case when candidate.status = 'observing' then 'inconclusive'
        when attempt.authorized_at is null then 'not_sent' else 'uncertain' end
      into strict expired_result from internal.connector_outbound_attempts attempt where attempt.lease_id = candidate.lease_id;
      update internal.connector_outbound_attempts attempt set settled_at = now_at,
        result = expired_result
      where attempt.lease_id = candidate.lease_id;
      update internal.connector_outbound_deliveries pending set
        status = case when expired_result <> 'not_sent' then 'unknown'
          when candidate.deadline_at > now_at then 'queued' else 'failed' end::public.connector_outbound_status,
        uncertain = expired_result <> 'not_sent', lease_id = null, lease_expires_at = null,
        next_action_at = case when candidate.deadline_at > now_at then now_at end, last_result = expired_result
      where pending.id = candidate.id;
      continue;
    end if;
    if candidate.deadline_at <= now_at + interval '10 seconds'
      or (case when candidate.uncertain then candidate.observation_attempts >= 8 else candidate.send_attempts >= 6 end) then
      update internal.connector_outbound_deliveries pending
      set status = case when candidate.status = 'blocked' then 'blocked' when candidate.uncertain then 'unknown'
          else 'failed' end::public.connector_outbound_status,
        next_action_at = null
      where pending.id = candidate.id;
      continue;
    end if;

    begin
      select * into authority from internal.lock_connector_outbound_authority(candidate);
    exception when lock_not_available then
      update internal.connector_outbound_deliveries pending
      set next_action_at = least(candidate.deadline_at, now_at + interval '1 second') where pending.id = candidate.id;
      continue;
    end;
    if not found or candidate.blocked_generation = authority.installation_generation then
      update internal.connector_outbound_deliveries pending set status = 'blocked',
        next_action_at = least(candidate.deadline_at, now_at + interval '30 seconds'), last_result = 'credential_unavailable'
      where pending.id = candidate.id;
      continue;
    end if;
    if exists (select 1 from internal.connector_outbound_deliveries active
      where active.installation_id = candidate.installation_id and active.lease_expires_at > now_at) then
      update internal.connector_outbound_deliveries pending set next_action_at = least(candidate.deadline_at, now_at + interval '1 second')
      where pending.id = candidate.id;
      continue;
    end if;
    select limit_record.retry_at into cooldown from internal.connector_outbound_cooldowns limit_record
    where limit_record.installation_id = candidate.installation_id;
    if cooldown > now_at then
      update internal.connector_outbound_deliveries pending set next_action_at = least(candidate.deadline_at, cooldown)
      where pending.id = candidate.id;
      continue;
    end if;

    select source.external_thread_id into strict external_thread_id from public.session_conversation_sources source
    where (source.session_id, source.id) = (candidate.session_id, candidate.source_id);
    now_at := clock_timestamp();
    delivery_id := candidate.id;
    lease_id := gen_random_uuid();
    lease_expires_at := least(now_at + interval '45 seconds', candidate.deadline_at);
    kind := case when candidate.uncertain then 'observing' else 'sending' end;
    provider := candidate.provider;
    operation := candidate.operation;
    external_resource_id := authority.external_resource_id;
    edit_target := candidate.edit_target;
    content := candidate.content;
    installation_id := candidate.installation_id;
    installation_generation := authority.installation_generation;
    mapping_revision := authority.mapping_revision;
    credential_ref := authority.credential_ref;
    credential_material_revision := authority.credential_material_revision;
    update internal.connector_outbound_deliveries pending set status = kind,
      lease_id = claim_connector_outbound_delivery.lease_id, lease_expires_at = claim_connector_outbound_delivery.lease_expires_at,
      next_action_at = claim_connector_outbound_delivery.lease_expires_at, blocked_generation = null,
      send_attempts = pending.send_attempts + (kind = 'sending')::integer,
      observation_attempts = pending.observation_attempts + (kind = 'observing')::integer
    where pending.id = candidate.id;
    insert into internal.connector_outbound_attempts (lease_id, delivery_id, operation, installation_generation, mapping_revision, started_at)
    values (lease_id, delivery_id, kind, installation_generation, mapping_revision, now_at);
    return next;
    return;
  end loop;
end;
$$;

create function public.confirm_connector_outbound_authority(p_delivery_id uuid, p_lease_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target internal.connector_outbound_deliveries;
  attempt internal.connector_outbound_attempts;
  authority record;
  now_at timestamptz;
  cooldown timestamptz;
begin
  select delivery.* into target from internal.connector_outbound_deliveries delivery
  where (delivery.id, delivery.lease_id) = (p_delivery_id, p_lease_id)
    and delivery.lease_expires_at > clock_timestamp() for update skip locked;
  if not found then return false; end if;
  select recorded.* into strict attempt from internal.connector_outbound_attempts recorded
  where recorded.lease_id = p_lease_id and recorded.settled_at is null;
  if attempt.authorized_at is not null then return false; end if;
  select * into authority from internal.lock_connector_outbound_authority(target);
  if found and (authority.installation_generation, authority.mapping_revision) =
    (attempt.installation_generation, attempt.mapping_revision) then
    now_at := clock_timestamp();
    if target.lease_expires_at <= now_at then return false; end if;
    select limit_record.retry_at into cooldown from internal.connector_outbound_cooldowns limit_record
    where limit_record.installation_id = target.installation_id and limit_record.retry_at > now_at;
    if found then
      update internal.connector_outbound_attempts recorded set settled_at = now_at, result = 'rate_limited'
      where recorded.lease_id = p_lease_id;
      update internal.connector_outbound_deliveries delivery
      set status = case when target.uncertain then 'unknown' else 'queued' end::public.connector_outbound_status,
        last_result = 'rate_limited', lease_id = null, lease_expires_at = null,
        next_action_at = least(target.deadline_at, cooldown)
      where delivery.id = target.id;
      return false;
    end if;
    update internal.connector_outbound_attempts recorded set authorized_at = now_at
    where recorded.lease_id = p_lease_id;
    return true;
  end if;
  now_at := clock_timestamp();
  update internal.connector_outbound_attempts recorded set settled_at = now_at, result = 'credential_unavailable'
  where recorded.lease_id = p_lease_id;
  update internal.connector_outbound_deliveries delivery set status = 'blocked', last_result = 'credential_unavailable',
    lease_id = null, lease_expires_at = null, next_action_at = least(target.deadline_at, now_at + interval '30 seconds')
  where delivery.id = target.id;
  return false;
exception when lock_not_available then
  return false;
end;
$$;

create function public.settle_connector_outbound_delivery(
  p_delivery_id uuid, p_lease_id uuid, p_result public.connector_outbound_result,
  p_provider_reply_id text default null, p_retry_after_seconds integer default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target internal.connector_outbound_deliveries;
  attempt internal.connector_outbound_attempts;
  target_status public.connector_outbound_status;
  now_at timestamptz;
  retry_at timestamptz;
begin
  select delivery.* into target from internal.connector_outbound_deliveries delivery
  where (delivery.id, delivery.lease_id) = (p_delivery_id, p_lease_id)
    and delivery.lease_expires_at > clock_timestamp() for update;
  now_at := clock_timestamp();
  if not found or target.lease_expires_at <= now_at then return false; end if;
  select recorded.* into attempt from internal.connector_outbound_attempts recorded
  where recorded.lease_id = p_lease_id and recorded.authorized_at is not null and recorded.settled_at is null;
  if not found then return false; end if;
  if (p_result in ('sent', 'found')) is distinct from (p_provider_reply_id is not null)
    or (p_result <> 'rate_limited' and p_retry_after_seconds is not null)
    or (p_provider_reply_id is not null
      and (length(p_provider_reply_id) not between 1 and 256 or p_provider_reply_id ~ '[[:space:][:cntrl:]]'))
    or (p_provider_reply_id is not null and target.edit_target is not null and p_provider_reply_id <> target.edit_target)
    or (case target.status
      when 'sending' then p_result in ('sent', 'not_sent', 'uncertain', 'rate_limited', 'credential_unavailable', 'rejected')
      when 'observing' then p_result in ('found', 'absent', 'inconclusive', 'rate_limited', 'credential_unavailable')
      else false end) is not true then
    raise exception 'Connector delivery settlement does not match its attempt.' using errcode = '22023';
  end if;

  target_status := case p_result
    when 'sent' then 'delivered' when 'found' then 'delivered' when 'rejected' then 'failed'
    when 'credential_unavailable' then 'blocked'
    when 'uncertain' then 'unknown' when 'inconclusive' then 'unknown'
    when 'absent' then 'queued'
    else case when target.uncertain then 'unknown' else 'queued' end
  end;
  if p_result = 'rate_limited' then
    retry_at := now_at + make_interval(secs => greatest(1, least(coalesce(p_retry_after_seconds, 30), 3600)));
    insert into internal.connector_outbound_cooldowns as cooldown (installation_id, retry_at)
    values (target.installation_id, retry_at) on conflict (installation_id) do update
      set retry_at = greatest(cooldown.retry_at, excluded.retry_at);
  elsif target_status in ('queued', 'unknown', 'blocked') then
    retry_at := now_at + make_interval(secs => 15 * (2 ^ least(
      case when target.status = 'observing' then target.observation_attempts else target.send_attempts end, 6))::integer);
  end if;
  update internal.connector_outbound_attempts recorded set settled_at = now_at, result = p_result
  where recorded.lease_id = p_lease_id;
  update internal.connector_outbound_deliveries delivery
  set status = target_status, last_result = p_result, provider_reply_id = p_provider_reply_id,
    uncertain = target_status = 'unknown' or (target_status = 'blocked' and target.uncertain),
    lease_id = null, lease_expires_at = null,
    next_action_at = case when retry_at is not null then least(target.deadline_at, retry_at) end,
    blocked_generation = case when target_status = 'blocked' then attempt.installation_generation end
  where delivery.id = target.id;
  return true;
end;
$$;

create function public.read_connector_outbound_delivery(p_workspace_id uuid, p_factory_id uuid, p_delivery_id uuid)
returns table (
  id uuid, operation public.connector_outbound_operation, status public.connector_outbound_status,
  edited_delivery_id uuid, provider_reply_id text, actor_link_id uuid, actor_kind public.connector_actor_kind,
  initiating_member_id uuid, initiating_service_principal_id uuid, send_attempts integer, observation_attempts integer,
  uncertain boolean, last_result public.connector_outbound_result, next_action_at timestamptz
) language sql stable security definer set search_path = '' as $$
  select delivery.id, delivery.operation, delivery.status, delivery.edited_delivery_id, delivery.provider_reply_id,
    delivery.actor_link_id, delivery.actor_kind, delivery.initiating_member_id, delivery.initiating_service_principal_id,
    delivery.send_attempts, delivery.observation_attempts, delivery.uncertain, delivery.last_result, delivery.next_action_at
  from internal.connector_outbound_deliveries delivery
  where (delivery.workspace_id, delivery.factory_id, delivery.id) = (p_workspace_id, p_factory_id, p_delivery_id)
$$;

revoke all on function public.enqueue_connector_outbound_delivery(uuid, uuid, uuid, uuid, uuid, text,
    public.connector_outbound_operation, jsonb, uuid, uuid),
  public.claim_connector_outbound_delivery(public.connector_provider),
  public.confirm_connector_outbound_authority(uuid, uuid),
  public.settle_connector_outbound_delivery(uuid, uuid, public.connector_outbound_result, text, integer),
  public.read_connector_outbound_delivery(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_connector_outbound_delivery(uuid, uuid, uuid, uuid, uuid, text,
    public.connector_outbound_operation, jsonb, uuid, uuid),
  public.claim_connector_outbound_delivery(public.connector_provider),
  public.confirm_connector_outbound_authority(uuid, uuid),
  public.settle_connector_outbound_delivery(uuid, uuid, public.connector_outbound_result, text, integer),
  public.read_connector_outbound_delivery(uuid, uuid, uuid)
  to service_role;
