-- OAuth consent delegates existing command scopes. It never creates a human
-- membership, grants unapproved resources, or widens a factory execution grant.
create table public.factory_oauth_clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (name = btrim(name) and length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  allowed_scopes public.factory_command_scope[] not null check (cardinality(allowed_scopes) between 1 and 5),
  created_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoked_by_member_id uuid,
  unique (workspace_id, id),
  check ((revoked_at is null) = (revoked_by_member_id is null))
);

create table public.factory_oauth_client_bindings (
  client_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null check (execution_grant_version between 1 and 9007199254740991),
  primary key (client_id, factory_id),
  foreign key (workspace_id, client_id) references public.factory_oauth_clients(workspace_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, service_principal_id, execution_grant_id)
    references public.factory_execution_grants(workspace_id, factory_id, service_principal_id, id) on delete cascade
);
create index factory_oauth_client_bindings_execution_idx on public.factory_oauth_client_bindings
  (workspace_id, factory_id, service_principal_id, execution_grant_id);

create table public.factory_oauth_grants (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  workspace_id uuid not null,
  consenting_member_id uuid not null,
  scopes public.factory_command_scope[] not null check (cardinality(scopes) between 1 and 5),
  created_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > created_at),
  revoked_at timestamptz,
  revoked_by_member_id uuid,
  revocation_reason text check (revocation_reason in ('disconnected', 'refresh_reuse', 'client_revoked')),
  unique (workspace_id, id),
  foreign key (workspace_id, client_id) references public.factory_oauth_clients(workspace_id, id) on delete cascade,
  check ((revoked_at is null) = (revocation_reason is null))
);
create index factory_oauth_grants_client_idx on public.factory_oauth_grants (workspace_id, client_id);
create index factory_oauth_grants_member_idx on public.factory_oauth_grants (workspace_id, consenting_member_id);

create table public.factory_oauth_grant_bindings (
  grant_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  service_principal_id uuid not null,
  execution_grant_id uuid not null,
  execution_grant_version bigint not null check (execution_grant_version between 1 and 9007199254740991),
  primary key (grant_id, factory_id),
  foreign key (workspace_id, grant_id) references public.factory_oauth_grants(workspace_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, service_principal_id, execution_grant_id)
    references public.factory_execution_grants(workspace_id, factory_id, service_principal_id, id) on delete cascade
);
create index factory_oauth_grant_bindings_execution_idx on public.factory_oauth_grant_bindings
  (workspace_id, factory_id, service_principal_id, execution_grant_id);

create table internal.factory_oauth_authorizations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  client_id uuid not null,
  consenting_member_id uuid not null,
  browser_session_id uuid not null,
  redirect_uri text not null,
  pkce_challenge text not null check (pkce_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state text,
  scopes public.factory_command_scope[] not null,
  offered_factory_ids uuid[] not null,
  consented_factory_ids uuid[],
  expires_at timestamptz not null,
  decided_at timestamptz,
  code_id uuid unique,
  code_digest text check (code_digest ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz,
  code_consumed_at timestamptz,
  foreign key (workspace_id, client_id) references public.factory_oauth_clients(workspace_id, id) on delete cascade,
  check ((code_id is null) = (code_digest is null) and (code_id is null) = (code_expires_at is null)),
  check ((code_id is null) = (consented_factory_ids is null))
);
create index factory_oauth_authorizations_client_idx on internal.factory_oauth_authorizations (workspace_id, client_id);

create table internal.factory_oauth_token_pairs (
  access_token_id uuid primary key,
  access_digest text not null check (access_digest ~ '^[0-9a-f]{64}$'),
  refresh_token_id uuid not null unique,
  refresh_digest text not null check (refresh_digest ~ '^[0-9a-f]{64}$'),
  grant_id uuid not null references public.factory_oauth_grants(id) on delete cascade,
  scopes public.factory_command_scope[] not null,
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  replaced_at timestamptz
);
create index factory_oauth_token_pairs_grant_idx on internal.factory_oauth_token_pairs(grant_id);
create unique index factory_oauth_token_pairs_active_idx on internal.factory_oauth_token_pairs(grant_id) where replaced_at is null;

alter table public.factory_oauth_clients enable row level security;
alter table public.factory_oauth_client_bindings enable row level security;
alter table public.factory_oauth_grants enable row level security;
alter table public.factory_oauth_grant_bindings enable row level security;
alter table internal.factory_oauth_authorizations enable row level security;
alter table internal.factory_oauth_token_pairs enable row level security;
revoke all on public.factory_oauth_clients, public.factory_oauth_client_bindings,
  public.factory_oauth_grants, public.factory_oauth_grant_bindings,
  internal.factory_oauth_authorizations, internal.factory_oauth_token_pairs
  from public, anon, authenticated, service_role;
grant select on public.factory_oauth_clients, public.factory_oauth_client_bindings,
  public.factory_oauth_grants, public.factory_oauth_grant_bindings to authenticated, service_role;

create function internal.can_read_factory_oauth_client(p_workspace_id uuid, p_client_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members member
    join public.workspaces workspace on workspace.id = member.workspace_id
    where member.workspace_id = p_workspace_id and member.user_id = auth.uid()
      and member.kind = 'human' and member.is_active and workspace.deletion_requested_at is null
      and (member.role in ('owner', 'admin') or exists (
        select 1 from public.factory_oauth_grants consent
        where (consent.workspace_id, consent.client_id, consent.consenting_member_id) =
          (p_workspace_id, p_client_id, member.id)
      ))
  );
$$;
revoke all on function internal.can_read_factory_oauth_client(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function internal.can_read_factory_oauth_client(uuid, uuid) to authenticated;

create policy factory_oauth_clients_read on public.factory_oauth_clients for select to authenticated
  using (internal.can_read_factory_oauth_client(workspace_id, id));
create policy factory_oauth_client_bindings_read on public.factory_oauth_client_bindings for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));
create policy factory_oauth_grants_read on public.factory_oauth_grants for select to authenticated using (exists (
  select 1 from public.workspace_members member
  where member.workspace_id = factory_oauth_grants.workspace_id and member.user_id = auth.uid()
    and member.kind = 'human' and member.is_active
    and (member.id = factory_oauth_grants.consenting_member_id or member.role in ('owner', 'admin'))
));
create policy factory_oauth_grant_bindings_read on public.factory_oauth_grant_bindings for select to authenticated using (
  internal.can_access_factory(workspace_id, factory_id) and exists (
  select 1 from public.factory_oauth_grants consent
  where (consent.workspace_id, consent.id) = (factory_oauth_grant_bindings.workspace_id, factory_oauth_grant_bindings.grant_id)
));

