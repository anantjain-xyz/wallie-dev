import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";
import { evaluateSessionPrReadiness } from "@/lib/pipeline/pr-readiness";

export const preferredRegion = "home";

/** Capture the token before the count: concurrent changes invalidate approval. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const { supabase, session } = await loadReviewContext(sessionId);
    const reviewRevision = session.artifact_review_revision;
    if (!Number.isSafeInteger(reviewRevision) || reviewRevision < 0)
      throw new Error("Review revision cannot be represented safely.");
    // Readiness is server-owned and derived only from stored observations; the
    // reviewer sees it, and approval still re-validates it under the lock.
    const [countResult, delivery] = await Promise.all([
      supabase
        .from("artifact_review_threads")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .eq("kind", "blocking")
        .eq("status", "open"),
      evaluateSessionPrReadiness(supabase, session.id, { record: false }).catch(() => null),
    ]);
    const { count, error } = countResult;
    if (error || count === null) throw error ?? new Error("Review count unavailable.");
    return reviewJson({
      reviewRevision,
      blockingCount: count,
      ...(delivery
        ? {
            delivery: {
              required:
                delivery.finalStage &&
                delivery.policy.requirements.deliveryMode === "code" &&
                delivery.policy.requirements.requireArtifactApprovalForDelivery,
              state: delivery.evaluation.state,
              blockers: delivery.evaluation.blockers,
            },
          }
        : {}),
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
