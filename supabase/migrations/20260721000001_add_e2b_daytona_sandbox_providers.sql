-- First-class workspace sandbox provider selection plus E2B and Daytona credentials.

create table public.workspace_sandbox_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  active_provider text not null default 'vercel',
  revision bigint not null default 1,
  updated_by_member_id uuid references public.workspace_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_sandbox_settings_provider_check
    check (active_provider in ('vercel', 'e2b', 'daytona')),
  constraint workspace_sandbox_settings_revision_check check (revision > 0)
);

create table public.workspace_e2b_sandbox_connections (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  encrypted_api_key text not null,
  api_key_preview text,
  status text not null default 'connected',
  connection_revision uuid not null default gen_random_uuid(),
  last_validated_at timestamptz,
  last_validation_error text,
  created_by_member_id uuid references public.workspace_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_e2b_sandbox_connections_status_check
    check (status in ('connected', 'error'))
);

create table public.workspace_daytona_sandbox_connections (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  encrypted_api_key text not null,
  api_key_preview text,
  api_url text not null default 'https://app.daytona.io/api',
  target text,
  status text not null default 'connected',
  connection_revision uuid not null default gen_random_uuid(),
  last_validated_at timestamptz,
  last_validation_error text,
  created_by_member_id uuid references public.workspace_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_daytona_sandbox_connections_status_check
    check (status in ('connected', 'error')),
  constraint workspace_daytona_sandbox_connections_api_url_check
    check (length(api_url) between 1 and 2048),
  constraint workspace_daytona_sandbox_connections_target_check
    check (target is null or length(target) between 1 and 128)
);

alter table public.workspace_vercel_sandbox_connections
  add column connection_revision uuid not null default gen_random_uuid();

alter table public.agent_runs
  drop constraint agent_runs_sandbox_provider_check,
  add column sandbox_connection_revision uuid,
  add constraint agent_runs_sandbox_provider_check
    check (sandbox_provider is null or sandbox_provider in ('vercel', 'e2b', 'daytona', 'fake'));

alter table public.sandbox_capability_checks
  drop constraint sandbox_capability_checks_sandbox_provider_check,
  drop constraint sandbox_capability_checks_vercel_sandbox_metadata_check,
  add column agent_provider text,
  add column agent_model text,
  add column sandbox_connection_revision uuid,
  add constraint sandbox_capability_checks_sandbox_provider_check
    check (sandbox_provider is null or sandbox_provider in ('vercel', 'e2b', 'daytona', 'fake')),
  add constraint sandbox_capability_checks_vercel_sandbox_metadata_check
    check (
      sandbox_provider is distinct from 'vercel'
      or (
        sandbox_id is not null
        and sandbox_vercel_team_id is not null
        and sandbox_vercel_project_id is not null
      )
      or (
        status = 'running'
        and sandbox_id is null
        and sandbox_vercel_team_id is null
        and sandbox_vercel_project_id is null
      )
    );

alter table public.codex_device_auth_flows
  add column workspace_id uuid references public.workspaces(id) on delete cascade,
  add column sandbox_provider text,
  add column sandbox_connection_revision uuid,
  add constraint codex_device_auth_flows_sandbox_provider_check
    check (sandbox_provider is null or sandbox_provider in ('vercel', 'e2b', 'daytona'));

insert into public.workspace_sandbox_settings (workspace_id, active_provider)
select id, 'vercel'
from public.workspaces
on conflict (workspace_id) do nothing;

update public.agent_runs as run
set sandbox_connection_revision = connection.connection_revision
from public.workspace_vercel_sandbox_connections as connection
where run.workspace_id = connection.workspace_id
  and run.sandbox_provider = 'vercel'
  and run.sandbox_vercel_team_id = connection.team_id
  and run.sandbox_vercel_project_id = connection.project_id
  and run.sandbox_connection_revision is null;

update public.sandbox_capability_checks as check_row
set sandbox_connection_revision = connection.connection_revision
from public.workspace_vercel_sandbox_connections as connection
where check_row.workspace_id = connection.workspace_id
  and check_row.sandbox_provider = 'vercel'
  and check_row.sandbox_vercel_team_id = connection.team_id
  and check_row.sandbox_vercel_project_id = connection.project_id
  and check_row.sandbox_connection_revision is null;

