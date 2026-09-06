import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { RecoveryDeferredError } from "@/features/wallie/realtime-recovery";
import { serializeSessionReviewData, type SessionDetailRpcPayload } from "./review-data";

/** An authoritative access miss must leave the stale detail page. */
export class SessionRecoveryAccessError extends Error {}

/** Reuse the same authenticated RPCs as the server page, with observable errors. */
export async function loadSessionRecoverySnapshot({
  supabase,
  workspaceSlug,
  sessionNumber,
  sessionId,
  signal,
}: {
  supabase: SupabaseClient<Database>;
  workspaceSlug: string;
  sessionNumber: number;
  sessionId: string;
  signal: AbortSignal;
}) {
  const params = { target_session_number: sessionNumber, target_workspace_slug: workspaceSlug };
  const [detail, attachments, response] = await Promise.all([
    supabase.rpc("get_session_detail_page", params).abortSignal(signal),
    supabase.rpc("get_session_prompt_attachments", params).abortSignal(signal),
    fetch(`/api/sessions/${sessionId}/review-capabilities`, { signal, cache: "no-store" }),
  ]);
  if ([401, 403, 404].includes(response.status))
    throw new SessionRecoveryAccessError("Session unavailable.");
  if (detail.error) throw detail.error;
  const payload = detail.data as SessionDetailRpcPayload | null;
  if (!payload || "access" in payload) throw new SessionRecoveryAccessError("Session unavailable.");
  if (!payload.session || payload.session.id !== sessionId) throw new Error("Session unavailable.");
  if (attachments.error) throw attachments.error;
  const capabilities = await response.json();
  if (
    !response.ok ||
    typeof capabilities?.stageId !== "string" ||
    typeof capabilities?.canApprove !== "boolean" ||
    typeof capabilities?.hasFailedRun !== "boolean"
  ) {
    throw new Error("Could not refresh review capabilities.");
  }
  // Independent authenticated reads can straddle a stage advancement. Retry
  // the whole snapshot rather than granting stage B's permissions to stage A.
  if (capabilities.stageId !== payload.session.currentStageId)
    throw new RecoveryDeferredError("Session stage changed during recovery.");
  return {
    review: serializeSessionReviewData(payload, attachments.data ?? []),
    canApprove: capabilities.canApprove as boolean,
    hasFailedRun: capabilities.hasFailedRun as boolean,
    failedStageSlug:
      typeof capabilities.failedStageSlug === "string" ? capabilities.failedStageSlug : null,
  };
}
