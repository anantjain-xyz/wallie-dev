-- Phase 0: Foundation cleanup for Symphony convergence.
--
-- 0.1  Add agent_jobs.session_id FK so the pipeline processor can locate
--      sessions directly instead of going through the anchor-issue shim.
--      Make issue_id nullable — pipeline jobs will use session_id from now on.
--
-- 0.3  Create workspace_agent_config table for per-workspace tunables
--      (concurrency_limit, stall_timeout_ms, max_retries, agent_provider,
--      agent_model).
--
-- Together these migrations unblock the new worker architecture and let the
-- settings UI expose agent tunables.

-- -----------------------------------------------------------------------
-- 0.1 — agent_jobs.session_id + issue_id nullable
-- -----------------------------------------------------------------------

-- Add session_id column (nullable, FK to sessions).
alter table public.agent_jobs
  add column session_id uuid references public.sessions(id) on delete cascade;

-- Make issue_id nullable so future pipeline jobs can be session-only.
alter table public.agent_jobs
  alter column issue_id drop not null;

-- Backfill session_id from the sessions table via the shared issue_id FK.
update public.agent_jobs aj
set session_id = s.id
from public.sessions s
where aj.session_id is null
  and aj.issue_id is not null
  and s.issue_id = aj.issue_id;

-- Index for looking up jobs by session.
create index agent_jobs_session_id_idx
  on public.agent_jobs (session_id)
  where session_id is not null;

-- Update the enforcement trigger to allow null issue_id when session_id is set.
create or replace function internal.enforce_agent_job_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- At least one of issue_id or session_id must be set.
  if new.issue_id is null and new.session_id is null then
    raise exception 'agent_jobs requires either issue_id or session_id'
      using errcode = '23514';
  end if;

  if new.issue_id is not null then
    perform internal.assert_workspace_match(
      new.workspace_id, 'public.issues', new.issue_id, 'issue_id'
    );
  end if;

  if new.session_id is not null then
    perform internal.assert_workspace_match(
      new.workspace_id, 'public.sessions', new.session_id, 'session_id'
    );
  end if;

  perform internal.assert_workspace_match(
    new.workspace_id, 'public.workspace_members',
    new.requested_by_member_id, 'requested_by_member_id'
  );

  return new;
end;
$$;

-- -----------------------------------------------------------------------
-- 0.3 — workspace_agent_config
-- -----------------------------------------------------------------------

create table public.workspace_agent_config (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  value_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_agent_config_workspace_key_unique unique (workspace_id, key)
);

create trigger workspace_agent_config_touch_updated_at
before update on public.workspace_agent_config
for each row
execute function internal.touch_updated_at();

alter table public.workspace_agent_config enable row level security;

-- Authenticated members can read their workspace's config.
create policy "workspace_agent_config_select"
  on public.workspace_agent_config
  for select
  using (workspace_id in (select public.current_user_workspace_ids()));

-- Only managers (owner/admin) can write config.
create policy "workspace_agent_config_insert"
  on public.workspace_agent_config
  for insert
  with check (public.can_manage_workspace(workspace_id));

create policy "workspace_agent_config_update"
  on public.workspace_agent_config
  for update
  using (public.can_manage_workspace(workspace_id));

create policy "workspace_agent_config_delete"
  on public.workspace_agent_config
  for delete
  using (public.can_manage_workspace(workspace_id));

-- Grant table access.
grant select on public.workspace_agent_config to authenticated;
grant insert (workspace_id, key, value_json) on public.workspace_agent_config to authenticated;
grant update (key, value_json) on public.workspace_agent_config to authenticated;
grant delete on public.workspace_agent_config to authenticated;
