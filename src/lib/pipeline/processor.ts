import "server-only";
import {
  RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH,
  VERCEL_SANDBOX_FAILURE_DIAGNOSTIC_MAX_LENGTH,
  sanitizeRunFailureDiagnostic,
} from "./failure-diagnostic";
import { redactRunSensitiveText } from "@/lib/agent-runner/redact-sensitive-text";
import {
  isScopedCredentialCleanupError,
  ScopedCredentialCleanupError,
} from "@/lib/agent-runner/scoped-credentials";
import {
  resolveScopedRunCredential,
  ScopedRunCredentialUnavailableError,
} from "@/lib/agent-credentials/scoped-run-credential";
import { wakeWorker } from "@/lib/worker/wake";
import { validateCheckpoint } from "@/lib/validation-evidence/service";
import type {
  BrowserScreenshotRuntime,
  BrowserVideoRuntime,
} from "@/lib/validation-evidence/browser-contract";
import { prepareValidationPlan, validationPlanInstructions } from "@/lib/validation-evidence/plan";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import {
  resolveEffectiveSessionRepository,
  type EffectiveSessionRepository,
} from "@/features/sessions/effective-repository";
import { inferWallieRunMode } from "@/features/wallie/utils";
import type { PipelineStage } from "@/features/sessions/types";
import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  createAgentRunner,
  DEFAULT_AGENT_EFFORT,
  DEFAULT_AGENT_RUNNER_CONFIG,
  DEFAULT_OPENCODE_MODEL,
  loadWorkspaceAgentConfig,
} from "@/lib/agent-runner";
import {
  loadPinnedFactoryExecution,
  loadPinnedFactoryRepositoryId,
  loadPinnedSessionPrompt,
  type PinnedFactoryExecution,
} from "@/lib/factory-definitions/runtime-definition";
import { resolveFactoryExecutionProfile } from "@/lib/factory-definitions/execution-profile";
import {
  AGENT_PROVIDERS,
  agentProviderSupportsEffort,
  normalizeAgentProviderName,
  OPENCODE_ZEN_PROVIDER_ID,
  parseOpenCodeModelId,
  type AgentEffort,
} from "@/lib/agent-config/contracts";
import {
  loadPinnedSessionJobGitInput,
  pinSessionJobGitInput,
  resolveQueuedRunConfig,
} from "@/lib/wallie/service";
import type { AgentRunner, AgentRunUsage } from "@/lib/agent-runner/types";
import { getClaudeCodeCredentialForSession } from "@/lib/claude-code/tokens";
import { createCodexChatGptAuthStore, getCodexCredentialForSession } from "@/lib/codex/tokens";
import { getCursorCredentialForSession, markCursorReconnectRequired } from "@/lib/cursor/tokens";
import { getOpenCodeAuthForSession } from "@/lib/opencode/tokens";
import { resolveSandboxImplementation, stopSandboxById } from "@/lib/sandbox";
import { redactSecrets } from "@/lib/sandbox/command";
import { formatVercelSandboxError, isVercelSandboxApiError } from "@/lib/vercel-sandbox/errors";
import { createWorkspaceSessionSandbox } from "@/lib/workspaces/resource-operations";
import type { AgentProvider, SandboxConnection, SandboxHandle } from "@/lib/sandbox/types";
import { assertCurrentSandboxCapabilityCheck } from "@/lib/sandbox-capabilities/readiness";
import { loadRequiredWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import { buildStageBranchName } from "@/lib/pipeline/branch-name";
import { ACTIVE_AGENT_RUN_STATUSES } from "@/lib/pipeline/cancel";
import { evaluateSessionPrReadiness } from "@/lib/pipeline/pr-readiness";
import { trustedPromptValue, untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import { loadRunAgentPrompt } from "@/lib/factory-agents/runtime";
import {
  factoryMemoryProposalInstructions,
  factoryMemoryProposalPath,
  stageFactoryMemoryProposal,
} from "@/lib/factory-memory/proposal";
import { resolveFactoryMcpCredentials } from "@/lib/factory-mcp/credentials";
import { loadFactorySkillBundle } from "@/lib/factory-skills/runtime";
import {
  formatSessionAttachmentPromptData,
  loadSessionAttachmentInputs,
  materializeSessionAttachments,
  SESSION_ATTACHMENT_PROMPT_INSTRUCTIONS,
} from "@/lib/pipeline/session-attachments";
import { renderStagePrompt } from "@/lib/prompt-templates";
import { RunContextRequiredInputTooLargeError } from "@/lib/run-context/packing";
import {
  FrozenRunContextUnavailableError,
  frozenRepositoryCommits,
  prepareRunContext,
  readRunContextOrigin,
  requiredRunContextInputs,
} from "@/lib/run-context/server";
import { loadJobFeedback } from "./job-feedback";
import { loadSpecificationPromptContext } from "./specification-context";
import { pinSessionAttemptManifest, type AttemptWorkerRuntime } from "./attempt-manifest";
import { ExecutionOwnershipLostError, RunEventCapture } from "./run-events";

import {
  captureSourceCheckpoint,
  readSourceBase,
  type SourceCheckpoint,
  UnsupportedLfsCheckpointError,
  UnsupportedSourceTransformError,
  UnsupportedSubmoduleCheckpointError,
  UnsafeRuntimeCheckpointError,
} from "./source-checkpoint";
import {
  publishSessionCheckpoint,
  CheckpointPublicationPendingError,
} from "./checkpoint-publication";
import { prepareSourceDelivery, SourcePreservationError } from "./source-delivery";
import { checkoutPinnedGitInput } from "./git-input";
import { materializeFactoryRepositoryContext } from "./repository-context";
import { restoreRetryInput, saveRetryCheckpoint } from "./retry-checkpoint";
import {
  deferSessionJobForGitContinuityRelease,
  isGitContinuityReleasePause,
} from "./git-continuity-release";
import { loadAttemptPredecessors, loadPipelineOperatingRules, loadStageById } from "./stages";
import {
  ExecutionBudgetExhaustedError,
  loadSessionExecutionBudget,
  recordSessionRunUsage,
  remainingTokenBudget,
} from "./execution-budget";

type AdminClient = SupabaseClient<Database>;
type SessionRow = Tables<"sessions">;
const RETRY_CHECKPOINT_LEAD_MS = 60_000;

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

class FactoryExecutionProfileUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactoryExecutionProfileUnavailableError";
  }
}

