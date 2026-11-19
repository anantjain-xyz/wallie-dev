create type public.factory_outbound_event_type as enum (
  'session.created', 'session.canceled', 'run.started', 'run.completed', 'conversation.message_added',
  'review.ready', 'review.approved', 'review.changes_requested', 'review.clarification_requested', 'review.clarification_answered'
);
create type public.factory_event_subscription_credential_kind as enum ('machine_token', 'oauth_grant');
create type public.factory_event_subscription_status as enum ('pending', 'active', 'revoked');

create table internal.factory_event_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  name text not null check (name = btrim(name) and length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  endpoint_url text not null check (
    length(endpoint_url) <= 2048 and endpoint_url ~ '^https://[a-z0-9-]+([.][a-z0-9-]+)+(/[^[:space:][:cntrl:]#]*)$'
    and strpos(endpoint_url, chr(92)) = 0
  ),
  event_types public.factory_outbound_event_type[] not null,
  credential_kind public.factory_event_subscription_credential_kind not null,
  credential_id uuid not null,
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null,
  writer_repository_id uuid not null,
  status public.factory_event_subscription_status not null default 'pending',
  revision bigint not null default 1 check (revision > 0),
  signing_secret_encrypted text not null check (length(signing_secret_encrypted) between 1 and 4000),
  verification_digest text check (verification_digest ~ '^[0-9a-f]{64}$'),
  verification_started_at timestamptz,
  verification_expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  created_by_member_id uuid not null,
  verified_at timestamptz,
  verified_by_member_id uuid,
  revoked_at timestamptz,
  revoked_by_member_id uuid,
  unique (id, workspace_id, factory_id, writer_repository_id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id,id) on delete cascade,
  check (cardinality(event_types) between 1 and 10),
  check ((verification_digest is null) = (verification_expires_at is null)),
  check ((revoked_at is null) = (status <> 'revoked')),
  check ((verified_at is null) = (verified_by_member_id is null)),
  check ((revoked_at is null) = (revoked_by_member_id is null)),
  check (status <> 'active' or verified_at is not null)
);
create index factory_event_subscriptions_scope_idx
  on internal.factory_event_subscriptions(workspace_id,factory_id,created_at desc,id desc);
create index factory_event_subscriptions_writer_idx
  on internal.factory_event_subscriptions(workspace_id,factory_id,writer_repository_id)
  where status = 'active';
alter table internal.factory_event_subscriptions enable row level security;
revoke all on internal.factory_event_subscriptions from public,anon,authenticated,service_role;

-- Queueing uses a side-effect-free view under the source transaction snapshot.
-- Do not take credential/grant locks while holding the session/run lifecycle
-- locks. The send transition uses stronger current, locked checks.
create view internal.factory_event_live_credentials with (security_invoker=true) as
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
revoke all on internal.factory_event_live_credentials from public,anon,authenticated,service_role;

create function internal.factory_event_subscription_has_authority(p_subscription internal.factory_event_subscriptions)
returns boolean language sql stable set search_path='' as $$
  select exists (
    select 1 from internal.factory_event_live_credentials credential
    where (credential.workspace_id,credential.factory_id,credential.credential_kind,credential.credential_id,
      credential.service_principal_id,credential.execution_grant_id,credential.execution_grant_version,credential.writer_repository_id) =
      (p_subscription.workspace_id,p_subscription.factory_id,p_subscription.credential_kind,p_subscription.credential_id,
        p_subscription.service_principal_id,p_subscription.execution_grant_id,p_subscription.execution_grant_version,
        p_subscription.writer_repository_id)
  )
$$;

create function public.list_factory_event_authorizations(p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid)
returns table(credential_kind public.factory_event_subscription_credential_kind,credential_id uuid,
  credential_name text,service_principal_id uuid)
language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  return query select eligible.credential_kind,eligible.credential_id,eligible.credential_name,eligible.service_principal_id
  from internal.factory_event_live_credentials eligible
  where (eligible.workspace_id,eligible.factory_id)=(p_workspace_id,p_factory_id)
  order by eligible.credential_name,eligible.credential_kind,eligible.credential_id limit 100;
