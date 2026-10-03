import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import {
  resolveEffectiveSessionRepository,
  type EffectiveSessionRepository,
} from "@/features/sessions/effective-repository";
import { inferWallieRunMode } from "@/features/wallie/utils";
import type { PipelineStage } from "@/features/sessions/types";
import { resolveGitHubAppConfig } from "@/features/github/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  createAgentRunner,
  DEFAULT_OPENCODE_MODEL,
  loadWorkspaceAgentConfig,
} from "@/lib/agent-runner";
import {
  AGENT_PROVIDERS,
  normalizeAgentProviderName,
  type AgentEffort,
} from "@/lib/agent-config/contracts";
import { enqueueSessionJobWithRun, resolveQueuedRunConfig } from "@/lib/wallie/service";
import type { AgentEvent, AgentRunner } from "@/lib/agent-runner/types";
import { getClaudeCodeCredentialForSession } from "@/lib/claude-code/tokens";
import { createCodexChatGptAuthStore, getCodexCredentialForSession } from "@/lib/codex/tokens";
import { getCursorCredentialForSession, markCursorReconnectRequired } from "@/lib/cursor/tokens";
import { getOpenCodeAuthForSession } from "@/lib/opencode/tokens";
import { createSessionSandbox, resolveSandboxImplementation, stopSandboxById } from "@/lib/sandbox";
import type { AgentProvider, SandboxConnection, SandboxHandle } from "@/lib/sandbox/types";
import { assertCurrentSandboxCapabilityCheck } from "@/lib/sandbox-capabilities/readiness";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import { buildStageBranchName } from "@/lib/pipeline/branch-name";
import { ACTIVE_AGENT_RUN_STATUSES } from "@/lib/pipeline/cancel";
import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import {
  formatSessionAttachmentPromptData,
  loadSessionAttachmentInputs,
  materializeSessionAttachments,
  SESSION_ATTACHMENT_PROMPT_INSTRUCTIONS,
} from "@/lib/pipeline/session-attachments";
import { renderStagePrompt } from "@/lib/prompt-templates";

import { openSessionPullRequest } from "./pull-request";
import { loadCompletedStageArtifacts, loadPipelineOperatingRules, loadStageById } from "./stages";

type AdminClient = SupabaseClient<Database>;
type SessionRow = Tables<"sessions">;

interface ProcessPipelineJobResult {
  jobId: string;
  processed: boolean;
  result: "error" | "idle" | "success";
  runId: string | null;
}

class MissingReviewableOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingReviewableOutputError";
  }
}

const RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH = 1000;
const REDACTED_RUN_DIAGNOSTIC_VALUE = "[redacted]";
const RUN_FAILURE_SECRET_KEY_SOURCE = String.raw`(?:access[_-]?key|access[_-]?token|api[_-]?key|client[_-]?secret|credential|password|private[_-]?key|secret|token)`;
const RUN_FAILURE_SECRET_KEY_PATTERN = new RegExp(RUN_FAILURE_SECRET_KEY_SOURCE, "i");
const RUN_FAILURE_QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Z0-9_-]*(?:${RUN_FAILURE_SECRET_KEY_SOURCE})[A-Z0-9_-]*\s*[:=]\s*)(["'])(?:\\.|(?!\2)[\s\S])*?\2`,
  "gi",
);
const RUN_FAILURE_UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Z0-9_-]*(?:${RUN_FAILURE_SECRET_KEY_SOURCE})[A-Z0-9_-]*\s*[:=]\s*)(?!["'])[^\r\n;,]+`,
  "gi",
);

export type PipelinePhaseActionResult = {
  error?: string;
  jobId?: string | null;
  session?: {
    archivedAt: string | null;
    currentArtifactVersion: number | null;
    currentStageId: string;
    phaseStatus: Tables<"sessions">["phase_status"];
    rejectionCount: number;
  };
  success: boolean;
};

export async function processPipelineJob(input: {
  admin?: AdminClient;
  job: Tables<"agent_jobs">;
  signal?: AbortSignal;
}): Promise<ProcessPipelineJobResult> {
  const admin = input.admin ?? createSupabaseAdminClient();
  // Carry the claim's identity through every await, including failure handling.
  const job = { ...input.job };
  let session: SessionRow | null;
  let stage: PipelineStage | null;
  try {
    const loaded = await loadSessionById(admin, job.session_id);
    session = loaded ? { ...loaded } : null;
    stage = session ? await loadStageById(admin, session.current_stage_id) : null;
  } catch (error) {
    const result = await failPipelineJob(admin, job, getErrorMessage(error, "Pipeline job failed"));
    return { jobId: job.id, processed: true, result, runId: null };
  }
  if (!session || !stage) {
    const message = session
      ? `Session ${session.id} references missing stage ${session.current_stage_id}.`
      : "No session row found for this job.";
    const result = await failPipelineJob(admin, job, message);
    return { jobId: job.id, processed: true, result, runId: null };
  }
  return runStage({ admin, job, session, signal: input.signal, stage });
}

class ExecutionOwnershipLostError extends Error {
  constructor() {
    super("This execution no longer owns its run.");
    this.name = "ExecutionOwnershipLostError";
  }
}

// --- Generic stage runner ---
//
// One implementation handles every user-defined stage. Render the stage's
// prompt against the session context, run it through the agent runner, capture
// the text output as a markdown artifact, and flip phase_status to
// awaiting_review. No specialized output shapes — that's the v1 trade-off for
// letting workspaces define their own pipeline.
async function runStage(input: {
  admin: AdminClient;
  job: Tables<"agent_jobs">;
  signal?: AbortSignal;
  session: SessionRow;
  stage: PipelineStage;
}): Promise<ProcessPipelineJobResult> {
  const { admin, job, session, signal, stage } = input;

  let runId: string | null = null;
  let sandbox: SandboxHandle | null = null;
  let github: {
    installationId: number;
    repo: { default_branch: string | null; full_name: string; id: string };
  } | null = null;
  const branch = buildStageBranchName(session.id, stage.slug, {
    jobId: job.id,
    attemptCount: job.attempt_count,
  });
  let installationToken: string | undefined;
  const collectedText: string[] = [];
  let finalOutput: string | undefined;
  let runFailureMessageRecorded = false;
  try {
    const [
      config,
      previousStages,
      attemptFeedback,
      operatingRulesMd,
      sessionAttachments,
      repository,
    ] = await Promise.all([
      loadWorkspaceAgentConfig(admin, session.workspace_id),
      loadCompletedStageArtifacts(admin, session.id),
      loadLatestFeedback(admin, session.id, stage.id),
      loadPipelineOperatingRules(admin, stage.pipelineId),
      loadSessionAttachmentInputs(admin, {
        sessionId: session.id,
        workspaceId: session.workspace_id,
      }),
      resolveEffectiveSessionRepository({
        sessionId: session.id,
        supabase: admin,
        workspaceId: session.workspace_id,
      }),
    ]);
    const provider = normalizeAgentProviderName(config.provider);
    if (!provider) {
      throw new Error(
        `Unknown agent provider: "${config.provider}". Supported: ${AGENT_PROVIDERS.join(", ")}`,
      );
    }

    const { data: startedRunId, error: startError } = await admin.rpc("start_session_job_attempt", {
      p_job_id: job.id,
      p_attempt_count: job.attempt_count,
      p_expected_stage_id: stage.id,
      p_expected_artifact_version: session.current_artifact_version,
      p_model_provider: provider,
      p_model_name: config.model,
      p_run_type: inferWallieRunMode(repository.repositoryId),
      p_branch_name: branch,
    });
    if (startError) throw startError;
    runId = startedRunId;
    if (!runId) {
      // No authority was acquired. Never guess an active run: another start
      // carrying the same claim may have won, or a newer attempt may exist.
      await failPipelineJob(admin, job, "Session execution could not be started.", {
        retry: false,
      });
      return { jobId: job.id, processed: true, result: "idle", runId: null };
    }

    // Every supported provider runs its CLI in a repository sandbox. Provision
    // it before resolving personal credentials so setup cannot retain a revoked key.
    if (runId) {
      await persistStartupProgress(admin, runId, job.attempt_count, session.workspace_id, {
        type: "progress",
        text: "Preparing sandbox and repository…",
      });
    }
    github = await loadGitHubContext(admin, session.workspace_id, repository.repository);
    if (!github) {
      throw new Error(
        "No GitHub installation or repository found for workspace. Connect a GitHub repository in workspace settings.",
      );
    }
    const sandboxImplementation = resolveSandboxImplementation();
    const sandboxSelection =
      sandboxImplementation === "fake"
        ? null
        : await loadRequiredWorkspaceSandboxConnection(admin, session.workspace_id);
    if (sandboxSelection) {
      await assertCurrentSandboxCapabilityCheck({
        admin,
        agent: { model: config.model, provider },
        connection: sandboxSelection.connection,
        repositoryId: github.repo.id,
        workspaceId: session.workspace_id,
      });
    }
    installationToken = await mintInstallationToken(github.installationId);
    throwIfAborted(signal);
    if (!(await touchRunActivity(admin, runId, job.attempt_count)))
      throw new ExecutionOwnershipLostError();
    sandbox = await createSessionSandbox({
      agentProvider: provider,
      baseBranch: github.repo.default_branch ?? "main",
      branch,
      implementation: sandboxSelection?.provider ?? "fake",
      connection: sandboxSelection?.connection,
      installationToken,
      ownerId: runId ?? undefined,
      repoFullName: github.repo.full_name,
      signal,
      sessionId: session.id,
      workspaceId: session.workspace_id,
      onSandboxCreated: async ({ provider: sandboxProvider, sandboxId }) => {
        if (!runId) return;
        if (sandboxProvider === "fake") {
          const attached = await updateRunSandbox(admin, runId, job.attempt_count, sandboxId, {
            provider: "fake",
          });
          if (!attached) {
            await stopSandboxById(sandboxId);
            throw new ExecutionOwnershipLostError();
          }
          return;
        }
        if (!sandboxSelection || sandboxSelection.provider !== sandboxProvider) {
          throw new Error(`Workspace ${sandboxProvider} Sandbox connection is required.`);
        }
        const attached = await updateRunSandbox(admin, runId, job.attempt_count, sandboxId, {
          connection: sandboxSelection.connection,
          provider: sandboxSelection.provider,
        });
        if (!attached) {
          // The run was canceled before its sandbox id landed; stop the
          // sandbox we just created so it doesn't keep executing detached
          // from the now-canceled run.
          await stopSandboxById(sandboxId, {
            connection: sandboxSelection.connection,
          });
          throw new ExecutionOwnershipLostError();
        }
      },
    });

    let usage: { inputTokens: number; outputTokens: number } | undefined;

    const materializedAttachments = await materializeSessionAttachments(
      admin,
      sandbox,
      sessionAttachments,
    );
    const prompt = renderStagePrompt(
      {
        promptTemplateMd: trustedPromptValue("stage.promptTemplate", stage.promptTemplateMd),
        slug: trustedPromptValue("stage.slug", stage.slug),
      },
      {
        attemptFeedback:
          attemptFeedback === null
            ? null
            : untrustedPromptValue("attempt.feedback", attemptFeedback),
        attemptNumber: session.rejection_count + 1,
        operatingRulesMd: trustedPromptValue("pipeline.operatingRules", operatingRulesMd),
        previousStages: Object.fromEntries(
          Object.entries(previousStages).map(([slug, artifact]) => [
            slug,
            untrustedPromptValue(`artifact.previousStages.${slug}`, artifact),
          ]),
        ),
        sessionAttachmentInstructions:
          materializedAttachments.length > 0
            ? trustedPromptValue(
                "session.attachmentInstructions",
                SESSION_ATTACHMENT_PROMPT_INSTRUCTIONS,
              )
            : undefined,
        sessionAttachments:
          materializedAttachments.length > 0
            ? untrustedPromptValue(
                "session.attachments",
                formatSessionAttachmentPromptData(materializedAttachments),
              )
            : undefined,
        sessionPrompt: untrustedPromptValue("session.prompt", session.prompt_md),
        sessionTitle: untrustedPromptValue("session.title", session.title),
      },
    );

    if (runId) {
      await persistStartupProgress(admin, runId, job.attempt_count, session.workspace_id, {
        type: "progress",
        text: "Starting agent…",
      });
    }
    if (!(await touchRunActivity(admin, runId, job.attempt_count)))
      throw new ExecutionOwnershipLostError();
    // Runners load credentials after their own nonsecret remote setup, directly
    // before delivering the secret. Construction never decrypts personal keys.
    const runner = createSessionAgentRunner({
      admin,
      effort: config.effort,
      model: config.model,
      provider,
      session,
    });
    for await (const event of runner.start({
      maxTokens: undefined,
      prompt,
      runId: runId ?? undefined,
      sandbox: sandbox ?? undefined,
      secrets: installationToken ? [installationToken] : undefined,
      signal,
      sessionId: session.id,
    })) {
      throwIfAborted(signal);
      if (runId) {
        if (!(await persistEvent(admin, runId, job.attempt_count, session.workspace_id, event))) {
          throw new ExecutionOwnershipLostError();
        }
      }
      if (event.type === "error") {
        runFailureMessageRecorded = true;
      }
      if (event.type === "text") {
        collectedText.push(event.text);
      } else if (event.type === "completion") {
        if (event.usage) usage = event.usage;
        if (event.taskComplete && event.finalOutput?.trim()) {
          finalOutput = event.finalOutput.trim();
        }
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    const artifactMarkdown = finalOutput ?? collectedText.join("\n").trim();
    if (!artifactMarkdown) {
      const message = `${stage.name} did not produce reviewable output. Wallie only received runner bookkeeping, so no artifact was created.`;

      if (runId) {
        await persistEvent(admin, runId, job.attempt_count, session.workspace_id, {
          type: "error",
          message,
        });
        runFailureMessageRecorded = true;
      }

      throw new MissingReviewableOutputError(message);
    }

    const published = await publishArtifact({
      admin,
      artifactMarkdown,
      branch,
      github,
      job,
      runId,
      sandbox,
      session,
      stage,
      usage,
    });
    if (published === "idle") {
      return { jobId: job.id, processed: true, result: "idle", runId };
    }
  } catch (error) {
    // Sandbox providers sanitize acquisition errors while preserving their name.
    if (error instanceof Error && error.name === "ExecutionOwnershipLostError") {
      return { jobId: job.id, processed: true, result: "idle", runId };
    }
    const result = await failPipelineJob(
      admin,
      job,
      getErrorMessage(error, "Stage generation failed"),
      {
        runId,
        retry:
          !(error instanceof MissingReviewableOutputError) && !isSandboxConnectionSetupError(error),
      },
    );
    if (runId && !runFailureMessageRecorded) {
      await persistRunFailureDiagnostic(admin, { error, runId, workspaceId: session.workspace_id });
    }
    return { jobId: job.id, processed: true, result, runId };
  } finally {
    try {
      await sandbox?.stop();
    } catch (stopError) {
      console.error("Failed to stop stage sandbox", {
        error: stopError instanceof Error ? stopError.message : String(stopError),
        sessionId: session.id,
      });
    }
  }

  const { data: completed, error: completeError } = await admin.rpc(
    "complete_session_job_attempt",
    {
      p_job_id: job.id,
      p_attempt_count: job.attempt_count,
      p_run_id: runId!,
    },
  );
  if (completeError) throw completeError;
  return { jobId: job.id, processed: true, result: completed ? "success" : "idle", runId };
}

/** Publication atomically commits markdown, review state, and the owned run's success. */
async function publishArtifact(input: {
  admin: AdminClient;
  artifactMarkdown: string;
  branch: string | null;
  github: {
    installationId: number;
    repo: { default_branch: string | null; full_name: string; id: string };
  } | null;
  job: Tables<"agent_jobs">;
  runId: string;
  sandbox: SandboxHandle | null;
  session: SessionRow;
  stage: PipelineStage;
  usage: { inputTokens: number; outputTokens: number } | undefined;
}): Promise<"idle" | "published"> {
  const { admin, artifactMarkdown, branch, github, job, runId, sandbox, session, stage } = input;

  const { data: published, error: publishError } = await admin.rpc("publish_session_job_attempt", {
    p_job_id: job.id,
    p_attempt_count: job.attempt_count,
    p_run_id: runId,
    p_expected_artifact_version: session.current_artifact_version,
    p_artifact_json: artifactMarkdown,
  });
  if (publishError) throw publishError;
  if (published !== true) return "idle";

  if (input.usage) {
    const { error } = await admin
      .from("agent_runs")
      .update({
        input_tokens: input.usage.inputTokens,
        output_tokens: input.usage.outputTokens,
      })
      .eq("id", runId)
      .eq("attempt_count", job.attempt_count)
      .eq("status", "success");
    if (error) throw error;
  }

  if (sandbox && github && branch) {
    const prOutcome = await openSessionPullRequest({
      admin,
      baseBranch: github.repo.default_branch ?? "main",
      body: artifactMarkdown.slice(0, 60000),
      branch,
      installationId: github.installationId,
      repoFullName: github.repo.full_name,
      repoId: github.repo.id,
      sandbox,
      sessionId: session.id,
      title: `${stage.name}: ${session.title}`,
      workspaceId: session.workspace_id,
    });

    // PR plumbing is recoverable — the artifact is durable and the reviewer
    // can approve the artifact directly — so we never block the stage. But we
    // always surface the outcome: `no_commits` used to be fully silent, which
    // is exactly how empty `session_pull_requests` went unnoticed.
    if (prOutcome.kind === "no_commits") {
      console.info("Stage produced no pull request (no commits ahead of base)", {
        sessionId: session.id,
        stageSlug: stage.slug,
      });
    } else if (prOutcome.kind !== "success") {
      console.error("Failed to open session pull request", {
        kind: prOutcome.kind,
        reason: prOutcome.reason,
        sessionId: session.id,
        stageSlug: stage.slug,
      });
    }
  }

  // Publication already made this run successful. Append its final history
  // without requiring active execution or refreshing its activity timestamp.
  await persistRunMessage(admin, runId, session.workspace_id, {
    kind: "completion",
    messageMd: `${stage.name} run completed`,
  });

  return "published";
}

// --- Approval + rejection handlers ---

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return fallback;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Pipeline job aborted.");
}

function isSandboxConnectionSetupError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "SandboxConnectionMissingError" ||
      error.name === "SandboxConnectionInvalidError" ||
      error.name === "SandboxCapabilityCheckStaleError")
  );
}

