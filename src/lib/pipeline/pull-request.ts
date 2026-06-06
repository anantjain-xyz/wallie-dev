import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { resolveGitHubAppConfig } from "@/features/github/config";
import type { SandboxHandle } from "@/lib/sandbox/types";

type AdminClient = SupabaseClient<Database>;

type InstallationOctokit = {
  request: <T = unknown>(route: string, params?: Record<string, unknown>) => Promise<{ data: T }>;
};

type GitHubAppLike = {
  getInstallationOctokit: (installationId: number) => Promise<InstallationOctokit>;
};

type MaybePromise<T> = T | Promise<T>;

interface OpenSessionPullRequestInput {
  admin: AdminClient;
  baseBranch: string;
  body: string;
  branch: string;
  /** Override for tests. Defaults to a real `App` from `@octokit/app`. */
  githubAppFactory?: () => MaybePromise<GitHubAppLike>;
  installationId: number;
  repoFullName: string;
  /** github_repositories.id (DB UUID, not GitHub's numeric repo id). */
  repoId: string;
  sandbox: SandboxHandle;
  sessionId: string;
  title: string;
  workspaceId: string;
}

export type OpenSessionPullRequestOutcome =
  | { kind: "no_commits" }
  | { kind: "push_failed"; reason: string }
  | { kind: "pr_failed"; reason: string }
  | {
      kind: "success";
      isDraft: boolean;
      prNumber: number;
      prState: string;
      prUrl: string;
    };

/**
 * After a stage agent finishes, record its work as a PR:
 *   1. Look up an existing PR for the stage branch. Stage agents are instructed
 *      to open their own PR (and usually do), so GitHub — not the local sandbox
 *      — is the source of truth for "is there a PR to record".
 *   2. If none exists, check whether the branch is actually ahead of base, then
 *      `git push` and open the PR ourselves.
 *   3. Upsert a `session_pull_requests` row keyed on (workspace, branch).
 *
 * Why GitHub-first: the sandbox is a shallow, single-revision clone, so a
 * *local* `<base>` ref frequently does not exist (only `origin/<base>` does
 * after a fetch). The previous implementation gated everything on
 * `git rev-list <base>..HEAD`, which silently resolved to 0/an error and made
 * this function return `no_commits` even though the agent had already pushed a
 * branch and opened a PR — so nothing was ever recorded.
 *
 * Remote failures are recoverable — the artifact is already persisted and the
 * reviewer can approve it from the dashboard — so this function never throws on
 * remote errors. It returns a tagged outcome so the caller can log without
 * aborting the stage.
 */