end;
$$;

create function public.list_factory_event_subscriptions(p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid)
returns table(id uuid,name text,endpoint_url text,status public.factory_event_subscription_status,
  credential_kind public.factory_event_subscription_credential_kind,credential_id uuid,event_types public.factory_outbound_event_type[],
  created_at timestamptz,verified_at timestamptz,revoked_at timestamptz,authorized boolean)
language plpgsql security definer set search_path='' as $$
begin
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  return query select subscription.id,subscription.name,subscription.endpoint_url,subscription.status,
    subscription.credential_kind,subscription.credential_id,subscription.event_types,
    subscription.created_at,subscription.verified_at,subscription.revoked_at,
    internal.factory_event_subscription_has_authority(subscription)
  from internal.factory_event_subscriptions subscription
  where (subscription.workspace_id,subscription.factory_id)=(p_workspace_id,p_factory_id)
  order by (subscription.status='revoked'),subscription.created_at desc,subscription.id desc limit 100;
end;
$$;

create function public.create_factory_event_subscription(p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,
  p_name text,p_endpoint_url text,p_credential_kind public.factory_event_subscription_credential_kind,p_credential_id uuid,
  p_event_types public.factory_outbound_event_type[],p_signing_secret_encrypted text)
returns uuid language plpgsql security definer set search_path='' as $$
declare manager_id uuid; credential internal.factory_event_live_credentials; created_id uuid;
begin
  manager_id:=internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id,p_factory_id);
  if p_name is null or length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]'
    or cardinality(coalesce(p_event_types,'{}')) not between 1 and 10
    or cardinality(p_event_types) <> (select count(distinct kind) from unnest(p_event_types) kind)
    or p_endpoint_url is null or length(p_endpoint_url)>2048
    or p_endpoint_url !~ '^https://[a-z0-9-]+([.][a-z0-9-]+)+(/[^[:space:][:cntrl:]#]*)$'
    or strpos(p_endpoint_url,chr(92))>0
    or p_signing_secret_encrypted is null or length(p_signing_secret_encrypted) not between 1 and 4000 then
    raise exception 'A valid HTTPS endpoint, bounded subscription name and event selection are required.' using errcode='22023';
  end if;
  select eligible.* into credential from internal.factory_event_live_credentials eligible
  where (eligible.workspace_id,eligible.factory_id,eligible.credential_kind,eligible.credential_id) =
    (p_workspace_id,p_factory_id,p_credential_kind,p_credential_id);
  if not found then raise exception 'Outbound subscription authority is unavailable.' using errcode='42501'; end if;

  -- Manager permissions hold the factory row exclusively, serializing limits
  -- across management callers in this factory.
  if (select count(*) from internal.factory_event_subscriptions subscription
    where (subscription.workspace_id,subscription.factory_id)=(p_workspace_id,p_factory_id)
      and (subscription.status<>'revoked' or subscription.created_at>clock_timestamp()-interval '1 day'))>=20 then
    raise exception 'This factory has reached its subscription limit.' using errcode='PT409';
  end if;
  insert into internal.factory_event_subscriptions(workspace_id,factory_id,name,endpoint_url,credential_kind,credential_id,
    event_types,signing_secret_encrypted,service_principal_id,execution_grant_id,execution_grant_version,writer_repository_id,created_by_member_id)
  values (p_workspace_id,p_factory_id,btrim(p_name),p_endpoint_url,p_credential_kind,p_credential_id,p_event_types,
    p_signing_secret_encrypted,credential.service_principal_id,credential.execution_grant_id,credential.execution_grant_version,
    credential.writer_repository_id,manager_id) returning id into created_id;
  return created_id;
end;
$$;

create function public.begin_factory_event_subscription_verification(p_workspace_id uuid,p_factory_id uuid,
  p_actor_user_id uuid,p_subscription_id uuid,p_verification_digest text)
