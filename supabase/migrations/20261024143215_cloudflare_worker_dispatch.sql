-- The database owns claims; Cloudflare only delivers their captured identities.
create table public.worker_dispatches (
  job_id uuid not null references public.agent_jobs(id) on delete cascade,
  attempt_count integer not null check (attempt_count > 0),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  workflow_id text not null unique,
  deadline_at timestamptz not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  execution_started_at timestamptz,
  primary key (job_id, attempt_count)
);
alter table public.worker_dispatches enable row level security;
create index worker_dispatches_workspace_idx on public.worker_dispatches(workspace_id);
create index worker_dispatches_pending_idx on public.worker_dispatches(created_at) where dispatched_at is null;
revoke all on public.worker_dispatches from public, anon, authenticated;
grant select, update, delete on public.worker_dispatches to service_role;

create table public.worker_auth_dispatches (
  flow_id uuid not null references public.cursor_auth_flows(id) on delete cascade,
  claim_token text not null,
  workflow_id text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  execution_started_at timestamptz,
  primary key (flow_id, claim_token)
);
-- Auth flows can precede workspace creation; they are private service data.
alter table public.worker_auth_dispatches enable row level security;
create index worker_auth_dispatches_pending_idx on public.worker_auth_dispatches(created_at) where dispatched_at is null;
revoke all on public.worker_auth_dispatches from public, anon, authenticated;
grant select, update, delete on public.worker_auth_dispatches to service_role;

create function public.claim_next_worker_dispatch(
  p_max_concurrent integer default 10,
  p_default_workspace_limit integer default 2,
  p_timeout_ms integer default 1800000
) returns setof public.worker_dispatches
language plpgsql security definer set search_path = '' as $$
declare claimed public.agent_jobs%rowtype;
begin
  if p_max_concurrent is null or p_default_workspace_limit is null or p_timeout_ms is null
    or p_max_concurrent < 1 or p_default_workspace_limit < 1
    or p_timeout_ms < 1 or p_timeout_ms > 1800000 then
    raise exception 'Invalid worker dispatch limits';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallie/cloudflare/dispatch', 0));
  if (select count(*) from public.agent_jobs where status in ('started', 'running')) >= p_max_concurrent then
    return;
  end if;
  select * into claimed from public.claim_next_agent_job(p_default_workspace_limit);
  if claimed.id is null then return; end if;
  return query insert into public.worker_dispatches(job_id, attempt_count, workspace_id, workflow_id, deadline_at)
  values (claimed.id, claimed.attempt_count, claimed.workspace_id,
    'job-' || claimed.id::text || '-' || claimed.attempt_count::text,
    now() + p_timeout_ms * interval '1 millisecond') returning *;
end;
$$;

create function public.begin_worker_dispatch(p_job_id uuid, p_attempt_count integer, p_workflow_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare acquired boolean;
begin
  -- Serialize with cancellation, publication, and attempt replacement.
  perform 1 from public.agent_jobs where id = p_job_id and attempt_count = p_attempt_count
    and status = 'running' for update;
  if not found then return false; end if;
  update public.worker_dispatches set execution_started_at = now()
  where job_id = p_job_id and attempt_count = p_attempt_count
    and workflow_id = p_workflow_id and execution_started_at is null and deadline_at > now()
  returning true into acquired;
  return coalesce(acquired, false);
end;
$$;

create function public.claim_next_worker_auth_dispatch()
returns setof public.worker_auth_dispatches
language plpgsql security definer set search_path = '' as $$
declare flow public.cursor_auth_flows%rowtype; token text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallie/cloudflare/cursor-auth', 0));
  update public.cursor_auth_flows set status = 'expired'
    where status in ('starting', 'processing', 'prompted') and expires_at <= now();
  update public.cursor_auth_flows set status = 'starting', claimed_by = null, claimed_at = null,
    login_url = null, error_message = null
    where status in ('processing', 'prompted') and claimed_at < now() - interval '15 seconds'
      and expires_at > now();
  if (select count(*) from public.cursor_auth_flows where status in ('processing', 'prompted')) >= 4 then
    return;
  end if;
  select * into flow from public.cursor_auth_flows where status = 'starting' and expires_at > now()
    order by created_at limit 1 for update skip locked;
  if flow.id is null then return; end if;
  token := gen_random_uuid()::text;
  update public.cursor_auth_flows set status = 'processing', claimed_by = token, claimed_at = now()
    where id = flow.id;
  return query insert into public.worker_auth_dispatches(flow_id, claim_token, workflow_id, expires_at)
    values (flow.id, token, 'cursor-' || flow.id::text || '-' || token, flow.expires_at) returning *;
end;
$$;

revoke all on function public.claim_next_worker_dispatch(integer, integer, integer) from public, anon, authenticated;
revoke all on function public.begin_worker_dispatch(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.claim_next_worker_auth_dispatch() from public, anon, authenticated;
grant execute on function public.claim_next_worker_dispatch(integer, integer, integer) to service_role;
grant execute on function public.begin_worker_dispatch(uuid, integer, text) to service_role;
grant execute on function public.claim_next_worker_auth_dispatch() to service_role;