export async function openSessionPullRequest(
  input: OpenSessionPullRequestInput,
): Promise<OpenSessionPullRequestOutcome> {
  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) {
    return { kind: "pr_failed", reason: `Invalid repo full_name: ${input.repoFullName}` };
  }

  const app = await (input.githubAppFactory ?? defaultAppFactory)();
  const octokit = await app.getInstallationOctokit(input.installationId);

  let pr: GitHubPullRequestResponse;
  try {
    // 1. The stage agent usually opens its own PR — find and record it.
    const existing = await findPullRequestForHead({ head: input.branch, octokit, owner, repo });
    if (existing) {
      pr = existing;
    } else {
      // 2. No PR yet. Only push + open one if the branch is genuinely ahead of
      // base; "no" avoids creating junk branches for analysis-only stages
      // (plan/review/land). "unknown" falls through and lets GitHub adjudicate.
      const ahead = await commitsAheadOfBase(input.sandbox, input.baseBranch);
      if (ahead === "no") {
        return { kind: "no_commits" };
      }

      const pushError = await pushSandboxBranch(input.sandbox, input.branch);
      if (pushError) {
        return { kind: "push_failed", reason: pushError };
      }

      try {
        pr = await openPullRequest({
          base: input.baseBranch,
          body: input.body,
          head: input.branch,
          octokit,
          owner,
          repo,
          title: input.title,
        });
      } catch (error) {
        if (isNoCommitsError(error)) {
          // GitHub knows the full history: the branch has nothing to propose.
          // Drop the branch we just pushed so we don't leave it behind.
          await deleteRemoteBranch(input.sandbox, input.branch);
          return { kind: "no_commits" };
        }
        if (!isAlreadyExistsError(error)) throw error;
        // Race: a PR appeared between our lookup and create. Recover it.
        const recovered = await findPullRequestForHead({
          head: input.branch,
          octokit,
          owner,
          repo,
        });
        if (!recovered) {
          throw new Error(
            `pulls.create returned 422 already_exists for ${input.branch} but pulls.list found nothing`,
          );
        }
        pr = recovered;
      }
    }
  } catch (error) {
    return {
      kind: "pr_failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const { error } = await input.admin.from("session_pull_requests").upsert(
    {
      branch_name: input.branch,
      github_repository_id: input.repoId,
      is_draft: pr.draft,
      pull_request_number: pr.number,
      pull_request_state: pullRequestState(pr),
      pull_request_url: pr.html_url,
      session_id: input.sessionId,
      workspace_id: input.workspaceId,
    },
    { onConflict: "workspace_id,branch_name" },
  );

  if (error) {
    return { kind: "pr_failed", reason: error.message };
  }

  return {
    kind: "success",
    isDraft: pr.draft,
    prNumber: pr.number,
    prState: pullRequestState(pr),
    prUrl: pr.html_url,
  };
}

type CommitsAhead = "yes" | "no" | "unknown";

/**
 * Decide whether the working branch has commits the base does not.
 *
 * The sandbox is a shallow, single-revision clone, so a local `<base>` branch
 * usually does not exist — `git rev-list <base>..HEAD` is therefore unreliable.
 * Instead we fetch the base ref explicitly and ask `git merge-base
 * --is-ancestor HEAD FETCH_HEAD`:
 *   - exit 0  → HEAD is fully contained in base → "no" commits ahead.
 *   - exit 1  → HEAD has commits not in base → "yes".
 *   - other   → could not determine (e.g. shallow boundary) → "unknown".
 *
 * "unknown" is deliberately not treated as "no": callers fall through and let
 * GitHub adjudicate so a real PR is never silently dropped.
 */
async function commitsAheadOfBase(
  sandbox: SandboxHandle,
  baseBranch: string,
): Promise<CommitsAhead> {
  const script = [
    `git fetch --no-tags origin ${shellQuote(baseBranch)} >/dev/null 2>&1 || true`,
    `if git merge-base --is-ancestor HEAD FETCH_HEAD 2>/dev/null; then`,
    `  echo NONE`,
    `else`,
    `  rc=$?`,
    `  if [ "$rc" -eq 1 ]; then echo AHEAD; else echo UNKNOWN; fi`,
    `fi`,
  ].join("\n");

  const proc = await sandbox.exec("bash", ["-lc", script]);
  let stdout = "";
  for await (const log of proc.logs()) {
    if (log.stream === "stdout") stdout += log.data;
  }
  await proc.exitCode;

  const verdict = stdout.trim().split("\n").pop()?.trim();
  if (verdict === "NONE") return "no";
  if (verdict === "AHEAD") return "yes";
  return "unknown";
}

async function pushSandboxBranch(sandbox: SandboxHandle, branch: string): Promise<string | null> {
  // Plain --force, not --force-with-lease: the sandbox is a fresh clone of the
  // base branch with no remote-tracking ref for `wallie/<stage>-<session>`, so
  // a lease without an explicit expected SHA fails as "stale info" on every
  // retry and blocks the PR refresh. Wallie owns these branches by
  // construction (one stage branch per session, one writer), so there is no
  // concurrent pusher to protect against.
  const proc = await sandbox.exec("bash", ["-lc", `git push --force origin ${shellQuote(branch)}`]);
  const stderr: string[] = [];
  for await (const log of proc.logs()) {
    if (log.stream === "stderr") stderr.push(log.data);
  }
  const code = await proc.exitCode;
  if (code === 0) return null;
  return stderr.join("").slice(0, 500) || `git push exited ${code}`;
}

