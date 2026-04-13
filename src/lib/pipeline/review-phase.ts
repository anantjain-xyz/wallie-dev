import type { Tables } from "@/lib/supabase/database.types";
import { createAgentRunner, DEFAULT_AGENT_RUNNER_CONFIG } from "@/lib/agent-runner";
import { createWorkspace } from "@/lib/workspace-manager/manager";
import { renderPhasePrompt } from "@/lib/prompt-templates";

import {
  type AdminClient,
  type PhaseResult,
  type SessionRow,
  buildCloneUrl,
  cleanupWorkspace,
  createAgentRun,
  errorResult,
  gitExec,
  isLinearIssueActive,
  loadAgentConfig,
  loadGitHubContext,
  loadLatestArtifact,
  loadPhaseArtifactText,
  loadSessionPullRequest,
  markRunError,
  markRunSuccess,
  persistEvent,
  successResult,
  updateRunActivity,
} from "./phase-helpers";

interface ReviewPhaseInput {
  admin: AdminClient;
  job: Tables<"agent_jobs">;
  session: SessionRow;
  botToken: string;
}

/**
 * Run the review phase: check out the PR branch in a workspace, launch an
 * agent to review code quality, run lint/typecheck/tests, and produce a
 * structured review artifact with pass/fail results.
 */
export async function runReviewPhase(input: ReviewPhaseInput): Promise<PhaseResult> {
  const { admin, job, session } = input;

  // --- Load configuration ---
  const agentConfig = await loadAgentConfig(admin, session.workspace_id);
  const maxTurns = agentConfig.maxTurns ?? DEFAULT_AGENT_RUNNER_CONFIG.maxTurns ?? 5;
  const provider = agentConfig.provider ?? DEFAULT_AGENT_RUNNER_CONFIG.provider;

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

  // --- Load the PR to review ---
  const pr = await loadSessionPullRequest(admin, session.id);
  if (!pr || !pr.branch_name) {
    return errorResult(
      admin,
      job,
      "No pull request found for this session. The engineering phase must complete first.",
    );
  }

  // --- Load previous artifacts for context ---
  const productSpec = await loadPhaseArtifactText(admin, session.id, "product");
  const designDoc = await loadPhaseArtifactText(admin, session.id, "design");

  // --- Load feedback from previous rejection (if any) ---
  const attemptNumber = session.current_artifact_version + 1;
  let feedbackText: string | null = null;
  if (session.current_artifact_version > 0) {
    const lastArtifact = await loadLatestArtifact(admin, session.id, session.phase);
    feedbackText = lastArtifact?.feedback_text ?? null;
  }

  // --- Render the prompt ---
  const prompt = await renderPhasePrompt(admin, {
    workspaceId: session.workspace_id,
    phase: "review",
    sessionTitle: session.title,
    sessionPrompt: session.prompt_md,
    attemptNumber,
    attemptFeedback: feedbackText,
    repoName: github.repo.name,
    repoFullName: github.repo.full_name,
    repoDefaultBranch: github.repo.default_branch ?? "main",
    productSpec,
    designDoc,
  });

  // --- Provision workspace on the PR branch ---
  const repoUrl = buildCloneUrl(github.installationId, github.repo.full_name);
  let workspace: { branch: string; path: string } | null = null;

  try {
    workspace = await createWorkspace({
      repoUrl,
      sessionId: session.id,
      branch: pr.branch_name,
    });

    // Fetch the PR branch from remote and check it out so the agent
    // reviews the actual PR diff, not a fresh empty branch.
    await gitExec(["fetch", "origin", pr.branch_name], workspace.path);
    await gitExec(["checkout", pr.branch_name], workspace.path);
    await gitExec(["reset", "--hard", `origin/${pr.branch_name}`], workspace.path);
  } catch (err) {
    return errorResult(
      admin,
      job,
      `Failed to provision workspace: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // --- Create agent run record ---
  const runId = await createAgentRun(admin, {
    jobId: job.id,
    issueId: job.issue_id ?? session.issue_id,
    model: agentConfig.model ?? "claude-code",
    provider,
    runType: "review",
    workspaceId: session.workspace_id,
  });

  if (!runId) {
    await cleanupWorkspace(session.id);
    return errorResult(admin, job, "Failed to create agent_run record.");
  }

  try {
    // --- Multi-turn agent loop ---
    const runner = createAgentRunner(provider);
    let continueSessionId: string | undefined;
    let taskComplete = false;

    for (let turn = 0; turn < maxTurns; turn++) {
      await updateRunActivity(admin, runId);

      const turnPrompt =
        turn === 0
          ? prompt
          : "Continue the review. Check any remaining areas and finalize your review report.";

      const events = runner.start({
        sessionId: session.id,
        workspacePath: workspace.path,
        prompt: turnPrompt,
        continueSessionId,
      });

      for await (const event of events) {
        await persistEvent(admin, runId, session.workspace_id, event);
        await updateRunActivity(admin, runId);

        if (event.type === "completion") {
          taskComplete = event.taskComplete;
          const sessionIdMatch = event.summary.match(/session:\s*(\S+)/i);
          if (sessionIdMatch) {
            continueSessionId = sessionIdMatch[1];
          }
        }

        if (event.type === "error") {
          console.error("[review] Agent error event", {
            message: event.message,
            runId,
            turn: turn + 1,
          });
        }
      }

      if (taskComplete) break;

      // Between turns: check if session is still active.
      if (session.linear_issue_id) {
        const stillActive = await isLinearIssueActive(admin, session.id);
        if (!stillActive) {
          await persistEvent(admin, runId, session.workspace_id, {
            type: "text",
            text: "Session is no longer active. Stopping review.",
          });
          break;
        }
      }
    }

    // --- Collect the review artifact ---
    const reviewReport = await collectReviewArtifact(admin, runId, pr);

    // --- Store review artifact ---
    const newVersion = session.current_artifact_version + 1;
    await admin.from("session_artifacts").insert({
      artifact_json: reviewReport,
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

    // --- Mark run and job as success ---
    await markRunSuccess(admin, runId);
    return successResult(admin, job, runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Review phase failed";
    await markRunError(admin, runId);
    return errorResult(admin, job, message, runId);
  } finally {
    await cleanupWorkspace(session.id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect the review report from agent run messages.
 */
async function collectReviewArtifact(
  admin: AdminClient,
  runId: string,
  pr: Tables<"session_pull_requests">,
): Promise<string> {
  const { data: messages } = await admin
    .from("agent_run_messages")
    .select("kind, message_md")
    .eq("agent_run_id", runId)
    .order("created_at", { ascending: false });

  type Msg = { kind: string; message_md: string };

  const lines: string[] = [];
  lines.push("# Review");
  lines.push("");
  lines.push(`**Branch:** \`${pr.branch_name}\``);
  if (pr.pull_request_url) {
    lines.push(`**Pull Request:** [#${pr.pull_request_number}](${pr.pull_request_url})`);
  }
  lines.push("");

  if (!messages || messages.length === 0) {
    lines.push("_No review output produced by agent._");
    return lines.join("\n");
  }

  // Use the last completion summary as the review body.
  const completionMsg = (messages as Msg[]).find((m) => m.kind === "completion");
  if (completionMsg?.message_md) {
    lines.push(completionMsg.message_md);
  } else {
    // Fall back to text events.
    const textMessages = (messages as Msg[])
      .filter((m) => m.kind === "text")
      .reverse()
      .map((m) => m.message_md);
    lines.push(...textMessages);
  }

  return lines.join("\n");
}
