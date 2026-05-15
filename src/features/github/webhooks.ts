import "server-only";

import { verify } from "@octokit/webhooks-methods";

import { resolveGitHubWebhookSecret } from "@/features/github/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { asLooseSupabaseClient } from "@/lib/supabase/loose";
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
    .select("id")
    .eq("github_installation_id", installation.id)
    .eq("repo_id", payload.repository.id)
    .maybeSingle();

  if (repositoryError) throw repositoryError;

  if (repository && branchName.startsWith("wallie/setup-")) {
    const handled = await updateRepositoryOnboardingFromSetupPr(admin, {
      branchName,
      merged: payload.pull_request.merged,
      pullRequestNumber: payload.pull_request.number,
      pullRequestState: payload.pull_request.state,
      pullRequestUrl: payload.pull_request.html_url,
      repositoryId: repository.id,
      workspaceId: installation.workspace_id,
    });
    if (handled) return;
  }

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

async function updateRepositoryOnboardingFromSetupPr(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  input: {
    branchName: string;
    merged: boolean;
    pullRequestNumber: number;
    pullRequestState: "closed" | "open";
    pullRequestUrl: string;
    repositoryId: string;
    workspaceId: string;
  },
): Promise<boolean> {
  const loose = asLooseSupabaseClient(admin);
  const { data: row, error: rowError } = await loose
    .from("repository_onboarding_status")
    .select("id, status, conflict_report")
    .eq("workspace_id", input.workspaceId)
    .eq("github_repository_id", input.repositoryId)
    .eq("setup_branch_name", input.branchName)
    .maybeSingle();

  if (rowError) throw rowError;
  if (!row) return false;

  const onboardingRow = row as {
    conflict_report: unknown;
    id: string;
    status: "not_set_up" | "pr_open" | "ready" | "conflict" | "error";
  };
  const hasUnresolvedConflicts =
    onboardingRow.status === "conflict" ||
    (Array.isArray(onboardingRow.conflict_report) && onboardingRow.conflict_report.length > 0);
  const status =
    !input.merged && input.pullRequestState === "closed"
      ? "error"
      : hasUnresolvedConflicts
        ? "conflict"
        : input.merged
          ? "ready"
          : "pr_open";
  const patch: Record<string, unknown> = {
    last_error: status === "error" ? "Setup PR was closed without merging." : null,
    setup_pr_number: input.pullRequestNumber,
    setup_pr_url: input.pullRequestUrl,
    status,
    ...(input.merged && !hasUnresolvedConflicts ? { conflict_report: [] } : {}),
  };

  const { error } = await loose
    .from("repository_onboarding_status")
    .update(patch)
    .eq("id", onboardingRow.id)
    .eq("workspace_id", input.workspaceId)
    .eq("github_repository_id", input.repositoryId)
    .eq("setup_branch_name", input.branchName);

  if (error) throw error;
  return true;
}
