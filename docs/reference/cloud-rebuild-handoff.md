# Wallie Cloud Rebuild Handoff

## Purpose

This document translates the current `wallie` repo into a rebuild plan for a new cloud-native implementation using only:

- Vercel
- Supabase

The goal is not to port the codebase line for line. The goal is to preserve the product's core behavior, remove the old local-first and sync-era complexity, and give a team of agents a clean execution plan.

This handoff is based on the repo state inspected on March 30, 2026.

## Executive Summary

The current `main` branch is already mostly a web app backed by Supabase, but it still carries design assumptions from an earlier ElectricSQL + PGlite local-first architecture. The current app surface is worth rebuilding, but the implementation should be simplified.

The rebuild should:

- Use Next.js App Router on Vercel.
- Use Supabase Auth instead of Clerk.
- Use Supabase Postgres + RLS as the system of record.
- Use Supabase Realtime only where collaboration or run status actually needs live updates.
- Use Supabase Storage instead of client-exposed DigitalOcean Spaces credentials.
- Use Vercel route handlers only for privileged and third-party integrations.
- Treat Wallie agent execution as an explicit async job subsystem, not an implicit side effect of issue changes.

## Current Product Surface To Preserve

The existing repo contains these meaningful product capabilities:

- Workspace onboarding and workspace-scoped data isolation.
- Authenticated issue tracking for a workspace.
- Issue list with:
  - filter by status, priority, estimate
  - search by title/description
  - sort by priority, status, created, updated
  - bulk update and bulk delete
- Issue detail page with:
  - title and description editing
  - plan and design fields
  - assignee, status, priority, estimate
  - comments
  - sub-issues
  - relationships: blocked by, blocks, duplicate, related
  - copy as markdown
  - linked GitHub PRs
  - agent run timeline and messages
- GitHub App integration:
  - install per workspace
  - sync repositories
  - assign repository to issue
  - reflect PR status back into issue state via webhook
- Workspace settings:
  - workspace name / slug / logo
  - GitHub integration settings
  - subscription display and Stripe portal
  - encrypted workspace secrets
  - Anthropic API key storage
- Wallie run model:
  - run limits by tier
  - run logs
  - run messages
  - project-mode output into `design` and `plan`
  - code-mode PR creation/update

## What To Drop

These are implementation artifacts, not product requirements:

- ElectricSQL
- PGlite
- local-first write-through sync
- trigger-based sync metadata
- proxy server
- write server
- old client/server migration split
- generic whole-table realtime refetching
- client-exposed Spaces credentials
- email-claim-based workspace lookup as the long-term auth model

These features should stay out of MVP unless explicitly re-requested:

- Kanban board
- offline mode
- full local cache behavior

## Product Cut Line

Build in two layers:

### Layer 1: Core MVP

- Auth
- workspace creation
- issue list
- issue detail
- comments
- sub-issues and relationships
- GitHub App install and repository sync
- issue-to-repo linkage
- PR link display and webhook-based issue status changes
- workspace settings
- subscription display
- encrypted secrets

### Layer 2: Wallie Automation

- explicit run requests
- queued background processing
- run logs and streaming status
- project planning mode
- code PR mode
- retry flows
- free tier usage enforcement

Reason: the repo still models Wallie runs in UI and schema, but the actual long-running executor is no longer present on `main`. The differentiated feature should be rebuilt intentionally rather than inferred from stale code paths.

## Target Architecture

## Stack

- Framework: Next.js 15+ App Router
- Deploy: Vercel
- Database/Auth/Storage/Realtime: Supabase
- Styling: Tailwind CSS
- Rich text: TipTap Markdown mode
- Billing: Stripe
- GitHub integration: GitHub App

## Architecture Principles

- Use server components for initial fetches where it improves first paint.
- Use client components only where interaction or realtime requires them.
- Let low-risk workspace-scoped CRUD go directly from browser to Supabase under RLS.
- Put privileged logic behind Vercel route handlers:
  - workspace bootstrap
  - GitHub install/callback/refresh/webhooks
  - Stripe portal/webhooks
  - secret read/write
  - Wallie run enqueue / control
- Keep realtime narrow and event-driven. Do not refetch whole tables on every change.
- Prefer DB constraints and RPCs for critical invariants.

## Auth Model

Use Supabase Auth.

Recommended auth methods:

- Google OAuth
- GitHub OAuth
- email magic link

Do not rebuild around Clerk.

