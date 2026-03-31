create schema if not exists extensions;
create schema if not exists internal;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

revoke all on schema internal from public;
revoke all on schema internal from anon;
revoke all on schema internal from authenticated;

create type public.workspace_tier as enum ('free', 'pro');
create type public.member_role as enum ('owner', 'admin', 'member', 'agent');
create type public.member_kind as enum ('human', 'system');
create type public.issue_status as enum (
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled'
);
create type public.issue_priority as enum ('none', 'low', 'medium', 'high', 'urgent');
create type public.issue_link_type as enum (
  'blocked_by',
  'sub_issue',
  'related',
  'duplicate'
);
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
  tier public.workspace_tier not null default 'free',
  current_billing_cycle_start_at timestamptz not null default now(),
  successful_agent_runs_this_cycle integer not null default 0,
  stripe_customer_id text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_slug_format_check
    check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint workspaces_successful_agent_runs_nonnegative_check
    check (successful_agent_runs_this_cycle >= 0)
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

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  number integer not null,
  title text not null,
  description_md text not null default '',
  plan_md text,
  design_md text,
  status public.issue_status not null default 'backlog',
  priority public.issue_priority not null default 'none',
  priority_rank smallint generated always as (
    case priority
      when 'urgent' then 5
      when 'high' then 4
      when 'medium' then 3
      when 'low' then 2
      else 1
    end
  ) stored,
  estimate_points integer,
  creator_member_id uuid references public.workspace_members(id) on delete set null,
  assignee_member_id uuid references public.workspace_members(id) on delete set null,
  github_repository_id uuid references public.github_repositories(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint issues_workspace_number_unique unique (workspace_id, number),
  constraint issues_number_positive_check check (number > 0),
  constraint issues_estimate_nonnegative_check
    check (estimate_points is null or estimate_points >= 0)
);

create table public.issue_comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  issue_id uuid not null references public.issues(id) on delete cascade,
  author_member_id uuid references public.workspace_members(id) on delete set null,
  body_md text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.issue_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_issue_id uuid not null references public.issues(id) on delete cascade,
  target_issue_id uuid not null references public.issues(id) on delete cascade,
  link_type public.issue_link_type not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint issue_links_source_target_type_unique unique (source_issue_id, target_issue_id, link_type),
  constraint issue_links_no_self_reference_check check (source_issue_id <> target_issue_id)
);

create table public.github_issue_branches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  issue_id uuid not null references public.issues(id) on delete cascade,
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

create table public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  issue_id uuid not null references public.issues(id) on delete cascade,
  requested_by_member_id uuid references public.workspace_members(id) on delete set null,
  trigger_type public.agent_trigger_type not null,
  status public.agent_job_status not null default 'queued',
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
  issue_id uuid not null references public.issues(id) on delete cascade,
  agent_job_id uuid references public.agent_jobs(id) on delete set null,
  triggered_by_member_id uuid references public.workspace_members(id) on delete set null,
  run_type text not null,
  model_provider text not null,
  model_name text not null,
  status public.agent_run_status not null default 'queued',
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

create unique index workspace_members_workspace_user_unique
  on public.workspace_members (workspace_id, user_id)
  where user_id is not null;

create unique index workspace_members_workspace_username_unique
  on public.workspace_members (workspace_id, username)
  where username is not null;

create unique index workspace_members_one_wallie_system_member_per_workspace
  on public.workspace_members (workspace_id)
  where kind = 'system' and username = 'wallie';

create index issues_workspace_number_desc_idx
  on public.issues (workspace_id, number desc);

create index issues_workspace_status_priority_rank_idx
  on public.issues (workspace_id, status, priority_rank desc);

create index issues_workspace_assignee_idx
  on public.issues (workspace_id, assignee_member_id);

create index issues_workspace_github_repository_idx
  on public.issues (workspace_id, github_repository_id);

create index issues_search_document_idx
  on public.issues using gin (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description_md, ''))
  );

create index issues_title_trgm_idx
  on public.issues using gin (title gin_trgm_ops);

create index issues_description_md_trgm_idx
  on public.issues using gin (description_md gin_trgm_ops);

create index issue_comments_issue_created_at_idx
  on public.issue_comments (issue_id, created_at);

create index issue_links_source_issue_idx
  on public.issue_links (source_issue_id);

create index issue_links_target_issue_idx
  on public.issue_links (target_issue_id);

create index github_repositories_workspace_full_name_idx
  on public.github_repositories (workspace_id, full_name);

create index github_issue_branches_issue_created_at_idx
  on public.github_issue_branches (issue_id, created_at);

