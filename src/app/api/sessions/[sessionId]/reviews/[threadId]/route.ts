import {
  loadReviewContext,
  loadReviewThread,
  reviewErrorResponse,
  reviewJson,
  reviewThreadParamsSchema,
  transitionReviewThreadSchema,
} from "@/features/sessions/review/http";
import { transitionArtifactReviewThread } from "@/features/sessions/review/repository";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string; threadId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { sessionId, threadId } = reviewThreadParamsSchema.parse(await params);
    const context = await loadReviewContext(sessionId);
    const thread = await loadReviewThread(context, threadId);
    return reviewJson({ thread });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const { sessionId, threadId } = reviewThreadParamsSchema.parse(await params);
    const body = transitionReviewThreadSchema.parse(await request.json());
    const context = await loadReviewContext(sessionId, true);
    await loadReviewThread(context, threadId);
    const thread = await transitionArtifactReviewThread(context.supabase, {
      ...body,
      workspaceId: context.session.workspace_id,
      threadId,
    });
    return reviewJson({ thread });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