## Multi-Tenancy Model

Use explicit membership in the database, keyed by `auth.uid()`.

Do not use the current email-claim lookup pattern as the main tenancy model.

## Realtime Model

Use Supabase Realtime only for:

- issue list row updates
- issue detail field updates
- comments
- issue links
- GitHub PR row updates
- agent run status/messages

Do not subscribe to a table and blindly refetch the whole result set on every event. Subscribe to workspace-scoped tables and patch local query caches by primary key.

## Storage Model

Use Supabase Storage for:

- workspace avatars
- editor-uploaded images

Use signed upload URLs or server-mediated uploads. Never ship storage credentials to the browser.

## Background Work Model

Within the Supabase + Vercel constraint:

- store job state in Postgres
- enqueue jobs in a DB table
- trigger processing through Vercel route handlers and/or Vercel cron
- make execution resumable and idempotent

Do not assume a permanently running worker.

If Wallie runs turn out to exceed Vercel execution constraints, keep the schema and UI contract intact and treat executor compute as a later deployment decision. The core rebuild should not depend on hiding that risk.

## Proposed App Routes

Use a workspace-prefixed URL model:

- `/`
  - redirect to the user's last active workspace, or onboarding if none exists
- `/login`
- `/signup`
- `/onboarding/workspace`
- `/w/[workspaceSlug]/issues`
  - list view
  - search, filter, sort via query params
- `/w/[workspaceSlug]/issues/[issueNumber]`
  - issue detail
- `/w/[workspaceSlug]/settings`
- `/w/[workspaceSlug]/settings/github`
  - optional nested settings view
- `/w/[workspaceSlug]/settings/billing`
  - optional nested settings view

Use issue number in URL, not the current formatted `ABC-123` route string. Keep `ABC-123` as display-only.

## Proposed API Routes

Use Vercel route handlers under `app/api`.

- `POST /api/workspaces`
  - create workspace
  - create owner membership
  - create `wallie` system member
- `POST /api/workspaces/[workspaceId]/avatar`
  - optional server-mediated upload flow
- `GET /api/github/install`
  - returns GitHub install URL for current workspace
- `GET /api/github/callback`
  - handles GitHub App callback
- `POST /api/github/refresh-repositories`
  - pulls current repo list for installation
- `POST /api/github/webhooks`
  - GitHub webhook receiver
- `POST /api/stripe/portal`
  - create Stripe customer portal session
- `POST /api/stripe/webhooks`
  - Stripe webhook receiver
- `GET /api/secrets`
  - list secret previews
- `POST /api/secrets`
  - create/update secret
- `DELETE /api/secrets/[key]`
  - delete secret
- `POST /api/agent-runs`
  - enqueue a Wallie run
- `POST /api/agent-runs/[runId]/retry`
  - retry logic
- `POST /api/agent-jobs/process`
  - internal processing entrypoint for cron or manual trigger

## Schema V2

This is the proposed schema to build, not a copy of the current SQL dump.

## Enums

Create these Postgres enums:

- `workspace_tier`: `free`, `pro`
- `member_role`: `owner`, `admin`, `member`, `agent`
- `member_kind`: `human`, `system`
- `issue_status`: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`
- `issue_priority`: `none`, `low`, `medium`, `high`, `urgent`
- `issue_link_type`: `blocked_by`, `sub_issue`, `related`, `duplicate`
- `agent_run_status`: `queued`, `started`, `running`, `success`, `error`, `canceled`
- `agent_job_status`: `queued`, `running`, `success`, `error`, `canceled`
- `agent_trigger_type`: `manual_run`, `manual_retry`, `assignment`, `comment_retry`

## Tables

### `profiles`

Purpose:
- One row per authenticated Supabase user.

Columns:
- `id uuid primary key references auth.users(id) on delete cascade`
- `primary_email text`
- `full_name text`
- `avatar_url text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Notes:
- This is global user identity, not workspace-scoped identity.

### `workspaces`

Purpose:
- Top-level tenant container.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `slug text not null unique`
- `name text not null`
- `avatar_path text`
- `tier workspace_tier not null default 'free'`
- `current_billing_cycle_start_at timestamptz not null default now()`
- `successful_agent_runs_this_cycle integer not null default 0`
- `stripe_customer_id text`
- `created_by uuid references auth.users(id)`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- `slug` should be lowercase plus hyphen format.

### `workspace_members`