export async function handleApproval(input: {
  admin?: AdminClient;
  approverMemberId: string | null;
  expectedWorkspaceId: string;
  sessionId: string;
  version: number;
}): Promise<PipelinePhaseActionResult> {
  const admin = input.admin ?? createSupabaseAdminClient();

  // The RPC enforces the approver gate (per-stage approver list, with
  // owner/admin fallback), records the completion, and advances to the next
  // stage by `position` in one transaction.
  const { data, error } = await admin.rpc("approve_session_stage", {
    approver_member_id: input.approverMemberId ?? undefined,
    expected_version: input.version,
    expected_workspace_id: input.expectedWorkspaceId,
    target_session_id: input.sessionId,
  });

  if (error) {
    return { error: error.message, success: false };
  }

  const row = Array.isArray(data) ? data[0] : null;

  if (!row) {
    return {
      error:
        "Approval failed: version is stale, stage already reviewed, or you are not authorized to approve this stage.",
      success: false,
    };
  }

  if (!row.archived_at && row.phase_status === "in_progress") {
    try {
      const queued = await enqueueSessionJobWithRun({
        admin,
        requestedByMemberId: input.approverMemberId,
        session: {
          current_stage_id: row.current_stage_id,
          id: input.sessionId,
          workspace_id: input.expectedWorkspaceId,
        },
        triggerType: "assignment",
      });

      return {
        jobId: queued.jobId,
        session: {
          archivedAt: row.archived_at,
          currentArtifactVersion: 0,
          currentStageId: row.current_stage_id,
          phaseStatus: row.phase_status,
          rejectionCount: 0,
        },
        success: true,
      };
    } catch (error) {
      console.error("Approved stage but failed to queue Wallie", {
        error: getErrorMessage(error, "Approved stage but failed to queue Wallie."),
        sessionId: input.sessionId,
        workspaceId: input.expectedWorkspaceId,
      });
      return {
        jobId: null,
        session: {
          archivedAt: row.archived_at,
          currentArtifactVersion: 0,
          currentStageId: row.current_stage_id,
          phaseStatus: row.phase_status,
          rejectionCount: 0,
        },
        success: true,
      };
    }
  }

  return {
    jobId: null,
    session: {
      archivedAt: row.archived_at,
      currentArtifactVersion: row.phase_status === "approved" ? input.version : 0,
      currentStageId: row.current_stage_id,
      phaseStatus: row.phase_status,
      rejectionCount: 0,
    },
    success: true,
  };
}

