import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { PipelinePhaseActionResult } from "@/lib/pipeline/processor";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { formatVercelSandboxError, isVercelSandboxApiError } from "@/lib/vercel-sandbox/errors";
import { resolveQueuedRunConfig } from "@/lib/wallie/service";
import { wakeWorker } from "@/lib/worker/wake";

type AdminClient = SupabaseClient<Database>;

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

export async function followUpSessionCommand(input: {
  admin?: AdminClient;
  expectedArtifactId: string;
  expectedStageId: string;
  expectedWorkspaceId: string;
  factoryId: string;
  feedbackText: string;
  feedbackSubmission?: {
    requestId: string;
    expectedReviewRevision: number;
    selectedThreadIds: string[];
  };
  requestedByMemberId: string | null;
  sessionId: string;
  version: number;
}): Promise<PipelinePhaseActionResult> {
  const admin = input.admin ?? createSupabaseAdminClient();

  let hasReceipt = false;
  if (input.feedbackSubmission) {
    if (!input.requestedByMemberId) {
      return {
        error: "Active human workspace membership is required.",
        errorCode: "42501",
        success: false,
      };
    }
    // Match the database request namespace so retries and conflicts both reach
    // the authoritative receipt check even when configuration has changed.
    const { data: receipt, error: receiptError } = await admin
      .from("artifact_feedback_batches")
      .select("id")
      .eq("workspace_id", input.expectedWorkspaceId)
      .eq("requested_by_member_id", input.requestedByMemberId)
      .eq("request_id", input.feedbackSubmission.requestId)
      .maybeSingle();
    if (receiptError) return { error: "Could not load the feedback submission.", success: false };
    hasReceipt = Boolean(receipt);
  }

  let runConfig: Awaited<ReturnType<typeof resolveQueuedRunConfig>> | undefined;
  if (!hasReceipt) {
    try {
      runConfig = await resolveQueuedRunConfig(admin, {
        id: input.sessionId,
        workspace_id: input.expectedWorkspaceId,
      });
    } catch (error) {
      return { error: getErrorMessage(error, "Failed to queue Wallie retry."), success: false };
    }
  }

  // One transaction: lock the session, validate workspace/archive/phase/version,
  // record the feedback, enqueue the rerun job + queued run under the session's
  // active dedupe key, and move the session to `rejected`. Any guard failure
  // raises and rolls everything back, so a rejection can no longer leave the
  // session wedged with a bumped rejection count and nothing queued, and a
  // concurrent approval serializes behind the row lock instead of racing the
  // final phase write.
  const argumentsForRejection = {
    p_agent_model_name: runConfig?.modelName,
    p_agent_model_provider: runConfig?.modelProvider,
    p_artifact_version: input.version,
    p_expected_artifact_id: input.expectedArtifactId,
    p_expected_stage_id: input.expectedStageId,
    p_feedback_text: input.feedbackText,
    p_requested_by_member_id: input.requestedByMemberId ?? undefined,
    p_run_type: runConfig?.runType,
    p_session_id: input.sessionId,
    p_workspace_id: input.expectedWorkspaceId,
  };
  const { data, error } = input.feedbackSubmission
    ? await admin.rpc("submit_session_follow_up_once", {
        ...argumentsForRejection,
        p_factory_id: input.factoryId,
        p_request_id: input.feedbackSubmission.requestId,
        p_expected_review_revision: input.feedbackSubmission.expectedReviewRevision,
        p_selected_thread_ids: input.feedbackSubmission.selectedThreadIds,
      })
    : await admin.rpc("reject_session_stage", {
        ...argumentsForRejection,
        p_agent_model_name: runConfig!.modelName,
        p_agent_model_provider: runConfig!.modelProvider,
      });

  if (error) {
    // The RPC raises with the reviewer-facing message for every guard
    // ("Session not found.", "Session is archived.", "Session is not awaiting
    // review.", "Version mismatch: a newer version exists."); surface it as-is.
    return {
      error: error.message,
      ...(input.feedbackSubmission ? { errorCode: error.code } : {}),
      success: false,
    };
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return {
      error: "Rejection raced with another update — please refresh and try again.",
      success: false,
    };
  }

  if (row.job_id) await wakeWorker();
  return {
    jobId: row.job_id,
    ...(input.feedbackSubmission &&
    "feedback_batch_id" in row &&
    typeof row.feedback_batch_id === "string"
      ? { feedbackBatchId: row.feedback_batch_id, revisionRunId: row.run_id }
      : {}),
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
