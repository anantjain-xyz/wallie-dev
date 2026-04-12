-- Sessions: foundations for the session-oriented refactor.
--
-- This migration is additive. It introduces a new `sessions` table (the
-- merged successor of `issues` + `pipeline_issues`), its artifact / phase
-- completion / pull-request child tables, the generalized 6-phase enum,
-- the `approve_session_phase` RPC, RLS policies, workspace-consistency
-- triggers, and the realtime publication entry.
--
-- At this stage nothing reads from `sessions`. The Slack handler dual-writes
-- so the table populates in shadow; PR 2 flips the read path, PR 4 drops the
-- legacy `issues` / `pipeline_issues` surface.

create type public.session_phase as enum (
  'product',
  'design',
  'engineering',
  'review',
  'land',
  'monitor'
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  number integer not null,
  title text not null,
  prompt_md text not null default '',
  creator_member_id uuid references public.workspace_members(id) on delete set null,
  linear_issue_id text,
  linear_issue_url text,
  slack_channel_id text,
  slack_thread_ts text,
  phase public.session_phase not null default 'product',
  phase_status public.pipeline_phase_status not null default 'agent_generating',
  rejection_count integer not null default 0,
  current_artifact_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint sessions_workspace_number_unique unique (workspace_id, number),
  constraint sessions_number_positive_check check (number > 0),
  constraint sessions_rejection_count_nonnegative_check
    check (rejection_count >= 0),
  constraint sessions_artifact_version_nonnegative_check
    check (current_artifact_version >= 0)
);

create table public.session_artifacts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  phase public.session_phase not null,
  version integer not null,
  artifact_json jsonb not null,
  feedback_text text,
  created_at timestamptz not null default now(),
  constraint session_artifacts_version_positive_check
    check (version > 0),
  constraint session_artifacts_unique_version
    unique (session_id, phase, version)
);

create table public.session_phase_completions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  phase public.session_phase not null,
  completed_at timestamptz not null default now(),
  completed_by_member_id uuid references public.workspace_members(id) on delete set null,
  constraint session_phase_completions_unique_phase
    unique (session_id, phase)
);

create table public.session_pull_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  github_repository_id uuid references public.github_repositories(id) on delete set null,
  branch_name text not null,
  pull_request_number integer,
  pull_request_url text,
  pull_request_state text,
  is_draft boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_pull_requests_workspace_branch_unique
    unique (workspace_id, branch_name)
);

create index sessions_workspace_number_desc_idx
  on public.sessions (workspace_id, number desc);

create index sessions_workspace_phase_idx
  on public.sessions (workspace_id, phase);

create index sessions_workspace_archived_idx
  on public.sessions (workspace_id, archived_at);

-- Mirror the partial-unique dedupe pipeline_issues has today: one session per
-- (workspace, linear_issue_id) whenever a Linear link is present.
create unique index sessions_workspace_linear_issue_idx
  on public.sessions (workspace_id, linear_issue_id)
  where linear_issue_id is not null;

-- Slack channel IDs are tenant-scoped, so two workspaces can legitimately
-- share the same (channel, thread) pair. Scope uniqueness by workspace.
create unique index sessions_workspace_slack_thread_idx
  on public.sessions (workspace_id, slack_channel_id, slack_thread_ts)
  where slack_channel_id is not null and slack_thread_ts is not null;

create index session_artifacts_session_id_idx
  on public.session_artifacts (session_id);

create index session_phase_completions_session_id_idx
  on public.session_phase_completions (session_id);

create index session_pull_requests_session_created_at_idx
  on public.session_pull_requests (session_id, created_at);

create trigger sessions_touch_updated_at
before update on public.sessions
for each row
execute function internal.touch_updated_at();

create trigger session_pull_requests_touch_updated_at
before update on public.session_pull_requests
for each row
execute function internal.touch_updated_at();

-- Workspace-consistency enforcement. Mirrors the `enforce_pipeline_issue_refs`
-- pattern so service-role bugs cannot cross-link sessions to foreign-workspace
-- members or repositories without DB rejection.
create or replace function internal.enforce_session_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.creator_member_id, 'creator_member_id');
  return new;
end;
$$;

create trigger sessions_enforce_refs
before insert or update on public.sessions
for each row
execute function internal.enforce_session_refs();

create or replace function internal.enforce_session_artifact_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.sessions', new.session_id, 'session_id');
  return new;
end;
$$;

create trigger session_artifacts_enforce_refs
before insert or update on public.session_artifacts
for each row
execute function internal.enforce_session_artifact_refs();

create or replace function internal.enforce_session_phase_completion_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.sessions', new.session_id, 'session_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.completed_by_member_id, 'completed_by_member_id');
  return new;
end;
$$;

create trigger session_phase_completions_enforce_refs
before insert or update on public.session_phase_completions
for each row
execute function internal.enforce_session_phase_completion_refs();

