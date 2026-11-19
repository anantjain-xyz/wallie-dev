alter table internal.factory_command_admissions add column resource_uri text
  check (resource_uri is null or (surface='mcp' and
    internal.factory_mcp_resource_factory_id(resource_uri,workspace_id) is not distinct from factory_id));

create type internal.factory_oauth_access_authority as (
  binding public.factory_oauth_grant_bindings,
  consenting_member_id uuid,
  scopes public.factory_command_scope[]
);
create type internal.factory_command_authority as (
  identity internal.factory_command_identity,
  scopes public.factory_command_scope[]
);
revoke all on type internal.factory_oauth_access_authority,internal.factory_command_authority
  from public,anon,authenticated,service_role;

-- Resolve live authority without using a scope or marking last use. The
-- legacy scoped wrappers and command execution retain the existing locks.
create function internal.resolve_factory_machine_token(
  p_workspace_id uuid,p_factory_id uuid,p_token_id uuid,p_digest text
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
  return token;
end;
$$;

create or replace function internal.inspect_factory_machine_token(
  p_workspace_id uuid,p_factory_id uuid,p_token_id uuid,p_digest text,p_scope public.factory_command_scope
) returns public.factory_machine_tokens language plpgsql set search_path = '' as $$
declare token public.factory_machine_tokens;
begin
  token := internal.resolve_factory_machine_token(p_workspace_id,p_factory_id,p_token_id,p_digest);
  if p_scope is null or not (p_scope = any(token.scopes)) then
    raise exception 'Machine token does not authorize this scope.' using errcode = 'PT403';
  end if;
  return token;
end;
$$;

create function internal.resolve_factory_oauth_access_token(
  p_workspace_id uuid, p_factory_id uuid, p_access_token_id uuid, p_access_token_digest text,
  p_resource text
) returns internal.factory_oauth_access_authority language plpgsql set search_path = '' as $$
declare
  consent public.factory_oauth_grants;
  token internal.factory_oauth_token_pairs;
  binding public.factory_oauth_grant_bindings;
  approved public.factory_execution_grants;
  resource_uri text;
  effective_scopes public.factory_command_scope[];
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
  select resource.resource_uri into resource_uri from internal.factory_oauth_grant_resources resource
  where resource.grant_id=consent.id;
  if resource_uri is distinct from p_resource then
    raise exception 'OAuth token is unavailable.' using errcode = '42501';
  end if;
  select * into binding from public.factory_oauth_grant_bindings pinned
  where (pinned.workspace_id, pinned.factory_id, pinned.grant_id) = (p_workspace_id, p_factory_id, consent.id);
  if not found then
    raise exception 'OAuth token is unavailable in this factory.' using errcode = 'PT403';
  end if;
  approved := internal.require_factory_oauth_binding(binding.workspace_id, binding.factory_id, binding.service_principal_id,
    binding.execution_grant_id, binding.execution_grant_version, consent.consenting_member_id, binding.scopes);
  if token.access_expires_at <= clock_timestamp() or consent.expires_at <= clock_timestamp() then
    raise exception 'OAuth token is unavailable.' using errcode = '42501';
  end if;
  effective_scopes := array(select token_scope from unnest(token.scopes) token_scope
    where token_scope = any(binding.scopes) and token_scope = any(approved.command_scopes));
  return row(binding,consent.consenting_member_id,effective_scopes)::internal.factory_oauth_access_authority;
end;
$$;

create or replace function internal.inspect_factory_oauth_access_token(
  p_workspace_id uuid,p_factory_id uuid,p_access_token_id uuid,p_access_token_digest text,p_scope public.factory_command_scope
) returns public.factory_oauth_grant_bindings language plpgsql set search_path = '' as $$
declare authorized internal.factory_oauth_access_authority;
begin
  authorized := internal.resolve_factory_oauth_access_token(p_workspace_id,p_factory_id,p_access_token_id,p_access_token_digest,null);
  if p_scope is null or not (p_scope = any(authorized.scopes)) then
    raise exception 'OAuth token does not authorize this scope.' using errcode = 'PT403';
  end if;
  return authorized.binding;
end;
$$;

create function internal.resolve_factory_command_credential(
  p_workspace_id uuid,p_factory_id uuid,p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid,p_credential_digest text,p_surface public.factory_command_surface,p_resource text
) returns internal.factory_command_authority language plpgsql set search_path = '' as $$
declare
  token public.factory_machine_tokens;
  authorized internal.factory_oauth_access_authority;
  binding public.factory_oauth_grant_bindings;
  identity internal.factory_command_identity;
begin
  if p_workspace_id is null or p_factory_id is null or p_credential_kind is null or p_credential_id is null
    or p_credential_digest is null or p_credential_digest !~ '^[a-f0-9]{64}$' or p_surface is null
    or (p_resource is not null and (p_surface <> 'mcp' or
      internal.factory_mcp_resource_factory_id(p_resource,p_workspace_id) is distinct from p_factory_id))
    or (p_credential_kind='oauth_access_token' and p_surface='mcp' and p_resource is null) then
    raise exception 'Machine credential is unavailable.' using errcode = '42501';
  end if;
  if p_credential_kind = 'machine_token' then
    token := internal.resolve_factory_machine_token(p_workspace_id,p_factory_id,p_credential_id,p_credential_digest);
    identity := row(token.service_principal_id,token.execution_grant_id,token.execution_grant_version,null,null);
    return row(identity,token.scopes)::internal.factory_command_authority;
  end if;
  authorized := internal.resolve_factory_oauth_access_token(p_workspace_id,p_factory_id,p_credential_id,p_credential_digest,p_resource);
  binding := authorized.binding;
  identity := row(binding.service_principal_id,binding.execution_grant_id,binding.execution_grant_version,
    authorized.consenting_member_id,binding.grant_id);
  return row(identity,authorized.scopes)::internal.factory_command_authority;
end;
$$;

create function internal.inspect_factory_command_credential(
  p_workspace_id uuid,p_factory_id uuid,p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid,p_credential_digest text,p_scope public.factory_command_scope,
  p_surface public.factory_command_surface,p_resource text
) returns internal.factory_command_identity language plpgsql set search_path = '' as $$
declare authorized internal.factory_command_authority;
begin
  authorized := internal.resolve_factory_command_credential(p_workspace_id,p_factory_id,p_credential_kind,
    p_credential_id,p_credential_digest,p_surface,p_resource);
  if p_scope is null or not (p_scope = any(authorized.scopes)) then
    raise exception 'Machine credential does not authorize this scope.' using errcode = 'PT403';
  end if;
  return authorized.identity;
end;
$$;

create function public.inspect_factory_mcp_identity(
  p_workspace_id uuid,p_factory_id uuid,p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid,p_credential_digest text,p_resource text
) returns table(status text,scopes public.factory_command_scope[])
language plpgsql security definer set search_path = '' as $$
declare authorized internal.factory_command_authority;
begin
  if p_resource is null then
    return query select 'unauthorized'::text,'{}'::public.factory_command_scope[];
    return;
  end if;
  authorized := internal.resolve_factory_command_credential(p_workspace_id,p_factory_id,p_credential_kind,
    p_credential_id,p_credential_digest,'mcp',p_resource);
  return query select 'authorized'::text,authorized.scopes;
exception when sqlstate 'PT403' then
  return query select 'forbidden'::text,'{}'::public.factory_command_scope[];
when insufficient_privilege or foreign_key_violation or sqlstate 'P0010' or sqlstate 'P0011' then
  return query select 'unauthorized'::text,'{}'::public.factory_command_scope[];
end;
$$;

create function public.admit_factory_command(
  p_workspace_id uuid,p_factory_id uuid,p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid,p_credential_digest text,p_scope public.factory_command_scope,
  p_request_id uuid,p_request_hash text,p_surface public.factory_command_surface,p_resource text
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
  actor := internal.inspect_factory_command_credential(p_workspace_id,p_factory_id,p_credential_kind,
    p_credential_id,p_credential_digest,p_scope,p_surface,p_resource);

  insert into internal.factory_command_quotas as setting(workspace_id) values (p_workspace_id)
  on conflict on constraint factory_command_quotas_pkey do nothing;
  select setting.* into strict quota from internal.factory_command_quotas setting
  where setting.workspace_id = p_workspace_id for update;
  -- Credential rows are already fenced. Recheck time-sensitive expiry after
  -- waiting for the quota mutex so expired authority never reserves a permit.
  actor := internal.inspect_factory_command_credential(p_workspace_id,p_factory_id,p_credential_kind,
    p_credential_id,p_credential_digest,p_scope,p_surface,p_resource);
  checked_at := clock_timestamp();

  select receipt.* into previous from internal.factory_command_admissions receipt
  where (receipt.workspace_id,receipt.service_principal_id,receipt.request_id) =
    (p_workspace_id,actor.service_principal_id,p_request_id);
  if found then
    if (previous.factory_id,previous.credential_kind,previous.credential_id,previous.scope,previous.surface,previous.request_hash,
      previous.resource_uri) is distinct from (p_factory_id,p_credential_kind,p_credential_id,p_scope,p_surface,p_request_hash,p_resource) then
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
    credential_kind,credential_id,scope,surface,request_id,request_hash,admitted_at,resource_uri
  ) values (
    p_workspace_id,p_factory_id,actor.service_principal_id,actor.execution_grant_id,actor.execution_grant_version,
    actor.consenting_member_id,actor.oauth_grant_id,p_credential_kind,p_credential_id,p_scope,p_surface,p_request_id,p_request_hash,checked_at,p_resource
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

create or replace function public.admit_factory_command(
  p_workspace_id uuid,p_factory_id uuid,p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid,p_credential_digest text,p_scope public.factory_command_scope,
  p_request_id uuid,p_request_hash text,p_surface public.factory_command_surface
) returns table (
  status public.factory_command_admission_status,retry_after_seconds integer,admission_id uuid,lease_id uuid,
  lease_expires_at timestamptz,workspace_id uuid,factory_id uuid,service_principal_id uuid,
  execution_grant_id uuid,execution_grant_version bigint,consenting_member_id uuid,scope public.factory_command_scope
) language sql security definer set search_path = '' as $$
  select * from public.admit_factory_command(p_workspace_id,p_factory_id,p_credential_kind,p_credential_id,
    p_credential_digest,p_scope,p_request_id,p_request_hash,p_surface,null);
$$;

create or replace function internal.require_factory_command(
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
  select receipt.* into strict accepted from internal.factory_command_admissions receipt where receipt.id=permit.admission_id;
  if (accepted.workspace_id,accepted.factory_id,accepted.credential_kind,accepted.credential_id,
    accepted.scope,accepted.surface,accepted.request_id,accepted.request_hash) is distinct from
    (p_workspace_id,p_factory_id,p_credential_kind,p_credential_id,p_scope,p_surface,p_request_id,p_request_hash) then
    raise exception 'Command admission is unavailable.' using errcode = 'PT409';
  end if;
  actor := internal.inspect_factory_command_credential(p_workspace_id,p_factory_id,p_credential_kind,
    p_credential_id,p_credential_digest,p_scope,p_surface,accepted.resource_uri);
  if (accepted.service_principal_id,accepted.execution_grant_id,accepted.execution_grant_version,
    accepted.consenting_member_id,accepted.oauth_grant_id) is distinct from (actor.service_principal_id,
    actor.execution_grant_id,actor.execution_grant_version,actor.consenting_member_id,actor.oauth_grant_id) then
    raise exception 'Command admission is unavailable.' using errcode = 'PT409';
  end if;
  if permit.expires_at <= clock_timestamp() then raise exception 'Command admission expired.' using errcode = 'PT409'; end if;
  update internal.factory_command_leases lease set verified_transaction=pg_current_xact_id() where lease.admission_id=permit.admission_id;
  return accepted;
end;
$$;

create or replace view internal.factory_event_live_credentials with (security_invoker=true) as
with credential as (
  select token.workspace_id,token.factory_id,token.id credential_id,token.name credential_name,
    'machine_token'::public.factory_event_subscription_credential_kind credential_kind,
    token.service_principal_id,token.execution_grant_id,token.execution_grant_version,null::uuid consenting_member_id
  from public.factory_machine_tokens token
  where token.revoked_at is null and (token.expires_at is null or token.expires_at>clock_timestamp())
    and 'sessions:read' = any(token.scopes)
  union all
  select binding.workspace_id,binding.factory_id,consent.id,client.name,'oauth_grant',
    binding.service_principal_id,binding.execution_grant_id,binding.execution_grant_version,consent.consenting_member_id
  from public.factory_oauth_grant_bindings binding
  join public.factory_oauth_grants consent on (consent.workspace_id,consent.id)=(binding.workspace_id,binding.grant_id)
  join public.factory_oauth_clients client on (client.workspace_id,client.id)=(consent.workspace_id,consent.client_id)
  join internal.factory_oauth_token_pairs pair on pair.grant_id=consent.id and pair.replaced_at is null
  join public.workspace_members member on (member.workspace_id,member.id)=(consent.workspace_id,consent.consenting_member_id)
  where consent.revoked_at is null and consent.expires_at>clock_timestamp() and client.revoked_at is null
    and not exists (select 1 from internal.factory_oauth_grant_resources resource where resource.grant_id=consent.id)
    and pair.refresh_expires_at>clock_timestamp()
    and 'sessions:read' = any(binding.scopes) and 'sessions:read' = any(pair.scopes)
    and 'sessions:read' = any(consent.scopes) and 'sessions:read' = any(client.allowed_scopes)
    and member.kind='human' and member.is_active and (
      member.role in ('owner','admin') or exists (
        select 1 from public.factory_members access
        where (access.workspace_id,access.factory_id,access.member_id)=(binding.workspace_id,binding.factory_id,member.id)
          and access.revoked_at is null
      )
    )
)
select credential.*,approved.github_repository_id writer_repository_id
from credential
join public.factory_execution_grants approved on
  (approved.workspace_id,approved.factory_id,approved.service_principal_id,approved.id,approved.version) =
  (credential.workspace_id,credential.factory_id,credential.service_principal_id,
    credential.execution_grant_id,credential.execution_grant_version)
join public.workspaces workspace on workspace.id=credential.workspace_id and workspace.deletion_requested_at is null
join public.factories factory on (factory.workspace_id,factory.id)=(credential.workspace_id,credential.factory_id) and factory.status='active'
join public.workspace_members payer on (payer.workspace_id,payer.id)=(approved.workspace_id,approved.budget_payer_member_id)
join public.execution_policy_revisions policy on (policy.workspace_id,policy.id)=(approved.workspace_id,approved.execution_policy_revision_id)
where approved.revoked_at is null and approved.expires_at>clock_timestamp()
  and 'sessions:read' = any(approved.command_scopes) and payer.kind='human' and payer.is_active
  and not exists (
    select 1 from unnest(array_prepend(approved.github_repository_id,approved.read_context_repository_ids)) target(id)
    where not exists (
      select 1 from public.github_repositories repository
      join public.github_installations installation on
        (installation.workspace_id,installation.id)=(repository.workspace_id,repository.github_installation_id)
      where (repository.workspace_id,repository.factory_id,repository.id)=(approved.workspace_id,approved.factory_id,target.id)
        and not repository.is_archived and not installation.suspended
    )
  );

revoke all on function
  internal.resolve_factory_machine_token(uuid,uuid,uuid,text),
  internal.resolve_factory_oauth_access_token(uuid,uuid,uuid,text,text),
  internal.resolve_factory_command_credential(uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_surface,text),
  internal.inspect_factory_command_credential(uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope,public.factory_command_surface,text),
  public.inspect_factory_mcp_identity(uuid,uuid,public.factory_command_credential_kind,uuid,text,text),
  public.admit_factory_command(uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope,uuid,text,public.factory_command_surface,text)
from public,anon,authenticated,service_role;
grant execute on function
  public.inspect_factory_mcp_identity(uuid,uuid,public.factory_command_credential_kind,uuid,text,text),
  public.admit_factory_command(uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope,uuid,text,public.factory_command_surface,text)
to service_role;

drop function internal.inspect_factory_command_credential(uuid,uuid,public.factory_command_credential_kind,uuid,text,public.factory_command_scope);
