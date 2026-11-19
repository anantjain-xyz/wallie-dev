create type public.factory_command_credential_kind as enum ('machine_token', 'oauth_access_token');
create type public.factory_command_surface as enum ('api', 'mcp');
create type public.factory_command_admission_status as enum (
  'admitted', 'unauthorized', 'forbidden', 'rate_limited', 'concurrency_limited', 'request_conflict', 'already_admitted'
);

-- Resource ACLs hold shared workspace locks. Use a separate quota mutex so
-- concurrent admissions never try to upgrade a shared lock on a workspace.
create table internal.factory_command_quotas (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  workspace_rate_limit integer not null default 120 check (workspace_rate_limit between 1 and 50000),
  workspace_concurrency_limit integer not null default 12 check (workspace_concurrency_limit between 1 and 500),
  principal_rate_limit integer not null default 60 check (principal_rate_limit between 1 and 50000),
  principal_concurrency_limit integer not null default 4 check (principal_concurrency_limit between 1 and 500),
  window_seconds integer not null default 60 check (window_seconds between 1 and 3600),
  lease_seconds integer not null default 60 check (lease_seconds between 1 and 600),
  updated_by_member_id uuid,
  updated_at timestamptz not null default clock_timestamp()
);

create table internal.factory_command_admissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  factory_id uuid not null,
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null,
  consenting_member_id uuid,
  oauth_grant_id uuid,
  credential_kind public.factory_command_credential_kind not null,
  credential_id uuid not null,
  scope public.factory_command_scope not null,
  surface public.factory_command_surface not null,
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  admitted_at timestamptz not null,
  unique (workspace_id, service_principal_id, request_id),
  unique (id, workspace_id, service_principal_id),
  check ((credential_kind = 'oauth_access_token') = (oauth_grant_id is not null)),
  check ((oauth_grant_id is null) = (consenting_member_id is null))
);
create index factory_command_admissions_workspace_time_idx on internal.factory_command_admissions(workspace_id, admitted_at desc);
create index factory_command_admissions_principal_time_idx
  on internal.factory_command_admissions(workspace_id, service_principal_id, admitted_at desc);
create index factory_command_admissions_retention_idx on internal.factory_command_admissions(admitted_at, id);

create table internal.factory_command_leases (
  admission_id uuid primary key,
  lease_id uuid not null default gen_random_uuid(),
  workspace_id uuid not null,
  service_principal_id uuid not null,
  expires_at timestamptz not null,
  verified_transaction xid8,
  foreign key (admission_id, workspace_id, service_principal_id)
    references internal.factory_command_admissions(id, workspace_id, service_principal_id) on delete cascade
);
create index factory_command_leases_workspace_expiry_idx on internal.factory_command_leases(workspace_id, expires_at);
create index factory_command_leases_principal_expiry_idx
  on internal.factory_command_leases(workspace_id, service_principal_id, expires_at);
create index factory_command_leases_retention_idx on internal.factory_command_leases(expires_at, admission_id);

-- Successful use is distinct from admission. Its insertion belongs to the
-- protected command transaction, so failed protected work cannot record use.
create table internal.factory_command_uses (
  admission_id uuid primary key references internal.factory_command_admissions(id) on delete cascade,
  used_at timestamptz not null
);

alter table internal.factory_command_quotas enable row level security;
alter table internal.factory_command_admissions enable row level security;
alter table internal.factory_command_leases enable row level security;
alter table internal.factory_command_uses enable row level security;
revoke all on internal.factory_command_quotas, internal.factory_command_admissions,
  internal.factory_command_leases, internal.factory_command_uses from public, anon, authenticated, service_role;

create function internal.preserve_factory_command_admission()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.workspaces where id = old.workspace_id)
    or (old.admitted_at <= clock_timestamp() - interval '7 days' and not exists (
      select 1 from internal.factory_command_leases lease where lease.admission_id = old.id
    ))
  ) then return old; end if;
  raise exception 'Command admissions are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_command_admission() from public, anon, authenticated, service_role;
create trigger preserve_factory_command_admission before update or delete on internal.factory_command_admissions
  for each row execute function internal.preserve_factory_command_admission();