export async function handleRejection(input: {
  admin?: AdminClient;
  expectedWorkspaceId: string;
  feedbackText: string;
  requestedByMemberId: string | null;
  sessionId: string;
  version: number;
}): Promise<PipelinePhaseActionResult> {
  const admin = input.admin ?? createSupabaseAdminClient();

  // The rerun's queued run must carry the workspace's configured model and the
  // session's run mode, resolved with the same lookups the shared enqueue path
  // uses. These are configuration reads, not state transitions, so they sit
  // outside the RPC; a failure here changes nothing.
  let runConfig: Awaited<ReturnType<typeof resolveQueuedRunConfig>>;
  try {
    runConfig = await resolveQueuedRunConfig(admin, {
      id: input.sessionId,
      workspace_id: input.expectedWorkspaceId,
    });
  } catch (error) {
    return {
      error: getErrorMessage(error, "Failed to queue Wallie retry."),
      success: false,
    };
  }

  // One transaction: lock the session, validate workspace/archive/phase/version,
  // record the feedback, enqueue the rerun job + queued run under the session's
  // active dedupe key, and move the session to `rejected`. Any guard failure
  // raises and rolls everything back, so a rejection can no longer leave the
  // session wedged with a bumped rejection count and nothing queued, and a
  // concurrent approval serializes behind the row lock instead of racing the
  // final phase write.
  const { data, error } = await admin.rpc("reject_session_stage", {
    p_agent_model_name: runConfig.modelName,
    p_agent_model_provider: runConfig.modelProvider,
    p_artifact_version: input.version,
    p_feedback_text: input.feedbackText,
    p_requested_by_member_id: input.requestedByMemberId ?? undefined,
    p_run_type: runConfig.runType,
    p_session_id: input.sessionId,
    p_workspace_id: input.expectedWorkspaceId,
  });

  if (error) {
    // The RPC raises with the reviewer-facing message for every guard
    // ("Session not found.", "Session is archived.", "Session is not awaiting
    // review.", "Version mismatch: a newer version exists."); surface it as-is.
    return { error: error.message, success: false };
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return {
      error: "Rejection raced with another update — please refresh and try again.",
      success: false,
    };
  }

  return {
    jobId: row.job_id,
    session: {
      archivedAt: row.archived_at,
      currentArtifactVersion: row.current_artifact_version,
      currentStageId: row.current_stage_id,
      phaseStatus: row.phase_status,
      rejectionCount: row.rejection_count,
    },
    success: true,
  };
}