create index agent_runs_issue_created_at_desc_idx
  on public.agent_runs (issue_id, created_at desc);

create index agent_run_messages_agent_run_created_at_idx
  on public.agent_run_messages (agent_run_id, created_at);

create unique index agent_jobs_active_dedupe_key_idx
  on public.agent_jobs (workspace_id, dedupe_key)
  where dedupe_key is not null and status in ('queued', 'running');

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

create or replace function public.next_issue_number(target_workspace_id uuid)
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
    raise exception 'Not authorized to allocate issue numbers for workspace %', target_workspace_id
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

create or replace function internal.enforce_issue_defaults_and_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_member_id uuid;
begin
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
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.assignee_member_id, 'assignee_member_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.github_repositories', new.github_repository_id, 'github_repository_id');

  return new;
end;
$$;

create or replace function internal.enforce_issue_comment_defaults_and_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  current_member_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if tg_op = 'INSERT' then
      current_member_id := internal.current_workspace_member_id(new.workspace_id);

      if current_member_id is null then
        raise exception 'Authenticated user is not an active member of workspace %', new.workspace_id
          using errcode = '42501';
      end if;

      if new.author_member_id is null then
        new.author_member_id := current_member_id;
      elsif new.author_member_id <> current_member_id then
        raise exception 'author_member_id must match the current workspace member'
          using errcode = '42501';
      end if;
    elsif new.author_member_id is distinct from old.author_member_id then
      raise exception 'author_member_id is immutable after insert'
        using errcode = '42501';
    end if;
  end if;

  perform internal.assert_workspace_match(new.workspace_id, 'public.issues', new.issue_id, 'issue_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.author_member_id, 'author_member_id');

  return new;
end;
$$;

create or replace function internal.enforce_issue_link_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.issues', new.source_issue_id, 'source_issue_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.issues', new.target_issue_id, 'target_issue_id');
  return new;
end;
$$;

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
  perform internal.assert_workspace_match(new.workspace_id, 'public.issues', new.issue_id, 'issue_id');
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
  perform internal.assert_workspace_match(new.workspace_id, 'public.issues', new.issue_id, 'issue_id');
  perform internal.assert_workspace_match(new.workspace_id, 'public.workspace_members', new.requested_by_member_id, 'requested_by_member_id');
  return new;
end;
$$;

create or replace function internal.enforce_agent_run_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(new.workspace_id, 'public.issues', new.issue_id, 'issue_id');
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

create trigger issues_touch_updated_at
before update on public.issues
for each row
execute function internal.touch_updated_at();

create trigger issue_comments_touch_updated_at
before update on public.issue_comments
for each row
execute function internal.touch_updated_at();

create trigger issue_links_touch_updated_at
before update on public.issue_links
for each row
execute function internal.touch_updated_at();

create trigger github_issue_branches_touch_updated_at
before update on public.github_issue_branches
for each row
execute function internal.touch_updated_at();

create trigger workspace_secrets_touch_updated_at
before update on public.workspace_secrets
for each row
execute function internal.touch_updated_at();

create trigger agent_jobs_touch_updated_at
before update on public.agent_jobs
for each row
execute function internal.touch_updated_at();

create trigger agent_runs_touch_updated_at
before update on public.agent_runs
for each row
execute function internal.touch_updated_at();

create trigger workspace_issue_counters_touch_updated_at
before update on internal.workspace_issue_counters
for each row
execute function internal.touch_updated_at();

create trigger issues_enforce_refs
before insert or update on public.issues
for each row
execute function internal.enforce_issue_defaults_and_refs();

create trigger issue_comments_enforce_refs
before insert or update on public.issue_comments
for each row
execute function internal.enforce_issue_comment_defaults_and_refs();

create trigger issue_links_enforce_refs
before insert or update on public.issue_links
for each row
execute function internal.enforce_issue_link_refs();

create trigger github_repositories_enforce_refs
before insert or update on public.github_repositories
for each row
execute function internal.enforce_github_repository_refs();

create trigger github_issue_branches_enforce_refs
before insert or update on public.github_issue_branches
for each row
execute function internal.enforce_github_issue_branch_refs();

create trigger workspace_secrets_enforce_refs
before insert or update on public.workspace_secrets
for each row
execute function internal.enforce_workspace_secret_refs();

create trigger agent_jobs_enforce_refs
before insert or update on public.agent_jobs
for each row
execute function internal.enforce_agent_job_refs();

create trigger agent_runs_enforce_refs
before insert or update on public.agent_runs
for each row
execute function internal.enforce_agent_run_refs();

create trigger agent_run_messages_enforce_refs
before insert or update on public.agent_run_messages
for each row
execute function internal.enforce_agent_run_message_refs();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.github_installations enable row level security;
alter table public.github_repositories enable row level security;
alter table public.issues enable row level security;
alter table public.issue_comments enable row level security;
alter table public.issue_links enable row level security;
alter table public.github_issue_branches enable row level security;
alter table public.workspace_secrets enable row level security;
alter table public.agent_jobs enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_run_messages enable row level security;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema internal to authenticated, service_role;

revoke all on public.profiles from anon, authenticated;
revoke all on public.workspaces from anon, authenticated;
revoke all on public.workspace_members from anon, authenticated;
revoke all on public.github_installations from anon, authenticated;
revoke all on public.github_repositories from anon, authenticated;
revoke all on public.issues from anon, authenticated;
revoke all on public.issue_comments from anon, authenticated;
revoke all on public.issue_links from anon, authenticated;
revoke all on public.github_issue_branches from anon, authenticated;
revoke all on public.workspace_secrets from anon, authenticated;
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
grant select, delete on public.issues to authenticated;
grant insert (
  workspace_id,
  number,
  title,
  description_md,
  plan_md,
  design_md,
  status,
  priority,
  estimate_points,
  assignee_member_id,
  github_repository_id
) on public.issues to authenticated;
grant update (
  title,
  description_md,
  plan_md,
  design_md,
  status,
  priority,
  estimate_points,
  assignee_member_id,
  github_repository_id
) on public.issues to authenticated;
grant select on public.issue_comments to authenticated;
grant insert (workspace_id, issue_id, body_md) on public.issue_comments to authenticated;
grant update (body_md) on public.issue_comments to authenticated;
grant delete on public.issue_comments to authenticated;
grant select on public.issue_links to authenticated;
grant insert (workspace_id, source_issue_id, target_issue_id, link_type) on public.issue_links to authenticated;
grant delete on public.issue_links to authenticated;
grant select on public.github_issue_branches to authenticated;
grant select on public.agent_runs to authenticated;
grant select on public.agent_run_messages to authenticated;

grant execute on function internal.current_workspace_member_id(uuid) to authenticated;
grant execute on function public.current_user_workspace_ids() to authenticated;
grant execute on function public.can_manage_workspace(uuid) to authenticated;
grant execute on function public.next_issue_number(uuid) to authenticated;

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

create policy issues_select_membership
  on public.issues
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy issues_insert_membership
  on public.issues
  for insert
  to authenticated
  with check (workspace_id in (select public.current_user_workspace_ids()));

create policy issues_update_membership
  on public.issues
  for update
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()))
  with check (workspace_id in (select public.current_user_workspace_ids()));