create function public.prune_factory_command_admissions(p_batch_size integer default 500)
returns table(leases_deleted integer, admissions_deleted integer)
language plpgsql security definer set search_path = '' as $$
declare
  batch_size integer := least(greatest(coalesce(p_batch_size, 500), 1), 500);
  cutoff timestamptz := clock_timestamp();
begin
  with expired as (
    select lease.admission_id from internal.factory_command_leases lease
    where lease.expires_at <= cutoff
    order by lease.expires_at, lease.admission_id
    limit batch_size for update skip locked
  )
  delete from internal.factory_command_leases lease using expired where lease.admission_id = expired.admission_id;
  get diagnostics leases_deleted = row_count;

  -- Preserve all receipts in the quota window, including completed uses, and
  -- any admission still carrying a lease. A locked expired lease remains live
  -- for retention until its guarded operation commits or rolls back.
  with stale as (
    select receipt.id from internal.factory_command_admissions receipt
    where receipt.admitted_at <= cutoff - interval '7 days'
      and not exists (select 1 from internal.factory_command_leases lease where lease.admission_id = receipt.id)
    order by receipt.admitted_at, receipt.id
    limit batch_size for update of receipt skip locked
  )
  delete from internal.factory_command_admissions receipt using stale where receipt.id = stale.id;
  get diagnostics admissions_deleted = row_count;
  return next;
end;
$$;
revoke all on function public.prune_factory_command_admissions(integer) from public, anon, authenticated, service_role;
grant execute on function public.prune_factory_command_admissions(integer) to service_role;

create function public.configure_factory_command_quotas(
  p_workspace_id uuid, p_actor_user_id uuid, p_workspace_rate_limit integer, p_workspace_concurrency_limit integer,
  p_principal_rate_limit integer, p_principal_concurrency_limit integer,
  p_window_seconds integer default 60, p_lease_seconds integer default 60
) returns void language plpgsql security definer set search_path = '' as $$
declare actor public.workspace_members;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  actor := internal.factory_oauth_member(p_workspace_id, p_actor_user_id);
  if actor.role not in ('owner', 'admin') then raise exception 'Workspace manager required.' using errcode = '42501'; end if;
  if (p_workspace_rate_limit between 1 and 50000 and p_principal_rate_limit between 1 and 50000
    and p_workspace_concurrency_limit between 1 and 500 and p_principal_concurrency_limit between 1 and 500
    and p_window_seconds between 1 and 3600 and p_lease_seconds between 1 and 600) is not true then
    raise exception 'Invalid command quota limits.' using errcode = '22023';
  end if;
  insert into internal.factory_command_quotas(workspace_id, workspace_rate_limit, workspace_concurrency_limit,
    principal_rate_limit, principal_concurrency_limit, window_seconds, lease_seconds, updated_by_member_id)
  values (p_workspace_id,p_workspace_rate_limit,p_workspace_concurrency_limit,p_principal_rate_limit,
    p_principal_concurrency_limit,p_window_seconds,p_lease_seconds,actor.id)
  on conflict (workspace_id) do update set workspace_rate_limit = excluded.workspace_rate_limit,
    workspace_concurrency_limit = excluded.workspace_concurrency_limit, principal_rate_limit = excluded.principal_rate_limit,
    principal_concurrency_limit = excluded.principal_concurrency_limit, window_seconds = excluded.window_seconds,
    lease_seconds = excluded.lease_seconds, updated_by_member_id = excluded.updated_by_member_id, updated_at = clock_timestamp();
end;
$$;
revoke all on function public.configure_factory_command_quotas(uuid, uuid, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.configure_factory_command_quotas(uuid, uuid, integer, integer, integer, integer, integer, integer)
  to service_role;

-- Machine token revocation takes FOR UPDATE. A key-share lock prevents it
-- until this transaction finishes, while allowing unrelated last-use updates.
create function internal.inspect_factory_machine_token(
  p_workspace_id uuid,p_factory_id uuid,p_token_id uuid,p_digest text,p_scope public.factory_command_scope
) returns public.factory_machine_tokens language plpgsql set search_path = '' as $$
declare token public.factory_machine_tokens; approved public.factory_execution_grants; checked_at timestamptz;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id,p_factory_id);
  select target.* into token from public.factory_machine_tokens target
  join internal.factory_machine_token_digests secret on secret.token_id=target.id
  where (target.workspace_id,target.factory_id,target.id,secret.digest) = (p_workspace_id,p_factory_id,p_token_id,p_digest)
  for key share of target;
  if not found or token.revoked_at is not null or token.expires_at <= clock_timestamp() then
    raise exception 'Machine token is unavailable or does not authorize this command.' using errcode = '42501';
  end if;
  approved := internal.require_factory_machine_grant(p_workspace_id,p_factory_id,token.execution_grant_id,token.execution_grant_version);
  checked_at := clock_timestamp();
  if (token.scopes <@ approved.command_scopes) is not true or approved.expires_at <= checked_at or token.expires_at <= checked_at then
    raise exception 'Machine token is unavailable or does not authorize this command.' using errcode = '42501';
  end if;
  if p_scope is null or not (p_scope = any(token.scopes)) then
    raise exception 'Machine token does not authorize this scope.' using errcode = 'PT403';
  end if;
  return token;
