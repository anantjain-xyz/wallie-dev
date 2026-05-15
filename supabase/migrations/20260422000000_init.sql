-- Wallie initial schema.
--
-- Single authoritative migration. No backwards-compatibility shims, no drops
-- of objects that are never created, no data backfills. Consolidated from the
-- previous 17-file migration history now that the project has no production
-- data to preserve.

-- ---------------------------------------------------------------------------
-- Schemas & extensions
-- ---------------------------------------------------------------------------

create schema if not exists extensions;
create schema if not exists internal;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

revoke all on schema internal from public;
revoke all on schema internal from anon;
revoke all on schema internal from authenticated;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type public.member_role as enum ('owner', 'admin', 'member', 'agent');
create type public.member_kind as enum ('human', 'system');

create type public.agent_run_status as enum (
  'queued',
  'started',
  'running',
  'success',
  'error',
  'canceled'
);

create type public.agent_job_status as enum (
  'queued',
  'running',
  'success',
  'error',
  'canceled'
);

create type public.agent_trigger_type as enum (
  'manual_run',
  'manual_retry',
  'assignment',
  'comment_retry'
);

create type public.pipeline_phase_status as enum (
  'agent_generating',
  'awaiting_review',
  'approved',
  'rejected'
);

-- Pipelines and pipeline_stages replace the old hardcoded session_phase enum.
-- Each workspace owns a default pipeline; users can edit stages, prompts, and
-- per-stage approver lists in the UI. Sessions pin to a pipeline_id and
-- advance through pipeline_stages by `position`.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  primary_email text,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  avatar_path text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_slug_format_check
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  kind public.member_kind not null,
  role public.member_role not null,
  email text,
  username text,
  full_name text,
  avatar_url text,
  preferences jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_members_identity_shape_check
    check (
      (kind = 'human' and user_id is not null)
      or (kind = 'system' and user_id is null and role = 'agent')
    )
);

create table public.github_installations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  installation_id bigint not null unique,
  installation_url text not null,
  app_id bigint not null,
  target_type text not null,
  target_name text not null,
  permissions jsonb not null,
  suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.github_repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  github_installation_id uuid not null references public.github_installations(id) on delete cascade,
  repo_id bigint not null,
  name text not null,
  full_name text not null,
  private boolean not null,
  html_url text not null,
  description text,
  default_programming_language text,
  default_branch text,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint github_repositories_installation_repo_unique unique (github_installation_id, repo_id)
);

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null default 'Default',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.pipelines(id) on delete cascade,
  -- Denormalized for RLS / workspace-consistency triggers; kept in sync by
  -- enforce_pipeline_stage_refs which copies pipelines.workspace_id.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  position integer not null,
  slug text not null,
  name text not null,
  description text not null default '',
  prompt_template_md text not null default '',
  -- Empty array means "any owner/admin can approve" (fallback).
  approver_member_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_stages_position_positive check (position > 0),
  constraint pipeline_stages_slug_format
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint pipeline_stages_pipeline_slug_unique unique (pipeline_id, slug),
  constraint pipeline_stages_pipeline_position_unique unique (pipeline_id, position)
);

create table public.workspace_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  encrypted_value text not null,
  value_preview text,
  created_by_member_id uuid references public.workspace_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_secrets_workspace_key_unique unique (workspace_id, key)
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
  -- Pinned at create time. Edits to the pipeline don't retroactively change a
  -- session's shape: stage_slug snapshots on artifacts/completions preserve
  -- history if a stage is renamed or removed.
  pipeline_id uuid not null references public.pipelines(id) on delete restrict,
  current_stage_id uuid not null references public.pipeline_stages(id) on delete restrict,
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

create table public.github_issue_branches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  github_repository_id uuid references public.github_repositories(id) on delete set null,
  branch_name text not null,
  pull_request_number integer,
  pull_request_url text,
  pull_request_state text,
  is_draft boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint github_issue_branches_workspace_branch_unique unique (workspace_id, branch_name)
);

create table public.session_artifacts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- stage_id may be null after a stage is deleted — stage_slug snapshot keeps
  -- the history readable. Inserts always set both.
  stage_id uuid references public.pipeline_stages(id) on delete set null,
  stage_slug text not null,
  version integer not null,
  artifact_json jsonb not null,
  feedback_text text,
  created_at timestamptz not null default now(),
  constraint session_artifacts_version_positive_check
    check (version > 0),
  constraint session_artifacts_unique_version
    unique (session_id, stage_slug, version)
);