// --- Data access helpers ---

async function loadSessionById(admin: AdminClient, id: string): Promise<SessionRow | null> {
  const { data, error } = await admin.from("sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadLatestFeedback(
  admin: AdminClient,
  sessionId: string,
  stageId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("session_artifact_feedback")
    .select("feedback_text")
    .eq("session_id", sessionId)
    .eq("stage_id", stageId)
    .order("target_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.feedback_text ?? null;
}

function createSessionAgentRunner(input: {
  admin: AdminClient;
  effort: AgentEffort;
  model?: string;
  provider: AgentProvider;
  session: Pick<SessionRow, "creator_member_id" | "workspace_id">;
}): AgentRunner {
  switch (input.provider) {
    case "codex":
      return createAgentRunner("codex", {
        codex: {
          chatGptAuthStore: createCodexChatGptAuthStore(input.admin, input.session),
          loadCredential: () => getCodexCredentialForSession(input.admin, input.session),
          effort: input.effort,
          model: input.model,
        },
      });
    case "claude-code":
      return createAgentRunner("claude-code", {
        claudeCode: {
          loadCredential: () => getClaudeCodeCredentialForSession(input.admin, input.session),
          effort: input.effort,
          model: input.model,
        },
      });
    case "cursor":
      return createAgentRunner("cursor", {
        cursor: {
          loadCredential: () => getCursorCredentialForSession(input.admin, input.session),
          model: input.model,
          onAuthenticationFailure: (reason, credential) =>
            markCursorReconnectRequired(
              input.admin,
              credential.userId,
              credential.generation,
              reason,
            ),
        },
      });
    case "opencode":
      return createAgentRunner("opencode", {
        openCode: {
          loadAuth: () =>
            getOpenCodeAuthForSession(
              input.admin,
              input.session,
              input.model ?? DEFAULT_OPENCODE_MODEL,
            ),
          model: input.model,
        },
      });
  }
}

interface GitHubContext {
  installationId: number;
  repo: {
    default_branch: string | null;
    full_name: string;
    id: string;
  };
}

async function loadGitHubContext(
  admin: AdminClient,
  workspaceId: string,
  repository: EffectiveSessionRepository | null,
): Promise<GitHubContext | null> {
  if (!repository || repository.isArchived) {
    return null;
  }

  const { data: installation } = await admin
    .from("github_installations")
    .select("id, installation_id")
    .eq("id", repository.githubInstallationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!installation) return null;

  return {
    installationId: installation.installation_id,
    repo: {
      default_branch: repository.defaultBranch,
      full_name: repository.fullName,
      id: repository.id,
    },
  };
}

async function mintInstallationToken(installationId: number): Promise<string> {
  const { App } = await import("@octokit/app");
  const app = new App(resolveGitHubAppConfig());
  const { data } = await app.octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    { installation_id: installationId },
  );
  return data.token;
}

async function updateRunSandbox(
  admin: AdminClient,
  runId: string,
  attemptCount: number,
  sandboxId: string,
  metadata:
    | {
        provider: "fake";
      }
    | {
        connection: SandboxConnection;
        provider: "daytona" | "e2b" | "vercel";
      },
): Promise<boolean> {
  const vercelMetadata =
    metadata.provider === "vercel" && metadata.connection.provider === "vercel"
      ? {
          sandbox_vercel_project_id: metadata.connection.credentials.projectId,
          sandbox_vercel_team_id: metadata.connection.credentials.teamId,
        }
      : {
          sandbox_vercel_project_id: null,
          sandbox_vercel_team_id: null,
        };
  const { data, error } = await admin
    .from("agent_runs")
    .update({
      sandbox_id: sandboxId,
      sandbox_provider: metadata.provider,
      sandbox_connection_revision:
        metadata.provider === "fake" ? null : metadata.connection.revision,
      ...vercelMetadata,
    })
    .eq("id", runId)
    .eq("attempt_count", attemptCount)
    // Only attach the sandbox to a run that is still active. If the run was
    // canceled in the race before its sandbox id landed, this affects zero
    // rows and the caller stops the orphaned sandbox.
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select("id");
  if (error) {
    throw error;
  }
  return (data?.length ?? 0) > 0;
}

/** Startup hints are best effort; a logging outage must not prevent execution. */
async function persistStartupProgress(
  admin: AdminClient,
  runId: string,
  attemptCount: number,
  workspaceId: string,
  event: Extract<AgentEvent, { type: "progress" }>,
) {
  try {
    if (!(await persistEvent(admin, runId, attemptCount, workspaceId, event))) {
      throw new ExecutionOwnershipLostError();
    }
  } catch (error) {
    if (error instanceof ExecutionOwnershipLostError) throw error;
    console.warn("Wallie could not record startup progress.");
  }
}

async function persistEvent(
  admin: AdminClient,
  runId: string,
  attemptCount: number,
  workspaceId: string,
  event: AgentEvent,
): Promise<boolean> {
  let kind: string;
  let messageMd: string;

  switch (event.type) {
    case "progress":
    case "text":
      kind = event.type;
      messageMd = event.text;
      break;
    case "tool_use":
      kind = "tool_use";
      messageMd = `**Tool:** ${event.tool}\n\n\`\`\`\n${event.input}\n\`\`\``;
      break;
    case "completion":
      if (isGenericRunnerCompletionSummary(event.summary)) {
        return touchRunActivity(admin, runId, attemptCount);
      }
      kind = "completion";
      messageMd = event.summary;
      break;
    case "error":
      kind = "error";
      messageMd = `**Error:** ${event.message}`;
      break;
  }

  await persistRunMessage(admin, runId, workspaceId, { kind, messageMd });
  return touchRunActivity(admin, runId, attemptCount);
}

/** Run history remains append-only after publication and never changes ownership. */
async function persistRunMessage(
  admin: AdminClient,
  runId: string,
  workspaceId: string,
  input: { kind: string; messageMd: string },
): Promise<void> {
  const { error } = await admin.from("agent_run_messages").insert({
    agent_run_id: runId,
    kind: input.kind,
    message_md: input.messageMd,
    workspace_id: workspaceId,
  });
  if (error) throw error;
}

async function persistRunFailureDiagnostic(
  admin: AdminClient,
  input: { error: unknown; runId: string; workspaceId: string },
): Promise<void> {
  const message = sanitizeRunFailureDiagnostic(
    typeof input.error === "string"
      ? input.error
      : getErrorMessage(input.error, "Stage generation failed"),
  );

  try {
    const { error } = await admin.from("agent_run_messages").insert({
      agent_run_id: input.runId,
      kind: "error",
      message_md: `**Error:** ${message}`,
      workspace_id: input.workspaceId,
    });

    if (error) {
      console.error("Failed to persist run failure diagnostic", {
        error: getErrorMessage(error, "Unknown diagnostic persistence error"),
        runId: input.runId,
      });
    }
  } catch (error) {
    console.error("Failed to persist run failure diagnostic", {
      error: getErrorMessage(error, "Unknown diagnostic persistence error"),
      runId: input.runId,
    });
  }
}

function redactJsonSecretFields(message: string): string {
  let redacted = "";
  let lastWritten = 0;
  let index = 0;

  while (index < message.length) {
    const key = readQuotedDiagnosticValue(message, index);
    if (!key) {
      index += 1;
      continue;
    }

    let cursor = skipDiagnosticWhitespace(message, key.end);
    if (message[cursor] !== ":") {
      index = key.end;
      continue;
    }

    if (!RUN_FAILURE_SECRET_KEY_PATTERN.test(key.value)) {
      index = key.end;
      continue;
    }

    cursor += 1;
    const valueStart = skipDiagnosticWhitespace(message, cursor);
    const valueEnd = findJsonDiagnosticValueEnd(message, valueStart);
    const redactionQuote = message[valueStart] === "'" ? "'" : `"`;

    redacted += message.slice(lastWritten, cursor);
    redacted += ` ${redactionQuote}${REDACTED_RUN_DIAGNOSTIC_VALUE}${redactionQuote}`;
    lastWritten = valueEnd;
    index = valueEnd;
  }

  return redacted + message.slice(lastWritten);
}

function readQuotedDiagnosticValue(
  message: string,
  start: number,
): { end: number; quote: `"` | "'"; value: string } | null {
  const quote = message[start];
  if (quote !== `"` && quote !== "'") return null;

  let value = "";
  for (let index = start + 1; index < message.length; index += 1) {
    const char = message[index]!;
    if (char === "\\") {
      const escaped = message[index + 1];
      if (escaped) {
        value += escaped;
        index += 1;
      }
      continue;
    }
    if (char === quote) {
      return { end: index + 1, quote, value };
    }
    value += char;
  }

  return null;
}

function skipDiagnosticWhitespace(message: string, start: number): number {
  let index = start;
  while (index < message.length && /\s/.test(message[index]!)) {
    index += 1;
  }
  return index;
}

function findJsonDiagnosticValueEnd(message: string, start: number): number {
  const first = message[start];
  if (first === `"` || first === "'") {
    return readQuotedDiagnosticValue(message, start)?.end ?? message.length;
  }

  if (first === "{" || first === "[") {
    const stack = [first === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < message.length) {
      const char = message[index]!;
      if (char === `"` || char === "'") {
        index = readQuotedDiagnosticValue(message, index)?.end ?? message.length;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) {
          return index + 1;
        }
      }
      index += 1;
    }
    return message.length;
  }

  let index = start;
  while (index < message.length && !/[\r\n,}\]]/.test(message[index]!)) {
    index += 1;
  }
  return index;
}

