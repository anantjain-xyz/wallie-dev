import "server-only";

import { App } from "@octokit/app";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { PipelineStage } from "@/features/sessions/types";
import { resolveGitHubAppConfig } from "@/features/github/config";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createAgentRunner, DEFAULT_AGENT_RUNNER_CONFIG } from "@/lib/agent-runner";
import type { AgentEvent, AgentRunner } from "@/lib/agent-runner/types";
import { CodexNotConnectedError, getCodexAccessTokenForSession } from "@/lib/codex/tokens";
import { createSessionSandbox } from "@/lib/sandbox";
import type { AgentProvider, SandboxHandle } from "@/lib/sandbox/types";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { renderStagePrompt } from "@/lib/prompt-templates";

import {
  formatEscalationDmBlocks,
  formatGenerationFailureBlocks,
  formatStageReviewBlocks,
  openSlackDm,
  postSlackMessage,
} from "./slack-format";
import { loadCompletedStageArtifacts, loadPipelineWithStages, loadStageById } from "./stages";
import { shouldEscalate } from "./state-machine";
import { PIPELINE_JOB_TYPE } from "./types";

type AdminClient = SupabaseClient<Database>;
type SessionRow = Tables<"sessions">;

interface ProcessPipelineJobResult {
  jobId: string;
  processed: boolean;
  result: "error" | "idle" | "success";
  runId: string | null;
}