end;
$$;
revoke all on function internal.inspect_factory_machine_token(uuid,uuid,uuid,text,public.factory_command_scope)
  from public,anon,authenticated,service_role;

create or replace function internal.require_factory_machine_token(
  p_workspace_id uuid,p_factory_id uuid,p_token_id uuid,p_digest text,p_scope public.factory_command_scope
) returns public.factory_machine_tokens language plpgsql set search_path = '' as $$
declare token public.factory_machine_tokens;
begin
  token := internal.inspect_factory_machine_token(p_workspace_id,p_factory_id,p_token_id,p_digest,p_scope);
  update public.factory_machine_tokens target set last_used_at = clock_timestamp(), last_used_scope = p_scope
  where target.id=token.id returning * into token;
  return token;
exception when sqlstate 'PT403' then
  raise exception 'Machine token is unavailable or does not authorize this command.' using errcode = '42501';
end;
$$;

create function internal.inspect_factory_oauth_access_token(
  p_workspace_id uuid, p_factory_id uuid, p_access_token_id uuid, p_access_token_digest text,
  p_scope public.factory_command_scope
) returns public.factory_oauth_grant_bindings language plpgsql set search_path = '' as $$
declare consent public.factory_oauth_grants; token internal.factory_oauth_token_pairs; binding public.factory_oauth_grant_bindings;
begin
  select grant_row.* into consent from public.factory_oauth_grants grant_row
  join internal.factory_oauth_token_pairs pair on pair.grant_id = grant_row.id
  where (grant_row.workspace_id, pair.access_token_id, pair.access_digest) =
    (p_workspace_id, p_access_token_id, p_access_token_digest);
  if not found then raise exception 'OAuth token is unavailable.' using errcode = '42501'; end if;
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.factory_oauth_clients client where client.id = consent.client_id and client.revoked_at is null for share;
  if not found then raise exception 'OAuth token is unavailable.' using errcode = '42501'; end if;
  select * into consent from public.factory_oauth_grants target where target.id = consent.id for share;
  if not found or consent.revoked_at is not null or consent.expires_at <= clock_timestamp() then
    raise exception 'OAuth token is unavailable.' using errcode = '42501';
  end if;
  select * into token from internal.factory_oauth_token_pairs pair
  where (pair.grant_id, pair.access_token_id, pair.access_digest) = (consent.id, p_access_token_id, p_access_token_digest);
  if not found or token.replaced_at is not null or token.access_expires_at <= clock_timestamp() then
    raise exception 'OAuth token is unavailable.' using errcode = '42501';
  end if;
  select * into binding from public.factory_oauth_grant_bindings pinned
  where (pinned.workspace_id, pinned.factory_id, pinned.grant_id) = (p_workspace_id, p_factory_id, consent.id);
  if not found then
    raise exception 'OAuth token is unavailable in this factory.' using errcode = 'PT403';
  end if;
  perform internal.require_factory_oauth_binding(binding.workspace_id, binding.factory_id, binding.service_principal_id,
    binding.execution_grant_id, binding.execution_grant_version, consent.consenting_member_id, binding.scopes);
  if token.access_expires_at <= clock_timestamp() or consent.expires_at <= clock_timestamp() then
    raise exception 'OAuth token is unavailable.' using errcode = '42501';
  end if;
  if p_scope is null or not (p_scope = any(token.scopes)) or not (p_scope = any(binding.scopes)) then
    raise exception 'OAuth token does not authorize this scope.' using errcode = 'PT403';
  end if;
  return binding;
