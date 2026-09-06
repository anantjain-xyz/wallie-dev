import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { serializeSessionReviewData, type SessionDetailRpcPayload } from "./review-data";

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
  if (detail.error) throw detail.error;
  if (attachments.error) throw attachments.error;
  const payload = detail.data as SessionDetailRpcPayload | null;
  if (!payload?.session || payload.session.id !== sessionId)
    throw new Error("Session unavailable.");
  const capabilities = await response.json();
  if (
    !response.ok ||
    typeof capabilities?.canApprove !== "boolean" ||
    typeof capabilities?.hasFailedRun !== "boolean"
  ) {
    throw new Error("Could not refresh review capabilities.");
  }
  return {
    review: serializeSessionReviewData(payload, attachments.data ?? []),
    canApprove: capabilities.canApprove as boolean,
    hasFailedRun: capabilities.hasFailedRun as boolean,
    failedStageSlug:
      typeof capabilities.failedStageSlug === "string" ? capabilities.failedStageSlug : null,
  };
}