alter table public.factory_audit_events drop constraint factory_audit_events_action_check;
alter table public.factory_audit_events add constraint factory_audit_events_action_check check (action in (
  'factory.created', 'factory.archived', 'factory.restored',
  'membership.granted', 'membership.revoked', 'membership.suspended', 'membership.reinstated',
  'agent.created', 'agent.prompt_revision_created',
  'skill.created', 'skill.revision_created', 'skill.revision_revoked',
  'service_principal.created', 'execution_grant.approved', 'execution_grant.updated', 'execution_grant.revoked',
  'credential_binding.created', 'credential_binding.revoked',
  'mcp_server.created', 'mcp_server.revision_created', 'mcp_server.revision_revoked',
  'mcp_secret_binding.created', 'mcp_secret_binding.revoked',
  'machine_token.issued', 'machine_token.revoked',
  'oauth_client.registered', 'oauth_client.revoked', 'oauth_grant.connected', 'oauth_grant.revoked'
));

create function internal.factory_oauth_member(p_workspace_id uuid, p_actor_user_id uuid)
returns public.workspace_members language plpgsql set search_path = '' as $$
declare actor public.workspace_members;
begin
  select * into actor from public.workspace_members member
  where (member.workspace_id, member.user_id) = (p_workspace_id, p_actor_user_id)
    and member.kind = 'human' and member.is_active for share nowait;
  if not found then raise exception 'Active workspace membership required.' using errcode = '42501'; end if;
  return actor;
exception when lock_not_available then
  raise exception 'Workspace access is changing. Retry the operation.' using errcode = 'PT409';
end;
$$;

