import "server-only";

import { verify } from "@octokit/webhooks-methods";

import { resolveGitHubWebhookSecret } from "@/features/github/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncGitHubRepositoriesForWorkspace } from "@/features/github/service";

type PullRequestEventPayload = {
  action: string;
  installation?: {
    id: number;
  };
  pull_request: {
    draft: boolean;
    head: {
      ref: string;
    };
    html_url: string;
    merged: boolean;
    number: number;
    state: "closed" | "open";
  };
  repository: {
    id: number;
  };
};

type InstallationEventPayload = {
  action: string;
  installation: {
    id: number;
  };
};

const TRACKED_PR_ACTIONS = new Set([
  "closed",
  "converted_to_draft",
  "edited",
  "opened",
  "ready_for_review",
  "reopened",
  "synchronize",
]);

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
  // Only PRs from Wallie-managed branches map back to a session. The pipeline
  // names them `wallie/<stage-slug>-<sessionId>` (see `buildStageBranchName`
  // in `lib/pipeline/processor.ts`).
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
    .select("id")
    .eq("github_installation_id", installation.id)
    .eq("repo_id", payload.repository.id)
    .maybeSingle();

  if (repositoryError) throw repositoryError;

  // Match by (github_repository_id, pull_request_number) when we know the
  // repo — that's the durable pair on rows the pipeline already opened.
  // Fall back to (workspace_id, branch_name) for the brief window between
  // pipeline-side INSERT and the first webhook delivery (or if the row was
  // inserted before the repo FK was resolvable).
  const updates = {
    github_repository_id: repository?.id ?? null,
    is_draft: payload.pull_request.draft,
    pull_request_number: payload.pull_request.number,
    pull_request_state: payload.pull_request.merged ? "merged" : payload.pull_request.state,
    pull_request_url: payload.pull_request.html_url,
  };

  if (repository) {
    const { data: byPr, error: byPrError } = await admin
      .from("session_pull_requests")
      .update(updates)
      .eq("workspace_id", installation.workspace_id)
      .eq("github_repository_id", repository.id)
      .eq("pull_request_number", payload.pull_request.number)
      .select("id");

    if (byPrError) throw byPrError;
    if (byPr && byPr.length > 0) return;
  }

  const { error: byBranchError } = await admin
    .from("session_pull_requests")
    .update(updates)
    .eq("workspace_id", installation.workspace_id)
    .eq("branch_name", branchName);

  if (byBranchError) throw byBranchError;
}