function sanitizeRunFailureDiagnostic(message: string): string {
  const fallback = "Stage generation failed";
  let sanitized = message.trim() || fallback;

  sanitized = redactJsonSecretFields(sanitized);

  sanitized = sanitized
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
      `$1${REDACTED_RUN_DIAGNOSTIC_VALUE}@`,
    )
    .replace(
      /([?&](?:access[_-]?token|api[_-]?key|auth|code|credential|key|password|secret|token)=)[^&\s]+/gi,
      `$1${REDACTED_RUN_DIAGNOSTIC_VALUE}`,
    )
    .replace(RUN_FAILURE_QUOTED_SECRET_ASSIGNMENT_PATTERN, `$1$2${REDACTED_RUN_DIAGNOSTIC_VALUE}$2`)
    .replace(
      /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
      REDACTED_RUN_DIAGNOSTIC_VALUE,
    )
    .replace(RUN_FAILURE_UNQUOTED_SECRET_ASSIGNMENT_PATTERN, `$1${REDACTED_RUN_DIAGNOSTIC_VALUE}`)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi, `$1 ${REDACTED_RUN_DIAGNOSTIC_VALUE}`)
    .replace(
      /\b(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|sb_[A-Za-z0-9_-]{16,}|vca_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
      REDACTED_RUN_DIAGNOSTIC_VALUE,
    );

  if (sanitized.length > RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH) {
    return `${sanitized.slice(0, RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH - 3)}...`;
  }

  return sanitized;
}