with current_agent_config as (
  select
    workspace.id as workspace_id,
    coalesce(
      (
        select config.value_json #>> '{}'
        from public.workspace_agent_config as config
        where config.workspace_id = workspace.id and config.key = 'agent_provider'
      ),
      'codex'
    ) as agent_provider,
    (
      select config.value_json #>> '{}'
      from public.workspace_agent_config as config
      where config.workspace_id = workspace.id and config.key = 'agent_model'
    ) as agent_model
  from public.workspaces as workspace
), resolved_agent_config as (
  select
    workspace_id,
    agent_provider,
    coalesce(
      agent_model,
      case
        when agent_provider = 'claude-code' then 'claude-opus-4-7[1m]'
        else 'gpt-5.5'
      end
    ) as agent_model
  from current_agent_config
)
update public.sandbox_capability_checks as check_row
set
  agent_provider = config.agent_provider,
  agent_model = config.agent_model
from resolved_agent_config as config
where check_row.workspace_id = config.workspace_id
  and (check_row.agent_provider is null or check_row.agent_model is null);

create index agent_runs_active_sandbox_connection_idx
  on public.agent_runs (workspace_id, sandbox_provider, sandbox_connection_revision, sandbox_id)
  where sandbox_id is not null and status in ('queued', 'started', 'running');

create index sandbox_capability_checks_connection_idx
  on public.sandbox_capability_checks (
    workspace_id,
    sandbox_provider,
    sandbox_connection_revision,
    sandbox_id
  )
  where sandbox_id is not null;

create index codex_device_auth_flows_workspace_active_idx
  on public.codex_device_auth_flows (workspace_id, sandbox_provider, expires_at)
  where workspace_id is not null and status in ('starting', 'prompted');

create table public.workspace_sandbox_connection_mutations (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  lock_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  primary key (workspace_id, provider),
  constraint workspace_sandbox_connection_mutations_provider_check
    check (provider in ('vercel', 'e2b', 'daytona'))
);

create or replace function internal.enforce_workspace_sandbox_connection_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.workspace_members',
    new.created_by_member_id,
    'created_by_member_id'
  );
  return new;
end;
$$;

create or replace function internal.enforce_workspace_sandbox_settings_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.workspace_members',
    new.updated_by_member_id,
    'updated_by_member_id'
  );
  return new;
end;
$$;

create or replace function internal.rotate_sandbox_connection_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.connection_revision := gen_random_uuid();
  return new;
end;
$$;

create or replace function internal.seed_workspace_sandbox_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workspace_sandbox_settings (workspace_id, active_provider)
  values (new.id, 'vercel')
  on conflict (workspace_id) do nothing;
  return new;
end;
$$;

create trigger workspace_sandbox_settings_touch_updated_at
before update on public.workspace_sandbox_settings
for each row execute function internal.touch_updated_at();

create trigger workspace_sandbox_settings_enforce_refs
before insert or update on public.workspace_sandbox_settings
for each row execute function internal.enforce_workspace_sandbox_settings_refs();

create trigger workspace_e2b_sandbox_connections_touch_updated_at
before update on public.workspace_e2b_sandbox_connections
for each row execute function internal.touch_updated_at();

create trigger workspace_e2b_sandbox_connections_rotate_revision
before update on public.workspace_e2b_sandbox_connections
for each row execute function internal.rotate_sandbox_connection_revision();

create trigger workspace_e2b_sandbox_connections_enforce_refs
before insert or update on public.workspace_e2b_sandbox_connections
for each row execute function internal.enforce_workspace_sandbox_connection_refs();

create trigger workspace_daytona_sandbox_connections_touch_updated_at
before update on public.workspace_daytona_sandbox_connections
for each row execute function internal.touch_updated_at();

create trigger workspace_daytona_sandbox_connections_rotate_revision
before update on public.workspace_daytona_sandbox_connections
for each row execute function internal.rotate_sandbox_connection_revision();

create trigger workspace_daytona_sandbox_connections_enforce_refs
before insert or update on public.workspace_daytona_sandbox_connections
for each row execute function internal.enforce_workspace_sandbox_connection_refs();

create trigger workspace_vercel_sandbox_connections_rotate_revision
before update on public.workspace_vercel_sandbox_connections
for each row execute function internal.rotate_sandbox_connection_revision();

create trigger workspaces_seed_sandbox_settings
after insert on public.workspaces
for each row execute function internal.seed_workspace_sandbox_settings();