Purpose:
- Workspace-scoped actor table for both humans and the `wallie` system user.
- Replaces `app_user`.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `user_id uuid references auth.users(id) on delete cascade`
- `kind member_kind not null`
- `role member_role not null`
- `email text`
- `username text`
- `full_name text`
- `avatar_url text`
- `preferences jsonb not null default '{}'::jsonb`
- `is_active boolean not null default true`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- unique `(workspace_id, user_id)` where `user_id is not null`
- unique `(workspace_id, username)` where `username is not null`
- exactly one `wallie` system member per workspace

Notes:
- Human members have `kind='human'`, `user_id not null`.
- The Wallie actor has `kind='system'`, `role='agent'`, `username='wallie'`.
- `preferences` stores server-backed defaults previously held in local storage.

### `github_installations`

Purpose:
- GitHub App installation per workspace.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `installation_id bigint not null unique`
- `installation_url text not null`
- `app_id bigint not null`
- `target_type text not null`
- `target_name text not null`
- `permissions jsonb not null`
- `suspended boolean not null default false`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Notes:
- Do not persist `access_token` unless GitHub API behavior forces it.
- Prefer minting fresh short-lived installation tokens inside route handlers.

### `github_repositories`

Purpose:
- Repositories available to a workspace through its GitHub App installation.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `github_installation_id uuid not null references github_installations(id) on delete cascade`
- `repo_id bigint not null`
- `name text not null`
- `full_name text not null`
- `private boolean not null`
- `html_url text not null`
- `description text`
- `default_programming_language text`
- `default_branch text`
- `is_archived boolean not null default false`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- unique `(github_installation_id, repo_id)`

### `issues`

Purpose:
- Core issue entity.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `number integer not null`
- `title text not null`
- `description_md text not null default ''`
- `plan_md text`
- `design_md text`
- `status issue_status not null default 'backlog'`
- `priority issue_priority not null default 'none'`
- `priority_rank smallint generated always as (...) stored`
- `estimate_points integer`
- `creator_member_id uuid references workspace_members(id) on delete set null`
- `assignee_member_id uuid references workspace_members(id) on delete set null`
- `github_repository_id uuid references github_repositories(id) on delete set null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- unique `(workspace_id, number)`

Notes:
- `priority_rank` should map `urgent=5`, `high=4`, `medium=3`, `low=2`, `none=1`.
- Do not use `max(number)+1` in the client.
- Create an RPC to allocate the next issue number transactionally.

### `issue_comments`

Purpose:
- Comment thread on issues.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `issue_id uuid not null references issues(id) on delete cascade`
- `author_member_id uuid references workspace_members(id) on delete set null`
- `body_md text not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### `issue_links`

Purpose:
- Relationships between issues.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `source_issue_id uuid not null references issues(id) on delete cascade`
- `target_issue_id uuid not null references issues(id) on delete cascade`
- `link_type issue_link_type not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- unique `(source_issue_id, target_issue_id, link_type)`
- prevent self-links

### `github_issue_branches`

Purpose:
- Track branch and PR state per issue.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `issue_id uuid not null references issues(id) on delete cascade`
- `github_repository_id uuid references github_repositories(id) on delete set null`
- `branch_name text not null`
- `pull_request_number integer`
- `pull_request_url text`
- `pull_request_state text`
- `is_draft boolean`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- unique `(workspace_id, branch_name)`

Notes:
- This replaces the looser current `github_branch` contract while preserving webhook lookup capability.

### `workspace_secrets`

Purpose:
- Encrypted per-workspace secrets.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `key text not null`
- `encrypted_value text not null`
- `value_preview text`
- `created_by_member_id uuid references workspace_members(id) on delete set null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:
- unique `(workspace_id, key)`

Notes:
- Store only encrypted values.
- UI reads previews only through route handlers.

### `agent_jobs`

Purpose:
- Queue and orchestrate Wallie work explicitly.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `issue_id uuid not null references issues(id) on delete cascade`
- `requested_by_member_id uuid references workspace_members(id) on delete set null`
- `trigger_type agent_trigger_type not null`
- `status agent_job_status not null default 'queued'`
- `attempt_count integer not null default 0`
- `last_error text`
- `dedupe_key text`
- `scheduled_at timestamptz`
- `started_at timestamptz`
- `finished_at timestamptz`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Notes:
- Use a partial unique index on active dedupe keys if needed.
- This makes Wallie execution an explicit queue, not implicit polling on issue mutation.

