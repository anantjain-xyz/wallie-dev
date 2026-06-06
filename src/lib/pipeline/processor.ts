import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { resolveEffectiveSessionRepository } from "@/features/sessions/effective-repository";
import type { PipelineStage } from "@/features/sessions/types";
import { resolveGitHubAppConfig } from "@/features/github/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createAgentRunner, loadWorkspaceAgentConfig } from "@/lib/agent-runner";
import { AGENT_PROVIDERS, normalizeAgentProviderName } from "@/lib/agent-config/contracts";
import { inferWallieRunMode } from "@/features/wallie/utils";
import { buildWallieJobDedupeKey } from "@/lib/wallie/constants";
import type { AgentEvent, AgentRunner } from "@/lib/agent-runner/types";
import {
  ClaudeCodeNotConnectedError,
  getClaudeCodeCredentialForSession,
} from "@/lib/claude-code/tokens";
import { isCodexAuthLeaseBusyError } from "@/lib/codex/contracts";
import {
  createCodexChatGptAuthStore,
  CodexNotConnectedError,
  getCodexCredentialForSession,
} from "@/lib/codex/tokens";
import { createSessionSandbox } from "@/lib/sandbox";
import type { AgentProvider, SandboxHandle } from "@/lib/sandbox/types";
import { renderStagePrompt } from "@/lib/prompt-templates";

import { openSessionPullRequest } from "./pull-request";
import { loadCompletedStageArtifacts, loadPipelineOperatingRules, loadStageById } from "./stages";
import { PIPELINE_JOB_TYPE } from "./types";

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

export type PipelinePhaseActionResult = {
  error?: string;
  jobId?: string | null;
  success: boolean;
};