create or replace function public.begin_sandbox_connection_mutation(
  target_workspace_id uuid,
  target_provider text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired_lock_id uuid := gen_random_uuid();
  selected_provider text;
begin
  if target_provider not in ('vercel', 'e2b', 'daytona') then
    raise exception 'Unsupported sandbox provider.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));

  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();
  delete from public.workspace_vercel_sandbox_connection_mutations where expires_at <= now();

  if exists (
    select 1 from public.workspace_sandbox_connection_mutations
    where workspace_id = target_workspace_id
      and provider = target_provider
      and expires_at > now()
  ) then
    return 'locked';
  end if;

  if target_provider = 'vercel' and exists (
    select 1 from public.workspace_vercel_sandbox_connection_mutations
    where workspace_id = target_workspace_id and expires_at > now()
  ) then
    return 'locked';
  end if;

  select active_provider into selected_provider
  from public.workspace_sandbox_settings
  where workspace_id = target_workspace_id;
  selected_provider := coalesce(selected_provider, 'vercel');

  if exists (
    select 1 from public.agent_runs
    where workspace_id = target_workspace_id
      and sandbox_provider = target_provider
      and status in ('queued', 'started', 'running')
  ) or exists (
    select 1 from public.sandbox_capability_checks
    where workspace_id = target_workspace_id
      and sandbox_provider = target_provider
      and status = 'running'
      and checked_at > now() - interval '1 hour'
  ) or (
    selected_provider = target_provider and exists (
      select 1 from public.agent_jobs
      where workspace_id = target_workspace_id
        and status in ('queued', 'started', 'running')
    )
  ) or exists (
    select 1 from public.codex_device_auth_flows
    where workspace_id = target_workspace_id
      and sandbox_provider = target_provider
      and status in ('starting', 'prompted')
      and expires_at > now()
  ) then
    return 'active';
  end if;

  insert into public.workspace_sandbox_connection_mutations (
    workspace_id, provider, lock_id, expires_at
  ) values (
    target_workspace_id, target_provider, acquired_lock_id, now() + interval '15 minutes'
  );

  return acquired_lock_id::text;
end;
$$;

-- Compatibility endpoint and the provider-neutral endpoint must share the
-- same exclusion boundary during the migration window.
create or replace function public.begin_vercel_sandbox_connection_mutation(
  target_workspace_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired_lock_id uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));
  delete from public.workspace_vercel_sandbox_connection_mutations where expires_at <= now();
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();

  if exists (
    select 1 from public.workspace_vercel_sandbox_connection_mutations
    where workspace_id = target_workspace_id and expires_at > now()
  ) or exists (
    select 1 from public.workspace_sandbox_connection_mutations
    where workspace_id = target_workspace_id and provider = 'vercel' and expires_at > now()
  ) then return 'locked'; end if;

  if exists (
    select 1 from public.agent_runs
    where workspace_id = target_workspace_id and status in ('queued', 'started', 'running')
  ) or exists (
    select 1 from public.agent_jobs
    where workspace_id = target_workspace_id and status in ('queued', 'started', 'running')
  ) or exists (
    select 1 from public.sandbox_capability_checks
    where workspace_id = target_workspace_id
      and status = 'running'
      and checked_at > now() - interval '1 hour'
  ) or exists (
    select 1 from public.codex_device_auth_flows
    where workspace_id = target_workspace_id
      and sandbox_provider = 'vercel'
      and status in ('starting', 'prompted')
      and expires_at > now()
  ) then return 'active'; end if;

  insert into public.workspace_vercel_sandbox_connection_mutations (
    workspace_id, lock_id, expires_at
  ) values (
    target_workspace_id, acquired_lock_id, now() + interval '15 minutes'
  );
  return acquired_lock_id::text;
end;
$$;

