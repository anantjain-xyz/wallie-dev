import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";
import { reviewEvidenceDeliverySchema } from "@/features/sessions/detail/review-evidence-contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadSessionPrReadinessDetails } from "@/lib/pipeline/pr-readiness";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };

/** Read-only delivery evidence for the authenticated session reviewer. */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const { session } = await loadReviewContext(sessionId);
    const details = await loadSessionPrReadinessDetails(createSupabaseAdminClient(), session.id);
    return reviewJson({
      delivery: details ? reviewEvidenceDeliverySchema.parse(details) : null,
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