create function internal.assert_factory_oauth_browser_session(p_actor_user_id uuid, p_actor_session_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform 1 from auth.sessions browser
  where (browser.id, browser.user_id) = (p_actor_session_id, p_actor_user_id)
    and (browser.not_after is null or browser.not_after > clock_timestamp()) for share;
  if not found then raise exception 'Browser session is unavailable.' using errcode = '42501'; end if;
end;
$$;

create function internal.valid_factory_oauth_scopes(p_scopes public.factory_command_scope[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(array_ndims(p_scopes) = 1 and cardinality(p_scopes) between 1 and 5
    and cardinality(p_scopes) = (select count(distinct scope) from unnest(p_scopes) scope), false);
$$;

create function internal.valid_factory_oauth_redirect(p_uri text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(length(p_uri) between 1 and 2048 and p_uri !~ '[#[:cntrl:][:space:]]' and strpos(p_uri, chr(92)) = 0
    and (p_uri ~ '^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?([/?].*)?$'
      or p_uri ~ '^http://(127[.]0[.]0[.]1|\[::1\]):[0-9]{1,5}([/?].*)?$')
    and coalesce(substring(p_uri from '^https?://(?:[^:/?]+|\[[0-9A-Fa-f:]+\]):([0-9]{1,5})')::integer <= 65535, true)
    and not exists (
      select 1 from regexp_split_to_table(coalesce(substring(p_uri from '[?](.*)$'), ''), '&') parameter(value)
      cross join lateral (
        -- Match URLSearchParams key recognition without changing the exact URI
        -- stored for authorization and exchange. Values are opaque.
        select string_agg(case when left(piece[1], 1) = '%' and length(piece[1]) = 3
          then coalesce(chr(nullif(get_byte(decode(substr(piece[1], 2), 'hex'), 0), 0)), piece[1])
          else piece[1] end, '' order by ordinal) as key
        from regexp_matches(split_part(parameter.value, '=', 1), '%[[:xdigit:]]{2}|.', 'g')
          with ordinality as part(piece, ordinal)
      ) decoded
      where decoded.key in ('code', 'state', 'error', 'error_description', 'error_uri', 'iss')
    ), false);
$$;

create function internal.require_factory_oauth_binding(
  p_workspace_id uuid, p_factory_id uuid, p_principal_id uuid, p_grant_id uuid, p_grant_version bigint,
  p_member_id uuid, p_scopes public.factory_command_scope[]
) returns timestamptz language plpgsql set search_path = '' as $$
declare approved public.factory_execution_grants;
begin
  approved := internal.require_factory_machine_grant(p_workspace_id, p_factory_id, p_grant_id, p_grant_version);
  if p_member_id is not null then
    perform internal.assert_factory_grant_invoker(p_workspace_id, p_factory_id, p_member_id);
  end if;
  if approved.service_principal_id <> p_principal_id or (p_scopes <@ approved.command_scopes) is not true then
    raise exception 'OAuth factory authority is unavailable.' using errcode = '42501';
  end if;
  return approved.expires_at;
end;
$$;

revoke all on function internal.factory_oauth_member(uuid, uuid),
  internal.assert_factory_oauth_browser_session(uuid, uuid),
  internal.valid_factory_oauth_scopes(public.factory_command_scope[]), internal.valid_factory_oauth_redirect(text),
  internal.require_factory_oauth_binding(uuid, uuid, uuid, uuid, bigint, uuid, public.factory_command_scope[])
  from public, anon, authenticated, service_role;

create function public.register_factory_oauth_client(
  p_workspace_id uuid, p_actor_user_id uuid, p_name text, p_redirect_uris text[],
  p_allowed_scopes public.factory_command_scope[], p_bindings jsonb
) returns public.factory_oauth_clients language plpgsql security definer set search_path = '' as $$
declare
  actor public.workspace_members;
  client public.factory_oauth_clients;
  chosen record;
  approved public.factory_execution_grants;
  covered public.factory_command_scope[] := '{}';
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  actor := internal.factory_oauth_member(p_workspace_id, p_actor_user_id);
  if actor.role not in ('owner', 'admin') then
    raise exception 'Workspace manager required.' using errcode = '42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 120 or p_name ~ '[[:cntrl:]]'
    or array_ndims(p_redirect_uris) is distinct from 1 or cardinality(p_redirect_uris) not between 1 and 10
    or cardinality(p_redirect_uris) <> (select count(distinct uri) from unnest(p_redirect_uris) uri)
    or exists (select 1 from unnest(p_redirect_uris) uri where not internal.valid_factory_oauth_redirect(uri))
    or not internal.valid_factory_oauth_scopes(p_allowed_scopes)
    or jsonb_typeof(p_bindings) is distinct from 'array' then
    raise exception 'OAuth registration requires a name, exact redirect URIs, scopes and factory bindings.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_bindings) not between 1 and 20 or jsonb_array_length(p_bindings) <> (
    select count(distinct binding->>'factory_id') from jsonb_array_elements(p_bindings) binding
  ) then
    raise exception 'OAuth registration requires distinct factory bindings.' using errcode = '22023';
  end if;
  insert into public.factory_oauth_clients (workspace_id, name, redirect_uris, allowed_scopes, created_by_member_id)
  values (p_workspace_id, btrim(p_name), p_redirect_uris, p_allowed_scopes, actor.id) returning * into client;

  for chosen in select * from jsonb_to_recordset(p_bindings)
    as item(factory_id uuid, execution_grant_id uuid, execution_grant_version bigint) order by factory_id
  loop
    approved := internal.require_factory_machine_grant(p_workspace_id, chosen.factory_id,
      chosen.execution_grant_id, chosen.execution_grant_version);
    if not (approved.command_scopes && p_allowed_scopes) then
      raise exception 'Factory grant does not authorize a registered command.' using errcode = '42501';
    end if;
    covered := covered || approved.command_scopes;
    insert into public.factory_oauth_client_bindings (
      client_id, workspace_id, factory_id, service_principal_id, execution_grant_id, execution_grant_version
    ) values (client.id, p_workspace_id, chosen.factory_id, approved.service_principal_id, approved.id, approved.version);
    insert into public.factory_audit_events(workspace_id, factory_id, actor_member_id, action, detail)
    values (p_workspace_id, chosen.factory_id, actor.id, 'oauth_client.registered',
      jsonb_build_object('clientId', client.id, 'grantId', approved.id, 'grantVersion', approved.version, 'scopes', p_allowed_scopes));
  end loop;
  if not (p_allowed_scopes <@ covered) then
    raise exception 'Registered commands must be covered by approved factory grants.' using errcode = '42501';
  end if;
  return client;
end;
$$;

create function public.begin_factory_oauth_authorization(
  p_client_id uuid, p_actor_user_id uuid, p_actor_session_id uuid, p_redirect_uri text,
  p_code_challenge text, p_requested_scopes public.factory_command_scope[], p_state text default null
) returns table(authorization_id uuid, client_name text, workspace_id uuid, workspace_name text,
  scopes public.factory_command_scope[], factories jsonb, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  client public.factory_oauth_clients;
  actor public.workspace_members;
  binding record;
  offered_ids uuid[] := '{}';
  offered_factories jsonb := '[]';
  request_row internal.factory_oauth_authorizations;
begin
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$'
    or not internal.valid_factory_oauth_scopes(p_requested_scopes)
    or (p_state is not null and (length(p_state) > 1024 or p_state ~ '[[:cntrl:]]')) then
    raise exception 'Invalid OAuth authorization request.' using errcode = '22023';
  end if;
  select target.* into client from public.factory_oauth_clients target where target.id = p_client_id;
  if not found then raise exception 'OAuth client is unavailable.' using errcode = '42501'; end if;
  perform internal.assert_workspace_accepts_work(client.workspace_id);
  select target.* into client from public.factory_oauth_clients target where target.id = p_client_id for share;
  if not found or client.revoked_at is not null or p_redirect_uri is null
    or not (p_redirect_uri = any(client.redirect_uris)) or not (p_requested_scopes <@ client.allowed_scopes) then
    raise exception 'OAuth client, redirect or scope is unavailable.' using errcode = '42501';
  end if;
  perform internal.assert_factory_oauth_browser_session(p_actor_user_id, p_actor_session_id);
  actor := internal.factory_oauth_member(client.workspace_id, p_actor_user_id);
  for binding in select pinned.*, factory.name from public.factory_oauth_client_bindings pinned
    join public.factories factory on (factory.workspace_id, factory.id) = (pinned.workspace_id, pinned.factory_id)
    where pinned.client_id = client.id order by pinned.factory_id
  loop
    begin
      perform internal.require_factory_oauth_binding(client.workspace_id, binding.factory_id, binding.service_principal_id,
        binding.execution_grant_id, binding.execution_grant_version, actor.id, p_requested_scopes);
      offered_ids := array_append(offered_ids, binding.factory_id);
      offered_factories := offered_factories || jsonb_build_array(jsonb_build_object(
        'factory_id', binding.factory_id, 'name', binding.name, 'service_principal_id', binding.service_principal_id,
        'execution_grant_id', binding.execution_grant_id, 'execution_grant_version', binding.execution_grant_version));
    exception when insufficient_privilege or sqlstate 'P0011' then
      continue;
    end;
  end loop;
  if cardinality(offered_ids) = 0 then
    raise exception 'No registered factory authorizes this request.' using errcode = '42501';
  end if;
  insert into internal.factory_oauth_authorizations (
    workspace_id, client_id, consenting_member_id, browser_session_id, redirect_uri, pkce_challenge,
    state, scopes, offered_factory_ids, expires_at
  ) values (client.workspace_id, client.id, actor.id, p_actor_session_id, p_redirect_uri, p_code_challenge,
    p_state, p_requested_scopes, offered_ids, clock_timestamp() + interval '10 minutes') returning * into request_row;
  return query select request_row.id, client.name, client.workspace_id, workspace.name,
    request_row.scopes, offered_factories, request_row.expires_at
  from public.workspaces workspace where workspace.id = client.workspace_id;
end;
$$;

create function public.decide_factory_oauth_authorization(
  p_authorization_id uuid, p_actor_user_id uuid, p_actor_session_id uuid, p_allow boolean,
  p_factory_ids uuid[] default null, p_code_id uuid default null, p_code_digest text default null
) returns table(redirect_uri text, state text, approved boolean)
language plpgsql security definer set search_path = '' as $$
declare
  request_row internal.factory_oauth_authorizations;
  client public.factory_oauth_clients;
  actor public.workspace_members;
  binding public.factory_oauth_client_bindings;
begin
  select * into request_row from internal.factory_oauth_authorizations where id = p_authorization_id;
  if not found then raise exception 'OAuth authorization is unavailable.' using errcode = '42501'; end if;
  perform internal.assert_workspace_accepts_work(request_row.workspace_id);
  select * into client from public.factory_oauth_clients where id = request_row.client_id for share;
  select * into request_row from internal.factory_oauth_authorizations where id = p_authorization_id for update;
  if not found or client.revoked_at is not null or request_row.decided_at is not null
    or request_row.expires_at <= clock_timestamp() or request_row.browser_session_id is distinct from p_actor_session_id then
    raise exception 'OAuth authorization is unavailable.' using errcode = '42501';
  end if;
  perform internal.assert_factory_oauth_browser_session(p_actor_user_id, p_actor_session_id);
  actor := internal.factory_oauth_member(request_row.workspace_id, p_actor_user_id);
  if actor.id <> request_row.consenting_member_id or p_allow is null then
    raise exception 'OAuth authorization is unavailable.' using errcode = '42501';
  end if;
  if p_allow then
    if array_ndims(p_factory_ids) is distinct from 1 or cardinality(p_factory_ids) not between 1 and 20
      or cardinality(p_factory_ids) <> (select count(distinct id) from unnest(p_factory_ids) id)
      or not (p_factory_ids <@ request_row.offered_factory_ids)
      or p_code_id is null or p_code_digest is null or p_code_digest !~ '^[a-f0-9]{64}$' then
      raise exception 'Consent must select offered factories and a valid authorization code.' using errcode = '22023';
    end if;
    for binding in select * from public.factory_oauth_client_bindings pinned
      where pinned.client_id = client.id and pinned.factory_id = any(p_factory_ids) order by pinned.factory_id
    loop
      perform internal.require_factory_oauth_binding(binding.workspace_id, binding.factory_id, binding.service_principal_id,
        binding.execution_grant_id, binding.execution_grant_version, actor.id, request_row.scopes);
    end loop;
    if request_row.expires_at <= clock_timestamp() then
      raise exception 'OAuth authorization is unavailable.' using errcode = '42501';
    end if;
  end if;
  update internal.factory_oauth_authorizations target set decided_at = clock_timestamp(),
    consented_factory_ids = case when p_allow then p_factory_ids end,
    code_id = case when p_allow then p_code_id end, code_digest = case when p_allow then p_code_digest end,
    code_expires_at = case when p_allow then clock_timestamp() + interval '2 minutes' end
  where target.id = request_row.id;
  return query select request_row.redirect_uri, request_row.state, p_allow;
end;
$$;

create function internal.audit_factory_oauth_grant(
  p_grant public.factory_oauth_grants, p_action text, p_actor_member_id uuid
) returns void language sql set search_path = '' as $$
  insert into public.factory_audit_events(workspace_id, factory_id, actor_member_id, action, detail)
  select binding.workspace_id, binding.factory_id, p_actor_member_id, p_action,
    jsonb_build_object('clientId', p_grant.client_id, 'oauthGrantId', p_grant.id, 'grantId', binding.execution_grant_id,
      'grantVersion', binding.execution_grant_version, 'scopes', p_grant.scopes, 'reason', p_grant.revocation_reason)
  from public.factory_oauth_grant_bindings binding where binding.grant_id = p_grant.id;
$$;

create function internal.revoke_factory_oauth_grant(
  p_grant public.factory_oauth_grants, p_reason text, p_actor_member_id uuid
) returns public.factory_oauth_grants language plpgsql set search_path = '' as $$
declare revoked public.factory_oauth_grants;
begin
  if p_grant.revoked_at is not null then return p_grant; end if;
  update public.factory_oauth_grants target set revoked_at = clock_timestamp(),
    revocation_reason = p_reason, revoked_by_member_id = p_actor_member_id
  where target.id = p_grant.id returning * into strict revoked;
  perform internal.audit_factory_oauth_grant(revoked, 'oauth_grant.revoked', p_actor_member_id);
  return revoked;
end;
$$;

create function public.revoke_factory_oauth_grant(p_workspace_id uuid, p_actor_user_id uuid, p_grant_id uuid)
returns public.factory_oauth_grants language plpgsql security definer set search_path = '' as $$
declare actor public.workspace_members; consent public.factory_oauth_grants;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  actor := internal.factory_oauth_member(p_workspace_id, p_actor_user_id);
  select * into consent from public.factory_oauth_grants target
  where (target.workspace_id, target.id) = (p_workspace_id, p_grant_id)
    and (target.consenting_member_id = actor.id or actor.role in ('owner', 'admin'));
  if not found then raise exception 'OAuth grant is unavailable.' using errcode = 'P0002'; end if;
  perform 1 from public.factory_oauth_clients where id = consent.client_id for share;
  select * into strict consent from public.factory_oauth_grants where id = p_grant_id for update;
  return internal.revoke_factory_oauth_grant(consent, 'disconnected', actor.id);
end;
$$;

create function public.revoke_factory_oauth_client(p_workspace_id uuid, p_actor_user_id uuid, p_client_id uuid)
returns public.factory_oauth_clients language plpgsql security definer set search_path = '' as $$
declare actor public.workspace_members; client public.factory_oauth_clients; consent public.factory_oauth_grants;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  actor := internal.factory_oauth_member(p_workspace_id, p_actor_user_id);
  if actor.role not in ('owner', 'admin') then
    raise exception 'Workspace manager required.' using errcode = '42501';
  end if;
  select * into client from public.factory_oauth_clients target
  where (target.workspace_id, target.id) = (p_workspace_id, p_client_id) for update;
  if not found then raise exception 'OAuth client is unavailable.' using errcode = 'P0002'; end if;
  if client.revoked_at is not null then return client; end if;
  update public.factory_oauth_clients target set revoked_at = clock_timestamp(), revoked_by_member_id = actor.id
  where target.id = client.id returning * into client;
  for consent in select * from public.factory_oauth_grants target
    where target.client_id = client.id and target.revoked_at is null order by target.id for update
  loop
    perform internal.revoke_factory_oauth_grant(consent, 'client_revoked', actor.id);
  end loop;
  insert into public.factory_audit_events(workspace_id, factory_id, actor_member_id, action, detail)
  select binding.workspace_id, binding.factory_id, actor.id, 'oauth_client.revoked', jsonb_build_object('clientId', client.id)
  from public.factory_oauth_client_bindings binding where binding.client_id = client.id;
  return client;
end;
$$;

create function internal.issue_factory_oauth_token_pair(
  p_grant public.factory_oauth_grants, p_scopes public.factory_command_scope[],
  p_access_token_id uuid, p_access_token_digest text, p_refresh_token_id uuid, p_refresh_token_digest text
) returns integer language plpgsql set search_path = '' as $$
declare issued_at timestamptz := clock_timestamp(); expires_at timestamptz;
begin
  if p_access_token_id is null or p_access_token_digest is null or p_access_token_digest !~ '^[a-f0-9]{64}$'
    or p_refresh_token_id is null or p_refresh_token_digest is null or p_refresh_token_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid OAuth token envelope.' using errcode = '22023';
  end if;
  expires_at := least(p_grant.expires_at, issued_at + interval '10 minutes');
  if expires_at <= issued_at then raise exception 'OAuth grant expired.' using errcode = '42501'; end if;
  insert into internal.factory_oauth_token_pairs (
    access_token_id, access_digest, refresh_token_id, refresh_digest, grant_id, scopes, access_expires_at, refresh_expires_at
  ) values (p_access_token_id, p_access_token_digest, p_refresh_token_id, p_refresh_token_digest, p_grant.id, p_scopes,
    expires_at, least(p_grant.expires_at, issued_at + interval '30 days'));
  return ceil(extract(epoch from expires_at - issued_at))::integer;
end;
$$;

create function public.exchange_factory_oauth_code(
  p_client_id uuid, p_redirect_uri text, p_code_id uuid, p_code_digest text, p_pkce_challenge text,
  p_access_token_id uuid, p_access_token_digest text, p_refresh_token_id uuid, p_refresh_token_digest text
) returns table(status text, expires_in integer, scopes public.factory_command_scope[])
language plpgsql security definer set search_path = '' as $$
declare
  request_row internal.factory_oauth_authorizations;
  client public.factory_oauth_clients;
  binding public.factory_oauth_client_bindings;
  consent public.factory_oauth_grants;
  granted_at timestamptz;
  expiry timestamptz := clock_timestamp() + interval '90 days';
  granted_factories integer := 0;
  ttl integer;
begin
  select * into request_row from internal.factory_oauth_authorizations request
  where (request.code_id, request.code_digest, request.client_id, request.redirect_uri, request.pkce_challenge) =
    (p_code_id, p_code_digest, p_client_id, p_redirect_uri, p_pkce_challenge);
  if not found then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  perform internal.assert_workspace_accepts_work(request_row.workspace_id);
  select * into client from public.factory_oauth_clients target where target.id = p_client_id for share;
  if not found or client.revoked_at is not null or not (p_redirect_uri = any(client.redirect_uris)) then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  select * into request_row from internal.factory_oauth_authorizations request
  where request.id = request_row.id for update;
  if not found or request_row.code_consumed_at is not null or request_row.code_expires_at <= clock_timestamp() then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  for binding in select * from public.factory_oauth_client_bindings pinned
    where pinned.client_id = client.id and pinned.factory_id = any(request_row.consented_factory_ids) order by pinned.factory_id
  loop
    expiry := least(expiry, internal.require_factory_oauth_binding(binding.workspace_id, binding.factory_id,
      binding.service_principal_id, binding.execution_grant_id, binding.execution_grant_version,
      request_row.consenting_member_id, request_row.scopes));
    granted_factories := granted_factories + 1;
  end loop;
  granted_at := clock_timestamp();
  if granted_factories = 0 or granted_factories <> cardinality(request_row.consented_factory_ids)
    or request_row.code_expires_at <= granted_at or expiry <= granted_at then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  insert into public.factory_oauth_grants (client_id, workspace_id, consenting_member_id, scopes, created_at, expires_at)
  values (client.id, client.workspace_id, request_row.consenting_member_id, request_row.scopes, granted_at, expiry)
  returning * into consent;
  insert into public.factory_oauth_grant_bindings (
    grant_id, workspace_id, factory_id, service_principal_id, execution_grant_id, execution_grant_version
  ) select consent.id, pinned.workspace_id, pinned.factory_id, pinned.service_principal_id, pinned.execution_grant_id,
    pinned.execution_grant_version from public.factory_oauth_client_bindings pinned
  where pinned.client_id = client.id and pinned.factory_id = any(request_row.consented_factory_ids);
  ttl := internal.issue_factory_oauth_token_pair(consent, consent.scopes,
    p_access_token_id, p_access_token_digest, p_refresh_token_id, p_refresh_token_digest);
  update internal.factory_oauth_authorizations request set code_consumed_at = granted_at where request.id = request_row.id;
  perform internal.audit_factory_oauth_grant(consent, 'oauth_grant.connected', consent.consenting_member_id);
  return query select 'issued'::text, ttl, consent.scopes;
exception when insufficient_privilege or sqlstate 'P0010' or sqlstate 'P0011' then
  return query select 'invalid_grant'::text, null::integer, null::public.factory_command_scope[];
end;
$$;

create function public.rotate_factory_oauth_refresh_token(
  p_client_id uuid, p_refresh_token_id uuid, p_refresh_token_digest text,
  p_next_access_token_id uuid, p_next_access_token_digest text,
  p_next_refresh_token_id uuid, p_next_refresh_token_digest text,
  p_requested_scopes public.factory_command_scope[] default null
) returns table(status text, expires_in integer, scopes public.factory_command_scope[])
language plpgsql security definer set search_path = '' as $$
declare
  consent public.factory_oauth_grants;
  client public.factory_oauth_clients;
  token internal.factory_oauth_token_pairs;
  binding public.factory_oauth_grant_bindings;
  desired public.factory_command_scope[];
  ttl integer;
begin
  -- A guessed refresh identifier or a mismatched client must never revoke a
  -- token family. Authenticate the presented old token before taking its lock.
  select grant_row.* into consent from public.factory_oauth_grants grant_row
  join internal.factory_oauth_token_pairs pair on pair.grant_id = grant_row.id
  where (grant_row.client_id, pair.refresh_token_id, pair.refresh_digest) =
    (p_client_id, p_refresh_token_id, p_refresh_token_digest);
  if not found then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  perform internal.assert_workspace_accepts_work(consent.workspace_id);
  select * into client from public.factory_oauth_clients target where target.id = p_client_id for share;
  if not found or client.revoked_at is not null then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  select * into consent from public.factory_oauth_grants target where target.id = consent.id for update;
  if not found or consent.revoked_at is not null or consent.expires_at <= clock_timestamp() then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  select * into token from internal.factory_oauth_token_pairs pair
  where (pair.grant_id, pair.refresh_token_id, pair.refresh_digest) = (consent.id, p_refresh_token_id, p_refresh_token_digest);
  if not found then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  if token.replaced_at is not null then
    perform internal.revoke_factory_oauth_grant(consent, 'refresh_reuse', null);
    -- A structured error commits the revocation and its audit history. Raising
    -- an exception here would roll both back and leave the stolen family live.
    return query select 'invalid_grant'::text, null::integer, null::public.factory_command_scope[];
    return;
  end if;
  if token.refresh_expires_at <= clock_timestamp() then raise exception 'Invalid OAuth grant.' using errcode = '42501'; end if;
  desired := coalesce(p_requested_scopes, consent.scopes);
  if not internal.valid_factory_oauth_scopes(desired) or not (desired <@ consent.scopes) then
    return query select 'invalid_scope'::text, null::integer, null::public.factory_command_scope[];
    return;
  end if;
  if not exists (select 1 from public.factory_oauth_grant_bindings where grant_id = consent.id) then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  for binding in select * from public.factory_oauth_grant_bindings pinned
    where pinned.grant_id = consent.id order by pinned.factory_id
  loop
    perform internal.require_factory_oauth_binding(binding.workspace_id, binding.factory_id, binding.service_principal_id,
      binding.execution_grant_id, binding.execution_grant_version, consent.consenting_member_id, consent.scopes);
  end loop;
  if token.refresh_expires_at <= clock_timestamp() or consent.expires_at <= clock_timestamp() then
    raise exception 'Invalid OAuth grant.' using errcode = '42501';
  end if;
  update internal.factory_oauth_token_pairs pair set replaced_at = clock_timestamp()
  where pair.refresh_token_id = token.refresh_token_id;
  ttl := internal.issue_factory_oauth_token_pair(consent, desired,
    p_next_access_token_id, p_next_access_token_digest, p_next_refresh_token_id, p_next_refresh_token_digest);
  return query select 'issued'::text, ttl, desired;
exception when insufficient_privilege or sqlstate 'P0010' or sqlstate 'P0011' then
  return query select 'invalid_grant'::text, null::integer, null::public.factory_command_scope[];
end;
$$;

-- A protected command must call this within its own transaction. Authorization
-- and the command then share locks through revocation, archive or membership change.
create function internal.require_factory_oauth_access_token(
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
  if not found or token.replaced_at is not null or token.access_expires_at <= clock_timestamp()
    or p_scope is null or not (p_scope = any(token.scopes)) then
    raise exception 'OAuth token is unavailable.' using errcode = '42501';
  end if;
  select * into binding from public.factory_oauth_grant_bindings pinned
  where (pinned.workspace_id, pinned.factory_id, pinned.grant_id) = (p_workspace_id, p_factory_id, consent.id);
  if not found then raise exception 'OAuth token is unavailable.' using errcode = '42501'; end if;
  perform internal.require_factory_oauth_binding(binding.workspace_id, binding.factory_id, binding.service_principal_id,
    binding.execution_grant_id, binding.execution_grant_version, consent.consenting_member_id, array[p_scope]);
  if token.access_expires_at <= clock_timestamp() or consent.expires_at <= clock_timestamp() then
    raise exception 'OAuth token is unavailable.' using errcode = '42501';
  end if;
  return binding;
end;
$$;

create function public.authorize_factory_oauth_access_token(
  p_workspace_id uuid, p_factory_id uuid, p_access_token_id uuid, p_access_token_digest text,
  p_scope public.factory_command_scope
) returns table(workspace_id uuid, factory_id uuid, service_principal_id uuid, execution_grant_id uuid,
  execution_grant_version bigint, oauth_grant_id uuid)
language sql security definer set search_path = '' as $$
  select binding.workspace_id, binding.factory_id, binding.service_principal_id, binding.execution_grant_id,
    binding.execution_grant_version, binding.grant_id
  from internal.require_factory_oauth_access_token(p_workspace_id, p_factory_id, p_access_token_id, p_access_token_digest, p_scope) binding;
$$;

revoke all on function
  internal.audit_factory_oauth_grant(public.factory_oauth_grants, text, uuid),
  internal.revoke_factory_oauth_grant(public.factory_oauth_grants, text, uuid),
  internal.issue_factory_oauth_token_pair(public.factory_oauth_grants, public.factory_command_scope[], uuid, text, uuid, text),
  internal.require_factory_oauth_access_token(uuid, uuid, uuid, text, public.factory_command_scope),
  public.register_factory_oauth_client(uuid, uuid, text, text[], public.factory_command_scope[], jsonb),
  public.begin_factory_oauth_authorization(uuid, uuid, uuid, text, text, public.factory_command_scope[], text),
  public.decide_factory_oauth_authorization(uuid, uuid, uuid, boolean, uuid[], uuid, text),
  public.revoke_factory_oauth_grant(uuid, uuid, uuid), public.revoke_factory_oauth_client(uuid, uuid, uuid),
  public.exchange_factory_oauth_code(uuid, text, uuid, text, text, uuid, text, uuid, text),
  public.rotate_factory_oauth_refresh_token(uuid, uuid, text, uuid, text, uuid, text, public.factory_command_scope[]),
  public.authorize_factory_oauth_access_token(uuid, uuid, uuid, text, public.factory_command_scope)
  from public, anon, authenticated, service_role;
grant execute on function
  public.register_factory_oauth_client(uuid, uuid, text, text[], public.factory_command_scope[], jsonb),
  public.begin_factory_oauth_authorization(uuid, uuid, uuid, text, text, public.factory_command_scope[], text),
  public.decide_factory_oauth_authorization(uuid, uuid, uuid, boolean, uuid[], uuid, text),
  public.revoke_factory_oauth_grant(uuid, uuid, uuid), public.revoke_factory_oauth_client(uuid, uuid, uuid),
  public.exchange_factory_oauth_code(uuid, text, uuid, text, text, uuid, text, uuid, text),
  public.rotate_factory_oauth_refresh_token(uuid, uuid, text, uuid, text, uuid, text, public.factory_command_scope[]),
  public.authorize_factory_oauth_access_token(uuid, uuid, uuid, text, public.factory_command_scope)
  to service_role;
