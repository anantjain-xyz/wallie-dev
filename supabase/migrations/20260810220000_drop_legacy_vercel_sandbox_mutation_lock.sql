-- Drop the legacy Vercel sandbox mutation-lock schema now that OP-412 has
-- retired the compatibility endpoint/RPC. Deploy application instances that no
-- longer call begin_vercel_sandbox_connection_mutation before applying this
-- migration so no old caller races the drop.
--
-- workspace_sandbox_connection_mutations is the sole sandbox-connection
-- mutation-lock mechanism after this migration.

create or replace function public.begin_codex_device_auth_flow(
  flow_id uuid,
  target_user_id uuid,
  target_workspace_id uuid,
  target_provider text,
  target_connection_revision uuid,
  target_expires_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  selected_provider text;
  current_revision uuid;
  current_status text;
begin
  if target_provider not in ('vercel', 'e2b', 'daytona') then return 'unsupported'; end if;

  perform pg_advisory_xact_lock(hashtextextended(target_workspace_id::text, 0));
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();

  if exists (
    select 1 from public.workspace_sandbox_connection_mutations
    where workspace_id = target_workspace_id
      and provider = target_provider
      and expires_at > now()
  ) then return 'locked'; end if;

  select active_provider into selected_provider
  from public.workspace_sandbox_settings
  where workspace_id = target_workspace_id;
  if coalesce(selected_provider, 'vercel') <> target_provider then return 'inactive'; end if;

  if target_provider = 'vercel' then
    select connection_revision, status into current_revision, current_status
    from public.workspace_vercel_sandbox_connections
    where workspace_id = target_workspace_id;
  elsif target_provider = 'e2b' then
    select connection_revision, status into current_revision, current_status
    from public.workspace_e2b_sandbox_connections
    where workspace_id = target_workspace_id;
  else
    select connection_revision, status into current_revision, current_status
    from public.workspace_daytona_sandbox_connections
    where workspace_id = target_workspace_id;
  end if;

  if current_revision is null then return 'missing'; end if;
  if current_status <> 'connected' then return 'invalid'; end if;
  if current_revision <> target_connection_revision then return 'stale'; end if;

  insert into public.codex_device_auth_flows (
    id,
    user_id,
    workspace_id,
    sandbox_provider,
    sandbox_connection_revision,
    sandbox_id,
    command_id,
    status,
    expires_at
  ) values (
    flow_id,
    target_user_id,
    target_workspace_id,
    target_provider,
    target_connection_revision,
    'provisioning:' || flow_id::text,
    'provisioning',
    'starting',
    target_expires_at
  );

  return 'started';
end;
$$;

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

  if exists (
    select 1 from public.workspace_sandbox_connection_mutations
    where workspace_id = target_workspace_id
      and provider = target_provider
      and expires_at > now()
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

  if exists (
    select 1 from public.workspace_sandbox_connection_mutations
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

  select active_provider into selected_provider
  from public.workspace_sandbox_settings where workspace_id = target_workspace_id;
  selected_provider := coalesce(selected_provider, 'vercel');

  if exists (
    select 1 from public.workspace_sandbox_connection_mutations
    where workspace_id = target_workspace_id
      and provider = selected_provider
      and expires_at > now()
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

revoke all on function public.begin_sandbox_connection_mutation(uuid, text)
  from public, anon, authenticated;
revoke all on function public.begin_codex_device_auth_flow(uuid, uuid, uuid, text, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.set_active_sandbox_provider(uuid, bigint, text, uuid)
  from public, anon, authenticated;
revoke all on function public.start_sandbox_capability_check(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_next_agent_job(integer)
  from public, anon, authenticated;
grant execute on function public.begin_sandbox_connection_mutation(uuid, text) to service_role;
grant execute on function public.begin_codex_device_auth_flow(uuid, uuid, uuid, text, uuid, timestamptz)
  to service_role;
grant execute on function public.set_active_sandbox_provider(uuid, bigint, text, uuid) to service_role;
grant execute on function public.start_sandbox_capability_check(uuid, uuid) to service_role;
grant execute on function public.claim_next_agent_job(integer) to service_role;

revoke all on function public.begin_vercel_sandbox_connection_mutation(uuid)
  from public, anon, authenticated, service_role;
drop function public.begin_vercel_sandbox_connection_mutation(uuid);

drop table if exists public.workspace_vercel_sandbox_connection_mutations;