function isGenericRunnerCompletionSummary(summary: string) {
  return summary.trim().toLowerCase() === "codex session completed";
}

async function touchRunActivity(
  admin: AdminClient,
  runId: string,
  attemptCount: number,
): Promise<boolean> {
  const { data, error } = await admin
    .from("agent_runs")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", runId)
    .eq("attempt_count", attemptCount)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

async function loadMaxRetries(admin: AdminClient, workspaceId: string): Promise<number> {
  const { data } = await admin
    .from("workspace_agent_config")
    .select("value_json")
    .eq("workspace_id", workspaceId)
    .eq("key", "max_retries")
    .maybeSingle();

  if (data && typeof data.value_json === "number") {
    return data.value_json;
  }
  return 3;
}

async function failPipelineJob(
  admin: AdminClient,
  job: Tables<"agent_jobs">,
  errorMessage: string,
  options: { retry?: boolean; runId?: string | null } = {},
): Promise<ProcessPipelineJobResult["result"]> {
  const maxRetries = await loadMaxRetries(admin, job.workspace_id);
  const { data, error } = await admin.rpc("fail_session_job_attempt", {
    p_job_id: job.id,
    p_attempt_count: job.attempt_count,
    p_run_id: options.runId ?? undefined,
    p_error: errorMessage,
    p_retry: options.retry !== false,
    p_max_retries: maxRetries,
  });
  if (error) throw error;
  if (data === "stale") return "idle";
  if (data === "success") return "success";
  if (data === "queued" || data === "error") return "error";
  throw new Error("Unexpected execution failure receipt.");
}
