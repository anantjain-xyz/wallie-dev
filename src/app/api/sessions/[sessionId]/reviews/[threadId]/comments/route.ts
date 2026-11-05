import { z } from "zod";

import {
  editReviewCommentSchema,
  loadReviewContext,
  loadReviewThread,
  readReviewPage,
  replyReviewCommentSchema,
  reviewErrorResponse,
  reviewJson,
  reviewThreadParamsSchema,
} from "@/features/sessions/review/http";
import {
  listArtifactReviewComments,
  writeArtifactReviewComment,
} from "@/features/sessions/review/repository";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string; threadId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { sessionId, threadId } = reviewThreadParamsSchema.parse(await params);
    const commentId = z
      .string()
      .uuid()
      .optional()
      .parse(new URL(request.url).searchParams.get("commentId") ?? undefined);
    const page = readReviewPage(request);
    const context = await loadReviewContext(sessionId);
    await loadReviewThread(context, threadId);
    if (commentId) {
      const { data: comment, error } = await context.supabase
        .from("artifact_review_comments")
        .select("*")
        .eq("id", commentId)
        .eq("thread_id", threadId)
        .eq("workspace_id", context.session.workspace_id)
        .maybeSingle();
      if (error) throw error;
      if (!comment) return reviewJson({ error: "Review comment not found." }, 404);
      return reviewJson({ comments: [comment], nextCursor: null });
    }
    const comments = await listArtifactReviewComments(context.supabase, {
      workspaceId: context.session.workspace_id,
      threadId,
      ...page,
    });
    return reviewJson({ comments: comments.items, nextCursor: comments.nextCursor });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { sessionId, threadId } = reviewThreadParamsSchema.parse(await params);
    const body = replyReviewCommentSchema.parse(await request.json());
    const context = await loadReviewContext(sessionId, true);
    await loadReviewThread(context, threadId);
    const comment = await writeArtifactReviewComment(context.supabase, {
      ...body,
      workspaceId: context.session.workspace_id,
      threadId,
    });
    return reviewJson({ comment });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const { sessionId, threadId } = reviewThreadParamsSchema.parse(await params);
    const body = editReviewCommentSchema.parse(await request.json());
    const context = await loadReviewContext(sessionId, true);
    await loadReviewThread(context, threadId);
    const comment = await writeArtifactReviewComment(context.supabase, {
      ...body,
      workspaceId: context.session.workspace_id,
      threadId,
    });
    return reviewJson({ comment });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