returns table(endpoint_url text,subscription_revision bigint)
language plpgsql security definer set search_path='' as $$
declare target internal.factory_event_subscriptions; now_at timestamptz;
begin
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  if p_verification_digest is null or p_verification_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid ownership challenge is required.' using errcode='22023';
  end if;
  select subscription.* into target from internal.factory_event_subscriptions subscription
  where (subscription.id,subscription.workspace_id,subscription.factory_id)=(p_subscription_id,p_workspace_id,p_factory_id)
    and subscription.status='pending' for update;
  if not found then raise exception 'Pending subscription not found.' using errcode='P0002'; end if;
  if not internal.factory_event_subscription_has_authority(target) then
    raise exception 'Outbound subscription authority is unavailable.' using errcode='42501';
  end if;
  now_at:=clock_timestamp();
  if target.verification_started_at>now_at-interval '30 seconds' then
    raise exception 'Wait before requesting another ownership challenge.' using errcode='PT409';
  end if;
  update internal.factory_event_subscriptions subscription set
    verification_digest=p_verification_digest,verification_started_at=now_at,verification_expires_at=now_at+interval '2 minutes'
  where subscription.id=target.id;
  return query select target.endpoint_url,target.revision;
end;
$$;

create function public.confirm_factory_event_subscription(p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,
  p_subscription_id uuid,p_verification_digest text)
returns boolean language plpgsql security definer set search_path='' as $$
declare manager_id uuid; target internal.factory_event_subscriptions;
begin
  manager_id:=internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  if p_verification_digest is null or p_verification_digest !~ '^[0-9a-f]{64}$' then return false; end if;
  select subscription.* into target from internal.factory_event_subscriptions subscription
  where (subscription.id,subscription.workspace_id,subscription.factory_id)=(p_subscription_id,p_workspace_id,p_factory_id)
    and subscription.status='pending' for update;
  if not found or target.verification_digest is distinct from p_verification_digest
    or target.verification_expires_at is null or target.verification_expires_at<=clock_timestamp()
    or not internal.factory_event_subscription_has_authority(target) then return false; end if;
  update internal.factory_event_subscriptions subscription set status='active',revision=revision+1,verified_at=clock_timestamp(),
    verified_by_member_id=manager_id,verification_digest=null,verification_expires_at=null
  where subscription.id=target.id;
  return true;
end;
$$;

create function public.revoke_factory_event_subscription(p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_subscription_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare manager_id uuid;
begin
  manager_id:=internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  update internal.factory_event_subscriptions subscription set status='revoked',revision=revision+1,revoked_at=clock_timestamp(),
    revoked_by_member_id=manager_id,verification_digest=null,verification_expires_at=null
  where (subscription.id,subscription.workspace_id,subscription.factory_id)=(p_subscription_id,p_workspace_id,p_factory_id)
    and subscription.status<>'revoked';
  return found;
end;
$$;

revoke all on function internal.factory_event_subscription_has_authority(internal.factory_event_subscriptions)
  from public,anon,authenticated,service_role;
revoke all on function public.list_factory_event_authorizations(uuid,uuid,uuid),
  public.list_factory_event_subscriptions(uuid,uuid,uuid),
  public.create_factory_event_subscription(uuid,uuid,uuid,text,text,public.factory_event_subscription_credential_kind,
    uuid,public.factory_outbound_event_type[],text),
  public.begin_factory_event_subscription_verification(uuid,uuid,uuid,uuid,text),
  public.confirm_factory_event_subscription(uuid,uuid,uuid,uuid,text),
  public.revoke_factory_event_subscription(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.list_factory_event_authorizations(uuid,uuid,uuid),
  public.list_factory_event_subscriptions(uuid,uuid,uuid),
  public.create_factory_event_subscription(uuid,uuid,uuid,text,text,public.factory_event_subscription_credential_kind,
    uuid,public.factory_outbound_event_type[],text),
  public.begin_factory_event_subscription_verification(uuid,uuid,uuid,uuid,text),
  public.confirm_factory_event_subscription(uuid,uuid,uuid,uuid,text),
  public.revoke_factory_event_subscription(uuid,uuid,uuid,uuid) to service_role;
