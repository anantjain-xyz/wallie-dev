# Wallie as "Easy-to-Use Symphony": Comparison & Roadmap

## Context

[Symphony](https://github.com/openai/symphony) is OpenAI's spec for a daemon service that orchestrates coding agents (Codex) to autonomously execute project work from issue trackers like Linear. It polls for issues, provisions isolated filesystem workspaces, launches multi-turn coding agent sessions, handles retries/backoff/reconciliation, and operates as a headless CLI daemon.

Wallie is a web-based AI product development platform (Next.js + Supabase) with a 6-phase approval pipeline, Slack integration, multi-tenancy, and a real-time UI. It currently generates product specs via Claude but has no autonomous code execution.

**Vision:** Wallie becomes an "easy to use" version of Symphony -- the complex daemon configuration (WORKFLOW.md, workspace setup, subprocess management) is abstracted behind Wallie's web UI, approval flows, and multi-tenant platform.

---

## 1. Feature-by-Feature Comparison

| Symphony Concept | Wallie Equivalent | Gap |
|---|---|---|
| **WORKFLOW.md** (YAML config + Liquid prompt template, hot-reload) | Phase order hard-coded in `src/features/sessions/types.ts`. Agent prompt hard-coded in `src/lib/pipeline/product-agent.ts`. No template system. | **Critical** -- No user-configurable workflow or prompt templates |
| **Config Layer** (typed defaults, `$VAR` indirection) | Zod env validation (`src/env/server.ts`), encrypted workspace secrets (`src/lib/secrets/crypto.ts`), hard-coded constants in `src/lib/wallie/constants.ts` | **Moderate** -- Has secrets infra, but no UI for agent tunables (concurrency, timeouts, model) |
| **Issue Tracker Polling** (polls Linear for candidates, pagination, state mapping) | Single-issue Linear fetch (`src/lib/linear/client.ts`). No polling. Triggered by Slack @mention or UI. | **Deferred** -- Wallie's trigger-based model (Slack + UI) works well for now. Autonomous polling is a future enhancement. |
| **Orchestrator** (in-memory state machine, polling loop, bounded concurrency, reconciliation) | Session state machine (`src/lib/pipeline/state-machine.ts`), `approve_session_phase` RPC. Jobs processed on-demand via HTTP. No concurrency limits. No polling loop. No reconciliation. | **Critical** -- No autonomous scheduling |
| **Workspace Manager** (per-issue filesystem dirs, lifecycle hooks, path containment) | No filesystem concept. Artifacts stored as JSONB in `session_artifacts`. Stub executor records branch names only. | **Critical** -- Biggest single gap. No place for agents to run code. |
| **Agent Runner** (Codex subprocess, JSON-RPC over stdio, multi-turn, approval handling) | Product agent: single-shot Claude API call for structured JSON (`src/lib/pipeline/product-agent.ts`). Stub executor: deterministic strings (`src/lib/wallie/executor.ts`). | **Critical** -- No real coding agent integration |
| **Multi-turn Continuation** (turns on same thread, re-checks tracker state between turns) | Not implemented. All agent calls are single-shot. | **Major** -- Required for non-trivial coding tasks |
| **Retry & Backoff** (exponential backoff, continuation retries, configurable max) | `agent_jobs.attempt_count` exists. Retry is manual (user clicks reject/retry). No automatic retry. | **Moderate** -- Infrastructure exists, logic missing |
| **Stall Detection** (kills inactive sessions past timeout) | Not implemented. Stuck `agent_generating` stays stuck. | **Moderate** |
| **Reconciliation** (every tick checks tracker state for running issues) | Not implemented. | **Moderate** |
| **Observability** (structured logs, optional HTTP dashboard, JSON REST API, token accounting) | Web UI dashboard at `/w/[slug]/pipeline`. Session detail with run history. `agent_run_messages` table. No token accounting. No REST API. | **Minor** -- UI is better than Symphony's; missing programmatic API |
| **Security** (workspace filesystem isolation, path validation, harness hardening) | Multi-tenant RLS, encrypted secrets, prompt injection protection (`src/lib/pipeline/prompt-safety.ts`). No filesystem isolation (no filesystem yet). | Wallie stronger on tenant isolation; weaker on sandbox (N/A currently) |
| **Approval Flow** | Not in Symphony (agents do ticket writing via tools) | **Wallie far ahead** -- atomic `approve_session_phase` RPC, rejection feedback, escalation threshold |
| **Web UI** | Symphony non-goal | **Wallie far ahead** -- full Next.js UI with real-time updates |
| **Multi-Tenancy** | Symphony is single-tenant daemon | **Wallie far ahead** -- workspaces, RLS, roles, encrypted per-workspace secrets |
| **Slack Integration** | Not in Symphony | **Wallie far ahead** -- full Slack App (triggers, approve/reject buttons, feedback modals, escalation DMs) |
| **GitHub Integration** | Not direct (agents use git tools) | **Wallie has infra** -- GitHub App, webhook handling, PR tracking. Needs to use it for actual code push. |

---

## 2. What Wallie Already Does Better

1. **Human-in-the-loop approval pipeline** -- 6-phase pipeline with per-phase approval gates, rejection feedback loops, escalation at 3 rejections. The `approve_session_phase` RPC is an atomic CAS-guarded transaction. Symphony has no approval workflow.

2. **Multi-tenant SaaS architecture** -- Workspaces with RLS, encrypted per-workspace secrets, role-based access. Symphony is single-tenant.

3. **Dual-channel interaction** -- Slack + web UI interchangeably. Real-time updates via Supabase Realtime.

4. **Artifact versioning with feedback audit trail** -- `session_artifacts` stores every version with the feedback that triggered each revision.

5. **Existing job queue infrastructure** -- `agent_jobs` with CAS claiming, dedupe keys, status tracking, attempt counts. Solid foundation to extend.

---

## 3. Critical Gaps (Priority Order)

1. **No coding agent execution engine** -- Wallie cannot launch an agent that reads/writes files, runs commands, and produces commits.
2. **No filesystem workspace management** -- No isolated directories for agents to clone repos and work in.
3. **No orchestration loop** -- One job per HTTP request, no background scheduler.
4. **No per-workspace agent configuration UI** -- All tunables are compile-time constants.
5. **No multi-turn agent sessions** -- Single-shot API calls only.

*Deferred: Autonomous Linear polling. Wallie's trigger-based model (Slack @mention + UI) works well for now.*

---

## 4. Roadmap

### Phase 0: Foundation Cleanup
*Unblock the new architecture by cleaning up legacy shims.*

- **0.1** Drop the anchor `issues` table shim. Add `agent_jobs.session_id` FK. Migrate data loaders to reference sessions directly.
- **0.2** Delete stub wallie executor (`src/lib/wallie/executor.ts`, `src/lib/wallie/core.ts`, `src/lib/wallie/types.ts`).
- **0.3** Add `workspace_agent_config` table: `(workspace_id, key, value_json)` with keys for `concurrency_limit`, `stall_timeout_ms`, `max_retries`, `agent_provider`, `agent_model`.
- **0.4** Build "Coding Agent" settings section on workspace settings page (`src/features/settings/settings-page-client.tsx`).

### Phase 1: Worker Infrastructure
*Build the execution backbone that replaces Symphony's daemon loop.*

- **1.1** **Worker Process** -- Standalone Node.js process (not Vercel serverless) that:
  - Connects to same Supabase database
  - Runs a polling loop claiming queued `agent_jobs` via CAS
  - Respects per-workspace `concurrency_limit`
  - Reports heartbeats (new column or table)
  - Deployable as Docker container / Fly.io / Railway / bare VM
- **1.2** **Workspace Manager** (`src/lib/workspace-manager/`):
  - `createWorkspace(sessionId, repoUrl, branch)` -- clones repo, checks out new branch
  - `destroyWorkspace(sessionId)` -- removes directory
  - Path containment validation (no symlink escapes)
  - Deterministic workspace paths keyed on session ID
- **1.3** **Stall detection** -- `last_activity_at` on `agent_runs`, worker updates on every event, reconciliation sweep kills stalled runs
- **1.4** **Reconciliation** -- Worker periodically checks Linear issue state for running sessions, stops agents for terminal/non-active states

### Phase 2: Agent Runner Integration
*Wire up a real coding agent for the engineering phase.*

- **2.1** **Agent Runner** (`src/lib/agent-runner/`):
  - Abstract interface: `AgentRunner.start(sessionId, workspacePath, prompt) -> AsyncIterable<AgentEvent>`
  - Claude Code implementation: launches `claude` CLI as subprocess, streams output
  - Codex implementation (optional): JSON-RPC app-server protocol
  - Events streamed to `agent_run_messages` for real-time UI
- **2.2** **Multi-turn continuation**:
  - After each turn: check completion signal, commit state, Linear issue state
  - Configurable max turns (default 5, from `workspace_agent_config`)
  - Between turns: push in-progress commit, update `session_pull_requests`
- **2.3** **Prompt template system**:
  - New table `workspace_prompt_templates (workspace_id, phase, template_md)`
  - Liquid-compatible templates with variables: `{{issue.title}}`, `{{issue.description}}`, `{{attempt.number}}`, `{{attempt.feedback}}`, `{{repo.name}}`
  - Built-in defaults per phase, customizable per workspace via settings UI
- **2.4** **Wire engineering phase** -- Replace `runManualPhaseStub` for `engineering` in `src/lib/pipeline/processor.ts` with real agent runner (provision workspace, render prompt, launch agent, stream events, create PR, store in `session_pull_requests`)

### Phase 3: Real Agents for Remaining Phases

- **3.1** **Design phase** -- Takes approved product spec, generates technical design doc via Claude
- **3.2** **Review phase** -- Checks out PR branch, runs lint/typecheck/tests, produces review artifact with pass/fail
- **3.3** **Land phase** -- Merges approved PR via GitHub App API, updates `session_pull_requests`
- **3.4** **Monitor phase** -- Post-land regression check (configurable window, optional error tracker integration)

### Phase 4: Operational Hardening

- **4.1** **Exponential backoff** -- `next_retry_at = now + min(base * 2^attempt, max_backoff)` stored on `agent_jobs.scheduled_at`
- **4.2** **Token accounting** -- `agent_runs.{input_tokens, output_tokens, total_cost_usd}`, displayed on session detail and workspace usage page
- **4.3** **REST API** -- `/api/v1/sessions` (list), `/api/v1/sessions/:id` (detail), `POST /api/v1/sessions/:id/refresh`. Authenticated with workspace API keys.
- **4.4** **Worker health dashboard** -- `/w/[slug]/workers` page showing heartbeats, active count, queue depth, error rate

### Future: Autonomous Polling (Deferred)

*When the trigger-based model is no longer sufficient:*
- Extend Linear client with paginated candidate queries
- Add Linear Poller to worker process (per-workspace polling config)
- Polling configuration UI (enable/disable, project picker, status filters, interval)

---

## 5. Key Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Where agents run** | Standalone worker process (not Vercel serverless) | Vercel functions timeout at 60-300s. Coding tasks take minutes to hours. Worker connects to same Supabase DB. |
| **Agent provider** | Abstracted interface supporting Claude Code CLI, Codex, future providers | "Easy to use" = users pick provider in settings UI, not edit WORKFLOW.md |
| **Workspace isolation** | Per-session directories on worker filesystem initially; Docker containers later | Start simple like Symphony, upgrade for multi-tenant safety |
| **Communication** | Database as job queue (Postgres via Supabase) | Web app enqueues, worker drains. No extra message broker. Preserves existing `agent_jobs` infra. |
| **Incremental delivery** | Each phase independently valuable | Teams can use Wallie after Phase 2. Approval pipeline provides safety Symphony lacks. |

---

## 6. Verification Plan

After each phase:
- **Phase 0:** `pnpm check` passes. Settings page renders new config section. Legacy executor code removed.
- **Phase 1:** Worker process starts, claims a queued job, provisions a workspace directory, clones a repo, and cleans up. Stall detection kills a simulated stuck run.
- **Phase 2:** End-to-end: create session via Slack mention -> product spec generated -> approve -> engineering phase launches real agent in workspace -> agent makes code changes -> PR created -> appears in session detail UI.
- **Phase 3:** Full pipeline runs from issue creation through PR merge with human approvals at each gate.
- **Phase 4:** Failed jobs retry with backoff. Token usage visible. REST API returns session state.

---

## Critical Files to Modify

- `src/lib/pipeline/processor.ts` -- Phase routing hub; replace manual stubs with real agent runners
- `src/lib/wallie/service.ts` -- Job claiming/processing; extract into standalone worker
- `supabase/migrations/` -- New tables: `workspace_agent_config`, `workspace_prompt_templates`; new columns on `agent_runs`
- `src/lib/wallie/executor.ts` -- Delete and replace with real agent runner
- `src/app/api/slack/events/route.ts` -- Extract session-creation logic into shared function
- `src/features/settings/` -- New UI sections for agent config and prompt templates