### `agent_runs`

Purpose:
- User-visible run history for Wallie.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `issue_id uuid not null references issues(id) on delete cascade`
- `agent_job_id uuid references agent_jobs(id) on delete set null`
- `triggered_by_member_id uuid references workspace_members(id) on delete set null`
- `run_type text not null`
- `model_provider text not null`
- `model_name text not null`
- `status agent_run_status not null default 'queued'`
- `started_at timestamptz`
- `finished_at timestamptz`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### `agent_run_messages`

Purpose:
- Streamed or persisted messages for a run timeline.

Columns:
- `id uuid primary key default gen_random_uuid()`
- `workspace_id uuid not null references workspaces(id) on delete cascade`
- `agent_run_id uuid not null references agent_runs(id) on delete cascade`
- `kind text not null`
- `message_md text not null`
- `created_at timestamptz not null default now()`

## Required Indexes

- `issues(workspace_id, number desc)`
- `issues(workspace_id, status, priority_rank desc)`
- `issues(workspace_id, assignee_member_id)`
- `issues(workspace_id, github_repository_id)`
- `issue_comments(issue_id, created_at)`
- `issue_links(source_issue_id)`
- `issue_links(target_issue_id)`
- `github_repositories(workspace_id, full_name)`
- `github_issue_branches(issue_id, created_at)`
- `agent_runs(issue_id, created_at desc)`
- `agent_run_messages(agent_run_id, created_at)`

Search indexes:

- `gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description_md,'')))` on `issues`
- optional trigram indexes for `issues.title`, `issues.description_md`

## Required RPCs / DB Functions

### `next_issue_number(workspace_id uuid) returns integer`

Purpose:
- allocate the next issue number atomically

Implementation guidance:
- use a workspace-scoped counter table or transactional row lock
- do not compute in client code

### `current_user_workspace_ids() returns setof uuid`

Purpose:
- helper for RLS

Implementation guidance:
- return workspace ids from `workspace_members` where `user_id = auth.uid()` and `is_active = true`

### `can_manage_workspace(workspace_id uuid) returns boolean`

Purpose:
- helper for privileged RLS checks on client-readable tables

## RLS Plan

## General Rule

Any table with `workspace_id` should scope reads to current workspace membership.

## Client-write tables

Allow authenticated members to read and write:

- `issues`
- `issue_comments`
- `issue_links`
- `workspace_members.preferences` for the current user row only

## Client-read, server-write tables

Allow authenticated members to read, but not write:

- `workspaces`
- `workspace_members`
- `github_installations`
- `github_repositories`
- `github_issue_branches`
- `agent_runs`
- `agent_run_messages`

## Service-only tables

Deny direct client access and expose through route handlers only:

- `workspace_secrets`
- `agent_jobs`

## Onboarding Exception

Workspace creation should happen through a service-role route handler because a user cannot satisfy workspace membership RLS before the workspace exists.

## Data Access Strategy

## Browser direct Supabase access

Use for:

- issue CRUD
- comments
- links
- filtered list reads
- detail reads
- realtime subscriptions

## Vercel route handlers

Use for:

- anything requiring service role
- third-party API secrets
- anything involving encryption
- webhook verification
- billing
- Wallie job orchestration

## UI/UX Mapping From Current Repo

Rebuild these current screens:

- Issue list
- Issue detail
- Create issue modal
- Workspace settings
- GitHub integration
- Subscription view
- Anthropic key management

Simplify these:

- Command bar
- menus and selectors
- sidebar navigation

Do not carry over every current component abstraction. The current component surface is larger than needed for a clean rebuild.

## Feature-by-Feature Rebuild Notes

## Issue List

Keep:

- active / backlog / done quick filters
- query-string-driven filters
- bulk select and bulk mutate
- search

Change:

- use server-rendered first load plus client cache hydration
- patch realtime updates by row id instead of full refetch
- store ordering preference in `workspace_members.preferences`, not localStorage

## Issue Detail

Keep:

- inline editing
- plan and design sections
- comments
- relationships
- sub-issues
- PR section
- copy as markdown
- Wallie run timeline

Change:

- route by workspace slug and issue number
- use explicit query objects / typed data layer
- move duplicate data fetches into a single issue detail loader

## GitHub Integration

Keep:

- one installation per workspace
- repo refresh
- default programming language selection
- webhook-driven issue status changes

Change:

- do not let client delete installation rows directly
- installation removal should go through a route handler
- treat repos and PR metadata as server-owned state

## Secrets

Keep:

- per-workspace secrets
- preview-only listing
- encryption at rest with app-controlled key

Change:

- route-handler only access
- store creator by `workspace_members.id`, not raw auth provider id

## Billing

Keep:

- workspace tier
- monthly run counter
- Stripe webhook updates
- customer portal

Change:

- separate billing display from Wallie runtime implementation
- enforce run limits in the Wallie job enqueue path

## Wallie Run Subsystem

This is the one area where the rebuild should not imitate the current `main` branch mechanically.

## Intended Behavior To Preserve

From repo history, Wallie runs were intended to work like this:

- a workspace has a system actor named `wallie`
- an issue can be assigned to `wallie`
- if the issue is connected to a repo, Wallie can work on it
- project-mode issues write `design` and `plan`
- code-mode issues create or update PRs
- runs are logged
- messages are visible in the issue timeline
- free-tier run count is enforced

## Proposed Rebuild Behavior

Use explicit user actions:

- `Run with Wallie`
- `Retry run`

Optional later automation:

- auto-enqueue when an issue is assigned to `wallie`

Reason:

- explicit runs are easier to reason about
- easier to debug on Vercel
- easier to meter for billing
- fewer accidental executions

## Wallie Job Flow

1. User clicks `Run with Wallie`.
2. Route handler validates workspace membership, repo linkage, secret availability, and billing limits.
3. Route handler creates:
   - `agent_jobs` row with `queued`
   - `agent_runs` row with `queued`
4. Processor claims queued job.
5. Processor updates `agent_runs.status` to `started` / `running`.
6. Processor appends `agent_run_messages`.
7. Processor either:
   - updates `design_md` and `plan_md`
   - or creates/updates branch + PR metadata
8. Processor sets final status.
9. On success, increment workspace monthly run count.

## Known Risk

If the final Wallie executor is long-running, Vercel runtime limits may constrain direct execution. Build the queue, data model, UI, and control plane first. Keep the executor contract isolated so compute strategy can be swapped without reworking the product.

## Recommended Repo Structure For The New Build

```text
app/
  (auth)/
  onboarding/
  w/[workspaceSlug]/
    issues/
    settings/
  api/
    workspaces/
    github/
    stripe/
    secrets/
    agent-runs/
components/
lib/
  supabase/
  auth/
  github/
  billing/
  wallie/
  validation/
  db/
features/
  issues/
  workspaces/
  settings/
  github/
  wallie/
supabase/
  migrations/
  seed.sql
```

## Phased Implementation Plan

## Phase 0: Decisions and Scaffold

Deliverables:

- new repo scaffold
- env model
- route conventions
- shared TS types
- formatting, lint, test baseline

Acceptance criteria:

- app boots on Vercel locally
- Supabase local/dev env works
- CI runs typecheck, lint, tests, build

## Phase 1: Auth, Workspace, and Shell

Deliverables:

- Supabase Auth
- profiles table
- workspace creation flow
- membership model
- app shell and workspace-scoped routing

Acceptance criteria:

- new user can sign in
- new user can create first workspace
- owner membership and `wallie` system member are created transactionally
- root redirects correctly

## Phase 2: Issue Tracking MVP

Deliverables:

- issue schema
- next issue number RPC
- issue list page
- create issue
- issue detail
- comment system
- relationships and sub-issues
- filter / search / sort / bulk updates

Acceptance criteria:

- workspace can run the full issue workflow without server-side custom APIs for basic CRUD
- realtime updates are visible across two browser sessions

## Phase 3: Settings, Storage, and Preferences

Deliverables:

- workspace settings
- avatar upload via Supabase Storage
- server-backed display preferences
- secret management UI and API

Acceptance criteria:

- no storage credentials are exposed to browser
- preferences survive device changes

## Phase 4: GitHub Integration

Deliverables:

- GitHub App install flow
- installation persistence
- repo sync
- default repo language metadata
- PR webhook mapping to issue states

Acceptance criteria:

- workspace can install GitHub App
- repos appear in settings
- issue can be linked to repo
- webhook updates issue status reliably

## Phase 5: Billing

Deliverables:

- Stripe portal
- workspace tier display
- webhook handling
- monthly counter reset

Acceptance criteria:

- upgrade and downgrade flows update workspace tier
- portal redirect works

## Phase 6: Wallie Runs

