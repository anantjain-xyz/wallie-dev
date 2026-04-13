import "server-only";

import type { Tables } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { SESSION_PHASE_LABELS, type SessionPhase } from "@/features/sessions/types";
import { runDesignPhase } from "./design-phase";
import { runEngineeringPhase } from "./engineering-phase";
import { runLandPhase } from "./land-phase";
import { runMonitorPhase } from "./monitor-phase";
import { runReviewPhase } from "./review-phase";

import { preScreenIssue } from "./pre-screen";
import { generateProductSpec } from "./product-agent";
import {
  escapeMrkdwn,
  formatEscalationDmBlocks,
  formatPreScreenFailBlocks,
  formatSpecBlocks,
  formatSpecDiffBlocks,
  openSlackDm,
  postSlackMessage,
} from "./slack-format";
import { nextPhase, shouldEscalate } from "./state-machine";
import { PIPELINE_JOB_TYPE, type ProductSpec, markdownToSpec, specToMarkdown } from "./types";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
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
    // Load the session row. Prefer the direct session_id FK (Phase 0
    // addition); fall back to the legacy anchor-issue lookup for jobs
    // created before the backfill.
    const session = job.session_id
      ? await loadSessionById(admin, job.session_id)
      : job.issue_id
        ? await loadSessionByIssueId(admin, job.issue_id)
        : null;
    if (!session) {
      await markPipelineJobError(admin, job, "No session row found for this job.");
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    // Load workspace secrets: ANTHROPIC_API_KEY (product-phase only) and
    // EM_SLACK_USER_ID. The key is only required for the product phase —
    // the other 5 phases use runManualPhaseStub, which doesn't hit the
    // model, so a missing key there must not block the job.
    const secrets = await loadPipelineSecrets(admin, job.workspace_id);
    if (session.phase === "product" && !secrets.anthropicApiKey) {
      await markPipelineJobError(admin, job, "Missing ANTHROPIC_API_KEY in workspace secrets.");
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    // Load Slack bot token from slack_installations
    const slackInstall = await loadSlackInstallation(admin, job.workspace_id);
    const botToken = slackInstall ? decryptSecretValue(slackInstall.bot_token_encrypted) : null;

    if (!botToken) {
      await markPipelineJobError(admin, job, "No Slack installation found for workspace.");
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    // Atomic CAS claim: only proceed if the session is in a non-terminal
    // state for this phase. This prevents a second worker from regenerating
    // a spec that has already been approved or escalated.
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

    // Route by phase: all 6 phases have real implementations.
    // Product uses a structured Claude API call; design, engineering,
    // review, and monitor use the agent runner; land merges the PR
    // via the GitHub App API.
    if (session.phase === "product") {
      // Non-null assertion: the phase-gated check above already rejected
      // product-phase jobs with a missing key.
      return await runProductPhase({
        admin,
        anthropicApiKey: secrets.anthropicApiKey!,
        botToken,
        emSlackUserId: secrets.emSlackUserId,
        job,
        session,
      });
    }

    if (session.phase === "design") {
      return await runDesignPhase({
        admin,
        botToken,
        job,
        session,
      });
    }

    if (session.phase === "engineering") {
      return await runEngineeringPhase({
        admin,
        botToken,
        job,
        session,
      });
    }

    if (session.phase === "review") {
      return await runReviewPhase({
        admin,
        botToken,
        job,
        session,
      });
    }

    if (session.phase === "land") {
      return await runLandPhase({
        admin,
        botToken,
        job,
        session,
      });
    }

    if (session.phase === "monitor") {
      return await runMonitorPhase({
        admin,
        botToken,
        job,
        session,
      });
    }

    // Fallback for any unrecognized phase (should not happen with current
    // phase set, but keeps the code forward-compatible).
    return await runManualPhaseStub({
      admin,
      botToken,
      job,
      session,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pipeline job failed";
    await markPipelineJobError(admin, job, message);
    return { jobId: job.id, processed: true, result: "error", runId: null };
  }
}

// --- Product phase (real agent) ---

async function runProductPhase(input: {
  admin: AdminClient;
  anthropicApiKey: string;
  botToken: string;
  emSlackUserId: string | null;
  job: Tables<"agent_jobs">;
  session: SessionRow;
}): Promise<ProcessPipelineJobResult> {
  const { admin, anthropicApiKey, botToken, job, session } = input;

  // Use session title and prompt directly — no anchor issue lookup needed.
  const issueTitle = session.title;
  const issueDescription = session.prompt_md;

  // Run pre-screen
  const preScreenResult = await preScreenIssue({
    anthropicApiKey,
    issueDescription,
    issueTitle,
  });

  if (!preScreenResult.pass) {
    // Post pre-screen fail to Slack. If the post fails (invalid_auth,
    // channel_not_found, etc.), the session is still logically rejected
    // — the reviewer just won't see a warning. Record the state flip
    // either way and mark the job as errored so operators can investigate.
    let slackPostError: string | null = null;
    if (session.slack_channel_id) {
      try {
        await postSlackMessage({
          blocks: formatPreScreenFailBlocks(preScreenResult.reason),
          botToken,
          channel: session.slack_channel_id,
          text: `Issue needs more detail: ${preScreenResult.reason}`,
          threadTs: session.slack_thread_ts ?? undefined,
        });
      } catch (postError) {
        slackPostError = postError instanceof Error ? postError.message : String(postError);
      }
    }

    await updateSessionStatus(admin, session.id, "rejected");
    if (slackPostError) {
      await markPipelineJobError(
        admin,
        job,
        `Pre-screen failed; Slack notification also failed: ${slackPostError}`,
      );
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }
    await markPipelineJobSuccess(admin, job);
    return { jobId: job.id, processed: true, result: "success", runId: null };
  }

  // Load previous spec if this is a revision of the product phase.
  let previousSpec: ProductSpec | null = null;
  let feedbackText: string | null = null;
  if (session.current_artifact_version > 0) {
    const lastArtifact = await loadLatestArtifact(admin, session.id, session.phase);
    if (lastArtifact) {
      // Support both legacy JSON artifacts and new markdown artifacts
      const raw = lastArtifact.artifact_json;
      if (typeof raw === "string") {
        previousSpec = markdownToSpec(raw);
      } else {
        previousSpec = raw as unknown as ProductSpec;
      }
      feedbackText = lastArtifact.feedback_text;
    }
  }

  // Generate spec AND persist the artifact + version pointer. Bundled into
  // a single try/catch because a failure anywhere in this block leaves the
  // session in the same observable state (no spec to review) and must
  // recover the same way: post a generic Slack warning, flip phase_status
  // to 'rejected', error the agent_job. Without the compensating delete
  // below, a partial save would wedge the next retry on the unique
  // (session_id, phase, version) constraint.
  const newVersion = session.current_artifact_version + 1;
  let spec: ProductSpec;
  let artifactInserted = false;
  try {
    spec = await generateProductSpec({
      anthropicApiKey,
      feedback: feedbackText,
      issueDescription,
      issueTitle,
      previousSpec,
    });

    const specMarkdown = specToMarkdown(spec);

    await insertArtifact(admin, {
      artifactJson: specMarkdown,
      feedbackText: null,
      phase: session.phase,
      sessionId: session.id,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Spec generation failed";

    // Compensate: if we inserted the artifact but a downstream write failed,
    // delete the orphan so the next retry computes newVersion against the
    // pre-insert pointer and doesn't hit 23505 on (session_id, phase,
    // version). We ignore the delete's own error — it's best-effort and a
    // leftover orphan is still recoverable by operator intervention.
    if (artifactInserted) {
      await admin
        .from("session_artifacts")
        .delete()
        .eq("session_id", session.id)
        .eq("phase", session.phase)
        .eq("version", newVersion);
    }

    // Post a generic warning to the Slack thread. We intentionally do not
    // surface the raw SDK/LLM error message — it can contain unescaped Slack
    // mrkdwn that renders as phishing links, and it can leak provider
    // internals. Operators can read the full message from agent_jobs.last_error.
    if (session.slack_channel_id) {
      const friendly = ":warning: Spec generation failed. An operator will investigate.";
      try {
        await postSlackMessage({
          blocks: [
            {
              text: {
                text: friendly,
                type: "mrkdwn",
              },
              type: "section",
            },
          ],
          botToken,
          channel: session.slack_channel_id,
          text: "Spec generation failed",
          threadTs: session.slack_thread_ts ?? undefined,
        });
      } catch (warnError) {
        console.error("Failed to post spec-gen warning to Slack", {
          error: warnError instanceof Error ? warnError.message : String(warnError),
          sessionId: session.id,
        });
      }
    }

    await updateSessionStatus(admin, session.id, "rejected");
    await markPipelineJobError(admin, job, message);
    return { jobId: job.id, processed: true, result: "error", runId: null };
  }

  // Post to Slack
  if (session.slack_channel_id) {
    const blocks = formatSpecBlocks({
      linearUrl: session.linear_issue_url,
      sessionId: session.id,
      spec,
      version: newVersion,
    });

    // If revision, prepend diff
    if (previousSpec && newVersion > 1) {
      const diffBlocks = formatSpecDiffBlocks({
        newSpec: spec,
        oldSpec: previousSpec,
      });
      blocks.unshift(...diffBlocks);
    }

    await postSlackMessage({
      blocks,
      botToken,
      channel: session.slack_channel_id,
      text: `Product spec for "${escapeMrkdwn(spec.title)}" (v${newVersion})`,
      threadTs: session.slack_thread_ts ?? undefined,
    });
  }

  await markPipelineJobSuccess(admin, job);
  return { jobId: job.id, processed: true, result: "success", runId: null };
}

// --- Manual phase stub (design / engineering / review / land / monitor) ---
//
// Writes an empty "manual" artifact, flips state to awaiting_review, and
// posts a Slack prompt asking a human to approve the transition. Adding a
// real agent for any phase later means replacing this call with a
// `runDesignPhase()` / `runEngineeringPhase()` / etc., nothing else changes.
async function runManualPhaseStub(input: {
  admin: AdminClient;
  botToken: string;
  job: Tables<"agent_jobs">;
  session: SessionRow;
}): Promise<ProcessPipelineJobResult> {
  const { admin, botToken, job, session } = input;

  const newVersion = session.current_artifact_version + 1;
  const phaseLabel = SESSION_PHASE_LABELS[session.phase as SessionPhase] ?? session.phase;
  const stubMarkdown = `# ${phaseLabel}\n\n_Awaiting manual completion._\n`;

  let artifactInserted = false;
  try {
    await insertArtifact(admin, {
      artifactJson: stubMarkdown,
      feedbackText: null,
      phase: session.phase,
      sessionId: session.id,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Manual phase stub failed";
    if (artifactInserted) {
      await admin
        .from("session_artifacts")
        .delete()
        .eq("session_id", session.id)
        .eq("phase", session.phase)
        .eq("version", newVersion);
    }
    await updateSessionStatus(admin, session.id, "rejected");
    await markPipelineJobError(admin, job, message);
    return { jobId: job.id, processed: true, result: "error", runId: null };
  }

  // Post a lightweight "awaiting approval" message on the same Slack
  // thread, if there is one. The UI path (in-app approve button) handles
  // sessions without a Slack channel — for those, the stub just flips
  // phase_status and the dashboard picks it up via realtime.
  if (session.slack_channel_id) {
    const phaseLabel = SESSION_PHASE_LABELS[session.phase as SessionPhase] ?? session.phase;
    const next = nextPhase(session.phase as SessionPhase);
    const nextLabel = next ? SESSION_PHASE_LABELS[next] : "completed";

    try {
      await postSlackMessage({
        blocks: [
          {
            text: {
              text: `*${phaseLabel} phase ready for review*\nApprove to advance this session from *${phaseLabel}* to *${nextLabel}*.`,
              type: "mrkdwn",
            },
            type: "section",
          },
          {
            block_id: `pipeline_actions:${session.id}:${newVersion}`,
            elements: [
              {
                action_id: "pipeline_approve",
                style: "primary",
                text: { text: "Approve", type: "plain_text" },
                type: "button",
                value: JSON.stringify({
                  session_id: session.id,
                  version: newVersion,
                }),
              },
              {
                action_id: "pipeline_request_changes",
                text: { text: "Request Changes", type: "plain_text" },
                type: "button",
                value: JSON.stringify({
                  session_id: session.id,
                  version: newVersion,
                }),
              },
            ],
            type: "actions",
          },
        ],
        botToken,
        channel: session.slack_channel_id,
        text: `${phaseLabel} phase awaiting review`,
        threadTs: session.slack_thread_ts ?? undefined,
      });
    } catch (postError) {
      // Slack post failure is non-fatal — the state flip already happened
      // and the in-app UI still shows the awaiting-review prompt.
      console.error("Failed to post manual stub prompt to Slack", {
        error: postError instanceof Error ? postError.message : String(postError),
        sessionId: session.id,
      });
    }
  }

  await markPipelineJobSuccess(admin, job);
  return { jobId: job.id, processed: true, result: "success", runId: null };
}

// --- Approval + rejection handlers ---

export async function handleApproval(input: {
  admin?: AdminClient;
  approverMemberId?: string | null;
  expectedWorkspaceId: string;
  sessionId: string;
  version: number;
}): Promise<{ error?: string; success: boolean }> {
  const admin = input.admin ?? createSupabaseAdminClient();

  // Atomic approval: a single Postgres function handles the CAS, records the
  // phase completion, and advances (or archives on terminal monitor) in one
  // transaction. The RPC also enforces the workspace match, so a Slack
  // interaction from workspace A still cannot approve a session in B.
  const { data, error } = await admin.rpc("approve_session_phase", {
    approver_member_id: input.approverMemberId ?? null,
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
      error: "Approval failed: session version is stale or already reviewed.",
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

  // Cross-workspace guard: the Slack team that sent the feedback modal must
  // own this session. Checked here (in addition to the CAS below) so the
  // load-then-branch logic never leaks rows across tenants.
  if (session.workspace_id !== input.expectedWorkspaceId) {
    return { escalated: false, error: "Session not found.", success: false };
  }

  if (session.phase_status !== "awaiting_review") {
    return { escalated: false, error: "Session is not awaiting review.", success: false };
  }

  if (session.current_artifact_version !== input.version) {
    return { escalated: false, error: "Version mismatch: a newer version exists.", success: false };
  }

  const newRejectionCount = session.rejection_count + 1;

  // Atomic CAS on rejection_count: only the first rejection that observed
  // the current count can advance it. A concurrent second rejection
  // (e.g. Submit Feedback double-click) sees rows-updated=0 and exits
  // without double-counting. This also implicitly re-checks phase_status,
  // version, and workspace_id.
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

  // Save feedback on the current artifact
  await admin
    .from("session_artifacts")
    .update({ feedback_text: input.feedbackText })
    .eq("session_id", input.sessionId)
    .eq("phase", session.phase)
    .eq("version", input.version);

  if (shouldEscalate(newRejectionCount)) {
    // Escalation. rejection_count was already advanced by the CAS above;
    // only update phase_status here.
    await admin.from("sessions").update({ phase_status: "escalated" }).eq("id", input.sessionId);

    // Send EM escalation DM
    const slackInstall = await loadSlackInstallation(admin, session.workspace_id);
    const botToken = slackInstall ? decryptSecretValue(slackInstall.bot_token_encrypted) : null;
    const secrets = await loadPipelineSecrets(admin, session.workspace_id);

    if (botToken && secrets.emSlackUserId) {
      // Escalation state is already persisted. Failing to deliver the EM DM
      // here is recoverable — the dashboard still shows the escalated
      // state, and an operator can re-run the DM manually. Log but do not
      // roll back; returning an error to the reviewer's modal would imply
      // their click failed, which it didn't.
      try {
        const dmChannelId = await openSlackDm({
          botToken,
          userId: secrets.emSlackUserId,
        });
        const latestArtifact = await loadLatestArtifact(admin, session.id, session.phase);
        let specTitle = session.title;
        if (latestArtifact) {
          const raw = latestArtifact.artifact_json;
          if (typeof raw === "string") {
            const parsed = markdownToSpec(raw);
            // Only use the parsed title if it looks like a real spec title,
            // not a phase label from a manual stub (e.g. "Design", "Review").
            if (parsed.title && parsed.problem_statement) {
              specTitle = parsed.title;
            }
          } else {
            specTitle = (raw as unknown as ProductSpec)?.title ?? specTitle;
          }
        }

        await postSlackMessage({
          blocks: formatEscalationDmBlocks({
            channelId: session.slack_channel_id ?? "",
            linearUrl: session.linear_issue_url,
            rejectionCount: newRejectionCount,
            specTitle,
            threadTs: session.slack_thread_ts ?? "",
          }),
          botToken,
          channel: dmChannelId,
          text: `Spec escalation: ${specTitle} has been rejected ${newRejectionCount} times.`,
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
  // a wedged state the UI cannot recover from. Leaving phase_status at
  // 'awaiting_review' lets the reviewer click Submit Feedback again.
  const wallieMember = await loadWallieSystemMember(admin, session.workspace_id);

  const { error: enqueueError } = await admin.from("agent_jobs").insert({
    dedupe_key: session.linear_issue_id
      ? `pipeline:${session.linear_issue_id}:active`
      : `pipeline:session:${session.id}:active`,
    issue_id: session.issue_id ?? undefined,
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

  // Retry is now durably queued. Flip state.
  await admin.from("sessions").update({ phase_status: "rejected" }).eq("id", input.sessionId);

  return { escalated: false, success: true };
}

// --- Data access helpers ---

async function loadSessionByIssueId(
  admin: AdminClient,
  issueId: string,
): Promise<SessionRow | null> {
  const { data, error } = await admin
    .from("sessions")
    .select("*")
    .eq("issue_id", issueId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

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

async function loadPipelineSecrets(
  admin: AdminClient,
  workspaceId: string,
): Promise<{
  anthropicApiKey: string | null;
  emSlackUserId: string | null;
}> {
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("key, encrypted_value")
    .eq("workspace_id", workspaceId)
    .in("key", ["ANTHROPIC_API_KEY", "EM_SLACK_USER_ID"]);

  if (error) throw error;

  const secrets: Record<string, string> = {};
  for (const row of data ?? []) {
    secrets[row.key] = decryptSecretValue(row.encrypted_value);
  }

  return {
    anthropicApiKey: secrets.ANTHROPIC_API_KEY ?? null,
    emSlackUserId: secrets.EM_SLACK_USER_ID ?? null,
  };
}

async function loadLatestArtifact(
  admin: AdminClient,
  sessionId: string,
  phase: SessionRow["phase"],
): Promise<Tables<"session_artifacts"> | null> {
  const { data, error } = await admin
    .from("session_artifacts")
    .select("*")
    .eq("session_id", sessionId)
    .eq("phase", phase)
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
    artifactJson: Record<string, unknown> | string;
    feedbackText: string | null;
    phase: SessionRow["phase"];
    sessionId: string;
    version: number;
    workspaceId: string;
  },
): Promise<void> {
  const { error } = await admin.from("session_artifacts").insert({
    artifact_json:
      typeof input.artifactJson === "string"
        ? input.artifactJson
        : JSON.parse(JSON.stringify(input.artifactJson)),
    feedback_text: input.feedbackText,
    phase: input.phase,
    session_id: input.sessionId,
    version: input.version,
    workspace_id: input.workspaceId,
  });

  if (error) throw error;
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

async function markPipelineJobError(
  admin: AdminClient,
  job: Tables<"agent_jobs">,
  errorMessage: string,
): Promise<void> {
  await admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      last_error: errorMessage,
      status: "error",
    })
    .eq("id", job.id);
}
