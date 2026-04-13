import type { Tables } from "@/lib/supabase/database.types";

import {
  type AdminClient,
  type PhaseResult,
  type SessionRow,
  createOctokit,
  errorResult,
  loadGitHubContext,
  loadSessionPullRequest,
  splitRepoFullName,
  successResult,
} from "./phase-helpers";

interface LandPhaseInput {
  admin: AdminClient;
  job: Tables<"agent_jobs">;
  session: SessionRow;
  botToken: string;
}

/**
 * Run the land phase: merge the approved PR via the GitHub App API and
 * update session_pull_requests with the merged state.
 *
 * This phase does not use an agent runner — it is a direct API action
 * gated by human approval in the review phase.
 */
export async function runLandPhase(input: LandPhaseInput): Promise<PhaseResult> {
  const { admin, job, session } = input;

  // --- Load GitHub context ---
  const github = await loadGitHubContext(admin, session.workspace_id);
  if (!github) {
    return errorResult(
      admin,
      job,
      "No GitHub installation or repository found for workspace. " +
        "Connect a GitHub repository in workspace settings.",
    );
  }

  // --- Load the PR to merge ---
  const pr = await loadSessionPullRequest(admin, session.id);
  if (!pr || !pr.pull_request_number) {
    return errorResult(
      admin,
      job,
      "No pull request found for this session. The engineering phase must create a PR first.",
    );
  }

  // --- Merge the PR via GitHub App ---
  const { owner, repo } = splitRepoFullName(github.repo.full_name);
  let mergeCommitSha: string | null = null;

  try {
    const octokit = await createOctokit(github.installationId);
    const { data: mergeResult } = await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        owner,
        repo,
        pull_number: pr.pull_request_number,
        merge_method: "squash",
        commit_title: `[Wallie] ${session.title} (#${pr.pull_request_number})`,
        commit_message: `Merged by Wallie pipeline.\n\nSession: ${session.id}`,
      },
    );
    mergeCommitSha = mergeResult.sha ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(admin, job, `Failed to merge PR #${pr.pull_request_number}: ${message}`);
  }

  // --- Update session_pull_requests ---
  await admin
    .from("session_pull_requests")
    .update({ pull_request_state: "merged" })
    .eq("id", pr.id);

  // --- Store land artifact ---
  const newVersion = session.current_artifact_version + 1;
  const artifactMd = buildLandArtifact({
    prNumber: pr.pull_request_number,
    prUrl: pr.pull_request_url,
    mergeCommitSha,
    repoFullName: github.repo.full_name,
  });

  await admin.from("session_artifacts").insert({
    artifact_json: artifactMd,
    feedback_text: null,
    phase: session.phase,
    session_id: session.id,
    version: newVersion,
    workspace_id: session.workspace_id,
  });

  await admin
    .from("sessions")
    .update({
      current_artifact_version: newVersion,
      phase_status: "awaiting_review",
    })
    .eq("id", session.id);

  // --- Mark job as success ---
  return successResult(admin, job);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildLandArtifact(input: {
  prNumber: number;
  prUrl: string | null;
  mergeCommitSha: string | null;
  repoFullName: string;
}): string {
  const lines: string[] = [];
  lines.push("# Land");
  lines.push("");
  if (input.prUrl) {
    lines.push(`**Pull Request:** [#${input.prNumber}](${input.prUrl}) — merged`);
  } else {
    lines.push(`**Pull Request:** #${input.prNumber} — merged`);
  }
  if (input.mergeCommitSha) {
    lines.push(`**Merge Commit:** \`${input.mergeCommitSha}\``);
  }
  lines.push(`**Repository:** ${input.repoFullName}`);
  lines.push(`**Merged At:** ${new Date().toISOString()}`);
  lines.push("");
  return lines.join("\n");
}
