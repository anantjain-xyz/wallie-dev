---
tracker:
  kind: linear
  api_key: ${LINEAR_API_KEY}
  # Linear workspace slug from the URL (linear.app/<workspace>/...). Optional;
  # when set, the dashboard renders direct "linear ↗" links on issue and
  # session pages. Sourced from .env.local — leave the placeholder as-is.
  workspace: ${SYMPHONY_LINEAR_WORKSPACE}
  # Restrict the worker to one team in the workspace by issue-identifier prefix
  # (e.g. "PB-"). Required when the API key has access to multiple teams in
  # one workspace. Sourced from .env.local; if unset, no filter is applied.
  identifier_prefix: ${SYMPHONY_TRACKER_PREFIX}
  # Restrict the worker to a single Linear project (by project UUID — find it
  # in the project URL or via the API). Stricter than identifier_prefix; both
  # may be set, in which case the filters intersect. Sourced from .env.local;
  # if unset, no project filter is applied.
  project_id: ${SYMPHONY_TRACKER_PROJECT_ID}
  active_states:
    - todo
    - in progress
    - rework
    - merging
  terminal_states:
    - done
    - canceled

polling:
  interval_ms: 30000

workspace:
  root: ${TMPDIR}/symphony-workspaces

hooks:
  after_create: |
    git clone "$REPO_URL" .
    git checkout -B "${ISSUE_BRANCH:-symphony/${ISSUE_IDENTIFIER}}"
    eval "${SYMPHONY_INSTALL_CMD:-npm ci}"
  before_run: |
    echo "starting attempt for ${ISSUE_IDENTIFIER}"
  after_run: |
    echo "finished attempt for ${ISSUE_IDENTIFIER}"
  timeout_ms: 60000

agent:
  # Which backend to drive. `codex` spawns `codex-adapter.mjs`; `claude` spawns
  # `claude-adapter.mjs` and supports `pnpm --filter @symphony/worker attach
  # <issue>` to resume the same session from your own terminal.
  backend: claude
  max_concurrent_agents: 4
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    in progress: 2

codex:
  command: node ${SYMPHONY_CODEX_ADAPTER}
  approval_policy: never
  thread_sandbox: workspace-write
  network_access: true
  turn_timeout_ms: 3600000

claude:
  command: node ${SYMPHONY_CLAUDE_ADAPTER}
  # default | acceptEdits | auto | bypassPermissions | dontAsk | plan
  permission_mode: auto
  # Workflow-essential tools the agent needs in every target repo. The target
  # repo's .claude/settings.json can layer in repo-specific extras on top.
  allowed_tools:
    # GitHub CLI (PR create/view/comment/merge, gh api, gh auth status, gh run)
    - Bash(gh *)
    # Git read + the mutating ops the workflow needs (commit/push/branch/etc).
    # Destructive forms (reset --hard, push --force*, clean -f*) intentionally omitted.
    - Bash(git status*)
    - Bash(git log*)
    - Bash(git diff*)
    - Bash(git show*)
    - Bash(git branch*)
    - Bash(git checkout*)
    - Bash(git switch*)
    - Bash(git add*)
    - Bash(git commit*)
    - Bash(git push)
    - Bash(git push origin*)
    - Bash(git pull*)
    - Bash(git fetch*)
    - Bash(git merge*)
    - Bash(git rebase*)
    - Bash(git remote*)
    - Bash(git stash*)
    - Bash(git rev-parse*)
    - Bash(git ls-files*)
    - Bash(git config --get*)
    # Read-only diagnostics the agent commonly probes for.
    - Bash(which *)
    - Bash(node --version)
    - Bash(npm --version)
    - Bash(pnpm --version)
    - Bash(python3 --version)
    # Fetching canonical boilerplate docs (LICENSE, CODE_OF_CONDUCT, ...) — see Guardrails.
    - Bash(curl *)
  disallowed_tools: []
  add_dirs: []
  turn_timeout_ms: 3600000
---

You are working on issue **{{identifier}}: {{title}}**.

## Issue context

