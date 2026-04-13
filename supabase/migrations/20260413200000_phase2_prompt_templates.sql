-- Phase 2: Agent Runner Integration
--
-- 1. workspace_prompt_templates — per-workspace, per-phase prompt templates
-- 2. agent_runs.issue_id becomes nullable (sessions may not have an issue)
-- 3. session_pull_requests gets a unique constraint for upsert support

-- ---------------------------------------------------------------------------
-- 1. Prompt Templates
-- ---------------------------------------------------------------------------

create table if not exists public.workspace_prompt_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  phase public.session_phase not null,
  template_md text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_prompt_templates_workspace_phase_key unique (workspace_id, phase)
);

create index if not exists idx_workspace_prompt_templates_workspace
  on public.workspace_prompt_templates(workspace_id);

alter table public.workspace_prompt_templates enable row level security;

create policy "workspace_prompt_templates_select"
  on public.workspace_prompt_templates for select to authenticated
  using (workspace_id in (select current_user_workspace_ids()));

create policy "workspace_prompt_templates_insert"
  on public.workspace_prompt_templates for insert to authenticated
  with check (can_manage_workspace(workspace_id));

create policy "workspace_prompt_templates_update"
  on public.workspace_prompt_templates for update to authenticated
  using (can_manage_workspace(workspace_id))
  with check (can_manage_workspace(workspace_id));

create policy "workspace_prompt_templates_delete"
  on public.workspace_prompt_templates for delete to authenticated
  using (can_manage_workspace(workspace_id));

create policy "workspace_prompt_templates_service_role_all"
  on public.workspace_prompt_templates for all to service_role
  using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 2. Make agent_runs.issue_id nullable
-- ---------------------------------------------------------------------------
-- Sessions created without a Linear issue have no issue_id. The engineering
-- phase creates agent_runs for these sessions.

alter table public.agent_runs alter column issue_id drop not null;

-- ---------------------------------------------------------------------------
-- 3. Unique constraint on session_pull_requests for upsert
-- ---------------------------------------------------------------------------

alter table public.session_pull_requests
  add constraint session_pull_requests_session_branch_key
  unique (session_id, branch_name);