async function deleteRemoteBranch(sandbox: SandboxHandle, branch: string): Promise<void> {
  // Best-effort cleanup of a branch we pushed that turned out to have nothing to
  // propose. Uses the sandbox's git credentials and handles the slashes in the
  // ref path natively (vs. octokit, which percent-encodes them). A stray branch
  // is harmless, so failures are swallowed.
  try {
    const proc = await sandbox.exec("bash", [
      "-lc",
      `git push origin --delete ${shellQuote(branch)}`,
    ]);
    await proc.exitCode;
  } catch {
    // ignore
  }
}

interface GitHubPullRequestResponse {
  draft: boolean;
  html_url: string;
  merged_at: string | null;
  number: number;
  state: "open" | "closed";
}

/**
 * Find the PR for a head branch, preferring an open one. Returns null when no
 * PR has ever been opened for the branch. Searches `state: all` so a PR the
 * stage agent already merged (or closed) is still recorded.
 */
async function findPullRequestForHead(input: {
  head: string;
  octokit: InstallationOctokit;
  owner: string;
  repo: string;
}): Promise<GitHubPullRequestResponse | null> {
  const { data } = await input.octokit.request<GitHubPullRequestResponse[]>(
    "GET /repos/{owner}/{repo}/pulls",
    {
      head: `${input.owner}:${input.head}`,
      owner: input.owner,
      repo: input.repo,
      state: "all",
    },
  );
  if (data.length === 0) return null;

  const open = data.find((pr) => pr.state === "open" && !pr.merged_at);
  if (open) return open;

  // Otherwise the most recent PR for this branch (highest number).
  return data.reduce((latest, pr) => (pr.number > latest.number ? pr : latest), data[0]!);
}

async function openPullRequest(input: {
  base: string;
  body: string;
  head: string;
  octokit: InstallationOctokit;
  owner: string;
  repo: string;
  title: string;
}): Promise<GitHubPullRequestResponse> {
  const { data } = await input.octokit.request<GitHubPullRequestResponse>(
    "POST /repos/{owner}/{repo}/pulls",
    {
      base: input.base,
      body: input.body,
      head: input.head,
      owner: input.owner,
      repo: input.repo,
      title: input.title,
    },
  );
  return data;
}

function isAlreadyExistsError(error: unknown): boolean {
  if (status422Messages(error).length === 0) return false;
  return status422Messages(error).some((m) => /already exists/i.test(m) || /pull request/i.test(m));
}

function isNoCommitsError(error: unknown): boolean {
  return status422Messages(error).some((m) => /no commits between/i.test(m));
}

/**
 * Collect human-readable messages from a 422 GitHub error. GitHub puts the
 * useful detail ("A pull request already exists", "No commits between …") in
 * the `errors[].message` array, while octokit surfaces a generic top-level
 * "Validation Failed", so check both. Returns [] for non-422 errors.
 */
function status422Messages(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  if ((error as { status?: number }).status !== 422) return [];

  const messages: string[] = [];
  const top = (error as { message?: string }).message;
  if (typeof top === "string") messages.push(top);

  const collect = (errors: unknown) => {
    if (!Array.isArray(errors)) return;
    for (const entry of errors) {
      const m = (entry as { message?: string })?.message;
      if (typeof m === "string") messages.push(m);
    }
  };
  collect((error as { errors?: unknown }).errors);
  collect((error as { response?: { data?: { errors?: unknown } } }).response?.data?.errors);

  return messages;
}

function pullRequestState(pr: GitHubPullRequestResponse): string {
  return pr.merged_at ? "merged" : pr.state;
}

async function defaultAppFactory(): Promise<GitHubAppLike> {
  const { App } = await import("@octokit/app");
  return new App(resolveGitHubAppConfig()) as unknown as GitHubAppLike;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