export type PipelinePhaseActionResult = {
  error?: string;
  errorCode?: string;
  feedbackBatchId?: string;
  revisionRunId?: string;
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
  captureOrderedEvents?: boolean;
  deadlineAt?: string;
  signal?: AbortSignal;
  workerRuntime?: AttemptWorkerRuntime;
  browserRuntime?: BrowserScreenshotRuntime;
  browserVideoRuntime?: BrowserVideoRuntime;
}): Promise<ProcessPipelineJobResult> {
  const admin = input.admin ?? createSupabaseAdminClient();
  throwIfAborted(input.signal);
  // Carry the claim's identity through every await, including failure handling.
  const job = { ...input.job };
  let session: SessionRow | null;
  let stage: PipelineStage | null;
  let pinned: PinnedFactoryExecution | null = null;
  try {
    const loaded = await loadSessionById(admin, job.session_id);
    session = loaded ? { ...loaded } : null;
    if (session) pinned = await loadPinnedFactoryExecution(admin, session);
    if (session && pinned) {
      const currentStageId = session.current_stage_id;
      const index = pinned.stages.findIndex(({ id }) => id === currentStageId);
      const pinnedStage = pinned.stages[index];
      stage =
        pinned.pipelineId === session.pipeline_id && pinnedStage
          ? { ...pinnedStage, position: index + 1, pipelineId: pinned.pipelineId }
          : null;
    } else {
      stage = session ? await loadStageById(admin, session.current_stage_id) : null;
    }
  } catch (error) {
    throwIfAborted(input.signal);
    const result = await failPipelineJob(admin, job, getErrorMessage(error, "Pipeline job failed"));
    return { jobId: job.id, processed: true, result, runId: null };
  }
  throwIfAborted(input.signal);
  if (!session || !stage) {
    const message = session
      ? `Session ${session.id} references missing stage ${session.current_stage_id}.`
      : "No session row found for this job.";
    const result = await failPipelineJob(admin, job, message);
    return { jobId: job.id, processed: true, result, runId: null };
  }
  return runStage({
    admin,
    job,
    session,
    captureOrderedEvents: input.captureOrderedEvents,
    deadlineAt: input.deadlineAt,
    signal: input.signal,
    stage,
    pinned,
    workerRuntime: input.workerRuntime,
    browserRuntime: input.browserRuntime,
    browserVideoRuntime: input.browserVideoRuntime,
  });
}