create table public.session_phase_completions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  stage_id uuid references public.pipeline_stages(id) on delete set null,
  stage_slug text not null,
  completed_at timestamptz not null default now(),
  completed_by_member_id uuid references public.workspace_members(id) on delete set null,
  constraint session_phase_completions_unique_stage
    unique (session_id, stage_slug)
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
    unique (workspace_id, branch_name),
  constraint session_pull_requests_session_branch_key
    unique (session_id, branch_name)
);

create table public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  requested_by_member_id uuid references public.workspace_members(id) on delete set null,
  trigger_type public.agent_trigger_type not null,
  status public.agent_job_status not null default 'queued',
  job_type text not null default 'session',
  attempt_count integer not null default 0,
  last_error text,
  dedupe_key text,
  scheduled_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_jobs_attempt_count_nonnegative_check check (attempt_count >= 0)
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  agent_job_id uuid references public.agent_jobs(id) on delete set null,
  triggered_by_member_id uuid references public.workspace_members(id) on delete set null,
  run_type text not null,
  model_provider text not null,
  model_name text not null,
  status public.agent_run_status not null default 'queued',
  last_activity_at timestamptz default now(),
  input_tokens bigint,
  output_tokens bigint,
  total_cost_usd numeric(12, 6),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.agent_run_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  agent_run_id uuid not null references public.agent_runs(id) on delete cascade,
  kind text not null,
  message_md text not null,
  created_at timestamptz not null default now()
);

create table internal.workspace_issue_counters (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  last_issue_number integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_issue_counters_last_issue_number_nonnegative_check
    check (last_issue_number >= 0)
);

create table public.workspace_agent_config (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  key text not null,
  value_json jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_agent_config_workspace_key_unique unique (workspace_id, key)
);

