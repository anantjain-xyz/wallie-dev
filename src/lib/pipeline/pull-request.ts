import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { resolveGitHubAppConfig } from "@/features/github/config";
import { attachLinearPullRequest } from "@/lib/linear/client";
import type { SandboxHandle } from "@/lib/sandbox/types";
import { decryptSecretValue } from "@/lib/secrets/crypto";

type AdminClient = SupabaseClient<Database>;

type InstallationOctokit = {
  request: <T = unknown>(route: string, params?: Record<string, unknown>) => Promise<{ data: T }>;
};

type GitHubAppLike = {
  getInstallationOctokit: (installationId: number) => Promise<InstallationOctokit>;
};

type MaybePromise<T> = T | Promise<T>;

const GITHUB_PULL_REQUEST_TITLE_MAX_LENGTH = 256;

interface SessionPullRequestPublicationInput {
  admin: AdminClient;
  baseBranch: string;
  body: string;
  branch: string;
  /** Override for tests. Defaults to a real `App` from `@octokit/app`. */
  githubAppFactory?: () => MaybePromise<GitHubAppLike>;
  installationId: number;
  linearIssueId: string | null;
  repoFullName: string;
  /** github_repositories.id (DB UUID, not GitHub's numeric repo id). */
  repoId: string;
  sessionId: string;
  title: string;
  workspaceId: string;
  /** Override for tests. Defaults to Linear's attachmentCreate mutation. */
  linearAttachment?: typeof attachLinearPullRequest;
}

interface OpenSessionPullRequestInput extends SessionPullRequestPublicationInput {
  sandbox: SandboxHandle;
}

interface ResumeSessionPullRequestPublicationInput extends SessionPullRequestPublicationInput {
  pullRequestNumber: number;
}

export type OpenSessionPullRequestOutcome =
  | { kind: "no_commits" }
  | { kind: "push_failed"; reason: string }
  | { kind: "pr_failed"; reason: string }
  | {
      kind: "publication_failed";
      pullRequestNumber: number;
      reason: string;
    }
  | {
      kind: "success";
      isDraft: boolean;
      prNumber: number;
      prState: string;
      prUrl: string;
    };