// --- Generic stage runner ---
//
// One implementation handles every user-defined stage. Render the stage's
// prompt against the session context, run it through the agent runner, capture
// the text output as a markdown artifact, and flip phase_status to
// awaiting_review. An opt-in specification stage uses the same runner and
// publication ownership while carrying only the pinned source input.
async function runStage(input: {
  admin: AdminClient;
  job: Tables<"agent_jobs">;
  captureOrderedEvents?: boolean;
  deadlineAt?: string;
  signal?: AbortSignal;
  session: SessionRow;
  stage: PipelineStage;
  pinned: PinnedFactoryExecution | null;
  workerRuntime?: AttemptWorkerRuntime;
  browserRuntime?: BrowserScreenshotRuntime;
  browserVideoRuntime?: BrowserVideoRuntime;
}): Promise<ProcessPipelineJobResult> {
  const { admin, job, session, stage, pinned, captureOrderedEvents = true } = input;
  const specificationStage = session.specification_stage_id === stage.id;
  const supervisorSignal = input.signal;
  let signal = input.signal;
  let budgetController: AbortController | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  let budgetExpired = false;
  let forwardSupervisorAbort: (() => void) | undefined;

  let runId: string | null = null;
  let sandbox: SandboxHandle | null = null;
  let sandboxStop: Promise<void> | undefined;
  let retryCheckpointTimer: ReturnType<typeof setTimeout> | undefined;
  let retryCheckpointController: AbortController | undefined;
  let retainSource = false;
  let scopedCleanupFailed = false;
  const checkpointSensitiveValues = new Set<string>();
  const stopSandbox = () => {
    if (!sandbox || retainSource) return;
    const handle = sandbox;
    sandboxStop ??= (async () => {
      try {
        await handle.stop();
      } catch (stopError) {
        console.error("Failed to stop stage sandbox", {
          error: redactSecrets(getErrorMessage(stopError, "Sandbox could not be stopped."), [
            ...checkpointSensitiveValues,
          ]),
          sessionId: session.id,
        });
      }
    })();
    return sandboxStop;
  };
  const discardUnsafeScopedSandbox = async () => {
    scopedCleanupFailed = true;
    retainSource = false;
    // A failed scratch removal overrides the recovery marker for this exact
    // attempt. The reaper can finish disposal if the immediate stop fails.
    await Promise.allSettled([
      stopSandbox(),
      runId &&
        admin
          .from("agent_runs")
          .update({ source_recovery_required: false })
          .eq("id", runId)
          .eq("workspace_id", session.workspace_id)
          .eq("attempt_count", job.attempt_count)
          .eq("source_recovery_required", true)
          .abortSignal(AbortSignal.timeout(5_000)),
    ]);
  };
  // A hung log iterator may never reach finally. Cancellation initiates stop
  // immediately; the supervisor releases capacity even if stop itself hangs.
  const onAbort = () => {
    void stopSandbox();
  };
  supervisorSignal?.addEventListener("abort", onAbort, { once: true });
  let github: {
    installationId: number;
    repo: { default_branch: string | null; full_name: string; id: string };
  } | null = null;
  const branch = buildStageBranchName(session.id, stage.slug, {
    jobId: job.id,
    attemptCount: job.attempt_count,
  });
  let installationToken: string | undefined;
  let finalOutput: string | undefined;
  let taskComplete = false;
  let runFailureEventRecorded = false;
  let capture: RunEventCapture | undefined;
  let captureOpen = false;
  try {
    if (specificationStage && !pinned?.implementationAgent) {
      throw new FactoryExecutionProfileUnavailableError(
        "The specification stage requires a pinned named agent.",
      );
    }

    const profile =
      pinned && resolveFactoryExecutionProfile(pinned, session.creator_member_id ?? undefined);
    const gitInputPromise = loadPinnedSessionJobGitInput({
      admin,
      jobId: job.id,
      sessionId: session.id,
      workspaceId: session.workspace_id,
    });
    const repositoryPin = pinned ? loadPinnedFactoryRepositoryId(admin, session, pinned) : null;
    const [
      config,
      predecessorInputs,
      operatingRulesMd,
      sessionPrompt,
      sessionAttachments,
      repository,
      priorGitInput,
      specification,
    ] = await Promise.all([
      pinned?.agent ?? loadWorkspaceAgentConfig(admin, session.workspace_id),
      loadAttemptPredecessors(admin, session.id),
      pinned?.operatingRulesMd ?? loadPipelineOperatingRules(admin, stage.pipelineId),
      pinned
        ? loadPinnedSessionPrompt(admin, session)
        : { title: session.title, promptMd: session.prompt_md },
      loadSessionAttachmentInputs(admin, {
        sessionId: session.id,
        workspaceId: session.workspace_id,
      }),
      Promise.all([gitInputPromise, repositoryPin]).then(([gitInput, selectedRepositoryId]) => {
        const repositoryId = selectedRepositoryId ?? gitInput?.repository_id;
        return resolveEffectiveSessionRepository({
          factoryId: session.factory_id,
          pinnedRepositoryId: repositoryId,
          sessionId: session.id,
          supabase: admin,
          workspaceId: session.workspace_id,
        });
      }),
      gitInputPromise,
      specificationStage ? loadSpecificationPromptContext(admin, session, stage.id) : undefined,
    ]);
    throwIfAborted(signal);
    if (pinned && predecessorInputs.predecessors.some(({ status }) => status !== "approved")) {
      throw new Error("The factory session has a predecessor without an exact approval receipt.");
    }
    const selectedRepositoryId = pinned ? repository.repositoryId : session.github_repository_id;
    if (
      priorGitInput &&
      selectedRepositoryId &&
      selectedRepositoryId !== priorGitInput.repository_id
    ) {
      throw new Error(
        "The pinned Git input belongs to a different repository. Restore the original repository connection before retrying.",
      );
    }
    const provider = profile?.provider ?? normalizeAgentProviderName(config.provider);
    if (!provider) {
      throw new Error(
        `Unknown agent provider: "${config.provider}". Supported: ${AGENT_PROVIDERS.join(", ")}`,
      );
    }
    const model = profile?.model ?? config.model;

    const { data: startedRunId, error: startError } = await admin.rpc("start_session_job_attempt", {
      p_job_id: job.id,
      p_attempt_count: job.attempt_count,
      p_expected_stage_id: stage.id,
      p_expected_artifact_version: session.current_artifact_version,
      p_model_provider: provider,
      p_model_name: model,
      p_run_type: inferWallieRunMode(repository.repositoryId),
      p_branch_name: branch,
    });
    if (startError) {
      if (isGitContinuityReleasePause(startError)) {
        await deferSessionJobForGitContinuityRelease({
          admin,
          jobId: job.id,
          attemptCount: job.attempt_count,
        });
        return { jobId: job.id, processed: true, result: "idle", runId: null };
      }
      throw startError;
    }
    runId = startedRunId;
    throwIfAborted(signal);
    if (!runId) {
      // No authority was acquired. Never guess an active run: another start
      // carrying the same claim may have won, or a newer attempt may exist.
      await failPipelineJob(admin, job, "Session execution could not be started.", {
        maxRetries: pinned?.agent.maxRetries,
        retry: false,
      });
      return { jobId: job.id, processed: true, result: "idle", runId: null };
    }

    // Tool grants identify operations by name and do not classify writes. The
    // specification stage only receives the existing read-only repository inputs.
    const mcpManifest = specificationStage ? undefined : pinned?.mcpManifest;
    if (profile?.unavailableReason)
      throw new FactoryExecutionProfileUnavailableError(profile.unavailableReason);

    const authority = profile?.credentialAuthority;
    const scopedBindingId = authority?.kind === "service" ? authority.bindingId : undefined;
    if (authority?.kind === "service" && !scopedBindingId) {
      throw new ScopedRunCredentialUnavailableError();
    }

    // Starting a manual retry can bind it to the original immutable feedback batch.
    const [agentPrompt, skillInstructions, feedbackInput] = await Promise.all([
      loadRunAgentPrompt(admin, {
        workspaceId: session.workspace_id,
        factoryId: session.factory_id,
        sessionId: session.id,
        runId,
        expected: pinned?.implementationAgent,
      }),
      loadFactorySkillBundle(admin, {
        workspaceId: session.workspace_id,
        factoryId: session.factory_id,
        skillRevisionIds: pinned?.skillIds ?? [],
        signal,
      }),
      loadJobFeedback(admin, job, stage.id, specificationStage ? { exactOnly: true } : undefined),
    ]);
    throwIfAborted(signal);

    const attemptFeedback = feedbackInput?.body ?? null;
    const runEvents = new RunEventCapture(
      admin,
      { jobId: job.id, runId, attemptCount: job.attempt_count },
      captureOrderedEvents,
    );
    capture = runEvents;
    const executionBudget = await loadSessionExecutionBudget(admin, session.id);
    if (executionBudget?.exhaustionCode) {
      throw new ExecutionBudgetExhaustedError(executionBudget.exhaustionCode);
    }
    if (executionBudget && executionBudget.remainingExecutionMs !== null) {
      budgetController = new AbortController();
      const controller = budgetController;
      forwardSupervisorAbort = () => controller.abort(supervisorSignal?.reason);
      if (supervisorSignal?.aborted) forwardSupervisorAbort();
      else supervisorSignal?.addEventListener("abort", forwardSupervisorAbort, { once: true });
      signal = controller.signal;
      signal.addEventListener("abort", onAbort, { once: true });
      const remainingMs = Math.max(0, executionBudget.remainingExecutionMs);
      budgetTimer = setTimeout(() => {
        budgetExpired = true;
        const error = new ExecutionBudgetExhaustedError("elapsed_execution");
        controller.abort(error);
      }, remainingMs);
    }
    const executionDeadlineAt =
      typeof executionBudget?.remainingExecutionMs === "number"
        ? new Date(
            Math.min(
              input.deadlineAt ? Date.parse(input.deadlineAt) : Infinity,
              Date.now() + executionBudget.remainingExecutionMs,
            ),
          ).toISOString()
        : input.deadlineAt;

    // Every supported provider runs its CLI in a repository sandbox. Provision
    // it before resolving personal credentials so setup cannot retain a revoked key.
    await persistStartupProgress(runEvents, "Preparing sandbox and repository…");
    github = await loadGitHubContext(admin, session.workspace_id, repository.repository);
    throwIfAborted(signal);
    if (!github) {
      throw new Error(
        priorGitInput
          ? "The pinned Git input's repository connection is unavailable. Restore the original repository connection before retrying."
          : "No GitHub installation or repository found for workspace. Connect a GitHub repository in workspace settings.",
      );
    }
    if (
      priorGitInput &&
      (priorGitInput.repository_id !== github.repo.id ||
        priorGitInput.repository_full_name !== github.repo.full_name)
    ) {
      throw new Error(
        "The pinned Git input belongs to a different repository. Restore the original repository connection before retrying.",
      );
    }
    const sandboxImplementation = resolveSandboxImplementation();
    const sandboxSelection =
      sandboxImplementation === "fake"
        ? null
        : profile
          ? await loadRequiredWorkspaceSandboxConnection(
              admin,
              session.workspace_id,
              profile.sandboxProvider,
            )
          : await loadRequiredWorkspaceSandboxConnection(admin, session.workspace_id);
    if (sandboxSelection) {
      await assertCurrentSandboxCapabilityCheck({
        admin,
        agent: { model, provider },
        connection: sandboxSelection.connection,
        ...(pinned ? { definitionDigest: pinned.canonicalDigest } : {}),
        repositoryId: github.repo.id,
        workspaceId: session.workspace_id,
      });
    }
    installationToken = await mintSandboxRepositoryToken({
      installationId: github.installationId,
      repositoryFullName: github.repo.full_name,
      purpose: "checkout",
    });
    throwIfAborted(signal);
    if (!(await touchRunActivity(admin, runId, job.attempt_count)))
      throw new ExecutionOwnershipLostError();
    throwIfAborted(signal);
    sandbox = await createWorkspaceSessionSandbox(admin, {
      agentProvider: provider,
      baseBranch: priorGitInput?.base_branch ?? github.repo.default_branch ?? "main",
      ...(priorGitInput
        ? {
            mode: {
              kind: "checkpoint" as const,
              sha: priorGitInput.input_sha,
              ...(priorGitInput.input_ref ? { ref: priorGitInput.input_ref } : {}),
            },
          }
        : {}),
      branch,
      implementation: sandboxSelection?.provider ?? "fake",
      connection: sandboxSelection?.connection,
      installationToken,
      timeoutMs: executionDeadlineAt
        ? Math.max(1, Math.min(1_800_000, Date.parse(executionDeadlineAt) - Date.now()))
        : 1_800_000,
      ownerId: runId ?? undefined,
      repoFullName: github.repo.full_name,
      signal,
      sessionId: session.id,
      workspaceId: session.workspace_id,
      onSandboxCreated: async ({ provider: sandboxProvider, sandboxId }) => {
        throwIfAborted(signal);
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
    throwIfAborted(signal);

    const observedSha = await readSourceBase(sandbox, signal);
    const gitInput = await pinSessionJobGitInput({
      admin,
      jobId: job.id,
      attemptCount: job.attempt_count,
      runId,
      repositoryId: github.repo.id,
      baseBranch: priorGitInput?.base_branch ?? github.repo.default_branch ?? "main",
      observedSha,
      signal,
    });
    if (!gitInput) throw new ExecutionOwnershipLostError();
    await checkoutPinnedGitInput({
      sandbox,
      branch,
      sha: gitInput.input_sha,
      ...(gitInput.input_ref ? { ref: gitInput.input_ref } : {}),
      signal,
    });
    const sourceBase = gitInput.input_sha;
    const retryCheckpointContext = {
      admin,
      attemptCount: job.attempt_count,
      baseSha: sourceBase,
      jobId: job.id,
      runId,
      sandbox,
    };
    const resumed =
      !specificationStage &&
      job.trigger_type === "manual_retry" &&
      (await restoreRetryInput({ ...retryCheckpointContext, signal }));
    if (resumed) {
      await persistStartupProgress(runEvents, "Restored committed source from the timed-out run.");
    }
    if (!(await touchRunActivity(admin, runId, job.attempt_count)))
      throw new ExecutionOwnershipLostError();
    let usage: AgentRunUsage | undefined;

    const materializedAttachments = await materializeSessionAttachments(
      admin,
      sandbox,
      sessionAttachments,
    );
    const runContextScope = {
      admin,
      workspaceId: session.workspace_id,
      factoryId: session.factory_id,
      sessionId: session.id,
      jobId: job.id,
      runId,
      attemptCount: job.attempt_count,
      signal,
    };
    const contextOrigin = pinned ? await readRunContextOrigin(runContextScope) : undefined;
    const readContext = await materializeFactoryRepositoryContext({
      admin,
      factoryId: session.factory_id,
      repositoryIds: pinned?.readContextRepositoryIds ?? [],
      expectedCommits: frozenRepositoryCommits(contextOrigin),
      sandbox,
      signal,
      workspaceId: session.workspace_id,
    });
    const context = pinned
      ? await prepareRunContext(runContextScope, {
          origin: contextOrigin,
          references: pinned.contextDocuments ?? [],
          requiredInputs: requiredRunContextInputs({
            sessionPrompt,
            feedback: feedbackInput,
            predecessors: predecessorInputs.predecessors,
            predecessorText: predecessorInputs.promptArtifacts,
            repositoryContexts: readContext,
            specification,
          }),
        })
      : undefined;
    if (context?.memoryProposalsEnabled) {
      runEvents.protectPrivatePath(factoryMemoryProposalPath(runId));
    }
    if (!specificationStage) await prepareValidationPlan(sandbox, runId);
    throwIfAborted(signal);
    const workerDeadlineMs =
      input.deadlineAt && input.deadlineAt === executionDeadlineAt
        ? Date.parse(input.deadlineAt)
        : undefined;
    const checkpointAt =
      specificationStage || workerDeadlineMs === undefined
        ? undefined
        : Math.max(
            workerDeadlineMs - RETRY_CHECKPOINT_LEAD_MS,
            Math.floor((Date.now() + workerDeadlineMs) / 2),
          );
    const checkpointInstructions = [
      ...(resumed
        ? [
            "This checkout contains commits recovered from the timed-out run. Inspect them and continue the remaining work. Verify the current source before reporting results.",
          ]
        : []),
      ...(checkpointAt !== undefined && checkpointAt > Date.now()
        ? [
            `Commit useful changes on the attempt branch before ${new Date(checkpointAt).toISOString()}. Wallie captures committed source around that time so Retry can recover it after a timeout.`,
          ]
        : []),
    ];
    const prompt = renderStagePrompt(
      {
        promptTemplateMd: trustedPromptValue("stage.promptTemplate", stage.promptTemplateMd),
        slug: trustedPromptValue("stage.slug", stage.slug),
      },
      {
        agentPromptMd: trustedPromptValue("agent.prompt", agentPrompt.promptMd),
        skillInstructions,
        attemptFeedback:
          attemptFeedback === null
            ? null
            : untrustedPromptValue("attempt.feedback", attemptFeedback),
        attemptNumber: session.rejection_count + 1,
        repoName: untrustedPromptValue(
          "repo.name",
          github.repo.full_name.split("/").at(-1) ?? github.repo.full_name,
        ),
        repoFullName: untrustedPromptValue("repo.fullName", github.repo.full_name),
        repoDefaultBranch: untrustedPromptValue(
          "repo.defaultBranch",
          pinned ? gitInput.base_branch : (github.repo.default_branch ?? "main"),
        ),
        externalContextDocuments: context?.documents,
        frozenConversation: context?.conversation,
        factoryMemories: context?.memories,
        memoryProposalInstructions: context?.memoryProposalsEnabled
          ? factoryMemoryProposalInstructions(runId)
          : undefined,
        readContext: readContext.length
          ? untrustedPromptValue(
              "repo.readContext",
              readContext
                .map(({ fullName, commitSha, snapshotPath }) =>
                  [fullName, "at", commitSha, "→", snapshotPath].join(" "),
                )
                .join("\n"),
            )
          : undefined,
        operatingRulesMd: trustedPromptValue("pipeline.operatingRules", operatingRulesMd),
        retryCheckpointInstructions: checkpointInstructions.length
          ? trustedPromptValue(
              "wallie.retryCheckpointInstructions",
              `## Retry checkpoint\n\n${checkpointInstructions.join("\n\n")}`,
            )
          : undefined,
        ...(specificationStage
          ? { specification }
          : {
              validationPlanInstructions: trustedPromptValue(
                "run.validationPlanInstructions",
                validationPlanInstructions(runId),
              ),
            }),
        previousStages: Object.fromEntries(
          Object.entries(predecessorInputs.promptArtifacts).map(([slug, artifact]) => [
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
        sessionPrompt: untrustedPromptValue("session.prompt", sessionPrompt.promptMd),
        sessionTitle: untrustedPromptValue("session.title", sessionPrompt.title),
      },
    );

    await persistStartupProgress(runEvents, "Starting agent…");
    if (!(await touchRunActivity(admin, runId, job.attempt_count)))
      throw new ExecutionOwnershipLostError();
    throwIfAborted(signal);
    const checkoutSha = resumed ? await readSourceBase(sandbox, signal) : gitInput.input_sha;
    const maxTurns = profile
      ? (profile.maxTurns ?? undefined)
      : provider === "claude-code"
        ? (config.maxTurns ?? DEFAULT_AGENT_RUNNER_CONFIG.maxTurns)
        : undefined;
    const effort = profile
      ? (profile.effort ?? undefined)
      : agentProviderSupportsEffort(provider)
        ? (config.effort ?? DEFAULT_AGENT_EFFORT)
        : undefined;
    if (
      !(await pinSessionAttemptManifest({
        admin,
        jobId: job.id,
        runId,
        attemptCount: job.attempt_count,
        prompt,
        checkoutSha,
        predecessors: predecessorInputs.predecessors,
        credentialOwnerMemberId: authority
          ? authority.kind === "human"
            ? authority.memberId
            : null
          : session.creator_member_id,
        workerRuntime: input.workerRuntime ?? "node",
        ...(effort ? { effort } : {}),
        maxTurns,
        signal,
      }))
    ) {
      throw new ExecutionOwnershipLostError();
    }
    throwIfAborted(signal);
    // Runners load credentials after their own nonsecret remote setup, directly
    // before delivering the secret. Construction never decrypts credentials.
    const credentialRunId = runId;
    const runner = createSessionAgentRunner({
      admin,
      effort,
      maxTurns,
      model,
      provider,
      session,
      loadScopedCredential: scopedBindingId
        ? () =>
            resolveScopedRunCredential({
              admin,
              attemptCount: job.attempt_count,
              bindingId: scopedBindingId,
              jobId: job.id,
              provider,
              runId: credentialRunId,
              signal,
              workspaceId: session.workspace_id,
            })
        : undefined,
    });
    const sensitiveValues = () => [
      prompt,
      ...(installationToken ? [installationToken] : []),
      ...checkpointSensitiveValues,
    ];
    let readCheckpointSensitiveValues:
      | ((signal: AbortSignal) => Promise<readonly string[]>)
      | undefined;
    if (input.deadlineAt && checkpointAt !== undefined) {
      const deadlineAt = input.deadlineAt;
      const controller = new AbortController();
      retryCheckpointController = controller;
      const checkpointSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
      retryCheckpointTimer = setTimeout(
        () => {
          void saveRetryCheckpoint({
            ...retryCheckpointContext,
            deadlineAt,
            sensitiveValues: async () => [
              ...((await readCheckpointSensitiveValues?.(checkpointSignal)) ?? []),
              ...sensitiveValues(),
            ],
            ...(scopedBindingId ? { scopedCredential: true } : {}),
            signal: checkpointSignal,
            workspaceId: session.workspace_id,
          })
            .then((saved) => {
              if (!saved || checkpointSignal.aborted) return;
              // This timer can finish after the agent stream closes while
              // validation is still running. Keep its checkpoint note in Run history.
              return persistRunMessage(admin, retryCheckpointContext.runId, session.workspace_id, {
                kind: "worker_progress",
                messageMd: "Saved committed source for Retry.",
              });
            })
            .catch(async (error: unknown) => {
              if (isScopedCredentialCleanupError(error)) {
                await discardUnsafeScopedSandbox();
                return;
              }
              if (!checkpointSignal.aborted) {
                console.warn("Could not save committed source for Retry.", { jobId: job.id });
              }
            });
        },
        Math.max(0, checkpointAt - Date.now()),
      );
    }
    if (installationToken) runEvents.addSensitiveValue(installationToken);
    runEvents.start(runner.provider);
    captureOpen = true;
    let sawTerminal = false;
    for await (const event of runner.start({
      // No current CLI exposes a verified max-output-token option. The value is
      // available to future adapters; unsupported providers remain bounded by
      // the session's attempt and wall-time limits and reactive usage checks.
      maxTokens: remainingTokenBudget(executionBudget),
      prompt,
      runId: runId ?? undefined,
      sandbox: sandbox ?? undefined,
      ...(scopedBindingId ? { scopedCredential: true } : {}),
      ...(mcpManifest
        ? {
            mcp: {
              manifest: mcpManifest,
              loadCredentials: () =>
                resolveFactoryMcpCredentials({
                  admin,
                  workspaceId: session.workspace_id,
                  jobId: job.id,
                  runId: credentialRunId,
                  attemptCount: job.attempt_count,
                  manifest: mcpManifest,
                  signal,
                }),
              onCleanup: async (status) => {
                const attempt = job.attempt_count;
                const messageMd =
                  status === "removed"
                    ? `MCP configuration and credential cleanup verified for attempt ${attempt}.`
                    : `MCP configuration cleanup could not be verified for attempt ${attempt}.`;
                await persistRunMessage(admin, credentialRunId, session.workspace_id, {
                  kind: status === "removed" ? "worker_progress" : "worker_error",
                  messageMd,
                  signal: AbortSignal.timeout(5_000),
                });
              },
            },
          }
        : {}),
      secrets: installationToken ? [installationToken] : undefined,
      onCheckpointSensitiveValues: (read) => {
        readCheckpointSensitiveValues = read;
      },
      onSensitiveValue: (value) => {
        checkpointSensitiveValues.add(value);
        runEvents.addSensitiveValue(value);
      },
      signal,
      sessionId: session.id,
    })) {
      if (scopedCleanupFailed) throw new ScopedCredentialCleanupError();
      const sourceRecoveryRequired =
        !specificationStage &&
        ((event.type === "completion" && event.taskComplete) ||
          // Scoped runners verify credential cleanup before terminal success.
          (event.type === "usage" && event.sourceRecoveryRequired && !scopedBindingId));
      if (sourceRecoveryRequired && !retainSource) {
        // Protect the only source copy synchronously, before usage persistence
        // or any other completion bookkeeping can fail or wait past the deadline.
        retainSource = true;
        const { data: retained, error: retentionError } = await admin
          .from("agent_runs")
          .update({ source_recovery_required: true })
          .eq("id", runId)
          .eq("attempt_count", job.attempt_count)
          .eq("status", "running")
          .select("id")
          .abortSignal(AbortSignal.timeout(5_000));
        // The retry scanner can fail while this write is in flight. The error
        // path clears the exact marker again after the pending write settles.
        if (scopedCleanupFailed) throw new ScopedCredentialCleanupError();
        // A DB outage must still permit capture into available private Storage.
        // The running-only guard serializes retention with terminal cleanup.
        if (!retentionError && !retained?.length) {
          retainSource = false;
          throw new ExecutionOwnershipLostError();
        }
      }
      const eventUsage =
        event.type === "completion" || event.type === "usage" ? event.usage : undefined;
      if (eventUsage) {
        try {
          await recordSessionRunUsage(admin, {
            attemptCount: job.attempt_count,
            jobId: job.id,
            runId,
            usage: eventUsage,
          });
        } catch (error) {
          // The budget RPC records usage before reporting exhaustion. Capture it
          // while this exact attempt still owns the run.
          if (error instanceof ExecutionBudgetExhaustedError && !signal?.aborted) {
            try {
              await runEvents.record(event);
            } catch {
              // Retire for budget exhaustion even if history is unavailable.
            }
          }
          throw error;
        }
      }
      throwIfAborted(signal);
      await runEvents.record(event);
      if (eventUsage) usage = eventUsage;
      if (event.type === "error") {
        runFailureEventRecorded = captureOrderedEvents;
      }
      if (event.type === "completion") {
        // Failed terminal results can carry usage before a following provider
        // error. Drain the stream so its blocker and partial output reach history.
        sawTerminal = true;
        taskComplete = event.taskComplete;
        if (event.taskComplete && event.finalOutput?.trim()) {
          finalOutput = event.finalOutput;
        }
      } else if (event.type === "error") {
        // The consumer stops here even if the adapter has pending events.
        throw new Error(redactRunSensitiveText(event.message));
      }
    }

    if (scopedCleanupFailed) throw new ScopedCredentialCleanupError();
    throwIfAborted(signal);
    await recordSessionRunUsage(admin, {
      attemptCount: job.attempt_count,
      finalize: true,
      jobId: job.id,
      runId,
      usage,
    });
    if (!sawTerminal) await runEvents.markGap("missing_terminal");
    if (!taskComplete) {
      await runEvents.finish(sawTerminal ? "complete" : "interrupted");
      captureOpen = false;
      throw new Error("Agent ended without a successful completion event.");
    }

    const artifactMarkdown = finalOutput;
    if (!artifactMarkdown) {
      const message =
        `${stage.name} supplied no final deliverable, so no artifact was created.` +
        (captureOrderedEvents
          ? " Progress and any partial output remain available in Run history."
          : "");

      await runEvents.record({ type: "error", message });
      runFailureEventRecorded = captureOrderedEvents;
      await runEvents.finish("complete");
      captureOpen = false;
      throw new MissingReviewableOutputError(message);
    }
    await runEvents.finish("complete");
    captureOpen = false;

    // Once the agent has produced reviewable work, deletion is safe only after
    // the source is durable. A dual-store outage leaves the provider TTL as the
    // recovery window, and the reaper honors this explicit retention marker.
    try {
      // Specification output is Markdown only. Bind publication to the
      // previously pinned input, never to the sandbox's post-run source.
      const checkpoint: SourceCheckpoint = specificationStage
        ? { kind: "unchanged", baseSha: sourceBase, headSha: sourceBase }
        : await validateCheckpoint({
            ...(pinned
              ? {
                  pinnedDeliveryPolicyRevisionId: pinned.deliveryPolicyRevisionId,
                  approvedToolIds: pinned.toolIds,
                }
              : {}),
            admin,
            browserRuntime: input.browserRuntime,
            browserVideoRuntime: input.browserVideoRuntime,
            workspaceId: session.workspace_id,
            pipelineId: stage.pipelineId,
            runId,
            sandbox,
            checkpoint: await captureSourceCheckpoint({
              sandbox,
              baseSha: sourceBase,
              signal,
              sensitiveValues: sensitiveValues(),
              ...(scopedBindingId ? { scopedCredential: true } : {}),
            }),
            secrets: sensitiveValues(),
            ...(scopedBindingId ? { scopedCredential: true } : {}),
            signal,
          });
      if (context?.memoryProposalsEnabled) {
        await stageFactoryMemoryProposal({
          ...runContextScope,
          sandbox,
          artifactMarkdown,
          secrets: sensitiveValues(),
        }).catch(() => {
          signal?.throwIfAborted();
          console.warn("Could not save the optional factory memory proposal.", { runId });
        });
      }
      const prepared = await prepareSourceDelivery({
        admin,
        baseBranch: gitInput.base_branch,
        body: artifactMarkdown,
        checkpoint,
        onDurable: () => {
          retainSource = false;
        },
        publication: {
          expectedArtifactVersion: session.current_artifact_version,
          artifactMarkdown,
          deadlineAt: executionDeadlineAt,
          usage,
        },
        repositoryId: github.repo.id,
        runId,
        signal,
        title: `${stage.name}: ${session.title}`,
        workspaceId: session.workspace_id,
      });
      if (!prepared) return { jobId: job.id, processed: true, result: "idle", runId };
      // Preparation clears the recovery marker in the same database transaction
      // that records the durable source, before any publication or cleanup.
    } catch (error) {
      if (
        error instanceof ExecutionOwnershipLostError ||
        isScopedCredentialCleanupError(error) ||
        signal?.aborted
      )
        throw error;
      throw new SourcePreservationError(
        !retainSource,
        error instanceof UnsafeRuntimeCheckpointError
          ? "unsafe-runtime"
          : error instanceof UnsupportedLfsCheckpointError
            ? "lfs"
            : error instanceof UnsupportedSubmoduleCheckpointError
              ? "gitlink"
              : error instanceof UnsupportedSourceTransformError
                ? "content-transform"
                : undefined,
      );
    }
    if (scopedCleanupFailed) throw new ScopedCredentialCleanupError();
    throwIfAborted(signal);

    const published = await publishArtifact({
      admin,
      artifactMarkdown,
      job,
      runId,
      session,
      deadlineAt: executionDeadlineAt,
      signal,
      stage,
    });
    if (published === "idle") {
      return { jobId: job.id, processed: true, result: "idle", runId };
    }
  } catch (error) {
    const unsafeCredentialCleanup = isScopedCredentialCleanupError(error);
    if (unsafeCredentialCleanup) await discardUnsafeScopedSandbox();
    if (
      capture &&
      captureOpen &&
      !signal?.aborted &&
      !(error instanceof Error && error.name === "ExecutionOwnershipLostError")
    ) {
      try {
        const captureDeadline = AbortSignal.timeout(2_000);
        await capture.markGap("stream_interrupted", captureDeadline);
        await capture.finish("interrupted", captureDeadline);
      } catch {
        // An absent end marker also identifies an incomplete capture.
      }
    }
    // The supervising worker owns its own timeout recovery. A session-budget
    // deadline instead retires this exact attempt here, with no automatic repair.
    if (signal?.aborted) {
      if (budgetExpired && !supervisorSignal?.aborted) {
        await failPipelineJob(admin, job, "Session elapsed execution budget exhausted.", {
          maxRetries: pinned?.agent.maxRetries,
          runId,
          retry: false,
        });
      }
      return { jobId: job.id, processed: true, result: "idle", runId };
    }
    // The durable intent owns retrying remote persistence. Starting another
    // agent here would abandon completed work and could race its adoption.
    if (error instanceof CheckpointPublicationPendingError) {
      return { jobId: job.id, processed: true, result: "idle", runId };
    }
    // Sandbox providers sanitize acquisition errors while preserving their name.
    if (error instanceof Error && error.name === "ExecutionOwnershipLostError") {
      return { jobId: job.id, processed: true, result: "idle", runId };
    }
    const failureMessage = redactSecrets(getErrorMessage(error, "Stage generation failed"), [
      installationToken,
      ...checkpointSensitiveValues,
    ]);
    const result = await failPipelineJob(admin, job, failureMessage, {
      maxRetries: pinned?.agent.maxRetries,
      runId,
      // Source+intent preparation may have committed despite a lost reply.
      // The database guard serializes with that transaction before failing.
      preservePublication: error instanceof SourcePreservationError,
      retry:
        !retainSource &&
        !(error instanceof MissingReviewableOutputError) &&
        !(error instanceof SourcePreservationError) &&
        !(error instanceof ExecutionBudgetExhaustedError) &&
        !(error instanceof FactoryExecutionProfileUnavailableError) &&
        !(error instanceof FrozenRunContextUnavailableError) &&
        !(error instanceof RunContextRequiredInputTooLargeError) &&
        !unsafeCredentialCleanup &&
        !(
          error instanceof Error &&
          [
            "ScopedRunCredentialUnavailableError",
            "McpCredentialsUnavailableError",
            "McpAdapterError",
          ].includes(error.name)
        ) &&
        !(
          pinned?.executionGrant &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "42501"
        ) &&
        !isSandboxConnectionSetupError(error),
    });
    if (result === "error" && runId && !runFailureEventRecorded) {
      await persistRunFailureDiagnostic(admin, {
        error: failureMessage,
        runId,
        workspaceId: session.workspace_id,
      });
    }
    return { jobId: job.id, processed: true, result, runId };
  } finally {
    clearTimeout(budgetTimer);
    clearTimeout(retryCheckpointTimer);
    retryCheckpointController?.abort();
    if (forwardSupervisorAbort) {
      supervisorSignal?.removeEventListener("abort", forwardSupervisorAbort);
    }
    supervisorSignal?.removeEventListener("abort", onAbort);
    signal?.removeEventListener("abort", onAbort);
    await stopSandbox();
  }

  throwIfAborted(signal);
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
  job: Tables<"agent_jobs">;
  runId: string;
  session: SessionRow;
  deadlineAt?: string;
  signal?: AbortSignal;
  stage: PipelineStage;
}): Promise<"idle" | "published"> {
  const { admin, artifactMarkdown, job, runId, session, stage } = input;

  throwIfAborted(input.signal);
  const publication = await publishSessionCheckpoint({
    admin,
    runId,
    jobId: job.id,
    attemptCount: job.attempt_count,
    workspaceId: session.workspace_id,
    expectedArtifactVersion: session.current_artifact_version,
    artifactMarkdown,
    deadlineAt: input.deadlineAt,
    signal: input.signal,
  });
  if (publication === "pending") throw new CheckpointPublicationPendingError();
  if (publication !== "adopted") return "idle";
  throwIfAborted(input.signal);

  // Publication already made this run successful. Append its final history
  // without requiring active execution or refreshing its activity timestamp.
  throwIfAborted(input.signal);
  await persistRunMessage(admin, runId, session.workspace_id, {
    kind: "worker_completion",
    messageMd: `${stage.name} run completed`,
  });

  return "published";
}

// --- Approval + rejection handlers ---

function getErrorMessage(error: unknown, fallback: string) {
  if (isVercelSandboxApiError(error)) return formatVercelSandboxError(error);
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
  expectedArtifactId: string;
  expectedReviewRevision: number;
  expectedStageId: string;
  expectedWorkspaceId: string;
  sessionId: string;
  version: number;
}): Promise<PipelinePhaseActionResult> {
  const admin = input.admin ?? createSupabaseAdminClient();
  if (!input.approverMemberId) {
    return { error: "You are not authorized to approve this stage.", success: false };
  }
  // Resolve execution configuration before changing review state. The RPC
  // records approval and commits the next job/run together, or changes nothing.
  let runConfig: Awaited<ReturnType<typeof resolveQueuedRunConfig>>;
  try {
    runConfig = await resolveQueuedRunConfig(admin, {
      id: input.sessionId,
      workspace_id: input.expectedWorkspaceId,
    });
  } catch (error) {
    return { error: getErrorMessage(error, "Failed to prepare the next stage."), success: false };
  }
  // Server-owned PR readiness: evaluate and persist a decision bound to the
  // current canonical identity right before the gated approval RPC. The
  // client supplies no readiness input; the RPC re-validates currentness under
  // the session lock. An evaluation failure leaves no new decision, and the
  // gate below fails closed.
  try {
    await evaluateSessionPrReadiness(admin, input.sessionId, { record: true });
  } catch {
    // A missing evaluation cannot pass the delivery gate; approval surfaces
    // the deterministic PT428 conflict instead.
  }
  const { data, error } = await admin.rpc("approve_session_stage", {
    approver_member_id: input.approverMemberId,
    expected_artifact_id: input.expectedArtifactId,
    p_expected_review_revision: input.expectedReviewRevision,
    expected_stage_id: input.expectedStageId,
    expected_version: input.version,
    expected_workspace_id: input.expectedWorkspaceId,
    p_agent_model_provider: runConfig.modelProvider,
    p_agent_model_name: runConfig.modelName,
    p_run_type: runConfig.runType,
    target_session_id: input.sessionId,
  });
  if (error) return { error: error.message, errorCode: error.code, success: false };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return {
      error:
        "Approval failed: review is stale, stage already reviewed, or you are not authorized to approve this stage.",
      success: false,
    };
  }
  if (row.job_id) await wakeWorker();
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

function createSessionAgentRunner(input: {
  admin: AdminClient;
  effort?: AgentEffort;
  maxTurns?: number;
  model?: string;
  provider: AgentProvider;
  session: Pick<SessionRow, "creator_member_id" | "workspace_id">;
  loadScopedCredential?: () => Promise<string>;
}): AgentRunner {
  const { loadScopedCredential } = input;
  switch (input.provider) {
    case "codex":
      return createAgentRunner("codex", {
        codex: {
          ...(loadScopedCredential
            ? {
                loadCredential: async () => ({
                  type: "platform_api_key" as const,
                  expiresAt: null,
                  secret: await loadScopedCredential(),
                }),
              }
            : {
                chatGptAuthStore: createCodexChatGptAuthStore(input.admin, input.session),
                loadCredential: () => getCodexCredentialForSession(input.admin, input.session),
              }),
          effort: input.effort,
          model: input.model,
        },
      });
    case "claude-code":
      return createAgentRunner("claude-code", {
        claudeCode: {
          loadCredential: loadScopedCredential
            ? async () => ({ secret: await loadScopedCredential() })
            : () => getClaudeCodeCredentialForSession(input.admin, input.session),
          effort: input.effort,
          maxTurns: input.maxTurns,
          model: input.model,
        },
      });
    case "cursor":
      return createAgentRunner("cursor", {
        cursor: {
          model: input.model,
          ...(loadScopedCredential
            ? {
                loadCredential: async () => ({
                  scope: "factory" as const,
                  secret: await loadScopedCredential(),
                }),
              }
            : {
                loadCredential: () => getCursorCredentialForSession(input.admin, input.session),
                onAuthenticationFailure: (reason, credential) =>
                  markCursorReconnectRequired(
                    input.admin,
                    credential.userId,
                    credential.generation,
                    reason,
                  ),
              }),
        },
      });
    case "opencode":
      return createAgentRunner("opencode", {
        openCode: {
          loadAuth: loadScopedCredential
            ? async () => {
                const providerId = parseOpenCodeModelId(
                  input.model ?? DEFAULT_OPENCODE_MODEL,
                )?.providerId;
                if (!providerId) throw new ScopedRunCredentialUnavailableError();
                const key = { secret: await loadScopedCredential() };
                return providerId === OPENCODE_ZEN_PROVIDER_ID
                  ? { credential: key }
                  : { providerCredentials: { [providerId]: key } };
              }
            : () =>
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
    .eq("suspended", false)
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
async function persistStartupProgress(capture: RunEventCapture, text: string) {
  try {
    await capture.record({ type: "progress", text });
  } catch (error) {
    if (error instanceof ExecutionOwnershipLostError) throw error;
    console.warn("Wallie could not record startup progress.");
  }
}

/** Run history remains append-only after publication and never changes ownership. */
async function persistRunMessage(
  admin: AdminClient,
  runId: string,
  workspaceId: string,
  input: { kind: string; messageMd: string; signal?: AbortSignal },
): Promise<void> {
  const request = admin.from("agent_run_messages").insert({
    agent_run_id: runId,
    kind: input.kind,
    message_md: input.messageMd,
    workspace_id: workspaceId,
  });
  const { error } = await (input.signal ? request.abortSignal(input.signal) : request);
  if (error) throw error;
}

async function persistRunFailureDiagnostic(
  admin: AdminClient,
  input: { error: unknown; runId: string; workspaceId: string },
): Promise<void> {
  const failureText =
    typeof input.error === "string"
      ? input.error
      : getErrorMessage(input.error, "Stage generation failed");
  const message = sanitizeRunFailureDiagnostic(
    failureText,
    failureText.startsWith("Vercel Sandbox request failed")
      ? VERCEL_SANDBOX_FAILURE_DIAGNOSTIC_MAX_LENGTH
      : RUN_FAILURE_DIAGNOSTIC_MAX_LENGTH,
  );

  try {
    const { error } = await admin.from("agent_run_messages").insert({
      agent_run_id: input.runId,
      kind: "worker_error",
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
  options: {
    maxRetries?: number;
    retry?: boolean;
    runId?: string | null;
    preservePublication?: boolean;
  } = {},
): Promise<ProcessPipelineJobResult["result"]> {
  const maxRetries = options.maxRetries ?? (await loadMaxRetries(admin, job.workspace_id));
  const { data, error } = await admin.rpc(
    options.preservePublication ? "fail_stalled_session_job_attempt" : "fail_session_job_attempt",
    {
      p_job_id: job.id,
      p_attempt_count: job.attempt_count,
      p_run_id: options.runId ?? undefined,
      p_error: errorMessage,
      p_retry: options.retry !== false,
      p_max_retries: maxRetries,
    },
  );
  if (error) throw error;
  if (data === "stale") return "idle";
  if (data === "success") return "success";
  if (data === "queued" || data === "error") return "error";
  throw new Error("Unexpected execution failure receipt.");
}