create or replace function internal.enforce_session_pull_request_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.sessions', new.session_id, 'session_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.github_repositories', new.github_repository_id, 'github_repository_id');
  return new;
end;
$$;

create trigger session_pull_requests_enforce_refs
before insert or update on public.session_pull_requests
for each row
execute function internal.enforce_session_pull_request_refs();

-- Generalized phase-approval RPC. The function owns PHASE_ORDER as a local
-- constant so adding a phase later is a one-line change here plus a matching
-- update to the TypeScript mirror. Collapses the three sequential writes the
-- legacy approve_pipeline_phase did (CAS, timestamp, advance) into a single
-- transactional step, and replaces the per-phase *_approved_at columns with a
-- row in session_phase_completions.
create or replace function public.approve_session_phase(
  target_session_id uuid,
  expected_workspace_id uuid,
  expected_version integer,
  approver_member_id uuid default null
)
returns table (
  id uuid,
  phase public.session_phase,
  phase_status public.pipeline_phase_status,
  workspace_id uuid,
  slack_channel_id text,
  slack_thread_ts text,
  linear_issue_url text,
  archived_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  phase_order public.session_phase[] := array[
    'product'::public.session_phase,
    'design'::public.session_phase,
    'engineering'::public.session_phase,
    'review'::public.session_phase,
    'land'::public.session_phase,
    'monitor'::public.session_phase
  ];
  current_phase public.session_phase;
  current_phase_idx integer;
  next_phase public.session_phase;
  approved_at_now timestamptz := now();
begin
  -- CAS guard: only proceed if the row is in awaiting_review at the expected
  -- version AND belongs to the expected workspace.
  update public.sessions s
  set phase_status = 'approved'
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review'
  returning s.phase into current_phase;

  if current_phase is null then
    return;
  end if;

  -- Record the completion. A repeat approval for the same (session, phase)
  -- is a no-op rather than an error — this matches the idempotent shape the
  -- Slack interaction handler relies on when retrying.
  insert into public.session_phase_completions (
    session_id,
    workspace_id,
    phase,
    completed_at,
    completed_by_member_id
  )
  values (
    target_session_id,
    expected_workspace_id,
    current_phase,
    approved_at_now,
    approver_member_id
  )
  on conflict (session_id, phase) do nothing;

  current_phase_idx := array_position(phase_order, current_phase);

  if current_phase_idx is null then
    -- Unknown phase. The CAS already moved phase_status to approved; leave it.
    return query
      select
        s.id,
        s.phase,
        s.phase_status,
        s.workspace_id,
        s.slack_channel_id,
        s.slack_thread_ts,
        s.linear_issue_url,
        s.archived_at
      from public.sessions s
      where s.id = target_session_id;
    return;
  end if;

  if current_phase_idx >= array_length(phase_order, 1) then
    -- Terminal phase (monitor). Archive the session.
    update public.sessions
    set archived_at = approved_at_now
    where id = target_session_id;
  else
    next_phase := phase_order[current_phase_idx + 1];
    update public.sessions
    set phase = next_phase,
        phase_status = 'agent_generating',
        current_artifact_version = 0,
        rejection_count = 0
    where id = target_session_id;
  end if;

  return query
    select
      s.id,
      s.phase,
      s.phase_status,
      s.workspace_id,
      s.slack_channel_id,
      s.slack_thread_ts,
      s.linear_issue_url,
      s.archived_at
    from public.sessions s
    where s.id = target_session_id;
end;
$$;

revoke all on function public.approve_session_phase(uuid, uuid, integer, uuid) from public;
grant execute on function public.approve_session_phase(uuid, uuid, integer, uuid) to service_role;

-- RLS. Select-only for authenticated workspace members; writes are
-- service-role only. Mirrors the pipeline_issues policy family.
alter table public.sessions enable row level security;
alter table public.session_artifacts enable row level security;
alter table public.session_phase_completions enable row level security;
alter table public.session_pull_requests enable row level security;

revoke all on public.sessions from anon, authenticated;
revoke all on public.session_artifacts from anon, authenticated;
revoke all on public.session_phase_completions from anon, authenticated;
revoke all on public.session_pull_requests from anon, authenticated;

grant select on public.sessions to authenticated;
grant select on public.session_artifacts to authenticated;
grant select on public.session_phase_completions to authenticated;
grant select on public.session_pull_requests to authenticated;

create policy sessions_select_membership
  on public.sessions
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy session_artifacts_select_membership
  on public.session_artifacts
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy session_phase_completions_select_membership
  on public.session_phase_completions
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy session_pull_requests_select_membership
  on public.session_pull_requests
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

-- Add `sessions` to the realtime publication so the future UI can subscribe.
-- pipeline_issues stays on the publication until PR 4 drops it.
do $$
declare
  publication_name text := 'supabase_realtime';
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = publication_name
      and schemaname = 'public'
      and tablename = 'sessions'
  ) then
    execute format('alter publication %I add table only public.sessions', publication_name);
  end if;
end
$$;