/**
 * After a stage agent finishes, record its work as a PR:
 *   1. Detect whether the sandbox branch is ahead of base, and look up the
 *      latest PR for the branch.
 *   2. Push this run's commits to the remote, then reuse the PR only if it is
 *      still open; refresh its body from the latest artifact, or open a fresh
 *      PR when a closed/merged one can't carry new work.
 *   3. Upsert a `session_pull_requests` row keyed on (workspace, branch), then
 *      attach the PR to the Linear issue when the session came from Linear.
 *
 * Why GitHub-first: the sandbox is a shallow, single-revision clone, so a
 * *local* `<base>` ref frequently does not exist (only `origin/<base>` does
 * after a fetch). The previous implementation gated everything on
 * `git rev-list <base>..HEAD`, which silently resolved to 0/an error and made
 * this function return `no_commits` even though the agent had already pushed a
 * branch and opened a PR — so nothing was ever recorded.
 *
 * Why we push even when a PR already exists: a stage retry gets a *fresh*
 * sandbox branch cut from base, so the new run's commits are local-only until
 * pushed. Skipping the push for an existing PR would leave that PR pinned to the
 * previous run's commits while Wallie shows the new artifact. We only push when
 * the branch is genuinely ahead — pushing a not-ahead branch would force-reset
 * the remote back to base.
 *
 * This function returns tagged failures so the caller can retry the durable
 * pipeline job instead of advancing a session to review without its PR.
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
  const title = normalizePullRequestTitle(input.title);

  let pr: GitHubPullRequestResponse;
  try {
    // Does this run's sandbox branch carry commits the base doesn't? "no"
    // avoids pushing junk for analysis-only stages (plan/review/land);
    // "unknown" falls through and lets GitHub adjudicate.
    const ahead = await commitsAheadOfBase(input.sandbox, input.baseBranch);

    // The most recent PR for this branch, if any. Only an *open* one is
    // reusable: a closed/merged PR can't carry this run's commits for review.
    const existing = await findPullRequestForHead({ head: input.branch, octokit, owner, repo });
    const reusable = existing && existing.state === "open" && !existing.merged_at;

    if (reusable) {
      // A retry starts from base in a fresh sandbox. If it produced no commits,
      // the existing PR still contains only the rejected attempt's head; do not
      // refresh or re-record that stale implementation as this attempt's work.
      if (ahead === "no") {
        await discardStaleSessionPullRequest({
          admin: input.admin,
          branch: input.branch,
          octokit,
          owner,
          prNumber: existing.number,
          repo,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
        });
        return { kind: "no_commits" };
      }

      // Refresh the open PR with this run's commits (a stage retry gets a fresh
      // sandbox branch). Never push a not-ahead branch — that would force-reset
      // the remote (and the PR) back to base.
      const pushError = await pushSandboxBranch(input.sandbox, input.branch);
      if (pushError) {
        return { kind: "push_failed", reason: pushError };
      }
      try {
        const refreshed = await updatePullRequest({
          body: input.body,
          octokit,
          owner,
          prNumber: existing.number,
          repo,
          title,
        });
        pr =
          refreshed.state === "open" && !refreshed.merged_at
            ? refreshed
            : await openReplacementPullRequest({
                base: input.baseBranch,
                body: input.body,
                head: input.branch,
                octokit,
                owner,
                repo,
                title,
              });
      } catch (error) {
        return publicationFailure(existing.number, error);
      }
    } else if (ahead === "no") {
      // Nothing new to propose. Preserve a merged PR because its work is now
      // in base, but discard a closed-unmerged PR left by a rejected attempt.
      if (!existing) {
        return { kind: "no_commits" };
      }
      if (!existing.merged_at) {
        await discardStaleSessionPullRequest({
          admin: input.admin,
          branch: input.branch,
          octokit,
          owner,
          prNumber: existing.number,
          repo,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
        });
        return { kind: "no_commits" };
      }
      pr = existing;
    } else {
      // New work, but no open PR to land it in (none yet, or the prior one was
      // closed/merged). Push and open a fresh, reviewable PR. Let GitHub — which
      // sees the full history — be the final arbiter of "no commits".
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
          title,
        });
      } catch (error) {
        if (isNoCommitsError(error)) {
          // Drop the branch we just pushed so we don't leave it behind.
          await deleteRemoteBranch(input.sandbox, input.branch);
          return { kind: "no_commits" };
        }
        if (!isAlreadyExistsError(error)) throw error;
        // Race: an open PR appeared between our lookup and create. Recover it.
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
        try {
          const refreshed = await updatePullRequest({
            body: input.body,
            octokit,
            owner,
            prNumber: recovered.number,
            repo,
            title,
          });
          pr =
            refreshed.state === "open" && !refreshed.merged_at
              ? refreshed
              : await openReplacementPullRequest({
                  base: input.baseBranch,
                  body: input.body,
                  head: input.branch,
                  octokit,
                  owner,
                  repo,
                  title,
                });
        } catch (updateError) {
          return publicationFailure(recovered.number, updateError);
        }
      }
    }
  } catch (error) {
    return {
      kind: "pr_failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return finalizeSessionPullRequestPublication({ ...input, title }, pr);
}

function publicationFailure(
  pullRequestNumber: number,
  error: unknown,
): OpenSessionPullRequestOutcome {
  return {
    kind: "publication_failed",
    pullRequestNumber,
    reason: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Retry only the durable bookkeeping for a PR that GitHub already created.
 * This deliberately needs no sandbox: a DB or Linear outage after agent work
 * must not start another coding run or force-push a replacement implementation.
 */
