import "server-only";

import { verify } from "@octokit/webhooks-methods";

import { resolveGitHubWebhookSecret } from "@/features/github/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncGitHubRepositoriesForWorkspace } from "@/features/github/service";
import type { Enums } from "@/lib/supabase/database.types";

type PullRequestEventPayload = {
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

function resolveIssueStatusFromPullRequest(
  payload: PullRequestEventPayload["pull_request"],
): Enums<"issue_status"> {
  if (payload.merged) {
    return "done";
  }

  if (payload.state === "open") {
    return payload.draft ? "in_progress" : "in_review";
  }

  return "in_progress";
}

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
  if (!payload.installation) {
    return;
  }

  const admin = createSupabaseAdminClient(input);
  const { data: installation, error: installationError } = await admin
    .from("github_installations")
    .select("id, workspace_id")
    .eq("installation_id", payload.installation.id)
    .maybeSingle();

  if (installationError) {
    throw installationError;
  }

  if (!installation) {
    return;
  }

  const [{ data: repository, error: repositoryError }, { data: branchRow, error: branchError }] =
    await Promise.all([
      admin
        .from("github_repositories")
        .select("id")
        .eq("github_installation_id", installation.id)
        .eq("repo_id", payload.repository.id)
        .maybeSingle(),
      admin
        .from("github_issue_branches")
        .select("id, issue_id")
        .eq("workspace_id", installation.workspace_id)
        .eq("branch_name", payload.pull_request.head.ref)
        .maybeSingle(),
    ]);

  if (repositoryError) {
    throw repositoryError;
  }

  if (branchError) {
    throw branchError;
  }

  if (!branchRow) {
    return;
  }

  const { error: branchUpdateError } = await admin
    .from("github_issue_branches")
    .update({
      github_repository_id: repository?.id ?? null,
      is_draft: payload.pull_request.draft,
      pull_request_number: payload.pull_request.number,
      pull_request_state: payload.pull_request.merged
        ? "merged"
        : payload.pull_request.state,
      pull_request_url: payload.pull_request.html_url,
    })
    .eq("id", branchRow.id);

  if (branchUpdateError) {
    throw branchUpdateError;
  }

  const { error: issueUpdateError } = await admin
    .from("issues")
    .update({
      status: resolveIssueStatusFromPullRequest(payload.pull_request),
    })
    .eq("id", branchRow.issue_id);

  if (issueUpdateError) {
    throw issueUpdateError;
  }
}