Deliverables:

- enqueue path
- job processor
- run timeline
- message logging
- project-mode writes
- code-mode PR writes
- retry path

Acceptance criteria:

- a run can be started intentionally
- user sees live or near-live state changes
- final status, messages, and PR/design/plan results are stored

## Phase 7: Hardening

Deliverables:

- audit RLS
- integration tests
- observability
- rate limits
- webhook replay safety
- idempotency

Acceptance criteria:

- critical flows are covered end-to-end
- webhooks are idempotent
- failure states are visible and recoverable

## Agent Work Breakdown

Run these in parallel where dependencies allow.

## Agent 1: Platform Foundation

Owns:

- Next.js scaffold
- environment loading
- base layouts
- shared UI primitives
- CI and quality tooling

Files/modules:

- `app/`
- `components/ui/`
- `lib/env.ts`
- lint, tsconfig, test setup, CI

Dependencies:

- none

Definition of done:

- working app shell
- deployable preview
- shared component baseline

## Agent 2: Data Model and RLS

Owns:

- Supabase migrations
- enums
- tables
- indexes
- RLS
- RPCs
- seed data

Files/modules:

- `supabase/migrations/*`
- `supabase/seed.sql`
- `lib/db/types.ts`

Dependencies:

- coordinate with Agent 1 on type generation location

Definition of done:

- schema applies cleanly
- RLS is correct
- `next_issue_number` exists

## Agent 3: Auth, Onboarding, and Workspace Shell

Owns:

- auth flows
- onboarding
- workspace create route
- workspace redirects
- workspace slug routing

Files/modules:

- `app/(auth)/*`
- `app/onboarding/*`
- `app/api/workspaces/route.ts`
- `app/w/[workspaceSlug]/layout.tsx`

Dependencies:

- Agent 2 schema

Definition of done:

- sign in works
- first workspace bootstrap works

## Agent 4: Issues List and Bulk Actions

Owns:

- issue list page
- filter and sort state
- search
- bulk actions
- create issue modal

Files/modules:

- `features/issues/list/*`
- `features/issues/create/*`
- `app/w/[workspaceSlug]/issues/page.tsx`

Dependencies:

- Agents 1, 2, 3

Definition of done:

- full issue list flow works

## Agent 5: Issue Detail and Collaboration

Owns:

- issue detail page
- description / plan / design editors
- comments
- sub-issues
- relationships
- copy as markdown
- timeline shell

Files/modules:

- `features/issues/detail/*`
- `app/w/[workspaceSlug]/issues/[issueNumber]/page.tsx`

Dependencies:

- Agents 1, 2, 3

Definition of done:

- issue detail workflow is complete

## Agent 6: GitHub Integration

Owns:

- GitHub App route handlers
- repo sync
- webhook receiver
- GitHub settings UI
- PR metadata persistence

Files/modules:

- `app/api/github/*`
- `features/github/*`
- `features/settings/github/*`

Dependencies:

- Agents 1, 2, 3

Definition of done:

- full install -> sync -> webhook loop works

## Agent 7: Wallie Run Orchestration

Owns:

- agent job schema usage
- run enqueue path
- processor entrypoint
- run lifecycle
- run messages
- retry mechanics

Files/modules:

- `app/api/agent-runs/*`
- `lib/wallie/*`
- `features/wallie/*`

Dependencies:

- Agents 1, 2, 3, 5, 6, 8

Definition of done:

- run lifecycle is visible and reliable even if executor logic is still stubbed

## Agent 8: Billing, Secrets, Storage, and Operations

Owns:

- Stripe integration
- secret encryption route handlers
- storage upload flow
- cron jobs
- observability and rate limiting

Files/modules:

- `app/api/stripe/*`
- `app/api/secrets/*`
- `lib/billing/*`
- `lib/secrets/*`
- `lib/storage/*`
- `lib/observability/*`

Dependencies:

- Agents 1, 2, 3

Definition of done:

- settings integrations are safe and production-ready

## Agent Prompts

These are meant to be copied directly into agents. They assume a greenfield rebuild repo, not this current codebase.

## Prompt: Agent 1

You own platform foundation for the Wallie cloud rebuild. Build a Next.js App Router app for Vercel with TypeScript, Tailwind, linting, test setup, env validation, and a minimal workspace-aware shell. You are not alone in the codebase. Other agents will work in parallel, so do not overwrite unrelated work and keep shared surfaces stable. Your scope is app bootstrap, shared UI primitives, root layouts, providers, and CI/tooling. Do not implement business features deeply. Deliver a deployable foundation with clear extension points and list every file you changed.