end;
$$;
revoke all on function internal.inspect_factory_oauth_access_token(uuid,uuid,uuid,text,public.factory_command_scope)
  from public,anon,authenticated,service_role;

create or replace function internal.require_factory_oauth_access_token(
  p_workspace_id uuid,p_factory_id uuid,p_access_token_id uuid,p_access_token_digest text,p_scope public.factory_command_scope
) returns public.factory_oauth_grant_bindings language plpgsql set search_path = '' as $$
begin
  return internal.inspect_factory_oauth_access_token(p_workspace_id,p_factory_id,p_access_token_id,p_access_token_digest,p_scope);
exception when sqlstate 'PT403' then
  raise exception 'OAuth token is unavailable.' using errcode = '42501';
end;
$$;

create type internal.factory_command_identity as (
  service_principal_id uuid,
  execution_grant_id uuid,
  execution_grant_version bigint,
  consenting_member_id uuid,
  oauth_grant_id uuid
);
revoke all on type internal.factory_command_identity from public,anon,authenticated,service_role;

create function internal.inspect_factory_command_credential(
  p_workspace_id uuid,p_factory_id uuid,p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid,p_credential_digest text,p_scope public.factory_command_scope
) returns internal.factory_command_identity language plpgsql set search_path = '' as $$
declare
  token public.factory_machine_tokens;
  binding public.factory_oauth_grant_bindings;
  member_id uuid;
begin
  if p_workspace_id is null or p_factory_id is null or p_credential_kind is null or p_credential_id is null
    or p_credential_digest is null or p_credential_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Machine credential is unavailable.' using errcode = '42501';
  end if;
  if p_credential_kind = 'machine_token' then
    token := internal.inspect_factory_machine_token(p_workspace_id,p_factory_id,p_credential_id,p_credential_digest,p_scope);
    return row(token.service_principal_id,token.execution_grant_id,token.execution_grant_version,null,null)::internal.factory_command_identity;
  end if;
  binding := internal.inspect_factory_oauth_access_token(p_workspace_id,p_factory_id,p_credential_id,p_credential_digest,p_scope);
  select consent.consenting_member_id into strict member_id from public.factory_oauth_grants consent where consent.id = binding.grant_id;
  return row(binding.service_principal_id,binding.execution_grant_id,binding.execution_grant_version,member_id,binding.grant_id)::internal.factory_command_identity;
end;
$$;
revoke all on function internal.inspect_factory_command_credential(
  uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope
) from public,anon,authenticated,service_role;

create function public.admit_factory_command(
  p_workspace_id uuid,p_factory_id uuid,p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid,p_credential_digest text,p_scope public.factory_command_scope,
  p_request_id uuid,p_request_hash text,p_surface public.factory_command_surface
) returns table (
  status public.factory_command_admission_status,retry_after_seconds integer,admission_id uuid,lease_id uuid,
  lease_expires_at timestamptz,workspace_id uuid,factory_id uuid,service_principal_id uuid,
  execution_grant_id uuid,execution_grant_version bigint,consenting_member_id uuid,scope public.factory_command_scope
) language plpgsql security definer set search_path = '' as $$
declare
  actor internal.factory_command_identity;
  quota internal.factory_command_quotas;
  previous internal.factory_command_admissions;
  accepted internal.factory_command_admissions;
  permit internal.factory_command_leases;
  checked_at timestamptz;
  window_length interval;
  workspace_retry_at timestamptz;
  principal_retry_at timestamptz;
