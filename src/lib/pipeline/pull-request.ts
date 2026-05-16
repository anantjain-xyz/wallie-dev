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
 * After a stage agent finishes, ship its work as a PR:
 *   1. Detect commits ahead of base inside the sandbox; bail if none.
 *   2. `git push` the working branch back to GitHub via the installation token.
 *   3. Open (or recover the existing) PR via Octokit.
 *   4. Upsert a `session_pull_requests` row keyed on (workspace, branch).
 *
 * Failures at steps 2-3 are recoverable — the artifact is already persisted
 * and the reviewer can approve it from the dashboard — so this function never
 * throws on remote errors. It returns a tagged outcome so the caller can log
 * without aborting the stage.
 */
export async function openSessionPullRequest(
  input: OpenSessionPullRequestInput,
): Promise<OpenSessionPullRequestOutcome> {
  if (!(await branchHasCommitsAhead(input.sandbox, input.baseBranch))) {
    return { kind: "no_commits" };
  }

  const pushError = await pushSandboxBranch(input.sandbox, input.branch);
  if (pushError) {
    return { kind: "push_failed", reason: pushError };
  }

  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) {
    return { kind: "pr_failed", reason: `Invalid repo full_name: ${input.repoFullName}` };
  }

  const app = await (input.githubAppFactory ?? defaultAppFactory)();
  const octokit = await app.getInstallationOctokit(input.installationId);

  let pr: GitHubPullRequestResponse;
  try {
    pr = await openOrRecoverPullRequest({
      base: input.baseBranch,
      body: input.body,
      head: input.branch,
      octokit,
      owner,
      repo,
      title: input.title,
    });
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

async function branchHasCommitsAhead(sandbox: SandboxHandle, baseBranch: string): Promise<boolean> {
  // `git rev-list base..HEAD --count` prints the number of commits on HEAD
  // that aren't on base. Output is a single line with a non-negative integer.
  const proc = await sandbox.exec("bash", [
    "-lc",
    `git rev-list ${shellQuote(baseBranch)}..HEAD --count`,
  ]);

  let stdout = "";
  for await (const log of proc.logs()) {
    if (log.stream === "stdout") stdout += log.data;
  }
  const code = await proc.exitCode;
  if (code !== 0) return false;

  const count = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(count) && count > 0;
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

interface GitHubPullRequestResponse {
  draft: boolean;
  html_url: string;
  merged_at: string | null;
  number: number;
  state: "open" | "closed";
}

async function openOrRecoverPullRequest(input: {
  base: string;
  body: string;
  head: string;
  octokit: InstallationOctokit;
  owner: string;
  repo: string;
  title: string;
}): Promise<GitHubPullRequestResponse> {
  try {
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
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;

    // Stage retry path: the prior run already opened a PR for this branch.
    // Look it up so we can refresh the row with the current state.
    const { data } = await input.octokit.request<GitHubPullRequestResponse[]>(
      "GET /repos/{owner}/{repo}/pulls",
      {
        head: `${input.owner}:${input.head}`,
        owner: input.owner,
        repo: input.repo,
        state: "all",
      },
    );
    if (data.length === 0) {
      throw new Error(
        `pulls.create returned 422 already_exists for ${input.head} but pulls.list found nothing`,
      );
    }
    return data[0]!;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: number }).status;
  if (status !== 422) return false;
  const message = (error as { message?: string }).message ?? "";
  return /already exists/i.test(message) || /pull request/i.test(message);
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
