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
  isLinearIssueActive,
  loadAgentConfig,
  loadGitHubContext,
  loadLatestArtifact,
  loadPhaseArtifactText,
  markRunError,
  markRunSuccess,
  persistEvent,
  successResult,
  updateRunActivity,
} from "./phase-helpers";

interface DesignPhaseInput {
  admin: AdminClient;
  job: Tables<"agent_jobs">;
  session: SessionRow;
  botToken: string;
}

/**
 * Run the design phase: provision a workspace, launch a coding agent to
 * explore the codebase and generate a technical design document, then
 * store the result as a session artifact.
 */
export async function runDesignPhase(input: DesignPhaseInput): Promise<PhaseResult> {
  const { admin, job, session } = input;

  // --- Load configuration ---
  const agentConfig = await loadAgentConfig(admin, session.workspace_id);
  const maxTurns = agentConfig.maxTurns ?? DEFAULT_AGENT_RUNNER_CONFIG.maxTurns ?? 5;
  const provider = agentConfig.provider ?? DEFAULT_AGENT_RUNNER_CONFIG.provider;

  // --- Load GitHub context (needed for workspace provisioning) ---
  const github = await loadGitHubContext(admin, session.workspace_id);
  if (!github) {
    return errorResult(
      admin,
      job,
      "No GitHub installation or repository found for workspace. " +
        "Connect a GitHub repository in workspace settings.",
    );
  }

  // --- Load approved product spec ---
  const productSpec = await loadPhaseArtifactText(admin, session.id, "product");

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
    phase: "design",
    sessionTitle: session.title,
    sessionPrompt: session.prompt_md,
    attemptNumber,
    attemptFeedback: feedbackText,
    repoName: github.repo.name,
    repoFullName: github.repo.full_name,
    repoDefaultBranch: github.repo.default_branch ?? "main",
    productSpec,
  });

  // --- Provision workspace ---
  const repoUrl = buildCloneUrl(github.installationId, github.repo.full_name);
  const branch = `wallie/design-${session.id}`;
  let workspace: { branch: string; path: string } | null = null;

  try {
    workspace = await createWorkspace({
      repoUrl,
      sessionId: session.id,
      branch,
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
    issueId: job.issue_id ?? session.issue_id,
    model: agentConfig.model ?? "claude-code",
    provider,
    runType: "design",
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
          : "Continue working on the technical design document. Review what you've produced so far and complete any remaining sections.";

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
          console.error("[design] Agent error event", {
            message: event.message,
            runId,
            turn: turn + 1,
          });
        }
      }

      if (taskComplete) break;

      // Between turns: check if session is still active (reconciliation).
      if (session.linear_issue_id) {
        const stillActive = await isLinearIssueActive(admin, session.id);
        if (!stillActive) {
          await persistEvent(admin, runId, session.workspace_id, {
            type: "text",
            text: "Session is no longer active. Stopping agent.",
          });
          break;
        }
      }
    }

    // --- Collect the agent's output as the design artifact ---
    // The agent's last completion summary serves as the design document.
    // We also check if the agent wrote a design doc file in the workspace.
    const designDoc = await collectDesignArtifact(admin, runId);

    // --- Store design artifact ---
    const newVersion = session.current_artifact_version + 1;
    await admin.from("session_artifacts").insert({
      artifact_json: designDoc,
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
    const message = err instanceof Error ? err.message : "Design phase failed";
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
 * Collect the design document from agent run messages.
 * Uses the last completion event summary, or falls back to concatenating
 * all text events from the run.
 */
async function collectDesignArtifact(admin: AdminClient, runId: string): Promise<string> {
  const { data: messages } = await admin
    .from("agent_run_messages")
    .select("kind, message_md")
    .eq("agent_run_id", runId)
    .order("created_at", { ascending: false });

  type Msg = { kind: string; message_md: string };

  if (!messages || messages.length === 0) {
    return "# Design\n\n_No output produced by agent._\n";
  }

  // Prefer the last completion summary.
  const completionMsg = (messages as Msg[]).find((m) => m.kind === "completion");
  if (completionMsg?.message_md) {
    return completionMsg.message_md;
  }

  // Fall back to concatenating text events.
  const textMessages = (messages as Msg[])
    .filter((m) => m.kind === "text")
    .reverse()
    .map((m) => m.message_md);

  if (textMessages.length > 0) {
    return textMessages.join("\n\n");
  }

  return "# Design\n\n_No output produced by agent._\n";
}