## Prompt: Agent 2

You own the Supabase schema for the Wallie cloud rebuild. Build the schema described in the handoff document: enums, tables, indexes, RLS, helper functions, and the `next_issue_number` RPC. You are not alone in the codebase. Other agents will depend on your schema, so keep names stable and avoid broad refactors outside `supabase/` and generated DB typing surfaces. Prioritize correctness and tenant isolation. Add seed data where it materially helps local development. List every file you changed.

## Prompt: Agent 3

You own auth, onboarding, workspace bootstrap, and workspace-scoped routing for the Wallie cloud rebuild. Implement Supabase Auth flows, onboarding for first workspace creation, root redirect behavior, and the workspace route shell under `/w/[workspaceSlug]`. You are not alone in the codebase. Do not rewrite shared primitives from Agent 1 or schema owned by Agent 2. Use the DB model from the handoff doc. Deliver a clean first-run experience and list every file you changed.

## Prompt: Agent 4

You own the issue list experience for the Wallie cloud rebuild. Implement issue list reads, create issue flow, filter/search/sort state, and bulk actions. You are not alone in the codebase. Other agents are building the shell and detail view, so keep your write scope to list/create modules and issue list routes. Use direct Supabase CRUD under RLS where appropriate. Do not add ad hoc server APIs for basic issue CRUD unless strictly necessary. List every file you changed.

## Prompt: Agent 5

You own the issue detail and collaboration experience for the Wallie cloud rebuild. Implement the issue detail page, rich markdown editing for description/plan/design, comments, sub-issues, relationship links, copy-as-markdown, and the issue timeline shell. You are not alone in the codebase. Do not step on Agent 4 list code or Agent 7 Wallie orchestration internals. Build against the schema in the handoff document and list every file you changed.

## Prompt: Agent 6

You own GitHub integration for the Wallie cloud rebuild. Implement GitHub App install flow, callback handling, repository sync, settings UI, and webhook-driven issue/PR state updates. You are not alone in the codebase. Treat GitHub installation and repository rows as server-owned state; do not expose privileged write paths to the browser. Coordinate with the schema in the handoff document and list every file you changed.

## Prompt: Agent 7

You own Wallie run orchestration for the Wallie cloud rebuild. Implement explicit run enqueueing, job state transitions, run records, run messages, retry behavior, and UI-visible statuses. You are not alone in the codebase. Other agents will provide issue detail, secrets, billing, and GitHub primitives. Do not assume a permanent worker; make execution resumable and idempotent under Vercel constraints. It is acceptable to stub the final model executor if the control plane is solid. List every file you changed.

## Prompt: Agent 8

You own billing, encrypted secrets, storage uploads, cron flows, and operational hardening for the Wallie cloud rebuild. Implement Stripe portal + webhooks, secret management route handlers with encryption, Supabase Storage upload flows, rate limiting, and operational scaffolding. You are not alone in the codebase. Keep your write scope to these infrastructure concerns and do not rework issue UI owned by others. List every file you changed.

## Open Questions To Resolve Early

- Is Wallie automation part of MVP, or does MVP stop at collaborative issue tracking plus GitHub metadata?
- Should root issue URLs be `/w/[slug]/issues/[number]` or vanity slug routes like `/<slug>/issues/[number]`?
- Which auth methods are required on day one?
- Do we want auto-run on assignment to `wallie`, or only explicit runs in the first release?
- Does the first rebuild need board view back?

## Recommended First Sprint

- Agent 1 starts platform scaffold.
- Agent 2 starts schema and RLS.
- Agent 3 starts auth/onboarding against draft schema.
- Agent 4 starts list/create UX once `issues` table and RPC shape are stable.
- Agent 5 starts detail UX once issue shape is stable.
- Agent 6 starts GitHub app server contract in parallel with settings shell.
- Agent 8 starts secrets/billing/storage route contracts in parallel.
- Agent 7 starts only after issue, secret, and GitHub contracts are clear.

## Final Recommendation

Do not rebuild this as “current repo minus Electron.” Rebuild it as:

- a clean multi-tenant issue tracker first
- a GitHub-integrated collaboration tool second
- a Wallie automation platform third

That sequencing preserves the real product value while reducing implementation risk.
