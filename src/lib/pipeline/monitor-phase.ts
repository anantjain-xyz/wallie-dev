import type { Tables } from "@/lib/supabase/database.types";
import { DEFAULT_AGENT_RUNNER_CONFIG } from "@/lib/agent-runner";
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
  isLinearIssueActive,
  loadAgentConfig,
  loadGitHubContext,
  loadLatestArtifact,
  loadPhaseArtifactText,
  loadSessionPullRequest,
  markRunError,
  markRunSuccess,
  persistEvent,
  resolveAgentRunner,
  successResult,
  updateRunActivity,
} from "./phase-helpers";

interface MonitorPhaseInput {
  admin: AdminClient;
  job: Tables<"agent_jobs">;
  session: SessionRow;
  botToken: string;
}

/**
 * Run the monitor phase: provision a workspace on the default branch
 * (which now includes the merged changes), launch an agent to run tests
 * and check for post-land regressions, and produce a monitoring report.
 */
export async function runMonitorPhase(input: MonitorPhaseInput): Promise<PhaseResult> {
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

  // --- Load context from previous phases ---
  const productSpec = await loadPhaseArtifactText(admin, session.id, "product");
  const pr = await loadSessionPullRequest(admin, session.id);

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
    phase: "monitor",
    sessionTitle: session.title,
    sessionPrompt: session.prompt_md,
    attemptNumber,
    attemptFeedback: feedbackText,
    repoName: github.repo.name,
    repoFullName: github.repo.full_name,
    repoDefaultBranch: github.repo.default_branch ?? "main",
    productSpec,
  });

  // --- Provision workspace on default branch (post-merge) ---
  // Use a unique branch name because createWorkspace always runs
  // `git checkout -b`, and the default branch already exists after
  // clone — passing it directly would cause a "branch already exists"
  // fatal error. The unique branch starts from the same HEAD as the
  // default branch, so regression checks run against post-merge code.
  const repoUrl = buildCloneUrl(github.installationId, github.repo.full_name);
  let workspace: { branch: string; path: string } | null = null;

  try {
    workspace = await createWorkspace({
      repoUrl,
      sessionId: session.id,
      branch: `wallie/monitor-${session.id}`,
    });
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
    sessionId: session.id,
    model: agentConfig.model ?? DEFAULT_AGENT_RUNNER_CONFIG.model ?? "codex",
    provider,
    runType: "monitor",
    workspaceId: session.workspace_id,
  });

  if (!runId) {
    await cleanupWorkspace(session.id);
    return errorResult(admin, job, "Failed to create agent_run record.");
  }

  try {
    // --- Resolve agent runner (codex requires per-user OAuth credentials) ---
    const runnerResult = await resolveAgentRunner({
      admin,
      session,
      provider,
      model: agentConfig.model,
    });
    if (!runnerResult.ok) {
      await markRunError(admin, runId);
      return errorResult(admin, job, runnerResult.error, runId);
    }

    // --- Multi-turn agent loop ---
    const runner = runnerResult.runner;
    let continueSessionId: string | undefined;
    let taskComplete = false;

    for (let turn = 0; turn < maxTurns; turn++) {
      await updateRunActivity(admin, runId);

      const turnPrompt =
        turn === 0
          ? prompt
          : "Continue the regression check. Verify any remaining tests and finalize your monitoring report.";

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
          console.error("[monitor] Agent error event", {
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
            text: "Session is no longer active. Stopping monitor.",
          });
          break;
        }
      }
    }

    // --- Collect the monitoring artifact ---
    const monitorReport = await collectMonitorArtifact(admin, runId, pr);

    // --- Store monitor artifact ---
    const newVersion = session.current_artifact_version + 1;
    await admin.from("session_artifacts").insert({
      artifact_json: monitorReport,
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
    const message = err instanceof Error ? err.message : "Monitor phase failed";
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
 * Collect the monitoring report from agent run messages and merge context.
 */
async function collectMonitorArtifact(
  admin: AdminClient,
  runId: string,
  pr: Tables<"session_pull_requests"> | null,
): Promise<string> {
  const { data: messages } = await admin
    .from("agent_run_messages")
    .select("kind, message_md")
    .eq("agent_run_id", runId)
    .order("created_at", { ascending: false });

  type Msg = { kind: string; message_md: string };

  const lines: string[] = [];
  lines.push("# Monitor");
  lines.push("");
  if (pr?.pull_request_url) {
    lines.push(`**Pull Request:** [#${pr.pull_request_number}](${pr.pull_request_url})`);
  }
  lines.push(`**Checked At:** ${new Date().toISOString()}`);
  lines.push("");

  if (!messages || messages.length === 0) {
    lines.push("_No monitoring output produced by agent._");
    return lines.join("\n");
  }

  // Use the last completion summary as the monitoring report body.
  const completionMsg = (messages as Msg[]).find((m) => m.kind === "completion");
  if (completionMsg?.message_md) {
    lines.push(completionMsg.message_md);
  } else {
    const textMessages = (messages as Msg[])
      .filter((m) => m.kind === "text")
      .reverse()
      .map((m) => m.message_md);
    lines.push(...textMessages);
  }

  return lines.join("\n");
}