create or replace function public.set_active_sandbox_provider(
  target_workspace_id uuid,
  expected_revision bigint,
  target_provider text,
  actor_member_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection_status text;
begin
  if target_provider not in ('vercel', 'e2b', 'daytona') then return 'unsupported'; end if;

  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();
  delete from public.workspace_vercel_sandbox_connection_mutations where expires_at <= now();

  if exists (
    select 1 from public.workspace_sandbox_connection_mutations
    where workspace_id = target_workspace_id and expires_at > now()
  ) or exists (
    select 1 from public.workspace_vercel_sandbox_connection_mutations
    where workspace_id = target_workspace_id and expires_at > now()
  ) then return 'locked'; end if;

  if exists (
    select 1 from public.agent_runs
    where workspace_id = target_workspace_id and status in ('queued', 'started', 'running')
  ) or exists (
    select 1 from public.agent_jobs
    where workspace_id = target_workspace_id and status in ('queued', 'started', 'running')
  ) or exists (
    select 1 from public.sandbox_capability_checks
    where workspace_id = target_workspace_id
      and status = 'running'
      and checked_at > now() - interval '1 hour'
  ) or exists (
    select 1 from public.codex_device_auth_flows
    where workspace_id = target_workspace_id
      and status in ('starting', 'prompted')
      and expires_at > now()
  ) then return 'active'; end if;

  if target_provider = 'vercel' then
    select status into connection_status from public.workspace_vercel_sandbox_connections
    where workspace_id = target_workspace_id;
  elsif target_provider = 'e2b' then
    select status into connection_status from public.workspace_e2b_sandbox_connections
    where workspace_id = target_workspace_id;
  else
    select status into connection_status from public.workspace_daytona_sandbox_connections
    where workspace_id = target_workspace_id;
  end if;

  if connection_status is null then return 'missing'; end if;
  if connection_status <> 'connected' then return 'invalid'; end if;

  update public.workspace_sandbox_settings
  set active_provider = target_provider,
      revision = revision + 1,
      updated_by_member_id = actor_member_id
  where workspace_id = target_workspace_id and revision = expected_revision;

  if not found then return 'stale'; end if;
  return 'updated';
end;
$$;

create or replace function public.start_sandbox_capability_check(
  target_workspace_id uuid,
  target_github_repository_id uuid
)
returns public.sandbox_capability_checks
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted public.sandbox_capability_checks%rowtype;
  selected_provider text;
  selected_revision uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();
  delete from public.workspace_vercel_sandbox_connection_mutations where expires_at <= now();

  select active_provider into selected_provider
  from public.workspace_sandbox_settings where workspace_id = target_workspace_id;
  selected_provider := coalesce(selected_provider, 'vercel');

  if exists (
    select 1 from public.workspace_sandbox_connection_mutations
    where workspace_id = target_workspace_id
      and provider = selected_provider
      and expires_at > now()
  ) or exists (
    select 1 from public.workspace_vercel_sandbox_connection_mutations
    where workspace_id = target_workspace_id and expires_at > now()
  ) then
    raise exception 'Sandbox connection update is in progress. Try again shortly.';
  end if;

  if selected_provider = 'vercel' then
    select connection_revision into selected_revision
    from public.workspace_vercel_sandbox_connections where workspace_id = target_workspace_id;
  elsif selected_provider = 'e2b' then
    select connection_revision into selected_revision
    from public.workspace_e2b_sandbox_connections where workspace_id = target_workspace_id;
  else
    select connection_revision into selected_revision
    from public.workspace_daytona_sandbox_connections where workspace_id = target_workspace_id;
  end if;

  insert into public.sandbox_capability_checks (
    workspace_id, github_repository_id, status, capabilities,
    sandbox_provider, sandbox_connection_revision
  ) values (
    target_workspace_id, target_github_repository_id, 'running', '{}'::jsonb,
    selected_provider, selected_revision
  ) returning * into inserted;

  return inserted;
end;
$$;

create or replace function public.claim_next_agent_job(
  default_concurrency_limit int default 2
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.agent_jobs%rowtype;
  configured_limit int;
  effective_limit int;
  running_count int;
  selected_provider text;
begin
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();
  delete from public.workspace_vercel_sandbox_connection_mutations where expires_at <= now();

  for candidate in
    select * from public.agent_jobs
    where status = 'queued' and (scheduled_at is null or scheduled_at <= now())
    order by created_at asc for update skip locked
  loop
    perform pg_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0));

    select active_provider into selected_provider
    from public.workspace_sandbox_settings where workspace_id = candidate.workspace_id;
    selected_provider := coalesce(selected_provider, 'vercel');

    if exists (
      select 1 from public.workspace_sandbox_connection_mutations
      where workspace_id = candidate.workspace_id
        and provider = selected_provider
        and expires_at > now()
    ) or exists (
      select 1 from public.workspace_vercel_sandbox_connection_mutations
      where workspace_id = candidate.workspace_id and expires_at > now()
    ) then continue; end if;

    configured_limit := null;
    select (value_json)::int into configured_limit
    from public.workspace_agent_config
    where workspace_id = candidate.workspace_id
      and key = 'concurrency_limit'
      and jsonb_typeof(value_json) = 'number';

    effective_limit := coalesce(configured_limit, default_concurrency_limit);
    select count(*) into running_count from public.agent_jobs
    where workspace_id = candidate.workspace_id and status = 'running';
    if running_count >= effective_limit then continue; end if;

    return query
    update public.agent_jobs
    set status = 'running', attempt_count = attempt_count + 1, last_error = null,
        started_at = coalesce(started_at, now()), scheduled_at = null
    where id = candidate.id and status = 'queued'
    returning *;
    return;
  end loop;
  return;
end;
$$;

alter table public.workspace_sandbox_settings enable row level security;
alter table public.workspace_e2b_sandbox_connections enable row level security;
alter table public.workspace_daytona_sandbox_connections enable row level security;
alter table public.workspace_sandbox_connection_mutations enable row level security;