begin
  if p_request_id is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' or p_surface is null then
    raise exception 'An exact command identity is required.' using errcode = '22023';
  end if;
  actor := internal.inspect_factory_command_credential(p_workspace_id,p_factory_id,p_credential_kind,p_credential_id,p_credential_digest,p_scope);

  insert into internal.factory_command_quotas as setting(workspace_id) values (p_workspace_id)
  on conflict on constraint factory_command_quotas_pkey do nothing;
  select setting.* into strict quota from internal.factory_command_quotas setting
  where setting.workspace_id = p_workspace_id for update;
  -- Credential rows are already fenced. Recheck time-sensitive expiry after
  -- waiting for the quota mutex so expired authority never reserves a permit.
  actor := internal.inspect_factory_command_credential(p_workspace_id,p_factory_id,p_credential_kind,p_credential_id,p_credential_digest,p_scope);
  checked_at := clock_timestamp();

  select receipt.* into previous from internal.factory_command_admissions receipt
  where (receipt.workspace_id,receipt.service_principal_id,receipt.request_id) =
    (p_workspace_id,actor.service_principal_id,p_request_id);
  if found then
    if (previous.factory_id,previous.credential_kind,previous.credential_id,previous.scope,previous.surface,previous.request_hash)
      is distinct from (p_factory_id,p_credential_kind,p_credential_id,p_scope,p_surface,p_request_hash) then
      status := 'request_conflict';
    else
      -- Only the winning call receives the permit capability. Even an exact
      -- replay cannot spawn another execution or debit another request.
      status := 'already_admitted';
    end if;
    return next;
    return;
  end if;

  window_length := make_interval(secs => quota.window_seconds);
  -- The oldest receipt among the most recent limit-many stays in the rolling
  -- window until enough receipts age out, even after a manager lowers a limit.
  select receipt.admitted_at + window_length into workspace_retry_at
  from internal.factory_command_admissions receipt
  where receipt.workspace_id=p_workspace_id and receipt.admitted_at > checked_at-window_length
  order by receipt.admitted_at desc offset quota.workspace_rate_limit-1 limit 1;
  select receipt.admitted_at + window_length into principal_retry_at
  from internal.factory_command_admissions receipt
  where receipt.workspace_id=p_workspace_id and receipt.service_principal_id=actor.service_principal_id
    and receipt.admitted_at > checked_at-window_length
  order by receipt.admitted_at desc offset quota.principal_rate_limit-1 limit 1;
  if workspace_retry_at is not null or principal_retry_at is not null then
    status := 'rate_limited';
    retry_after_seconds := greatest(1, ceil(extract(epoch from greatest(workspace_retry_at,principal_retry_at)-checked_at))::integer);
    return next;
    return;
  end if;

  -- Real command transactions lock their own lease. Expired locked permits
  -- survive the cleanup and still count against concurrency until unlocked.
  with expired as (
    select lease.admission_id from internal.factory_command_leases lease
    where lease.workspace_id=p_workspace_id and lease.expires_at <= checked_at for update skip locked
  )
  delete from internal.factory_command_leases lease using expired where lease.admission_id=expired.admission_id;
  select lease.expires_at into workspace_retry_at from internal.factory_command_leases lease
  where lease.workspace_id=p_workspace_id order by lease.expires_at desc offset quota.workspace_concurrency_limit-1 limit 1;
  select lease.expires_at into principal_retry_at from internal.factory_command_leases lease
  where lease.workspace_id=p_workspace_id and lease.service_principal_id=actor.service_principal_id
  order by lease.expires_at desc offset quota.principal_concurrency_limit-1 limit 1;
  if workspace_retry_at is not null or principal_retry_at is not null then
    status := 'concurrency_limited';
    retry_after_seconds := greatest(1, ceil(extract(epoch from greatest(workspace_retry_at,principal_retry_at)-checked_at))::integer);
    return next;
    return;
  end if;

  insert into internal.factory_command_admissions (
    workspace_id,factory_id,service_principal_id,execution_grant_id,execution_grant_version,consenting_member_id,oauth_grant_id,
    credential_kind,credential_id,scope,surface,request_id,request_hash,admitted_at
  ) values (
    p_workspace_id,p_factory_id,actor.service_principal_id,actor.execution_grant_id,actor.execution_grant_version,
    actor.consenting_member_id,actor.oauth_grant_id,p_credential_kind,p_credential_id,p_scope,p_surface,p_request_id,p_request_hash,checked_at
  ) returning * into accepted;
  insert into internal.factory_command_leases(admission_id,workspace_id,service_principal_id,expires_at)
  values (accepted.id,p_workspace_id,actor.service_principal_id,checked_at+make_interval(secs=>quota.lease_seconds))
  returning * into permit;
  return query select 'admitted'::public.factory_command_admission_status,null::integer,accepted.id,permit.lease_id,permit.expires_at,
    accepted.workspace_id,accepted.factory_id,accepted.service_principal_id,accepted.execution_grant_id,accepted.execution_grant_version,
    accepted.consenting_member_id,accepted.scope;