export async function processPipelineJob(input: {
  admin?: AdminClient;
  job: Tables<"agent_jobs">;
}): Promise<ProcessPipelineJobResult> {
  const admin = input.admin ?? createSupabaseAdminClient();
  const job = input.job;

  try {
    const session = await loadSessionById(admin, job.session_id);
    if (!session) {
      await markPipelineJobError(admin, job, "No session row found for this job.");
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    const slackInstall = await loadSlackInstallation(admin, job.workspace_id);
    const botToken = slackInstall ? decryptSecretValue(slackInstall.bot_token_encrypted) : null;

    if (!botToken) {
      await markPipelineJobError(admin, job, "No Slack installation found for workspace.");
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
    // an artifact that has already been approved or escalated.
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

    return await runStage({ admin, botToken, job, session, stage });
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
// the text output as a markdown artifact, flip phase_status, and post a
// review block to Slack. No git, no PR creation, no specialized output
// shapes — that's the v1 trade-off for letting workspaces define their own
// pipeline.
async function runStage(input: {
  admin: AdminClient;
  botToken: string;
  job: Tables<"agent_jobs">;
  session: SessionRow;
  stage: PipelineStage;
}): Promise<ProcessPipelineJobResult> {
  const { admin, botToken, job, session, stage } = input;

  const newVersion = session.current_artifact_version + 1;

  const config = await loadAgentConfig(admin, session.workspace_id);
  const provider = normalizeAgentProvider(config.provider);

  // Pull artifacts from completed prior stages so the prompt can reference
  // them via {{artifact.previousStages.<slug>}}.
  const previousStages = await loadCompletedStageArtifacts(admin, session.id);

  // Resume-on-rejection: pull the most recent feedback for this stage so the
  // template can include it via {{attempt.feedback}}. Match on stage_id so a
  // rename in the editor doesn't cause us to miss the prior attempt.
  const lastArtifact = await loadLatestArtifact(admin, session.id, stage.id);
  const attemptFeedback = lastArtifact?.feedback_text ?? null;

  const prompt = renderStagePrompt(stage, {
    attemptFeedback,
    attemptNumber: session.rejection_count + 1,
    previousStages,
    sessionPrompt: session.prompt_md,
    sessionTitle: session.title,
  });

  let runId: string | null = null;
  let sandbox: SandboxHandle | null = null;
  const collectedText: string[] = [];
  let artifactInserted = false;
  try {
    const resolvedRunner = await resolveAgentRunner({
      admin,
      model: config.model,
      provider,
      session,
    });

    // Sandbox-needing runners (codex, claude-code) require a GitHub repo to
    // clone. Text-only runners (anthropic-api) skip both — saving the
    // sandbox-spawn latency that the issue called out.
    if (resolvedRunner.runner.requiresSandbox) {
      const github = await loadGitHubContext(admin, session.workspace_id);
      if (!github) {
        await markPipelineJobError(
          admin,
          job,
          "No GitHub installation or repository found for workspace. Connect a GitHub repository in workspace settings.",
        );
        return { jobId: job.id, processed: true, result: "error", runId: null };
      }
      const installationToken = await mintInstallationToken(github.installationId);
      const branch = buildStageBranchName(session.id, stage.slug);
      sandbox = await createSessionSandbox({
        agentProvider: provider,
        baseBranch: github.repo.default_branch ?? "main",
        branch,
        codexAccessToken: resolvedRunner.codexAccessToken,
        installationToken,
        repoFullName: github.repo.full_name,
        sessionId: session.id,
      });
    }

    runId = await createAgentRun(admin, {
      jobId: job.id,
      model: config.model ?? DEFAULT_AGENT_RUNNER_CONFIG.model ?? "codex",
      provider: resolvedRunner.runner.provider,
      runType: stage.slug,
      sessionId: session.id,
      workspaceId: session.workspace_id,
    });

    let usage: { inputTokens: number; outputTokens: number } | undefined;

    for await (const event of resolvedRunner.runner.start({
      maxTokens: undefined,
      prompt,
      sandbox: sandbox ?? undefined,
      sessionId: session.id,
    })) {
      if (runId) {
        await persistEvent(admin, runId, session.workspace_id, event);
      }
      if (event.type === "text") {
        collectedText.push(event.text);
      } else if (event.type === "completion") {
        if (event.summary) collectedText.push(event.summary);
        if (event.usage) usage = event.usage;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    if (runId) {
      await markRunSuccess(admin, runId, usage);
    }

    const artifactMarkdown =
      collectedText.join("\n").trim() || `_${stage.name} produced no output._`;

    await insertArtifact(admin, {
      artifactJson: artifactMarkdown,
      feedbackText: null,
      sessionId: session.id,
      stageId: stage.id,
      stageSlug: stage.slug,
      version: newVersion,
      workspaceId: session.workspace_id,
    });
    artifactInserted = true;

    const { error: pointerError } = await admin
      .from("sessions")
      .update({
        current_artifact_version: newVersion,
        phase_status: "awaiting_review",
      })
      .eq("id", session.id);
    if (pointerError) throw pointerError;

    if (session.slack_channel_id) {
      const pipeline = await loadPipelineWithStages(admin, session.pipeline_id);
      const stages = pipeline?.stages ?? [];
      const idx = stages.findIndex((s) => s.id === stage.id);
      const nextStage = idx >= 0 && idx < stages.length - 1 ? stages[idx + 1]! : null;

      try {
        await postSlackMessage({
          blocks: formatStageReviewBlocks({
            artifactPreviewMd: artifactMarkdown,
            linearUrl: session.linear_issue_url,
            nextStage,
            sessionId: session.id,
            stage,
            version: newVersion,
          }),
          botToken,
          channel: session.slack_channel_id,
          text: `${stage.name} ready for review (v${newVersion})`,
          threadTs: session.slack_thread_ts ?? undefined,
        });
      } catch (postError) {
        // State flip is durable; failing to post Slack is recoverable from the
        // in-app dashboard. Log and continue.
        console.error("Failed to post stage review to Slack", {
          error: postError instanceof Error ? postError.message : String(postError),
          sessionId: session.id,
        });
      }
    }
  } catch (error) {
    if (runId) {
      await markRunError(admin, runId);
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

    if (session.slack_channel_id) {
      try {
        await postSlackMessage({
          blocks: formatGenerationFailureBlocks(stage.name),
          botToken,
          channel: session.slack_channel_id,
          text: `${stage.name} generation failed`,
          threadTs: session.slack_thread_ts ?? undefined,
        });
      } catch {
        // Ignore — operator will see the agent_jobs row.
      }
    }

    await updateSessionStatus(admin, session.id, "rejected");
    const message = error instanceof Error ? error.message : "Stage generation failed";
    await markPipelineJobError(admin, job, message);
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

export async function handleApproval(input: {
  admin?: AdminClient;
  approverMemberId: string | null;
  expectedWorkspaceId: string;
  sessionId: string;
  version: number;
}): Promise<{ error?: string; success: boolean }> {
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

  return { success: true };
}

export async function handleRejection(input: {
  admin?: AdminClient;
  expectedWorkspaceId: string;
  feedbackText: string;
  sessionId: string;
  version: number;
}): Promise<{ escalated: boolean; error?: string; success: boolean }> {
  const admin = input.admin ?? createSupabaseAdminClient();

  const session = await loadSessionById(admin, input.sessionId);
  if (!session) {
    return { escalated: false, error: "Session not found.", success: false };
  }

  if (session.workspace_id !== input.expectedWorkspaceId) {
    return { escalated: false, error: "Session not found.", success: false };
  }

  if (session.phase_status !== "awaiting_review") {
    return { escalated: false, error: "Session is not awaiting review.", success: false };
  }

  if (session.current_artifact_version !== input.version) {
    return { escalated: false, error: "Version mismatch: a newer version exists.", success: false };
  }

  const stage = await loadStageById(admin, session.current_stage_id);
  if (!stage) {
    return {
      escalated: false,
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
    return { escalated: false, error: claimRejectionError.message, success: false };
  }

  if (!claimedRejection) {
    return {
      escalated: false,
      error: "Rejection raced with another update — please refresh and try again.",
      success: false,
    };
  }

  // Match on stage_id (immutable FK) rather than stage_slug — a stage
  // renamed in settings between artifact generation and review would
  // otherwise cause this update to match zero rows and silently drop the
  // reviewer's feedback.
  await admin
    .from("session_artifacts")
    .update({ feedback_text: input.feedbackText })
    .eq("session_id", input.sessionId)
    .eq("stage_id", stage.id)
    .eq("version", input.version);

  if (shouldEscalate(newRejectionCount)) {
    await admin.from("sessions").update({ phase_status: "escalated" }).eq("id", input.sessionId);

    const slackInstall = await loadSlackInstallation(admin, session.workspace_id);
    const botToken = slackInstall ? decryptSecretValue(slackInstall.bot_token_encrypted) : null;
    const emSlackUserId = await loadEmSlackUserId(admin, session.workspace_id);

    if (botToken && emSlackUserId) {
      try {
        const dmChannelId = await openSlackDm({
          botToken,
          userId: emSlackUserId,
        });

        await postSlackMessage({
          blocks: formatEscalationDmBlocks({
            channelId: session.slack_channel_id ?? "",
            linearUrl: session.linear_issue_url,
            rejectionCount: newRejectionCount,
            sessionTitle: session.title,
            stageName: stage.name,
            threadTs: session.slack_thread_ts ?? "",
          }),
          botToken,
          channel: dmChannelId,
          text: `Stage escalation: ${session.title} (${stage.name}) rejected ${newRejectionCount} times.`,
        });
      } catch (dmError) {
        console.error("Failed to deliver escalation DM", {
          error: dmError instanceof Error ? dmError.message : String(dmError),
          sessionId: input.sessionId,
        });
      }
    }

    return { escalated: true, success: true };
  }

  // Not escalated: enqueue a new generation job BEFORE flipping phase_status
  // to 'rejected'. If the enqueue fails with a non-dedupe error we must not
  // transition into 'rejected', because 'rejected' with no queued worker is
  // a wedged state the UI cannot recover from.
  const wallieMember = await loadWallieSystemMember(admin, session.workspace_id);

  const { error: enqueueError } = await admin.from("agent_jobs").insert({
    dedupe_key: session.linear_issue_id
      ? `pipeline:${session.linear_issue_id}:active`
      : `pipeline:session:${session.id}:active`,
    job_type: PIPELINE_JOB_TYPE,
    requested_by_member_id: wallieMember?.id ?? null,
    session_id: session.id,
    trigger_type: "slack_mention",
    workspace_id: session.workspace_id,
  });

  // 23505 = unique_violation: a concurrent retry already exists. Silent
  // success — the existing queued job will pick up the feedback.
  if (enqueueError && enqueueError.code !== "23505") {
    return { escalated: false, error: enqueueError.message, success: false };
  }

  await admin.from("sessions").update({ phase_status: "rejected" }).eq("id", input.sessionId);

  return { escalated: false, success: true };
}

// --- Data access helpers ---

async function loadSessionById(admin: AdminClient, id: string): Promise<SessionRow | null> {
  const { data, error } = await admin.from("sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

async function loadSlackInstallation(
  admin: AdminClient,
  workspaceId: string,
): Promise<Tables<"slack_installations"> | null> {
  const { data, error } = await admin
    .from("slack_installations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadEmSlackUserId(admin: AdminClient, workspaceId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("encrypted_value")
    .eq("workspace_id", workspaceId)
    .eq("key", "EM_SLACK_USER_ID")
    .maybeSingle();
  if (error) return null;
  return data ? decryptSecretValue(data.encrypted_value) : null;
}

async function loadLatestArtifact(
  admin: AdminClient,
  sessionId: string,
  stageId: string,
): Promise<Tables<"session_artifacts"> | null> {
  const { data, error } = await admin
    .from("session_artifacts")
    .select("*")
    .eq("session_id", sessionId)
    .eq("stage_id", stageId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadWallieSystemMember(
  admin: AdminClient,
  workspaceId: string,
): Promise<Pick<Tables<"workspace_members">, "id"> | null> {
  const { data, error } = await admin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "system")
    .eq("username", "wallie")
    .maybeSingle();
  if (error) throw error;
  return data;
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
    feedbackText: string | null;
    sessionId: string;
    stageId: string;
    stageSlug: string;
    version: number;
    workspaceId: string;
  },
): Promise<void> {
  const { error } = await admin.from("session_artifacts").insert({
    artifact_json: input.artifactJson,
    feedback_text: input.feedbackText,
    session_id: input.sessionId,
    stage_id: input.stageId,
    stage_slug: input.stageSlug,
    version: input.version,
    workspace_id: input.workspaceId,
  });
  if (error) throw error;
}

async function loadAgentConfig(
  admin: AdminClient,
  workspaceId: string,
): Promise<{ maxTurns?: number; model?: string; provider?: string }> {
  const { data } = await admin
    .from("workspace_agent_config")
    .select("key, value_json")
    .eq("workspace_id", workspaceId)
    .in("key", ["max_turns", "agent_provider", "agent_model"]);

  const config: Record<string, unknown> = {};
  for (const row of data ?? []) {
    config[row.key] = row.value_json;
  }

  return {
    maxTurns: typeof config.max_turns === "number" ? config.max_turns : undefined,
    model: typeof config.agent_model === "string" ? config.agent_model : undefined,
    provider: typeof config.agent_provider === "string" ? config.agent_provider : undefined,
  };
}

function normalizeAgentProvider(provider: string | undefined): AgentProvider {
  const normalized = (provider ?? DEFAULT_AGENT_RUNNER_CONFIG.provider).replace(/_/g, "-");
  if (normalized === "codex" || normalized === "claude-code" || normalized === "anthropic-api") {
    return normalized;
  }
  throw new Error(
    `Unknown agent provider: "${provider}". Supported: codex, claude-code, claude_code, anthropic-api, anthropic_api`,
  );
}

async function loadAnthropicApiKey(
  admin: AdminClient,
  workspaceId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("encrypted_value")
    .eq("workspace_id", workspaceId)
    .eq("key", "ANTHROPIC_API_KEY")
    .maybeSingle();
  if (error) return null;
  return data ? decryptSecretValue(data.encrypted_value) : null;
}

async function resolveAgentRunner(input: {
  admin: AdminClient;
  model?: string;
  provider: AgentProvider;
  session: Pick<SessionRow, "creator_member_id" | "workspace_id">;
}): Promise<{ codexAccessToken?: string; runner: AgentRunner }> {
  if (input.provider === "codex") {
    try {
      const accessToken = await getCodexAccessTokenForSession(input.admin, input.session);
      return {
        codexAccessToken: accessToken,
        runner: createAgentRunner("codex", {
          codex: { accessToken, model: input.model },
        }),
      };
    } catch (error) {
      if (error instanceof CodexNotConnectedError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }

  if (input.provider === "anthropic-api") {
    const apiKey = await loadAnthropicApiKey(input.admin, input.session.workspace_id);
    if (!apiKey) {
      throw new Error(
        "anthropic-api provider requires ANTHROPIC_API_KEY in workspace secrets. Add it under Settings → Integrations → Anthropic.",
      );
    }
    return {
      runner: createAgentRunner("anthropic-api", {
        anthropic: { apiKey, model: input.model },
      }),
    };
  }

  return { runner: createAgentRunner(input.provider) };
}

interface GitHubContext {
  installationId: number;
  repo: {
    default_branch: string | null;
    full_name: string;
  };
}

async function loadGitHubContext(
  admin: AdminClient,
  workspaceId: string,
): Promise<GitHubContext | null> {
  const { data: installation } = await admin
    .from("github_installations")
    .select("id, installation_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!installation) return null;

  const { data: repo } = await admin
    .from("github_repositories")
    .select("full_name, default_branch")
    .eq("github_installation_id", installation.id)
    .eq("is_archived", false)
    .order("full_name", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!repo) return null;

  return {
    installationId: installation.installation_id,
    repo: {
      default_branch: repo.default_branch,
      full_name: repo.full_name,
    },
  };
}

async function mintInstallationToken(installationId: number): Promise<string> {
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

async function createAgentRun(
  admin: AdminClient,
  input: {
    jobId: string;
    sessionId: string;
    model: string;
    provider: string;
    runType: string;
    workspaceId: string;
  },
): Promise<string | null> {
  const { data, error } = await admin
    .from("agent_runs")
    .insert({
      agent_job_id: input.jobId,
      model_name: input.model,
      model_provider: input.provider,
      run_type: input.runType,
      session_id: input.sessionId,
      started_at: new Date().toISOString(),
      status: "running" as const,
      workspace_id: input.workspaceId,
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id;
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
      kind = "completion";
      messageMd = event.summary;
      break;
    case "error":
      kind = "error";
      messageMd = `**Error:** ${event.message}`;
      break;
  }

  await admin.from("agent_run_messages").insert({
    agent_run_id: runId,
    kind,
    message_md: messageMd,
    workspace_id: workspaceId,
  });
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
): Promise<void> {
  const maxRetries = await loadMaxRetries(admin, job.workspace_id);

  if (job.attempt_count < maxRetries) {
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
}