create policy issues_delete_membership
  on public.issues
  for delete
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy issue_comments_select_membership
  on public.issue_comments
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy issue_comments_insert_membership
  on public.issue_comments
  for insert
  to authenticated
  with check (workspace_id in (select public.current_user_workspace_ids()));

create policy issue_comments_update_author_or_manager
  on public.issue_comments
  for update
  to authenticated
  using (
    workspace_id in (select public.current_user_workspace_ids())
    and (
      author_member_id = internal.current_workspace_member_id(workspace_id)
      or public.can_manage_workspace(workspace_id)
    )
  )
  with check (
    workspace_id in (select public.current_user_workspace_ids())
    and (
      author_member_id = internal.current_workspace_member_id(workspace_id)
      or public.can_manage_workspace(workspace_id)
    )
  );

create policy issue_comments_delete_author_or_manager
  on public.issue_comments
  for delete
  to authenticated
  using (
    workspace_id in (select public.current_user_workspace_ids())
    and (
      author_member_id = internal.current_workspace_member_id(workspace_id)
      or public.can_manage_workspace(workspace_id)
    )
  );

create policy issue_links_select_membership
  on public.issue_links
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspace_ids()));

create policy issue_links_insert_membership
  on public.issue_links
  for insert
  to authenticated
  with check (workspace_id in (select public.current_user_workspace_ids()));

create policy issue_links_delete_membership
  on public.issue_links
  for delete
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

do $$
declare
  publication_name text := 'supabase_realtime';
  realtime_target text;
  realtime_targets text[] := array[
    'public.workspaces',
    'public.workspace_members',
    'public.issues',
    'public.issue_comments',
    'public.issue_links',
    'public.github_installations',
    'public.github_repositories',
    'public.github_issue_branches',
    'public.agent_runs',
    'public.agent_run_messages'
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