exception when sqlstate 'PT403' then
  status := 'forbidden';
  return next;
when insufficient_privilege or foreign_key_violation or sqlstate 'P0010' or sqlstate 'P0011' then
  status := 'unauthorized';
  return next;
end;
$$;
revoke all on function public.admit_factory_command(
  uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope,uuid,text,public.factory_command_surface
) from public,anon,authenticated,service_role;
grant execute on function public.admit_factory_command(
  uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope,uuid,text,public.factory_command_surface
) to service_role;

create function public.release_factory_command_admission(p_admission_id uuid,p_lease_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from internal.factory_command_leases permit
  where (permit.admission_id,permit.lease_id) = (p_admission_id,p_lease_id);
  return found;
end;
$$;
revoke all on function public.release_factory_command_admission(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.release_factory_command_admission(uuid,uuid) to service_role;

create function internal.require_factory_command(
  p_workspace_id uuid,p_factory_id uuid,p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid,p_credential_digest text,p_scope public.factory_command_scope,
  p_request_id uuid,p_request_hash text,p_surface public.factory_command_surface,p_admission_id uuid,p_lease_id uuid
) returns internal.factory_command_admissions language plpgsql set search_path = '' as $$
declare actor internal.factory_command_identity; accepted internal.factory_command_admissions; permit internal.factory_command_leases;
begin
  select lease.* into permit from internal.factory_command_leases lease
  where (lease.admission_id,lease.lease_id) = (p_admission_id,p_lease_id) for update;
  if not found or permit.expires_at <= clock_timestamp() or permit.verified_transaction is not null then
    raise exception 'Command admission is unavailable.' using errcode = 'PT409';
  end if;
  actor := internal.inspect_factory_command_credential(p_workspace_id,p_factory_id,p_credential_kind,p_credential_id,p_credential_digest,p_scope);
  select receipt.* into strict accepted from internal.factory_command_admissions receipt where receipt.id=permit.admission_id;
  if (accepted.workspace_id,accepted.factory_id,accepted.credential_kind,accepted.credential_id,
    accepted.scope,accepted.surface,accepted.request_id,accepted.request_hash,accepted.service_principal_id,
    accepted.execution_grant_id,accepted.execution_grant_version,accepted.consenting_member_id,accepted.oauth_grant_id)
    is distinct from (p_workspace_id,p_factory_id,p_credential_kind,p_credential_id,p_scope,p_surface,p_request_id,p_request_hash,
      actor.service_principal_id,actor.execution_grant_id,actor.execution_grant_version,actor.consenting_member_id,actor.oauth_grant_id) then
    raise exception 'Command admission is unavailable.' using errcode = 'PT409';
  end if;
  if permit.expires_at <= clock_timestamp() then raise exception 'Command admission expired.' using errcode = 'PT409'; end if;
  update internal.factory_command_leases lease set verified_transaction=pg_current_xact_id() where lease.admission_id=permit.admission_id;
  return accepted;
end;
$$;
revoke all on function internal.require_factory_command(
  uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope,uuid,text,public.factory_command_surface,uuid,uuid
) from public,anon,authenticated,service_role;

create function internal.record_factory_command_use(p_admission_id uuid,p_lease_id uuid)
returns void language plpgsql set search_path = '' as $$
declare accepted internal.factory_command_admissions; successful_at timestamptz;
begin
  select receipt.* into accepted from internal.factory_command_admissions receipt
  join internal.factory_command_leases lease on lease.admission_id=receipt.id
  where (lease.admission_id,lease.lease_id,lease.verified_transaction) = (p_admission_id,p_lease_id,pg_current_xact_id());
  if not found then raise exception 'Command use must be recorded in its verified transaction.' using errcode = 'PT409'; end if;
  successful_at := clock_timestamp();
  insert into internal.factory_command_uses(admission_id,used_at) values (accepted.id,successful_at);
  if accepted.credential_kind='machine_token' then
    update public.factory_machine_tokens target set last_used_at=successful_at,last_used_scope=accepted.scope
    where target.id=accepted.credential_id and (target.last_used_at is null or target.last_used_at <= successful_at);
  end if;
end;
$$;
revoke all on function internal.record_factory_command_use(uuid,uuid) from public,anon,authenticated,service_role;