export async function processPipelineJob(input: {
  admin?: AdminClient;
  job: Tables<"agent_jobs">;
  signal?: AbortSignal;
}): Promise<ProcessPipelineJobResult> {
  const admin = input.admin ?? createSupabaseAdminClient();
  const job = input.job;

  try {
    const session = await loadSessionById(admin, job.session_id);
    if (!session) {
      await markPipelineJobError(admin, job, "No session row found for this job.");
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    const stage = await loadStageById(admin, session.current_stage_id);
    if (!stage) {
      await markPipelineJobError(
        admin,
        job,
        `Session ${session.id} references missing stage ${session.current_stage_id}.`,
      );
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    // Atomic CAS claim: only proceed if the session is in a non-terminal
    // state for the current stage. Prevents a second worker from regenerating
    // an artifact that has already been approved.
    const { data: claimed, error: claimError } = await admin
      .from("sessions")
      .update({ phase_status: "agent_generating" })
      .eq("id", session.id)
      .in("phase_status", ["agent_generating", "awaiting_review", "rejected"])
      .select("id")
      .maybeSingle();

    if (claimError) {
      await markPipelineJobError(admin, job, claimError.message);
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    if (!claimed) {
      // Terminal state — nothing to do for this job.
      await markPipelineJobSuccess(admin, job);
      return { jobId: job.id, processed: true, result: "success", runId: null };
    }

    return await runStage({ admin, job, session, signal: input.signal, stage });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pipeline job failed";
    await markPipelineJobError(admin, job, message);
    return { jobId: job.id, processed: true, result: "error", runId: null };
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

  const newVersion = session.current_artifact_version + 1;

  const config = await loadWorkspaceAgentConfig(admin, session.workspace_id);
  const provider = normalizeAgentProviderName(config.provider);
  if (!provider) {
    throw new Error(
      `Unknown agent provider: "${config.provider}". Supported: ${AGENT_PROVIDERS.join(", ")}`,
    );
  }

  // Pull artifacts from completed prior stages so the prompt can reference
  // them via {{artifact.previousStages.<slug>}}.
  const previousStages = await loadCompletedStageArtifacts(admin, session.id);

  // Resume-on-rejection: pull the most recent feedback for this stage so the
  // template can include it via {{attempt.feedback}}. Match on stage_id so a
  // rename in the editor doesn't cause us to miss the prior attempt.
  const attemptFeedback = await loadLatestFeedback(admin, session.id, stage.id);

  // Workspace-editable operating rules for this pipeline, prepended to the
  // stage prompt so the cross-cutting discipline applies to every stage.
  const operatingRulesMd = await loadPipelineOperatingRules(admin, stage.pipelineId);

  const prompt = renderStagePrompt(stage, {
    attemptFeedback,
    attemptNumber: session.rejection_count + 1,
    operatingRulesMd,
    previousStages,
    sessionPrompt: session.prompt_md,
    sessionTitle: session.title,
  });

  let runId: string | null = null;
  let sandbox: SandboxHandle | null = null;
  let github: {
    installationId: number;
    repo: { default_branch: string | null; full_name: string; id: string };
  } | null = null;
  let branch: string | null = null;
  const collectedText: string[] = [];
  let artifactInserted = false;
  try {
    const resolvedRunner = await resolveAgentRunner({
      admin,
      model: config.model,
      provider,
      session,
    });

    runId = await startAgentRun(admin, {
      jobId: job.id,
      model: config.model,
      provider: resolvedRunner.runner.provider,
      requestedByMemberId: job.requested_by_member_id,
      runType: "project",
      sessionId: session.id,
      stage,
      workspaceId: session.workspace_id,
    });

    // CLI-backed runners require a GitHub repo to clone into the sandbox.
    if (resolvedRunner.runner.requiresSandbox) {
      github = await loadGitHubContext(admin, session.workspace_id, session.id);
      if (!github) {
        if (runId) {
          await markRunError(admin, runId);
        }
        await updateSessionStatus(admin, session.id, "rejected");
        await markPipelineJobError(
          admin,
          job,
          "No GitHub installation or repository found for workspace. Connect a GitHub repository in workspace settings.",
        );
        return { jobId: job.id, processed: true, result: "error", runId: null };
      }
      const installationToken = await mintInstallationToken(github.installationId);
      branch = buildStageBranchName(session.id, stage.slug);
      throwIfAborted(signal);
      sandbox = await createSessionSandbox({
        agentProvider: provider,
        baseBranch: github.repo.default_branch ?? "main",
        branch,
        installationToken,
        repoFullName: github.repo.full_name,
        signal,
        sessionId: session.id,
      });
      if (runId) {
        await updateRunSandbox(admin, runId, sandbox.id);
      }
    }

    let usage: { inputTokens: number; outputTokens: number } | undefined;

    for await (const event of resolvedRunner.runner.start({
      maxTokens: undefined,
      prompt,
      runId: runId ?? undefined,
      sandbox: sandbox ?? undefined,
      signal,
      sessionId: session.id,
    })) {
      throwIfAborted(signal);
      if (runId) {
        await persistEvent(admin, runId, session.workspace_id, event);
      }
      if (event.type === "text") {
        collectedText.push(event.text);
      } else if (event.type === "completion") {
        if (event.usage) usage = event.usage;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    const artifactMarkdown = collectedText.join("\n").trim();
    if (!artifactMarkdown) {
      const message = `${stage.name} did not produce reviewable output. Wallie only received runner bookkeeping, so no artifact was created.`;

      if (runId) {
        await persistEvent(admin, runId, session.workspace_id, { type: "error", message });
      }

      throw new MissingReviewableOutputError(message);
    }

    if (runId) {
      await persistEvent(admin, runId, session.workspace_id, {
        type: "completion",
        taskComplete: true,
        summary: `${stage.name} run completed`,
      });
      await markRunSuccess(admin, runId, usage);
    }

    await insertArtifact(admin, {
      artifactJson: artifactMarkdown,
      sessionId: session.id,
      stageId: stage.id,
      stageSlug: stage.slug,
      version: newVersion,
      workspaceId: session.workspace_id,
    });
    artifactInserted = true;

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

      if (prOutcome.kind !== "success" && prOutcome.kind !== "no_commits") {
        // PR plumbing is recoverable — the artifact is durable and the reviewer
        // can approve the artifact directly. Surface the failure for ops without
        // blocking the stage.
        console.error("Failed to open session pull request", {
          kind: prOutcome.kind,
          reason: prOutcome.reason,
          sessionId: session.id,
          stageSlug: stage.slug,
        });
      }
    }

    const { error: pointerError } = await admin
      .from("sessions")
      .update({
        current_artifact_version: newVersion,
        phase_status: "awaiting_review",
      })
      .eq("id", session.id);
    if (pointerError) throw pointerError;
  } catch (error) {
    if (runId) {
      await markRunError(admin, runId);
    }

    if (isCodexAuthLeaseBusyError(error)) {
      await updateSessionStatus(admin, session.id, session.phase_status);
      await deferPipelineJob(admin, job, error.message);
      return { jobId: job.id, processed: true, result: "idle", runId };
    }

    if (artifactInserted) {
      // Compensate: drop the orphan so the next retry doesn't hit the
      // (session_id, stage_slug, version) unique constraint.
      await admin
        .from("session_artifacts")
        .delete()
        .eq("session_id", session.id)
        .eq("stage_slug", stage.slug)
        .eq("version", newVersion);
    }

    await updateSessionStatus(admin, session.id, "rejected");
    const message = getErrorMessage(error, "Stage generation failed");
    await markPipelineJobError(admin, job, message, {
      retry: !(error instanceof MissingReviewableOutputError),
    });
    return { jobId: job.id, processed: true, result: "error", runId };
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

  await markPipelineJobSuccess(admin, job);
  return { jobId: job.id, processed: true, result: "success", runId };
}

// --- Approval + rejection handlers ---

function isUniqueViolation(error: { code?: string } | null | undefined) {
  return error?.code === "23505";
}

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

async function loadActiveSessionJob(
  admin: AdminClient,
  input: { dedupeKey: string; workspaceId: string },
) {
  const { data, error } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("dedupe_key", input.dedupeKey)
    .in("status", ["queued", "started", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

async function cleanupQueuedJob(admin: AdminClient, jobId: string) {
  const { error } = await admin.from("agent_jobs").delete().eq("id", jobId).eq("status", "queued");

  if (error) {
    console.error("Failed to clean up orphaned pipeline job", {
      error,
      jobId,
    });
  }
}

async function enqueueSessionJobWithRun(input: {
  admin: AdminClient;
  requestedByMemberId: string | null;
  sessionId: string;
  triggerType: Tables<"agent_jobs">["trigger_type"];
  workspaceId: string;
}) {
  const dedupeKey = buildWallieJobDedupeKey(input.sessionId);
  const [agentConfig, repositoryResolution, session] = await Promise.all([
    loadWorkspaceAgentConfig(input.admin, input.workspaceId),
    resolveEffectiveSessionRepository({
      sessionId: input.sessionId,
      supabase: input.admin,
      workspaceId: input.workspaceId,
    }),
    loadSessionById(input.admin, input.sessionId),
  ]);
  const stage = session ? await loadStageById(input.admin, session.current_stage_id) : null;
  const { data: job, error: jobError } = await input.admin
    .from("agent_jobs")
    .insert({
      dedupe_key: dedupeKey,
      job_type: PIPELINE_JOB_TYPE,
      requested_by_member_id: input.requestedByMemberId,
      session_id: input.sessionId,
      stage_id: stage?.id ?? null,
      stage_name: stage?.name ?? null,
      stage_slug: stage?.slug ?? null,
      trigger_type: input.triggerType,
      workspace_id: input.workspaceId,
    })
    .select("id")
    .single();

  if (isUniqueViolation(jobError)) {
    return {
      created: false,
      jobId: await loadActiveSessionJob(input.admin, {
        dedupeKey,
        workspaceId: input.workspaceId,
      }),
    };
  }

  if (jobError || !job) {
    throw jobError ?? new Error("Wallie job insert did not return a job id.");
  }

  const runType = inferWallieRunMode(repositoryResolution.repositoryId);
  const { error: runError } = await input.admin.from("agent_runs").insert({
    agent_job_id: job.id,
    model_name: agentConfig.model,
    model_provider: agentConfig.provider,
    run_type: runType,
    session_id: input.sessionId,
    stage_id: stage?.id ?? null,
    stage_name: stage?.name ?? null,
    stage_slug: stage?.slug ?? null,
    triggered_by_member_id: input.requestedByMemberId,
    workspace_id: input.workspaceId,
  });

  if (runError) {
    await cleanupQueuedJob(input.admin, job.id);
    throw runError;
  }

  return {
    created: true,
    jobId: job.id,
  };
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

  if (!row.archived_at && row.phase_status === "agent_generating") {
    try {
      const queued = await enqueueSessionJobWithRun({
        admin,
        requestedByMemberId: input.approverMemberId,
        sessionId: input.sessionId,
        triggerType: "assignment",
        workspaceId: input.expectedWorkspaceId,
      });

      return { jobId: queued.jobId, success: true };
    } catch (error) {
      console.error("Approved stage but failed to queue Wallie", {
        error: getErrorMessage(error, "Approved stage but failed to queue Wallie."),
        sessionId: input.sessionId,
        workspaceId: input.expectedWorkspaceId,
      });
      return { jobId: null, success: true };
    }
  }

  return { jobId: null, success: true };
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

  const session = await loadSessionById(admin, input.sessionId);
  if (!session) {
    return { error: "Session not found.", success: false };
  }

  if (session.workspace_id !== input.expectedWorkspaceId) {
    return { error: "Session not found.", success: false };
  }

  if (session.phase_status !== "awaiting_review") {
    return { error: "Session is not awaiting review.", success: false };
  }

  if (session.current_artifact_version !== input.version) {
    return { error: "Version mismatch: a newer version exists.", success: false };
  }

  const stage = await loadStageById(admin, session.current_stage_id);
  if (!stage) {
    return {
      error: "Session references a missing stage.",
      success: false,
    };
  }

  const newRejectionCount = session.rejection_count + 1;

  // Atomic CAS on rejection_count: only the first rejection that observed
  // the current count can advance it. A concurrent second rejection sees
  // rows-updated=0 and exits without double-counting.
  const { data: claimedRejection, error: claimRejectionError } = await admin
    .from("sessions")
    .update({ rejection_count: newRejectionCount })
    .eq("id", input.sessionId)
    .eq("workspace_id", input.expectedWorkspaceId)
    .eq("rejection_count", session.rejection_count)
    .eq("phase_status", "awaiting_review")
    .eq("current_artifact_version", input.version)
    .select("id")
    .maybeSingle();

  if (claimRejectionError) {
    return { error: claimRejectionError.message, success: false };
  }

  if (!claimedRejection) {
    return {
      error: "Rejection raced with another update — please refresh and try again.",
      success: false,
    };
  }

  // Feedback lives in its own table keyed on (session_id, stage_id,
  // target_version). Stage_id is the immutable FK so a stage rename between
  // generation and review does not orphan the row. The unique constraint
  // makes the row a first-write-wins record of "why was this version
  // rejected" — the loser of a truly concurrent rejection is caught by the
  // CAS guard above; this insert is a defense-in-depth check.
  const { error: feedbackInsertError } = await admin.from("session_artifact_feedback").insert({
    feedback_text: input.feedbackText,
    session_id: input.sessionId,
    stage_id: stage.id,
    stage_slug: stage.slug,
    target_version: input.version,
    workspace_id: session.workspace_id,
  });

  // 23505 = unique_violation: feedback already exists for this target_version,
  // which means a prior attempt inserted it but a later step (e.g., agent_jobs
  // enqueue) failed and the session never advanced. Treat as idempotent
  // success and proceed to enqueue rather than wedging the session in
  // awaiting_review with rejection_count bumped but nothing queued.
  if (feedbackInsertError && feedbackInsertError.code !== "23505") {
    return { error: feedbackInsertError.message, success: false };
  }

  // Enqueue a new generation job BEFORE flipping phase_status to 'rejected'.
  // If the enqueue fails with a non-dedupe error we must not transition into
  // 'rejected', because 'rejected' with no queued worker is a wedged state the
  // UI cannot recover from.
  let queued: { created: boolean; jobId: string | null };
  try {
    queued = await enqueueSessionJobWithRun({
      admin,
      requestedByMemberId: input.requestedByMemberId,
      sessionId: session.id,
      triggerType: "comment_retry",
      workspaceId: session.workspace_id,
    });
  } catch (error) {
    return {
      error: getErrorMessage(error, "Failed to queue Wallie retry."),
      success: false,
    };
  }

  await admin.from("sessions").update({ phase_status: "rejected" }).eq("id", input.sessionId);

  return { jobId: queued.jobId, success: true };
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

async function updateSessionStatus(
  admin: AdminClient,
  sessionId: string,
  status: SessionRow["phase_status"],
): Promise<void> {
  const { error } = await admin
    .from("sessions")
    .update({ phase_status: status })
    .eq("id", sessionId);
  if (error) throw error;
}

async function insertArtifact(
  admin: AdminClient,
  input: {
    artifactJson: string;
    sessionId: string;
    stageId: string;
    stageSlug: string;
    version: number;
    workspaceId: string;
  },
): Promise<void> {
  const { error } = await admin.from("session_artifacts").insert({
    artifact_json: input.artifactJson,
    session_id: input.sessionId,
    stage_id: input.stageId,
    stage_slug: input.stageSlug,
    version: input.version,
    workspace_id: input.workspaceId,
  });
  if (error) throw error;
}

async function resolveAgentRunner(input: {
  admin: AdminClient;
  model?: string;
  provider: AgentProvider;
  session: Pick<SessionRow, "creator_member_id" | "workspace_id">;
}): Promise<{ runner: AgentRunner }> {
  if (input.provider === "codex") {
    try {
      const credential = await getCodexCredentialForSession(input.admin, input.session);
      return {
        runner: createAgentRunner("codex", {
          codex: {
            chatGptAuthStore: createCodexChatGptAuthStore(input.admin),
            credential,
            model: input.model,
          },
        }),
      };
    } catch (error) {
      if (error instanceof CodexNotConnectedError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }

  if (input.provider === "claude-code") {
    try {
      const credential = await getClaudeCodeCredentialForSession(input.admin, input.session);
      return {
        runner: createAgentRunner("claude-code", {
          claudeCode: { credential, model: input.model },
        }),
      };
    } catch (error) {
      if (error instanceof ClaudeCodeNotConnectedError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }

  return {
    runner: createAgentRunner(input.provider),
  };
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
  sessionId: string,
): Promise<GitHubContext | null> {
  const resolution = await resolveEffectiveSessionRepository({
    sessionId,
    supabase: admin,
    workspaceId,
  });
  const repository = resolution.repository;

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

function buildStageBranchName(sessionId: string, stageSlug: string): string {
  const safeSlug = stageSlug.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `wallie/${safeSlug || "stage"}-${sessionId}`;
}

async function startAgentRun(
  admin: AdminClient,
  input: {
    jobId: string;
    sessionId: string;
    model: string;
    provider: AgentProvider;
    requestedByMemberId: string | null;
    runType: string;
    workspaceId: string;
    stage: Pick<PipelineStage, "id" | "name" | "slug"> | null;
  },
): Promise<string | null> {
  const startedAt = new Date().toISOString();
  const { data: existingRun, error: updateError } = await admin
    .from("agent_runs")
    .update({
      model_name: input.model,
      model_provider: input.provider,
      stage_id: input.stage?.id ?? null,
      stage_name: input.stage?.name ?? null,
      stage_slug: input.stage?.slug ?? null,
      started_at: startedAt,
      status: "running" as const,
      triggered_by_member_id: input.requestedByMemberId,
    })
    .eq("agent_job_id", input.jobId)
    .in("status", ["queued", "started", "running"])
    .select("id")
    .maybeSingle();

  if (updateError) {
    throw updateError;
  }

  if (existingRun) {
    return existingRun.id;
  }

  const { data, error } = await admin
    .from("agent_runs")
    .insert({
      agent_job_id: input.jobId,
      model_name: input.model,
      model_provider: input.provider,
      run_type: input.runType,
      session_id: input.sessionId,
      stage_id: input.stage?.id ?? null,
      stage_name: input.stage?.name ?? null,
      stage_slug: input.stage?.slug ?? null,
      started_at: startedAt,
      status: "running" as const,
      triggered_by_member_id: input.requestedByMemberId,
      workspace_id: input.workspaceId,
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id;
}

async function updateRunSandbox(
  admin: AdminClient,
  runId: string,
  sandboxId: string,
): Promise<void> {
  const { error } = await admin
    .from("agent_runs")
    .update({ sandbox_id: sandboxId })
    .eq("id", runId);
  if (error) {
    throw error;
  }
}

async function markRunSuccess(
  admin: AdminClient,
  runId: string,
  usage?: { inputTokens: number; outputTokens: number },
): Promise<void> {
  await admin
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "success" as const,
      ...(usage
        ? {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
          }
        : {}),
    })
    .eq("id", runId);
}

async function markRunError(admin: AdminClient, runId: string): Promise<void> {
  await admin
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "error" as const,
    })
    .eq("id", runId);
}

async function markActiveRunsForJobError(admin: AdminClient, jobId: string): Promise<void> {
  await admin
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "error" as const,
    })
    .eq("agent_job_id", jobId)
    .in("status", ["queued", "started", "running"]);
}

async function persistEvent(
  admin: AdminClient,
  runId: string,
  workspaceId: string,
  event: AgentEvent,
): Promise<void> {
  let kind: string;
  let messageMd: string;

  switch (event.type) {
    case "text":
      kind = "text";
      messageMd = event.text;
      break;
    case "tool_use":
      kind = "tool_use";
      messageMd = `**Tool:** ${event.tool}\n\n\`\`\`\n${event.input}\n\`\`\``;
      break;
    case "completion":
      if (isGenericRunnerCompletionSummary(event.summary)) {
        await touchRunActivity(admin, runId);
        return;
      }
      kind = "completion";
      messageMd = event.summary;
      break;
    case "error":
      kind = "error";
      messageMd = `**Error:** ${event.message}`;
      break;
  }

  const { error } = await admin.from("agent_run_messages").insert({
    agent_run_id: runId,
    kind,
    message_md: messageMd,
    workspace_id: workspaceId,
  });
  if (error) {
    throw error;
  }

  await touchRunActivity(admin, runId);
}

function isGenericRunnerCompletionSummary(summary: string) {
  return summary.trim().toLowerCase() === "codex session completed";
}

async function touchRunActivity(admin: AdminClient, runId: string): Promise<void> {
  await admin
    .from("agent_runs")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", runId)
    .in("status", ["queued", "started", "running"]);
}

async function markPipelineJobSuccess(
  admin: AdminClient,
  job: Tables<"agent_jobs">,
): Promise<void> {
  await admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      status: "success",
    })
    .eq("id", job.id);
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

async function markPipelineJobError(
  admin: AdminClient,
  job: Tables<"agent_jobs">,
  errorMessage: string,
  options: { retry?: boolean } = {},
): Promise<void> {
  const maxRetries = await loadMaxRetries(admin, job.workspace_id);

  if (options.retry !== false && job.attempt_count < maxRetries) {
    const { error: retryError } = await admin.rpc("schedule_job_retry", {
      target_job_id: job.id,
      base_delay_ms: 5000,
      max_backoff_ms: 300000,
    });

    if (!retryError) {
      await admin.from("agent_jobs").update({ last_error: errorMessage }).eq("id", job.id);
      return;
    }
  }

  await admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      last_error: errorMessage,
      status: "error",
    })
    .eq("id", job.id);
  await markActiveRunsForJobError(admin, job.id);
}

async function deferPipelineJob(
  admin: AdminClient,
  job: Tables<"agent_jobs">,
  message: string,
): Promise<void> {
  const { error: retryError } = await admin.rpc("schedule_job_retry", {
    target_job_id: job.id,
    base_delay_ms: 15000,
    max_backoff_ms: 120000,
  });

  if (!retryError) {
    await admin.from("agent_jobs").update({ last_error: message }).eq("id", job.id);
    return;
  }

  await markPipelineJobError(admin, job, message);
}