revoke all on public.workspace_sandbox_settings from anon, authenticated;
revoke all on public.workspace_e2b_sandbox_connections from anon, authenticated;
revoke all on public.workspace_daytona_sandbox_connections from anon, authenticated;
revoke all on public.workspace_sandbox_connection_mutations from anon, authenticated;
grant all on public.workspace_sandbox_settings to service_role;
grant all on public.workspace_e2b_sandbox_connections to service_role;
grant all on public.workspace_daytona_sandbox_connections to service_role;
grant all on public.workspace_sandbox_connection_mutations to service_role;

grant select (workspace_id, active_provider, revision, updated_by_member_id, created_at, updated_at)
  on public.workspace_sandbox_settings to authenticated;
grant select (
  workspace_id, api_key_preview, status, connection_revision, last_validated_at,
  last_validation_error, created_by_member_id, created_at, updated_at
) on public.workspace_e2b_sandbox_connections to authenticated;
grant select (
  workspace_id, api_key_preview, api_url, target, status, connection_revision,
  last_validated_at, last_validation_error, created_by_member_id, created_at, updated_at
) on public.workspace_daytona_sandbox_connections to authenticated;
grant select (connection_revision)
  on public.workspace_vercel_sandbox_connections to authenticated;

create policy workspace_sandbox_settings_select_membership
  on public.workspace_sandbox_settings for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));
create policy workspace_sandbox_settings_service_only
  on public.workspace_sandbox_settings for all to authenticated using (false) with check (false);
create policy workspace_e2b_sandbox_connections_select_membership
  on public.workspace_e2b_sandbox_connections for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));
create policy workspace_e2b_sandbox_connections_service_only
  on public.workspace_e2b_sandbox_connections for all to authenticated using (false) with check (false);
create policy workspace_daytona_sandbox_connections_select_membership
  on public.workspace_daytona_sandbox_connections for select to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));
create policy workspace_daytona_sandbox_connections_service_only
  on public.workspace_daytona_sandbox_connections for all to authenticated using (false) with check (false);
create policy workspace_sandbox_connection_mutations_service_only
  on public.workspace_sandbox_connection_mutations for all to authenticated
  using (false) with check (false);

-- Keep onboarding readiness keyed to the exact provider connection that was
-- tested, so rotating credentials or switching providers makes the old result
-- stale instead of silently reusing it.
create or replace function public.load_workspace_onboarding_sandbox_checks(
  target_workspace_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'agent_model', latest.agent_model,
        'agent_provider', latest.agent_provider,
        'capabilities', latest.capabilities,
        'checked_at', latest.checked_at,
        'error_text', latest.error_text,
        'github_repository_id', latest.github_repository_id,
        'id', latest.id,
        'sandbox_connection_revision', latest.sandbox_connection_revision,
        'sandbox_provider', latest.sandbox_provider,
        'sandbox_vercel_project_id', latest.sandbox_vercel_project_id,
        'sandbox_vercel_team_id', latest.sandbox_vercel_team_id,
        'status', latest.status
      )
      order by latest.checked_at desc, latest.id desc
    ),
    '[]'::jsonb
  )
  from (
    select distinct on (check_row.github_repository_id)
      check_row.agent_model,
      check_row.agent_provider,
      check_row.capabilities,
      check_row.checked_at,
      check_row.error_text,
      check_row.github_repository_id,
      check_row.id,
      check_row.sandbox_connection_revision,
      check_row.sandbox_provider,
      check_row.sandbox_vercel_project_id,
      check_row.sandbox_vercel_team_id,
      check_row.status
    from public.sandbox_capability_checks check_row
    where check_row.workspace_id = target_workspace_id
    order by
      check_row.github_repository_id,
      check_row.checked_at desc,
      check_row.id desc
  ) latest;
$$;

revoke all on function public.begin_sandbox_connection_mutation(uuid, text)
  from public, anon, authenticated;
revoke all on function public.set_active_sandbox_provider(uuid, bigint, text, uuid)
  from public, anon, authenticated;
revoke all on function public.start_sandbox_capability_check(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.load_workspace_onboarding_sandbox_checks(uuid)
  from public, anon, authenticated;
revoke all on function public.claim_next_agent_job(integer)
  from public, anon, authenticated;
grant execute on function public.begin_sandbox_connection_mutation(uuid, text) to service_role;
grant execute on function public.set_active_sandbox_provider(uuid, bigint, text, uuid) to service_role;
grant execute on function public.start_sandbox_capability_check(uuid, uuid) to service_role;
grant execute on function public.load_workspace_onboarding_sandbox_checks(uuid) to service_role;
grant execute on function public.claim_next_agent_job(integer) to service_role;