create table public.worker_heartbeats (
  id uuid primary key default gen_random_uuid(),
  worker_id text not null,
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  active_job_id uuid references public.agent_jobs(id) on delete set null,
  metadata jsonb not null default '{}',
  constraint worker_heartbeats_worker_id_unique unique (worker_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create unique index workspace_members_workspace_user_unique
  on public.workspace_members (workspace_id, user_id)
  where user_id is not null;

create unique index workspace_members_workspace_username_unique
  on public.workspace_members (workspace_id, username)
  where username is not null;

create unique index workspace_members_one_wallie_system_member_per_workspace
  on public.workspace_members (workspace_id)
  where kind = 'system' and username = 'wallie';

create index github_repositories_workspace_full_name_idx
  on public.github_repositories (workspace_id, full_name);

create index github_issue_branches_session_created_at_idx
  on public.github_issue_branches (session_id, created_at);

create index sessions_workspace_number_desc_idx
  on public.sessions (workspace_id, number desc);

create index sessions_workspace_current_stage_idx
  on public.sessions (workspace_id, current_stage_id);

create index sessions_pipeline_id_idx
  on public.sessions (pipeline_id);

create index pipelines_workspace_id_idx
  on public.pipelines (workspace_id);

create unique index pipelines_one_default_per_workspace
  on public.pipelines (workspace_id) where is_default;

create index pipeline_stages_pipeline_position_idx
  on public.pipeline_stages (pipeline_id, position);

create index session_artifacts_stage_id_idx
  on public.session_artifacts (stage_id);

create index session_phase_completions_stage_id_idx
  on public.session_phase_completions (stage_id);

create index sessions_workspace_archived_idx
  on public.sessions (workspace_id, archived_at);

create unique index sessions_workspace_linear_issue_idx
  on public.sessions (workspace_id, linear_issue_id)
  where linear_issue_id is not null;

create index session_artifacts_session_id_idx
  on public.session_artifacts (session_id);

create index session_phase_completions_session_id_idx
  on public.session_phase_completions (session_id);

create index session_pull_requests_session_created_at_idx
  on public.session_pull_requests (session_id, created_at);

create unique index agent_jobs_active_dedupe_key_idx
  on public.agent_jobs (workspace_id, dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');

create index agent_jobs_job_type_status_idx
  on public.agent_jobs (job_type, status)
  where status in ('queued', 'running');

create index agent_jobs_session_id_idx
  on public.agent_jobs (session_id);

create index agent_runs_session_created_at_desc_idx
  on public.agent_runs (session_id, created_at desc);

create index agent_runs_stall_sweep_idx
  on public.agent_runs (last_activity_at)
  where status in ('queued', 'started', 'running');

create index agent_run_messages_agent_run_created_at_idx
  on public.agent_run_messages (agent_run_id, created_at);

create index worker_heartbeats_last_heartbeat_idx
  on public.worker_heartbeats (last_heartbeat_at);

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

create or replace function internal.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function internal.assert_workspace_match(
  expected_workspace_id uuid,
  target_table regclass,
  target_id uuid,
  field_name text
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  actual_workspace_id uuid;
begin
  if target_id is null then
    return;
  end if;

  execute format('select workspace_id from %s where id = $1', target_table)
    into actual_workspace_id
    using target_id;

  if actual_workspace_id is null then
    raise exception '% references a missing row', field_name
      using errcode = '23503';
  end if;

  if actual_workspace_id <> expected_workspace_id then
    raise exception '% must belong to workspace %', field_name, expected_workspace_id
      using errcode = '23514';
  end if;
end;
$$;

create or replace function internal.current_workspace_member_id(target_workspace_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select wm.id
  from public.workspace_members wm
  where wm.workspace_id = target_workspace_id
    and wm.user_id = auth.uid()
    and wm.kind = 'human'
    and wm.is_active = true
  limit 1
$$;

create or replace function internal.slugify_workspace_value(input text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(
    both '-'
    from regexp_replace(
      regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g'),
      '-{2,}',
      '-',
      'g'
    )
  )
$$;

create or replace function public.current_user_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select wm.workspace_id
  from public.workspace_members wm
  where wm.user_id = auth.uid()
    and wm.kind = 'human'
    and wm.is_active = true
$$;

create or replace function public.can_manage_workspace(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(
      auth.role() = 'service_role'
      or exists (
        select 1
        from public.workspace_members wm
        where wm.workspace_id = target_workspace_id
          and wm.user_id = auth.uid()
          and wm.kind = 'human'
          and wm.is_active = true
          and wm.role in ('owner', 'admin')
      ),
      false
    )
$$;

-- ---------------------------------------------------------------------------
-- Trigger functions (workspace-consistency enforcement)
-- ---------------------------------------------------------------------------

create or replace function internal.enforce_github_repository_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.github_installations', new.github_installation_id, 'github_installation_id');
  return new;
end;
$$;

create or replace function internal.enforce_github_issue_branch_refs()
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

create or replace function internal.enforce_workspace_secret_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.created_by_member_id, 'created_by_member_id');
  return new;
end;
$$;

create or replace function internal.enforce_agent_job_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(
    new.workspace_id, 'public.sessions', new.session_id, 'session_id'
  );

  perform internal.assert_workspace_match(
    new.workspace_id, 'public.workspace_members',
    new.requested_by_member_id, 'requested_by_member_id'
  );

  return new;
end;
$$;

create or replace function internal.enforce_agent_run_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.sessions', new.session_id, 'session_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.agent_jobs', new.agent_job_id, 'agent_job_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.triggered_by_member_id, 'triggered_by_member_id');
  return new;
end;
$$;

create or replace function internal.enforce_agent_run_message_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.agent_runs', new.agent_run_id, 'agent_run_id');
  return new;
end;
$$;

create or replace function internal.enforce_pipeline_stage_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  pipeline_workspace_id uuid;
begin
  select p.workspace_id into pipeline_workspace_id
  from public.pipelines p
  where p.id = new.pipeline_id;

  if pipeline_workspace_id is null then
    raise exception 'pipeline_id references a missing pipeline'
      using errcode = '23503';
  end if;

  -- Keep workspace_id in lockstep with the parent pipeline so RLS and the
  -- assert_workspace_match calls on artifacts/completions stay consistent.
  new.workspace_id := pipeline_workspace_id;
  return new;
end;
$$;

create or replace function internal.enforce_session_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_member_id uuid;
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.pipelines', new.pipeline_id, 'pipeline_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.pipeline_stages', new.current_stage_id, 'current_stage_id');

  -- For authenticated (non-service_role) inserts, default creator_member_id
  -- to the current workspace member and lock the field on update. Mirrors
  -- the old issues trigger so sessions created from the UI stay attributed
  -- without every client having to wire the member id through.
  if coalesce(auth.role(), '') <> 'service_role' then
    if tg_op = 'INSERT' then
      current_member_id := internal.current_workspace_member_id(new.workspace_id);

      if current_member_id is null then
        raise exception 'Authenticated user is not an active member of workspace %', new.workspace_id
          using errcode = '42501';
      end if;

      if new.creator_member_id is null then
        new.creator_member_id := current_member_id;
      elsif new.creator_member_id <> current_member_id then
        raise exception 'creator_member_id must match the current workspace member'
          using errcode = '42501';
      end if;
    elsif new.creator_member_id is distinct from old.creator_member_id then
      raise exception 'creator_member_id is immutable after insert'
        using errcode = '42501';
    end if;
  end if;

  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.creator_member_id, 'creator_member_id');
  return new;
end;
$$;

create or replace function internal.enforce_session_artifact_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.sessions', new.session_id, 'session_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.pipeline_stages', new.stage_id, 'stage_id');
  return new;
end;
$$;

create or replace function internal.enforce_session_phase_completion_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.sessions', new.session_id, 'session_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.pipeline_stages', new.stage_id, 'stage_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.completed_by_member_id, 'completed_by_member_id');
  return new;
end;
$$;

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

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger profiles_touch_updated_at
before update on public.profiles
for each row
execute function internal.touch_updated_at();

create trigger workspaces_touch_updated_at
before update on public.workspaces
for each row
execute function internal.touch_updated_at();

create trigger workspace_members_touch_updated_at
before update on public.workspace_members
for each row
execute function internal.touch_updated_at();

create trigger github_installations_touch_updated_at
before update on public.github_installations
for each row
execute function internal.touch_updated_at();

create trigger github_repositories_touch_updated_at
before update on public.github_repositories
for each row
execute function internal.touch_updated_at();

create trigger github_repositories_enforce_refs
before insert or update on public.github_repositories
for each row
execute function internal.enforce_github_repository_refs();

create trigger github_issue_branches_touch_updated_at
before update on public.github_issue_branches
for each row
execute function internal.touch_updated_at();

create trigger github_issue_branches_enforce_refs
before insert or update on public.github_issue_branches
for each row
execute function internal.enforce_github_issue_branch_refs();

create trigger pipelines_touch_updated_at
before update on public.pipelines
for each row
execute function internal.touch_updated_at();

create trigger pipeline_stages_touch_updated_at
before update on public.pipeline_stages
for each row
execute function internal.touch_updated_at();

create trigger pipeline_stages_enforce_refs
before insert or update on public.pipeline_stages
for each row
execute function internal.enforce_pipeline_stage_refs();

create trigger workspace_secrets_touch_updated_at
before update on public.workspace_secrets
for each row
execute function internal.touch_updated_at();

create trigger workspace_secrets_enforce_refs
before insert or update on public.workspace_secrets
for each row
execute function internal.enforce_workspace_secret_refs();

create trigger sessions_touch_updated_at
before update on public.sessions
for each row
execute function internal.touch_updated_at();

create trigger sessions_enforce_refs
before insert or update on public.sessions
for each row
execute function internal.enforce_session_refs();

create trigger session_artifacts_enforce_refs
before insert or update on public.session_artifacts
for each row
execute function internal.enforce_session_artifact_refs();

create trigger session_phase_completions_enforce_refs
before insert or update on public.session_phase_completions
for each row
execute function internal.enforce_session_phase_completion_refs();

create trigger session_pull_requests_touch_updated_at
before update on public.session_pull_requests
for each row
execute function internal.touch_updated_at();

create trigger session_pull_requests_enforce_refs
before insert or update on public.session_pull_requests
for each row
execute function internal.enforce_session_pull_request_refs();

create trigger agent_jobs_touch_updated_at
before update on public.agent_jobs
for each row
execute function internal.touch_updated_at();

create trigger agent_jobs_enforce_refs
before insert or update on public.agent_jobs
for each row
execute function internal.enforce_agent_job_refs();

create trigger agent_runs_touch_updated_at
before update on public.agent_runs
for each row
execute function internal.touch_updated_at();

create trigger agent_runs_enforce_refs
before insert or update on public.agent_runs
for each row
execute function internal.enforce_agent_run_refs();

create trigger agent_run_messages_enforce_refs
before insert or update on public.agent_run_messages
for each row
execute function internal.enforce_agent_run_message_refs();

create trigger workspace_issue_counters_touch_updated_at
before update on internal.workspace_issue_counters
for each row
execute function internal.touch_updated_at();

create trigger workspace_agent_config_touch_updated_at
before update on public.workspace_agent_config
for each row
execute function internal.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

-- Default stage seed shared by create_workspace and the "Reset to defaults"
-- button in the settings UI. Mirrors the legacy 6-phase pipeline so that
-- existing UX continues to work out of the box; workspaces can edit, add,
-- remove, or reorder stages from the settings page.
create or replace function internal.default_pipeline_stages()
returns table (
  stage_position integer,
  slug text,
  name text,
  description text,
  prompt_template_md text
)
language sql
immutable
set search_path = ''
as $$
  values
    (
      1,
      'product',
      'Product',
      'Write the spec and approve the problem framing.',
      '## Task' || E'\n\n' ||
      '{{session.title}}' || E'\n\n' ||
      '## Description' || E'\n\n' ||
      '{{session.prompt}}' || E'\n'
    ),
    (
      2,
      'design',
      'Design',
      'Resolve the design approach before engineering picks it up.',
      'Design the technical approach for: {{session.title}}' || E'\n\n' ||
      '## Description' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '{{#if artifact.previousStages.product}}## Approved Product Spec' || E'\n\n' ||
      '{{artifact.previousStages.product}}' || E'\n{{/if}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Produce a concise technical design document that covers approach, key files, data model, API surface, testing, and risks.' || E'\n'
    ),
    (
      3,
      'engineering',
      'Engineering',
      'Scope the implementation plan and confirm the diff shape.',
      'Implement: {{session.title}}' || E'\n\n' ||
      '## Description' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '{{#if artifact.previousStages.product}}## Product Spec' || E'\n\n' ||
      '{{artifact.previousStages.product}}' || E'\n{{/if}}' || E'\n\n' ||
      '{{#if artifact.previousStages.design}}## Design Document' || E'\n\n' ||
      '{{artifact.previousStages.design}}' || E'\n{{/if}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Read the codebase, implement the change, follow existing patterns, and produce small focused commits.' || E'\n'
    ),
    (
      4,
      'review',
      'Review',
      'Human review of the generated change set.',
      'Review the implementation for: {{session.title}}' || E'\n\n' ||
      '## Description' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '{{#if artifact.previousStages.engineering}}## Engineering Output' || E'\n\n' ||
      '{{artifact.previousStages.engineering}}' || E'\n{{/if}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Verify the implementation matches the spec, call out risks, and report findings as a structured review.' || E'\n'
    ),
    (
      5,
      'land',
      'Land',
      'Merge, tag, and roll out.',
      'Merge the approved change for "{{session.title}}". Confirm CI is green and the rollout plan is captured below.' || E'\n'
    ),
    (
      6,
      'monitor',
      'Monitor',
      'Watch for regressions. Terminal phase — approving archives.',
      'Verify that landing "{{session.title}}" has not introduced regressions.' || E'\n\n' ||
      '## Description' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Run tests, lint, and a smoke check; produce a monitoring report with pass/fail status.' || E'\n'
    );
$$;

create or replace function public.next_session_number(target_workspace_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocated_number integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (
       select 1
       from public.current_user_workspace_ids() as workspace_ids(workspace_id)
       where workspace_id = target_workspace_id
     ) then
    raise exception 'Not authorized to allocate session numbers for workspace %', target_workspace_id
      using errcode = '42501';
  end if;

  insert into internal.workspace_issue_counters as counters (
    workspace_id,
    last_issue_number
  )
  values (target_workspace_id, 1)
  on conflict (workspace_id)
  do update
    set last_issue_number = counters.last_issue_number + 1,
        updated_at = now()
  returning last_issue_number into allocated_number;

  return allocated_number;
end;
$$;

create or replace function public.create_workspace(
  workspace_name text,
  requested_slug text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_email text := nullif(auth.jwt() ->> 'email', '');
  actor_full_name text := nullif(
    coalesce(
      auth.jwt() -> 'user_metadata' ->> 'full_name',
      auth.jwt() -> 'user_metadata' ->> 'name'
    ),
    ''
  );
  actor_avatar_url text := nullif(
    coalesce(
      auth.jwt() -> 'user_metadata' ->> 'avatar_url',
      auth.jwt() -> 'user_metadata' ->> 'picture'
    ),
    ''
  );
  base_slug text;
  candidate_slug text;
  suffix integer := 0;
  created_workspace public.workspaces%rowtype;
  profile_row public.profiles%rowtype;
  default_pipeline_id uuid;
begin
  if actor_id is null then
    raise exception 'Authenticated user required to create a workspace'
      using errcode = '42501';
  end if;

  workspace_name := btrim(coalesce(workspace_name, ''));

  if workspace_name = '' then
    raise exception 'workspace_name is required'
      using errcode = '22023';
  end if;

  base_slug := internal.slugify_workspace_value(
    coalesce(nullif(btrim(requested_slug), ''), workspace_name)
  );

  if base_slug = '' then
    base_slug := 'workspace';
  end if;

  candidate_slug := base_slug;

  while exists (
    select 1
    from public.workspaces workspace_record
    where workspace_record.slug = candidate_slug
  ) loop
    suffix := suffix + 1;
    candidate_slug := base_slug || '-' || suffix;
  end loop;

  select *
  into profile_row
  from public.profiles profile_record
  where profile_record.id = actor_id;

  insert into public.workspaces (
    slug,
    name,
    created_by
  )
  values (
    candidate_slug,
    workspace_name,
    actor_id
  )
  returning *
  into created_workspace;

  insert into public.workspace_members (
    workspace_id,
    user_id,
    kind,
    role,
    email,
    full_name,
    avatar_url
  )
  values (
    created_workspace.id,
    actor_id,
    'human',
    'owner',
    coalesce(profile_row.primary_email, actor_email),
    coalesce(profile_row.full_name, actor_full_name),
    coalesce(profile_row.avatar_url, actor_avatar_url)
  );

  insert into public.workspace_members (
    workspace_id,
    kind,
    role,
    username,
    full_name
  )
  values (
    created_workspace.id,
    'system',
    'agent',
    'wallie',
    'Wallie'
  );

  insert into internal.workspace_issue_counters (
    workspace_id,
    last_issue_number
  )
  values (
    created_workspace.id,
    0
  )
  on conflict (workspace_id) do nothing;

  -- Seed the default pipeline so new workspaces have a working flow without
  -- needing to open settings first. Owners can edit/replace it from the UI.
  insert into public.pipelines (workspace_id, name, is_default)
  values (created_workspace.id, 'Default', true)
  returning id into default_pipeline_id;

  insert into public.pipeline_stages (
    pipeline_id, workspace_id, position, slug, name, description, prompt_template_md
  )
  select
    default_pipeline_id,
    created_workspace.id,
    s.stage_position,
    s.slug,
    s.name,
    s.description,
    s.prompt_template_md
  from internal.default_pipeline_stages() s;

  return created_workspace;
end;
$$;

-- CAS-guarded stage approval. Stage order is read from pipeline_stages.position
-- on the session's pinned pipeline, so renaming/inserting/removing stages in
-- settings doesn't require touching this function.
--
-- Approver gate:
--   1. If approver_member_id is in the stage's approver_member_ids list, allow.
--   2. Otherwise, if the list is empty AND approver_member_id is an active
--      owner/admin, allow.
--   3. Otherwise, return empty (caller treats this as a 403).
-- A null approver_member_id (e.g. from a service-side automation) only passes
-- when the list is empty AND no role check is required, which today means it
-- never passes — the route handler always resolves the member id first.
create or replace function public.approve_session_stage(
  target_session_id uuid,
  expected_workspace_id uuid,
  expected_version integer,
  approver_member_id uuid default null
)
returns table (
  id uuid,
  pipeline_id uuid,
  current_stage_id uuid,
  current_stage_slug text,
  phase_status public.pipeline_phase_status,
  workspace_id uuid,
  linear_issue_url text,
  archived_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  session_pipeline_id uuid;
  current_stage_id_v uuid;
  current_stage_slug_v text;
  current_position integer;
  approver_list uuid[];
  approver_role public.member_role;
  approver_active boolean;
  approver_workspace uuid;
  next_stage_id uuid;
  approved_at_now timestamptz := now();
begin
  -- Lookup the current stage so we can check approvers BEFORE flipping state.
  select s.pipeline_id, s.current_stage_id
  into session_pipeline_id, current_stage_id_v
  from public.sessions s
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review';

  if current_stage_id_v is null then
    return;
  end if;

  select ps.position, ps.slug, ps.approver_member_ids
  into current_position, current_stage_slug_v, approver_list
  from public.pipeline_stages ps
  where ps.id = current_stage_id_v;

  if approver_member_id is not null then
    select wm.role, wm.is_active, wm.workspace_id
    into approver_role, approver_active, approver_workspace
    from public.workspace_members wm
    where wm.id = approver_member_id;

    if not coalesce(approver_active, false)
       or approver_workspace is distinct from expected_workspace_id then
      return;
    end if;
  end if;

  if coalesce(array_length(approver_list, 1), 0) > 0 then
    if approver_member_id is null
       or not (approver_member_id = any(approver_list)) then
      return;
    end if;
  else
    -- Empty list: fall back to workspace owner/admin.
    if approver_member_id is null
       or approver_role is null
       or approver_role not in ('owner', 'admin') then
      return;
    end if;
  end if;

  -- Approver checks passed; flip phase_status with the same CAS gate as before.
  update public.sessions s
  set phase_status = 'approved'
  where s.id = target_session_id
    and s.workspace_id = expected_workspace_id
    and s.current_artifact_version = expected_version
    and s.phase_status = 'awaiting_review';

  if not found then
    return;
  end if;

  insert into public.session_phase_completions (
    session_id,
    workspace_id,
    stage_id,
    stage_slug,
    completed_at,
    completed_by_member_id
  )
  values (
    target_session_id,
    expected_workspace_id,
    current_stage_id_v,
    current_stage_slug_v,
    approved_at_now,
    approver_member_id
  )
  on conflict (session_id, stage_slug) do nothing;

  -- Find the next stage by position. Null result = terminal stage; archive.
  select ps.id into next_stage_id
  from public.pipeline_stages ps
  where ps.pipeline_id = session_pipeline_id
    and ps.position > current_position
  order by ps.position asc
  limit 1;

  if next_stage_id is null then
    update public.sessions
    set archived_at = approved_at_now
    where id = target_session_id;
  else
    update public.sessions
    set current_stage_id = next_stage_id,
        phase_status = 'agent_generating',
        current_artifact_version = 0,
        rejection_count = 0
    where id = target_session_id;
  end if;

  return query
    select
      s.id,
      s.pipeline_id,
      s.current_stage_id,
      ps.slug,
      s.phase_status,
      s.workspace_id,
      s.linear_issue_url,
      s.archived_at
    from public.sessions s
    join public.pipeline_stages ps on ps.id = s.current_stage_id
    where s.id = target_session_id;
end;
$$;

-- Atomic concurrency-aware job claim. Returns the claimed row if the
-- workspace is below its concurrency limit, the job isn't scheduled for the
-- future, and the CAS succeeds. Returns empty otherwise.
create or replace function public.claim_agent_job(
  target_job_id uuid,
  default_concurrency_limit int default 2
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_workspace_id uuid;
  job_scheduled_at timestamptz;
  configured_limit int;
  effective_limit int;
  running_count int;
begin
  select workspace_id, scheduled_at
  into job_workspace_id, job_scheduled_at
  from public.agent_jobs
  where id = target_job_id
    and status = 'queued'
  for update skip locked;

  if job_workspace_id is null then
    return;
  end if;

  if job_scheduled_at is not null and job_scheduled_at > now() then
    return;
  end if;

  select (value_json)::int into configured_limit
  from public.workspace_agent_config
  where workspace_id = job_workspace_id
    and key = 'concurrency_limit'
    and jsonb_typeof(value_json) = 'number';

  effective_limit := coalesce(configured_limit, default_concurrency_limit);

  select count(*) into running_count
  from public.agent_jobs
  where workspace_id = job_workspace_id
    and status = 'running';

  if running_count >= effective_limit then
    return;
  end if;

  return query
  update public.agent_jobs
  set
    status = 'running',
    attempt_count = attempt_count + 1,
    last_error = null,
    started_at = coalesce(started_at, now()),
    scheduled_at = null
  where id = target_job_id
    and status = 'queued'
  returning *;
end;
$$;

-- Exponential backoff retry. scheduled_at = now() + min(base * 2^attempt, max).
create or replace function public.schedule_job_retry(
  target_job_id uuid,
  base_delay_ms int default 5000,
  max_backoff_ms int default 300000
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_attempt int;
  delay_ms int;
  next_retry timestamptz;
begin
  select attempt_count into current_attempt
  from public.agent_jobs
  where id = target_job_id
  for update;

  if current_attempt is null then
    return;
  end if;

  delay_ms := least(base_delay_ms * power(2, current_attempt)::int, max_backoff_ms);
  next_retry := now() + (delay_ms || ' milliseconds')::interval;

  return query
  update public.agent_jobs
  set
    status = 'queued',
    scheduled_at = next_retry,
    finished_at = null
  where id = target_job_id
  returning *;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS enablement
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.github_installations enable row level security;
alter table public.github_repositories enable row level security;
alter table public.github_issue_branches enable row level security;
alter table public.workspace_secrets enable row level security;
alter table public.pipelines enable row level security;
alter table public.pipeline_stages enable row level security;
alter table public.sessions enable row level security;
alter table public.session_artifacts enable row level security;
alter table public.session_phase_completions enable row level security;
alter table public.session_pull_requests enable row level security;
alter table public.agent_jobs enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_run_messages enable row level security;
alter table public.workspace_agent_config enable row level security;
alter table public.worker_heartbeats enable row level security;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema internal to authenticated, service_role;

revoke all on public.profiles from anon, authenticated;
revoke all on public.workspaces from anon, authenticated;
revoke all on public.workspace_members from anon, authenticated;
revoke all on public.github_installations from anon, authenticated;
revoke all on public.github_repositories from anon, authenticated;
revoke all on public.github_issue_branches from anon, authenticated;
revoke all on public.workspace_secrets from anon, authenticated;
revoke all on public.pipelines from anon, authenticated;
revoke all on public.pipeline_stages from anon, authenticated;
revoke all on public.sessions from anon, authenticated;
revoke all on public.session_artifacts from anon, authenticated;
revoke all on public.session_phase_completions from anon, authenticated;
revoke all on public.session_pull_requests from anon, authenticated;
revoke all on public.agent_jobs from anon, authenticated;
revoke all on public.agent_runs from anon, authenticated;
revoke all on public.agent_run_messages from anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all tables in schema internal to service_role;
grant all on all functions in schema public to service_role;
grant all on all functions in schema internal to service_role;

grant select, insert, update on public.profiles to authenticated;
grant select on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;
grant update (preferences) on public.workspace_members to authenticated;
grant select on public.github_installations to authenticated;
grant select on public.github_repositories to authenticated;
grant select on public.github_issue_branches to authenticated;
grant select on public.pipelines to authenticated;
grant select on public.pipeline_stages to authenticated;
grant select on public.sessions to authenticated;
grant select on public.session_artifacts to authenticated;
grant select on public.session_phase_completions to authenticated;
grant select on public.session_pull_requests to authenticated;
grant select on public.agent_runs to authenticated;
grant select on public.agent_run_messages to authenticated;
grant select on public.workspace_agent_config to authenticated;
grant insert (workspace_id, key, value_json) on public.workspace_agent_config to authenticated;
grant update (key, value_json) on public.workspace_agent_config to authenticated;
grant delete on public.workspace_agent_config to authenticated;

grant execute on function internal.current_workspace_member_id(uuid) to authenticated;
grant execute on function public.current_user_workspace_ids() to authenticated;
grant execute on function public.can_manage_workspace(uuid) to authenticated;
grant execute on function public.next_session_number(uuid) to authenticated;
grant execute on function public.create_workspace(text, text) to authenticated;

revoke all on function public.approve_session_stage(uuid, uuid, integer, uuid) from public;
grant execute on function public.approve_session_stage(uuid, uuid, integer, uuid) to service_role;

revoke all on function public.schedule_job_retry(uuid, int, int) from public;
grant execute on function public.schedule_job_retry(uuid, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- RLS policies
-- ---------------------------------------------------------------------------

create policy profiles_select_self
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

create policy profiles_insert_self
  on public.profiles
  for insert
  to authenticated
  with check (id = auth.uid());

create policy profiles_update_self
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy workspaces_select_membership
  on public.workspaces
  for select
  to authenticated
  using (id in (select public.current_user_workspace_ids()));

create policy workspace_members_select_membership
  on public.workspace_members
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy workspace_members_update_own_preferences
  on public.workspace_members
  for update
  to authenticated
  using (user_id = auth.uid() and workspace_id in (select public.current_user_workspace_ids()))
  with check (user_id = auth.uid() and workspace_id in (select public.current_user_workspace_ids()));

create policy github_installations_select_membership
  on public.github_installations
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy github_repositories_select_membership
  on public.github_repositories
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy github_issue_branches_select_membership
  on public.github_issue_branches
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy agent_runs_select_membership
  on public.agent_runs
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy agent_run_messages_select_membership
  on public.agent_run_messages
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

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

create policy workspace_agent_config_select
  on public.workspace_agent_config
  for select
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy workspace_agent_config_insert
  on public.workspace_agent_config
  for insert
  with check (public.can_manage_workspace(workspace_id));

create policy workspace_agent_config_update
  on public.workspace_agent_config
  for update
  using (public.can_manage_workspace(workspace_id));

create policy workspace_agent_config_delete
  on public.workspace_agent_config
  for delete
  using (public.can_manage_workspace(workspace_id));

create policy pipelines_select_membership
  on public.pipelines for select to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy pipelines_insert_manager
  on public.pipelines for insert to authenticated
  with check (public.can_manage_workspace(workspace_id));

create policy pipelines_update_manager
  on public.pipelines for update to authenticated
  using (public.can_manage_workspace(workspace_id))
  with check (public.can_manage_workspace(workspace_id));

create policy pipelines_delete_manager
  on public.pipelines for delete to authenticated
  using (public.can_manage_workspace(workspace_id));

create policy pipeline_stages_select_membership
  on public.pipeline_stages for select to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy pipeline_stages_insert_manager
  on public.pipeline_stages for insert to authenticated
  with check (public.can_manage_workspace(workspace_id));

create policy pipeline_stages_update_manager
  on public.pipeline_stages for update to authenticated
  using (public.can_manage_workspace(workspace_id))
  with check (public.can_manage_workspace(workspace_id));

create policy pipeline_stages_delete_manager
  on public.pipeline_stages for delete to authenticated
  using (public.can_manage_workspace(workspace_id));

create policy worker_heartbeats_select
  on public.worker_heartbeats
  for select
  using (true);

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------

do $$
declare
  publication_name text := 'supabase_realtime';
  realtime_target text;
  realtime_targets text[] := array[
    'public.workspaces',
    'public.workspace_members',
    'public.github_installations',
    'public.github_repositories',
    'public.github_issue_branches',
    'public.agent_runs',
    'public.agent_run_messages',
    'public.sessions',
    'public.pipelines',
    'public.pipeline_stages'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = publication_name) then
    execute format('create publication %I', publication_name);
  end if;

  foreach realtime_target in array realtime_targets loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = publication_name
        and schemaname = split_part(realtime_target, '.', 1)
        and tablename = split_part(realtime_target, '.', 2)
    ) then
      execute format('alter publication %I add table only %s', publication_name, realtime_target);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'workspace-avatars',
  'workspace-avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id)
do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