- Identifier: {{identifier}}
- Title: {{title}}
- Current state: {{state}}
- Branch: {{branch}}
- Labels: {{#labels.length}}{{#labels}}{{.}} {{/labels}}{{/labels.length}}
{{#description}}

## Description

{{description}}
{{/description}}
{{#blockers.length}}

## Blockers

{{#blockers}}
- {{.}}
{{/blockers}}
{{/blockers.length}}

## Instructions

1. Unattended orchestration. Never ask a human for follow-up actions.
2. Only stop early for a true blocker (missing non-GitHub auth/secrets/tools after fallbacks). Record blocker in the workpad and move the issue per the escape hatch.
3. Final message reports completed actions and blockers only — no "next steps for the user".
4. Work only in the provided repository copy.

## Skills (progressive disclosure)

Repeatable mechanics live under `.agents/skills/<name>/SKILL.md` (the canonical, runner-agnostic location; `.claude/skills/<name>` are symlinks Claude Code uses for auto-discovery). Reach for them by name — your runner will surface the right one on demand:

| Skill | Use when |
|---|---|
| `workpad` | finding, bootstrapping, updating, or resetting the Symphony Workpad on a Linear issue |
| `pull` | syncing the branch with `origin/main` and resolving conflicts |
| `commit` | creating a well-formed git commit from staged changes |
| `push` | pushing the branch and ensuring a PR exists with the `symphony` label |
| `pr-feedback` | sweeping the PR for actionable reviewer feedback before `In Review` |
| `land` | squash-merging the PR once approved and green (entered via `Merging`) |

This workflow tells you *which* skill applies at each step; the skill body has the exact commands and gotchas. Don't re-derive what's already in a skill.

## Environment

Facts about this run — do not waste turns rediscovering them.

- **Linear**: the Linear MCP server is the primary path — use its tools (`mcp__linear-server__*`) directly. If — and only if — no Linear MCP tools appear in your environment, fall back to the HTTP API: `curl -fsS -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" https://api.linear.app/graphql -d '{"query":"..."}'`. `$LINEAR_API_KEY` is always present. Do not spend turns probing — one of these two paths is configured.
- **Linear MCP gotchas**: `mcp__linear-server__save_comment` with a `commentId` creates a NEW comment instead of updating in place — see the `workpad` skill for the GraphQL `commentUpdate` workaround. `mcp__linear-server__create_attachment` only accepts file uploads (base64); for URL attachments (e.g., a PR link), the auto-link from `git push` usually suffices, otherwise use `attachmentLinkCreate` / `attachmentLinkGitHubPR` via GraphQL.
- **GitHub**: `gh` CLI is authenticated. `gh pr edit --add-label` currently 500s with a Projects-classic GraphQL deprecation — the `push` skill applies the `symphony` label via REST.
- **Workspace**: already `cd`'d into `$TMPDIR/symphony-workspaces/<IDENTIFIER>/`; branch is checked out; `npm ci` already ran via `after_create`. The `.symphony-workspace-ready` file at the workspace root is the init sentinel — ignore it in `git status` and never `git add` it.
- **Deferred tools you will likely need**: load in a single call — `ToolSearch("select:TodoWrite,WebFetch")`. Do not make multiple discovery queries.

## Attempt N > 1 fast-path

If this is a retry (attempt number > 1 or the workpad already exists), do these **before** regenerating anything:

1. Read the existing `## Symphony Workpad` comment in full — it is the canonical state; the orchestrator's retry-context trailer may be empty or stale.
2. Run `git status && git log --oneline origin/main..HEAD` to see what prior attempts already committed. Pick up their work; do not re-do committed files.
3. Scan the workpad `### Confusions` and `### Notes` for known failure modes (content-filter hits, tool access, flaky tests) and avoid repeating them.
4. If the workpad's last-update timestamp is older than the prior attempt's start, prior attempts died mid-stream without persisting — rebuild your picture from repo state (committed files, open PR) rather than the workpad's plan alone.
5. **No-op redispatch short-circuit.** Only applies when the issue state is `Todo` or `In Progress` (NOT `Rework` — that always requires the full reset of Step 3, and NOT `Merging` — that always runs the Land procedure). Within those two states, the short-circuit fires only if **all** of the following hold:
   - Every Plan / Acceptance / Validation checkbox in the workpad is already ticked.
   - A PR is linked.
   - `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup` shows the PR `OPEN`/`MERGED`, `mergeable` is `MERGEABLE` (NOT `CONFLICTING` or `UNKNOWN`), `mergeStateStatus` is `CLEAN`/`HAS_HOOKS`/`UNSTABLE` (NOT `DIRTY`/`BLOCKED` due to conflicts), and required checks are green.
   - `git log --oneline origin/main..HEAD` matches the workpad's recorded commits.

   If any of those fail — especially a `CONFLICTING` / `DIRTY` PR — do NOT short-circuit. Drop into Step 1 and run the `pull` skill. If the only failing check is mergeability, the redispatch is specifically a "fix the conflicts" signal — treat it that way.

   When the short-circuit does apply, append a one-line `### Notes` entry (`no-op redispatch — work already complete on <short-sha> / PR #<n>`) and shut down without re-running validation. Only re-engage if the on-disk state contradicts the workpad.

## Status routing

Route on the issue's current state. Before routing, check whether the branch PR exists and its status (affects pre-merge states only).

| State | Action |
|---|---|
| `Backlog` | Do not modify. Shut down. |
| `Todo` | Move to `In Progress`, bootstrap workpad (`workpad` skill), run Step 1. If a PR is already attached: check `gh pr view --json mergeable,mergeStateStatus` first — a `CONFLICTING`/`DIRTY` PR is the most common reason for a Todo redispatch and the conflicts MUST be resolved (`pull` skill) before anything else. Then run the `pr-feedback` sweep before new work. |
| `In Progress` | Continue Step 1 from existing workpad. |
| `In Review` | Do not change code or content. Wait/poll for review decision. |
| `Merging` (PR already `MERGED`) | Skip land procedure; record merge SHA in workpad; move to `Done`. |
| `Merging` (any other PR state) | Run the `land` skill. |
| `Rework` | Run Step 3 (full reset). |
| `Done` | Shut down. |

**Branch-PR-closed guard** (pre-merge states only — `Todo`/`In Progress`/`Rework`): if the branch's PR is `CLOSED` or `MERGED`, prior branch work is non-reusable. Fresh branch from `origin/main`, restart from Step 1.

## Step 1: Setup and plan (Todo / In Progress)

1. **Workpad**: use the `workpad` skill to find or bootstrap the single `## Symphony Workpad` comment for this issue. Persist its comment ID. Never open a second workpad.
2. **Reconcile**: check off items already done; refresh Plan, Acceptance Criteria, and Validation to match current scope.
3. **Env stamp**: include a code-fence line at the top of the workpad: `<host>:<abs-workdir>@<short-sha>`. Example: `devbox-01:/tmp/symphony-workspaces/ENG-42@7bdde33bc`.
4. **Acceptance Criteria**: checklist form.
   - User-facing changes → include a UI walkthrough (launch path → interaction → expected result) as a required criterion.
   - If the ticket body has `Validation`, `Test Plan`, or `Testing` sections, copy them verbatim into Acceptance Criteria / Validation as required checkboxes. No optional downgrade.
5. **Reproduction signal**: capture the current behavior before changing code — command output, screenshot, or deterministic UI state — in `### Notes`.
6. **Sync**: run the `pull` skill to merge `origin/main` and resolve any conflicts before continuing. If a PR is already attached, also confirm `gh pr view --json mergeable,mergeStateStatus` reports `MERGEABLE` after pushing. Record result (`clean` / `conflicts resolved`) and the new short SHA in `### Notes`.
7. Proceed to Step 2.

## Step 2: Execute and publish

1. Implement against the workpad plan. Update the workpad after each milestone (reproduction done, code landed, validation run, feedback addressed). Never leave completed work unchecked.
2. Run required validation for the scope.
   - **Mandatory**: ticket-provided `Validation`/`Test Plan`/`Testing` items must pass. Unmet items = incomplete work.
   - Prefer a targeted proof that directly exercises the change.
   - Temporary local proof edits allowed; revert before commit; document in `### Validation`/`### Notes`.
   - User-facing → exercise the path locally (dashboard/worker) and capture evidence in the workpad. Screenshots **must** be Playwright-captured (`mcp__plugin_playwright_playwright__browser_navigate` + `..._take_screenshot`); logs/CLI output supplement screenshots, they do not replace them. Save screenshots to a workspace-relative path (e.g., `./<name>.png` or `.playwright-mcp/<name>.png`) — the Playwright sandbox blocks `/tmp/...` and any path outside the workspace + `.playwright-mcp/` roots. Embed the screenshot inline in the workpad.
3. **Cleanup test data.** Anything you created in external systems for testing — Linear issues, comments, attachments; non-issue GitHub branches, draft PRs, gists; database rows in shared instances; etc. — must be deleted before moving the issue to `In Review`. Do not delete the active issue branch, its PR, or issue-owned evidence/attachments needed for review. The end state must match the start state plus only the artifacts that belong to this issue. Test-data cleanup is mandatory; record the cleanup actions in `### Notes`.
4. **Before every push**: run required validation; rerun until green; use the `commit` skill to commit; use the `push` skill to publish.
5. The `push` skill handles attaching the PR URL to the issue and applying the `symphony` label. For user-facing changes, keep Playwright screenshots in the Linear workpad only; do not require or manually upload screenshots in the GitHub PR description. Do not commit proof screenshots to the repository.
6. After review feedback or check failures: run the `pull` skill again to merge `origin/main`, then re-run validation.
7. Final workpad pass before `In Review`:
   - All plan / acceptance / validation checkboxes reflect reality.
   - Add `### Confusions` section only if something during execution was unclear.
   - Do not put the PR URL in the workpad (it's on the issue via attachment).
   - Do not post any additional "done"/summary comment.
8. **Gate before `In Review`**:
   - Read the PR's `Manual QA Plan` comment if present; sharpen UI/runtime coverage accordingly.
   - Run the `pr-feedback` skill.
   - PR checks must be green on the latest commit.
   - All ticket-mandated validation items must be checked in the workpad.
   - For user-facing changes: confirm Playwright screenshots are embedded in the Linear workpad.
   - Confirm test data created during validation has been cleaned up.
   - Loop until no actionable comments remain and checks are fully green.
9. Move to `In Review`. Exception: if blocked per the escape hatch below, move to `In Review` with the blocker brief.
10. If the ticket started as `Todo` with a PR already attached, ensure all existing PR feedback is resolved (run the `pr-feedback` skill) — code update OR explicit justified pushback reply — before moving.

### Escape hatch (blocked access)

Use only for genuine external blockers after fallbacks exhausted.

- **GitHub is not a valid blocker by default** — try alternate remote/auth first. Only escalate after fallbacks are documented in the workpad.
- For missing non-GitHub tools/auth, move the ticket to `In Review` with a blocker brief in the workpad: (a) what's missing, (b) why it blocks acceptance, (c) exact human action to unblock. No extra top-level comments.

## Step 3: Rework (full reset)

1. Re-read the full issue body and all human comments. Identify what to do differently.
2. Close the existing PR tied to this issue.
3. Run the `workpad` skill to **reset** the existing comment in place via the GraphQL `commentUpdate` workaround (one workpad per issue, ever — never delete it).
4. Fresh branch from `origin/main`.
5. Start over from Step 1.

## Land procedure (entered via `Merging`)

Run the `land` skill — it handles the approve/sync/squash-merge loop, the `Done` transition, and the `Rework` fallback when checks/conflicts can't be resolved.

## Guardrails

- **Boilerplate documents** (LICENSE, CODE_OF_CONDUCT, SECURITY templates, Contributor Covenant / Apache / MIT / GPL verbatim text): fetch from the authoritative URL with `curl -fsSL <URL> -o <file>`. Do **not** regenerate verbatim inline — upstream content filters may abort the turn silently. Canonical sources:
  - Apache-2.0 LICENSE: `https://www.apache.org/licenses/LICENSE-2.0.txt`
  - MIT LICENSE (template): `https://opensource.org/license/mit/`
  - Contributor Covenant 2.1: `https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md`
- Workpad is the single source of truth. One `## Symphony Workpad` comment per issue, ever. Do not edit the issue body/description for planning or progress. **The workpad comment is never test data and must not be deleted** — see the `workpad` skill for handling accidental duplicates.
- Do not post additional "done"/summary comments outside the workpad.
- Temporary proof edits must be reverted before commit.
- **Test data cleanup is mandatory.** Any artifacts created in external systems during testing (Linear issues/comments/attachments, non-issue GitHub branches/draft PRs/gists, rows in shared databases, etc.) must be deleted before transitioning to `In Review`. Do not delete the active issue branch, its PR, or issue-owned evidence/attachments needed for review. Leaving test residue is treated the same as leaving a temporary code edit unrevert.
- **Proof-of-testing screenshots must be Playwright-captured** for user-facing changes, and must appear in the Linear workpad via Linear-hosted markdown images or attachments. Do not require screenshots in the GitHub PR description, do not upload them manually to GitHub, and do not check screenshot files into the repository. Hand-cropped screenshots, `console.log` snippets, or text-only descriptions do not satisfy this requirement.
- Out-of-scope improvements → new Backlog issue (clear title / description / acceptance criteria, same project as current issue, `related` link to current, `blockedBy` if dependent).
- Never `--no-verify`, `git reset --hard`, `git push --force*`, or `git clean -f*` without an explicit ask.
- `In Review` / `Done` / `Backlog` → do not modify the issue or its code.
- Keep issue text concise, specific, reviewer-oriented.
- If blocked before any workpad exists, post a single blocker comment: blocker, impact, next unblock action.

## Completion bar (before `In Review`)

- Step 1/2 checklist fully reflected in the single workpad comment.
- Acceptance criteria and ticket-mandated validation items all checked.
- Validation/tests green for the latest commit.
- `pr-feedback` sweep clean (no actionable comments remain).
- PR checks green, branch pushed, PR linked on the issue, `symphony` label present.
- User-facing changes: Playwright-captured screenshots embedded in the Linear workpad.
- All test data created during validation has been cleaned up; no residue left in Linear, GitHub, or shared backends.
