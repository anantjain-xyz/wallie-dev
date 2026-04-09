-- Pipeline Dashboard: Phase 1 schema
-- Adds slack_installations, pipeline_issues, pipeline_artifacts tables
-- Adds job_type column to agent_jobs
-- Adds slack_mention trigger type

-- New enum types for pipeline state machine
create type public.pipeline_phase as enum (
  'product',
  'design',
  'engineering',
  'shipped'
);

create type public.pipeline_phase_status as enum (
  'agent_generating',
  'awaiting_review',
  'approved',
  'rejected',
  'escalated'
);

-- Add slack_mention to existing trigger type enum
alter type public.agent_trigger_type add value 'slack_mention';

-- Add job_type to agent_jobs (discriminator for wallie vs pipeline jobs)
alter table public.agent_jobs
  add column job_type text not null default 'wallie';

-- Slack workspace installations (mirrors github_installations pattern)
create table public.slack_installations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  team_id text not null unique,
  team_name text,
  bot_token_encrypted text not null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pipeline issues: phase state machine for each Linear issue in the pipeline
create table public.pipeline_issues (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  linear_issue_id text,
  linear_issue_url text,
  slack_channel_id text,
  slack_thread_ts text,
  phase public.pipeline_phase not null default 'product',
  phase_status public.pipeline_phase_status not null default 'agent_generating',
  rejection_count integer not null default 0,
  current_artifact_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  product_approved_at timestamptz,
  design_approved_at timestamptz,
  engineering_approved_at timestamptz,
  shipped_at timestamptz,
  constraint pipeline_issues_rejection_count_nonnegative_check
    check (rejection_count >= 0),
  constraint pipeline_issues_artifact_version_nonnegative_check
    check (current_artifact_version >= 0)
);

-- Pipeline artifacts: append-only revision history
create table public.pipeline_artifacts (
  id uuid primary key default gen_random_uuid(),
  pipeline_issue_id uuid not null references public.pipeline_issues(id) on delete cascade,
  phase public.pipeline_phase not null,
  version integer not null,
  artifact_json jsonb not null,
  feedback_text text,
  created_at timestamptz not null default now(),
  constraint pipeline_artifacts_version_positive_check
    check (version > 0),
  constraint pipeline_artifacts_unique_version
    unique (pipeline_issue_id, phase, version)
);

-- Indexes
create index slack_installations_workspace_id_idx
  on public.slack_installations (workspace_id);

create index pipeline_issues_workspace_id_idx
  on public.pipeline_issues (workspace_id);

create index pipeline_issues_issue_id_idx
  on public.pipeline_issues (issue_id);

create index pipeline_issues_linear_issue_id_idx
  on public.pipeline_issues (linear_issue_id);

create unique index pipeline_issues_slack_thread_idx
  on public.pipeline_issues (slack_channel_id, slack_thread_ts)
  where slack_channel_id is not null and slack_thread_ts is not null;

create index pipeline_artifacts_pipeline_issue_id_idx
  on public.pipeline_artifacts (pipeline_issue_id);

create index agent_jobs_job_type_status_idx
  on public.agent_jobs (job_type, status)
  where status in ('queued', 'running');

-- Triggers: updated_at
create trigger slack_installations_touch_updated_at
before update on public.slack_installations
for each row
execute function internal.touch_updated_at();

create trigger pipeline_issues_touch_updated_at
before update on public.pipeline_issues
for each row
execute function internal.touch_updated_at();

-- RLS
alter table public.slack_installations enable row level security;
alter table public.pipeline_issues enable row level security;
alter table public.pipeline_artifacts enable row level security;

-- Service role gets full access (already granted via "grant all on all tables")
-- For authenticated users: read-only access scoped to workspace membership

grant select on public.slack_installations to authenticated;
grant select on public.pipeline_issues to authenticated;
grant select on public.pipeline_artifacts to authenticated;

create policy slack_installations_select_membership
  on public.slack_installations
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy pipeline_issues_select_membership
  on public.pipeline_issues
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy pipeline_artifacts_select_membership
  on public.pipeline_artifacts
  for select
  to authenticated
  using (
    pipeline_issue_id in (
      select pi.id from public.pipeline_issues pi
      where pi.workspace_id in (select public.current_user_workspace_ids())
    )
  );

-- Add pipeline_issues to realtime publication
do $$
declare
  publication_name text := 'supabase_realtime';
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = publication_name
      and schemaname = 'public'
      and tablename = 'pipeline_issues'
  ) then
    execute format('alter publication %I add table only public.pipeline_issues', publication_name);
  end if;
end
$$;
