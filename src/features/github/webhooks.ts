import "server-only";

import { verify } from "@octokit/webhooks-methods";
import { z } from "zod";

import { resolveGitHubAppConfig, resolveGitHubWebhookSecret } from "@/features/github/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncGitHubRepositoriesForWorkspace } from "@/features/github/service";

import {
  pullRequestEventSchema,
  type InstallationEventPayload,
  type PullRequestEventPayload,
} from "./webhook-payloads";

const TRACKED_PR_ACTIONS = new Set([
  "closed",
  "converted_to_draft",
  "edited",
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

const pullRequestObservationSchema = pullRequestEventSchema.shape.pull_request.extend({
  base: z.object({ repo: z.object({ id: z.number().int().positive().safe() }) }),
});

const canonicalBranchSchema = z
  .string()
  .regex(
    /^wallie\/sessions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  );
const canonicalObservationSchema = pullRequestObservationSchema
  .extend({
    base: z.object({
      ref: z.string().min(1),
      repo: z.object({ id: z.number().int().positive().safe() }),
    }),
    head: pullRequestEventSchema.shape.pull_request.shape.head.extend({
      sha: z.string().regex(/^[a-f0-9]{40}$/),
    }),
  })
  .refine((snapshot) => !snapshot.merged || snapshot.state === "closed");

export async function verifyGitHubWebhookRequest(
  payload: string,
  signature: string,
  input: Record<string, string | undefined> = process.env,
) {
  return verify(resolveGitHubWebhookSecret(input), payload, signature);
}

export async function handleGitHubInstallationEvent(
  payload: InstallationEventPayload,
  input: Record<string, string | undefined> = process.env,
) {
  const admin = createSupabaseAdminClient(input);

  switch (payload.action) {
    case "deleted": {
      const { error } = await admin
        .from("github_installations")
        .delete()
        .eq("installation_id", payload.installation.id);

      if (error) {
        throw error;
      }

      return;
    }
    case "suspend":
    case "unsuspend": {
      const { error } = await admin
        .from("github_installations")
        .update({
          suspended: payload.action === "suspend",
        })
        .eq("installation_id", payload.installation.id);

      if (error) {
        throw error;
      }

      return;
    }
    default:
      return;
  }
}

export async function handleGitHubInstallationRepositoriesEvent(
  payload: InstallationEventPayload,
  input: Record<string, string | undefined> = process.env,
) {
  const admin = createSupabaseAdminClient(input);
  const { data: installation, error } = await admin
    .from("github_installations")
    .select("workspace_id, installation_id")
    .eq("installation_id", payload.installation.id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!installation) {
    return;
  }

  await syncGitHubRepositoriesForWorkspace(
    {
      installationId: installation.installation_id,
      workspaceId: installation.workspace_id,
    },
    input,
  );
}

export async function handleGitHubPullRequestEvent(
  payload: PullRequestEventPayload,
  input: Record<string, string | undefined> = process.env,
) {
  if (!payload.installation) return;
  if (!TRACKED_PR_ACTIONS.has(payload.action)) return;

  const branchName = payload.pull_request.head.ref;
  // Only PRs from Wallie-managed branches map back to Wallie state. Pipeline
  // branches use `wallie/<stage-slug>-<sessionId>`; repository setup branches
  // use `wallie/setup-...`.
  if (!branchName.startsWith("wallie/")) return;

  const admin = createSupabaseAdminClient(input);

  const { data: installation, error: installationError } = await admin
    .from("github_installations")
    .select("id, workspace_id")
    .eq("installation_id", payload.installation.id)
    .maybeSingle();

  if (installationError) throw installationError;
  if (!installation) return;

  const { data: repository, error: repositoryError } = await admin
    .from("github_repositories")
    .select("id, full_name")
    .eq("github_installation_id", installation.id)
    .eq("repo_id", payload.repository.id)
    .maybeSingle();

  if (repositoryError) throw repositoryError;

  // A branch is not a repository identity. Unknown repositories must never
  // claim a link from another repository, even within the same workspace.
  if (!repository) return;

  if (canonicalBranchSchema.safeParse(branchName).success) {
    // Canonical epochs never use the legacy branch fallback. Only their pinned
    // PR identity may dirty state, and only a fenced current GET may finish it.
    const { data: observationId, error: beginError } = await admin.rpc(
      "begin_session_pr_observation",
      {
        p_workspace_id: installation.workspace_id,
        p_repository_id: repository.id,
        p_branch_name: branchName,
        p_pr_number: payload.pull_request.number,
      },
    );
    if (beginError) throw beginError;
    if (!observationId) return;
    const [, , sessionId, epochId] = branchName.split("/");
    const { data: epoch, error: epochError } = await admin
      .from("session_pr_epochs")
      .select("base_branch, branch_name, pr_number, github_repository_id, repository_full_name")
      .eq("id", epochId)
      .eq("session_id", sessionId)
      .eq("workspace_id", installation.workspace_id)
      .eq("repository_id", repository.id)
      .eq("branch_name", branchName)
      .maybeSingle();
    if (epochError) throw epochError;
    if (!epoch || epoch.pr_number !== payload.pull_request.number) return;
    if (
      epoch.github_repository_id !== payload.repository.id ||
      epoch.repository_full_name.toLowerCase() !== repository.full_name.toLowerCase() ||
      epoch.branch_name !== branchName
    )
      throw new Error("GitHub repository no longer matches the canonical pull request epoch.");
    const [owner, repo, extra] = epoch.repository_full_name.split("/");
    if (!owner || !repo || extra) throw new Error("Invalid GitHub repository identity.");
    const { App } = await import("@octokit/app");
    const octokit = await new App(resolveGitHubAppConfig(input)).getInstallationOctokit(
      payload.installation.id,
    );
    const { data } = await octokit
      .request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: payload.pull_request.number,
        request: { signal: AbortSignal.timeout(10_000) },
      })
      .catch(() => {
        throw new Error("Canonical pull request observation is temporarily unavailable.");
      });
    const snapshot = canonicalObservationSchema.parse(data);
    const headRepositoryMatches = snapshot.head.repo?.id === epoch.github_repository_id;
    const url = new URL(snapshot.html_url);
    if (
      snapshot.number !== payload.pull_request.number ||
      snapshot.base.repo.id !== epoch.github_repository_id ||
      snapshot.base.ref !== epoch.base_branch ||
      snapshot.head.ref !== branchName ||
      (snapshot.head.repo && !headRepositoryMatches) ||
      (snapshot.state === "open" && !headRepositoryMatches) ||
      url.origin !== "https://github.com" ||
      url.pathname.toLowerCase() !==
        `/${epoch.repository_full_name}/pull/${snapshot.number}`.toLowerCase() ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("GitHub returned a different canonical pull request identity.");
    }
    const { error: finishError } = await admin.rpc("finish_session_pr_observation", {
      p_observation_id: observationId,
      p_pr_url: snapshot.html_url,
      p_pr_state: snapshot.merged ? "merged" : snapshot.state,
      p_is_draft: snapshot.draft,
      // A deleted head repository can prove terminal state, never a synced head.
      // Generated RPC types omit this SQL argument's accepted nullability.
      p_pr_head_sha: headRepositoryMatches ? snapshot.head.sha : null!,
      p_pr_updated_at: snapshot.updated_at,
    });
    if (finishError) throw finishError;
    return;
  }

  const { error } = await admin.rpc("apply_github_pull_request_event", {
    target_workspace_id: installation.workspace_id,
    target_repository_id: repository.id,
    target_branch_name: branchName,
    source_pull_request_number: payload.pull_request.number,
    source_pull_request_url: payload.pull_request.html_url,
    source_pull_request_state: payload.pull_request.merged ? "merged" : payload.pull_request.state,
    source_is_draft: payload.pull_request.draft,
    source_updated_at: payload.pull_request.updated_at,
    source_head_repository_matches: payload.pull_request.head.repo?.id === payload.repository.id,
  });
  if (error) throw error;

  // Equal provider timestamps cannot order close/reopen or draft transitions.
  // Reserve the observation before fetching; the database rejects it if a newer
  // observation starts or accepted state changes while this request is in flight.
  const { data: token, error: observationError } = await admin.rpc(
    "begin_github_pull_request_observation",
    {
      target_workspace_id: installation.workspace_id,
      target_repository_id: repository.id,
      target_branch_name: branchName,
      source_pull_request_number: payload.pull_request.number,
      source_pull_request_state: payload.pull_request.merged
        ? "merged"
        : payload.pull_request.state,
      source_is_draft: payload.pull_request.draft,
      source_updated_at: payload.pull_request.updated_at,
    },
  );
  if (observationError) throw observationError;
  if (!token) return;

  const [owner, repo] = repository.full_name.split("/");
  if (!owner || !repo) throw new Error("Invalid GitHub repository identity.");
  const { App } = await import("@octokit/app");
  const octokit = await new App(resolveGitHubAppConfig(input)).getInstallationOctokit(
    payload.installation.id,
  );
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: payload.pull_request.number,
  });
  const snapshot = pullRequestObservationSchema.parse(data);
  if (snapshot.number !== payload.pull_request.number)
    throw new Error("GitHub returned a different pull request.");
  if (snapshot.base.repo.id !== payload.repository.id)
    throw new Error("GitHub returned a different repository.");
  const { error: finishError } = await admin.rpc("finish_github_pull_request_observation", {
    target_workspace_id: installation.workspace_id,
    target_repository_id: repository.id,
    target_branch_name: branchName,
    source_pull_request_number: snapshot.number,
    source_pull_request_url: snapshot.html_url,
    source_pull_request_state: snapshot.merged ? "merged" : snapshot.state,
    source_is_draft: snapshot.draft,
    source_updated_at: snapshot.updated_at,
    observation_token: token,
  });
  if (finishError) throw finishError;
}
