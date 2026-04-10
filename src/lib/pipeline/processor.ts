import "server-only";

import type { Tables } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decryptSecretValue } from "@/lib/secrets/crypto";

import { preScreenIssue } from "./pre-screen";
import { generateProductSpec } from "./product-agent";
import {
  formatEscalationDmBlocks,
  formatPreScreenFailBlocks,
  formatSpecBlocks,
  formatSpecDiffBlocks,
  openSlackDm,
  postSlackMessage,
} from "./slack-format";
import { approvalTimestampField, nextPhase, shouldEscalate } from "./state-machine";
import { PIPELINE_JOB_TYPE, buildPipelineDedupeKey, type ProductSpec } from "./types";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type PipelineIssueRow = Tables<"pipeline_issues">;

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
    // Load pipeline_issue for this job's issue_id
    const pipelineIssue = await loadPipelineIssueByIssueId(admin, job.issue_id);
    if (!pipelineIssue) {
      await markPipelineJobError(admin, job, "No pipeline_issue row found for this job.");
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    // Load the anchor issue row
    const issue = await loadIssue(admin, job.issue_id);
    if (!issue) {
      await markPipelineJobError(admin, job, "Anchor issue row not found.");
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    // Load workspace secrets: ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, EM_SLACK_USER_ID
    const secrets = await loadPipelineSecrets(admin, job.workspace_id);
    if (!secrets.anthropicApiKey) {
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

    // Atomic CAS claim: only proceed if the pipeline_issue is in a non-terminal state.
    // This prevents a second worker from regenerating a spec that has already been
    // approved or escalated. Terminal states (approved, escalated) are rejected.
    // Uses a single UPDATE ... WHERE status IN (...) so the check and set are atomic.
    const { data: claimed, error: claimError } = await admin
      .from("pipeline_issues")
      .update({ phase_status: "agent_generating" })
      .eq("id", pipelineIssue.id)
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

    // Run pre-screen
    const preScreenResult = await preScreenIssue({
      anthropicApiKey: secrets.anthropicApiKey,
      issueDescription: issue.description_md,
      issueTitle: issue.title,
    });

    if (!preScreenResult.pass) {
      // Post pre-screen fail to Slack
      if (pipelineIssue.slack_channel_id) {
        await postSlackMessage({
          blocks: formatPreScreenFailBlocks(preScreenResult.reason),
          botToken,
          channel: pipelineIssue.slack_channel_id,
          text: `Issue needs more detail: ${preScreenResult.reason}`,
          threadTs: pipelineIssue.slack_thread_ts ?? undefined,
        });
      }

      await updatePipelineIssueStatus(admin, pipelineIssue.id, "rejected");
      await markPipelineJobSuccess(admin, job);
      return { jobId: job.id, processed: true, result: "success", runId: null };
    }

    // Load previous spec if this is a revision
    let previousSpec: ProductSpec | null = null;
    let feedbackText: string | null = null;
    if (pipelineIssue.current_artifact_version > 0) {
      const lastArtifact = await loadLatestArtifact(admin, pipelineIssue.id, pipelineIssue.phase);
      if (lastArtifact) {
        previousSpec = lastArtifact.artifact_json as unknown as ProductSpec;
        feedbackText = lastArtifact.feedback_text;
      }
    }

    // Generate spec
    let spec: ProductSpec;
    try {
      spec = await generateProductSpec({
        anthropicApiKey: secrets.anthropicApiKey,
        feedback: feedbackText,
        issueDescription: issue.description_md,
        issueTitle: issue.title,
        previousSpec,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Spec generation failed";

      // Post raw error to Slack with warning
      if (pipelineIssue.slack_channel_id) {
        await postSlackMessage({
          blocks: [
            {
              text: {
                text: `:warning: Spec generation failed: ${message}`,
                type: "mrkdwn",
              },
              type: "section",
            },
          ],
          botToken,
          channel: pipelineIssue.slack_channel_id,
          text: `Spec generation failed: ${message}`,
          threadTs: pipelineIssue.slack_thread_ts ?? undefined,
        });
      }

      await updatePipelineIssueStatus(admin, pipelineIssue.id, "rejected");
      await markPipelineJobError(admin, job, message);
      return { jobId: job.id, processed: true, result: "error", runId: null };
    }

    // Save artifact
    const newVersion = pipelineIssue.current_artifact_version + 1;
    await insertArtifact(admin, {
      artifactJson: spec,
      feedbackText: null,
      phase: pipelineIssue.phase,
      pipelineIssueId: pipelineIssue.id,
      version: newVersion,
    });

    // Update pipeline_issue version and status
    await admin
      .from("pipeline_issues")
      .update({
        current_artifact_version: newVersion,
        phase_status: "awaiting_review",
      })
      .eq("id", pipelineIssue.id);

    // Store spec in issue.plan_md for the anchor row
    await admin
      .from("issues")
      .update({ plan_md: JSON.stringify(spec, null, 2) })
      .eq("id", issue.id);

    // Post to Slack
    if (pipelineIssue.slack_channel_id) {
      const blocks = formatSpecBlocks({
        linearUrl: pipelineIssue.linear_issue_url,
        pipelineIssueId: pipelineIssue.id,
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
        channel: pipelineIssue.slack_channel_id,
        text: `Product spec for "${spec.title}" (v${newVersion})`,
        threadTs: pipelineIssue.slack_thread_ts ?? undefined,
      });
    }

    await markPipelineJobSuccess(admin, job);
    return { jobId: job.id, processed: true, result: "success", runId: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pipeline job failed";
    await markPipelineJobError(admin, job, message);
    return { jobId: job.id, processed: true, result: "error", runId: null };
  }
}

export async function handleApproval(input: {
  admin?: AdminClient;
  expectedWorkspaceId: string;
  pipelineIssueId: string;
  version: number;
}): Promise<{ error?: string; success: boolean }> {
  const admin = input.admin ?? createSupabaseAdminClient();

  // CAS: only approve if version matches, status is awaiting_review, AND the
  // pipeline_issue belongs to the workspace of the Slack team that sent the
  // interaction. expectedWorkspaceId is resolved from the signed Slack team_id
  // in the interactions route, so this prevents one workspace from approving
  // another workspace's pipeline_issue by guessing its UUID.
  const { data, error } = await admin
    .from("pipeline_issues")
    .update({
      phase_status: "approved",
    })
    .eq("id", input.pipelineIssueId)
    .eq("workspace_id", input.expectedWorkspaceId)
    .eq("current_artifact_version", input.version)
    .eq("phase_status", "awaiting_review")
    .select("id, phase, workspace_id, slack_channel_id, slack_thread_ts, linear_issue_url")
    .maybeSingle();

  if (error) {
    return { error: error.message, success: false };
  }

  if (!data) {
    return { error: "Approval failed: spec version is stale or already reviewed.", success: false };
  }

  // Set approval timestamp
  const tsField = approvalTimestampField(data.phase);
  if (tsField) {
    await admin
      .from("pipeline_issues")
      .update({ [tsField]: new Date().toISOString() })
      .eq("id", input.pipelineIssueId);
  }

  // Advance to next phase (if any)
  const next = nextPhase(data.phase);
  if (next === "shipped") {
    // Terminal transition: engineering approval → shipped
    await admin
      .from("pipeline_issues")
      .update({
        phase: "shipped",
        phase_status: "approved",
      })
      .eq("id", input.pipelineIssueId);
  } else if (next) {
    // Intermediate transition: move to next phase and kick off generation
    await admin
      .from("pipeline_issues")
      .update({
        phase: next,
        phase_status: "agent_generating",
        rejection_count: 0,
      })
      .eq("id", input.pipelineIssueId);

    // TODO: Enqueue next phase agent job (design agent, engineering agent)
    // For Phase 1, only product phase is implemented
  }

  return { success: true };
}

export async function handleRejection(input: {
  admin?: AdminClient;
  expectedWorkspaceId: string;
  feedbackText: string;
  pipelineIssueId: string;
  version: number;
}): Promise<{ escalated: boolean; error?: string; success: boolean }> {
  const admin = input.admin ?? createSupabaseAdminClient();

  // Load current state
  const pipelineIssue = await loadPipelineIssueById(admin, input.pipelineIssueId);
  if (!pipelineIssue) {
    return { escalated: false, error: "Pipeline issue not found.", success: false };
  }

  // Cross-workspace guard: the Slack team that sent the feedback modal must
  // own this pipeline_issue. Checked here (in addition to the CAS below) so
  // the load-then-branch logic never leaks rows across tenants.
  if (pipelineIssue.workspace_id !== input.expectedWorkspaceId) {
    return { escalated: false, error: "Pipeline issue not found.", success: false };
  }

  if (pipelineIssue.phase_status !== "awaiting_review") {
    return { escalated: false, error: "Issue is not awaiting review.", success: false };
  }

  if (pipelineIssue.current_artifact_version !== input.version) {
    return { escalated: false, error: "Version mismatch: a newer version exists.", success: false };
  }

  const newRejectionCount = pipelineIssue.rejection_count + 1;

  // Atomic CAS on rejection_count: only the first rejection that observed the
  // current count can advance it. A concurrent second rejection (e.g. Submit
  // Feedback double-click) sees rows-updated=0 and exits without double-counting.
  // This also implicitly re-checks phase_status, version, and workspace_id.
  const { data: claimedRejection, error: claimRejectionError } = await admin
    .from("pipeline_issues")
    .update({ rejection_count: newRejectionCount })
    .eq("id", input.pipelineIssueId)
    .eq("workspace_id", input.expectedWorkspaceId)
    .eq("rejection_count", pipelineIssue.rejection_count)
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
    .from("pipeline_artifacts")
    .update({ feedback_text: input.feedbackText })
    .eq("pipeline_issue_id", input.pipelineIssueId)
    .eq("phase", pipelineIssue.phase)
    .eq("version", input.version);

  if (shouldEscalate(newRejectionCount)) {
    // Escalation. rejection_count was already advanced by the CAS above; only
    // update phase_status here.
    await admin
      .from("pipeline_issues")
      .update({
        phase_status: "escalated",
      })
      .eq("id", input.pipelineIssueId);

    // Send EM escalation DM
    const slackInstall = await loadSlackInstallation(admin, pipelineIssue.workspace_id);
    const botToken = slackInstall ? decryptSecretValue(slackInstall.bot_token_encrypted) : null;
    const secrets = await loadPipelineSecrets(admin, pipelineIssue.workspace_id);

    if (botToken && secrets.emSlackUserId) {
      const dmChannelId = await openSlackDm({
        botToken,
        userId: secrets.emSlackUserId,
      });
      if (dmChannelId) {
        const latestArtifact = await loadLatestArtifact(
          admin,
          pipelineIssue.id,
          pipelineIssue.phase,
        );
        const specTitle =
          (latestArtifact?.artifact_json as unknown as ProductSpec)?.title ?? "Unknown spec";

        await postSlackMessage({
          blocks: formatEscalationDmBlocks({
            channelId: pipelineIssue.slack_channel_id ?? "",
            linearUrl: pipelineIssue.linear_issue_url,
            rejectionCount: newRejectionCount,
            specTitle,
            threadTs: pipelineIssue.slack_thread_ts ?? "",
          }),
          botToken,
          channel: dmChannelId,
          text: `Spec escalation: ${specTitle} has been rejected ${newRejectionCount} times.`,
        });
      }
    }

    return { escalated: true, success: true };
  }

  // Not escalated: mark as rejected and enqueue a new generation job. rejection_count
  // was already advanced by the CAS above; only update phase_status here.
  await admin
    .from("pipeline_issues")
    .update({
      phase_status: "rejected",
    })
    .eq("id", input.pipelineIssueId);

  // Enqueue a new pipeline job to regenerate with feedback.
  // Use the same dedupe_key as the original enqueue so the partial unique index on
  // agent_jobs(workspace_id, dedupe_key) where status in ('queued','running') prevents
  // a double-click on Submit Feedback from enqueueing two retry jobs.
  const wallieMember = await loadWallieSystemMember(admin, pipelineIssue.workspace_id);

  const { error: enqueueError } = await admin.from("agent_jobs").insert({
    dedupe_key: pipelineIssue.linear_issue_id
      ? buildPipelineDedupeKey(pipelineIssue.linear_issue_id)
      : null,
    issue_id: pipelineIssue.issue_id,
    job_type: PIPELINE_JOB_TYPE,
    requested_by_member_id: wallieMember?.id ?? null,
    trigger_type: "slack_mention",
    workspace_id: pipelineIssue.workspace_id,
  });

  // 23505 = unique_violation: a concurrent retry already exists. Silent success.
  if (enqueueError && enqueueError.code !== "23505") {
    return { escalated: false, error: enqueueError.message, success: false };
  }

  return { escalated: false, success: true };
}

// --- Data access helpers ---

async function loadPipelineIssueByIssueId(
  admin: AdminClient,
  issueId: string,
): Promise<PipelineIssueRow | null> {
  const { data, error } = await admin
    .from("pipeline_issues")
    .select("*")
    .eq("issue_id", issueId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function loadPipelineIssueById(
  admin: AdminClient,
  id: string,
): Promise<PipelineIssueRow | null> {
  const { data, error } = await admin
    .from("pipeline_issues")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function loadIssue(
  admin: AdminClient,
  issueId: string,
): Promise<Pick<Tables<"issues">, "description_md" | "id" | "title"> | null> {
  const { data, error } = await admin
    .from("issues")
    .select("id, title, description_md")
    .eq("id", issueId)
    .maybeSingle();

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
  pipelineIssueId: string,
  phase: PipelineIssueRow["phase"],
): Promise<Tables<"pipeline_artifacts"> | null> {
  const { data, error } = await admin
    .from("pipeline_artifacts")
    .select("*")
    .eq("pipeline_issue_id", pipelineIssueId)
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

async function updatePipelineIssueStatus(
  admin: AdminClient,
  pipelineIssueId: string,
  status: string,
): Promise<void> {
  const { error } = await admin
    .from("pipeline_issues")
    .update({ phase_status: status as PipelineIssueRow["phase_status"] })
    .eq("id", pipelineIssueId);

  if (error) throw error;
}

async function insertArtifact(
  admin: AdminClient,
  input: {
    artifactJson: ProductSpec;
    feedbackText: string | null;
    phase: PipelineIssueRow["phase"];
    pipelineIssueId: string;
    version: number;
  },
): Promise<void> {
  const { error } = await admin.from("pipeline_artifacts").insert({
    artifact_json: JSON.parse(JSON.stringify(input.artifactJson)),
    feedback_text: input.feedbackText,
    phase: input.phase,
    pipeline_issue_id: input.pipelineIssueId,
    version: input.version,
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
