import "server-only";

import { verify } from "@octokit/webhooks-methods";

import { resolveGitHubWebhookSecret } from "@/features/github/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncGitHubRepositoriesForWorkspace } from "@/features/github/service";

import type { InstallationEventPayload, PullRequestEventPayload } from "./webhook-payloads";

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

  // A branch is not a repository identity. Unknown repositories must never
  // claim a link from another repository, even within the same workspace.
  if (!repository) return;

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
}