export async function resumeSessionPullRequestPublication(
  input: ResumeSessionPullRequestPublicationInput,
): Promise<OpenSessionPullRequestOutcome> {
  const [owner, repo] = input.repoFullName.split("/");
  if (!owner || !repo) {
    return { kind: "pr_failed", reason: `Invalid repo full_name: ${input.repoFullName}` };
  }

  try {
    const app = await (input.githubAppFactory ?? defaultAppFactory)();
    const octokit = await app.getInstallationOctokit(input.installationId);
    const title = normalizePullRequestTitle(input.title);
    const { data: checkpointedPr } = await octokit.request<GitHubPullRequestResponse>(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        pull_number: input.pullRequestNumber,
        repo,
      },
    );

    let pr = checkpointedPr;
    if (pr.state === "open" && !pr.merged_at) {
      pr = await updatePullRequest({
        body: input.body,
        octokit,
        owner,
        prNumber: pr.number,
        repo,
        title,
      });
      if (pr.state === "closed" && !pr.merged_at) {
        pr = await openReplacementPullRequest({
          base: input.baseBranch,
          body: input.body,
          head: input.branch,
          octokit,
          owner,
          repo,
          title,
        });
      }
    } else if (!pr.merged_at) {
      // The checkpoint points to a closed, unmerged PR. The branch is already
      // durable, so publish it again without starting another sandbox/agent.
      // If another retry opened one concurrently, recover that open PR.
      try {
        pr = await openPullRequest({
          base: input.baseBranch,
          body: input.body,
          head: input.branch,
          octokit,
          owner,
          repo,
          title,
        });
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        const recovered = await findPullRequestForHead({
          head: input.branch,
          octokit,
          owner,
          repo,
        });
        if (!recovered || recovered.state !== "open" || recovered.merged_at) {
          throw new Error(
            `pulls.create returned 422 already_exists for ${input.branch} but no open PR was found`,
          );
        }
        pr = recovered;
      }
    }

    return finalizeSessionPullRequestPublication({ ...input, title }, pr);
  } catch (error) {
    return {
      kind: "publication_failed",
      pullRequestNumber: input.pullRequestNumber,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function finalizeSessionPullRequestPublication(
  input: SessionPullRequestPublicationInput,
  pr: GitHubPullRequestResponse,
): Promise<OpenSessionPullRequestOutcome> {
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
    return { kind: "publication_failed", pullRequestNumber: pr.number, reason: error.message };
  }

  if (input.linearIssueId) {
    try {
      const apiKey = await loadLinearApiKey(input.admin, input.workspaceId);
      await (input.linearAttachment ?? attachLinearPullRequest)(apiKey, input.linearIssueId, {
        pullRequestNumber: pr.number,
        title: input.title,
        url: pr.html_url,
      });
    } catch (linearError) {
      return {
        kind: "publication_failed",
        pullRequestNumber: pr.number,
        reason: `Failed to attach pull request to Linear: ${linearError instanceof Error ? linearError.message : String(linearError)}`,
      };
    }
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
 * Find the latest PR for a head branch, preferring an open one. Returns null
 * when no PR has ever been opened. Searches `state: all` so a merged PR is still
 * recorded (link preservation); callers decide reuse — only an open PR is reused
 * for new work, a closed/merged one is not.
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

async function openReplacementPullRequest(input: {
  base: string;
  body: string;
  head: string;
  octokit: InstallationOctokit;
  owner: string;
  repo: string;
  title: string;
}): Promise<GitHubPullRequestResponse> {
  try {
    return await openPullRequest(input);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const recovered = await findPullRequestForHead(input);
    if (!recovered || recovered.state !== "open" || recovered.merged_at) {
      throw new Error(
        `pulls.create returned 422 already_exists for ${input.head} but no open PR was found`,
      );
    }
    return recovered;
  }
}

async function discardStaleSessionPullRequest(input: {
  admin: AdminClient;
  branch: string;
  octokit: InstallationOctokit;
  owner: string;
  prNumber: number;
  repo: string;
  sessionId: string;
  workspaceId: string;
}): Promise<void> {
  await input.octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: input.owner,
    pull_number: input.prNumber,
    repo: input.repo,
    state: "closed",
  });

  const { error } = await input.admin
    .from("session_pull_requests")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("session_id", input.sessionId)
    .eq("branch_name", input.branch)
    .eq("pull_request_number", input.prNumber);
  if (error) throw error;
}

async function updatePullRequest(input: {
  body: string;
  octokit: InstallationOctokit;
  owner: string;
  prNumber: number;
  repo: string;
  title: string;
}): Promise<GitHubPullRequestResponse> {
  const { data } = await input.octokit.request<GitHubPullRequestResponse>(
    "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    {
      body: input.body,
      owner: input.owner,
      pull_number: input.prNumber,
      repo: input.repo,
      title: input.title,
    },
  );
  return data;
}

function normalizePullRequestTitle(value: string): string {
  const singleLine = value
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = singleLine || "Wallie change";
  return Array.from(normalized).slice(0, GITHUB_PULL_REQUEST_TITLE_MAX_LENGTH).join("");
}

async function loadLinearApiKey(admin: AdminClient, workspaceId: string): Promise<string> {
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("encrypted_value")
    .eq("workspace_id", workspaceId)
    .eq("key", "LINEAR_API_KEY")
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error("LINEAR_API_KEY is not configured for this workspace.");
  }

  return decryptSecretValue(data.encrypted_value);
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
