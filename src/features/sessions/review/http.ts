import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const reviewSessionParamsSchema = z.object({ sessionId: z.string().uuid() });
export const reviewThreadParamsSchema = reviewSessionParamsSchema.extend({
  threadId: z.string().uuid(),
});

export const reviewPageSchema = z
  .object({
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    cursorCreatedAt: z.string().datetime({ offset: true }).optional(),
    cursorId: z.string().uuid().optional(),
  })
  .refine((page) => Boolean(page.cursorCreatedAt) === Boolean(page.cursorId), {
    message: "A review cursor requires both timestamp and id.",
  });

const reviewBodyText = z
  .string()
  .refine((body) => body.trim().length > 0, "Comment cannot be empty.")
  .refine((body) => Array.from(body).length <= 10000, "Comment is too long.");
const sourceText = (maxLength: number) =>
  z.string().refine((text) => Array.from(text).length <= maxLength);

export const createReviewThreadSchema = z
  .object({
    requestId: z.string().uuid(),
    artifactId: z.string().uuid(),
    artifactVersion: z.number().int().positive().max(2147483647),
    anchor: z
      .object({
        coordinateSystem: z.literal("unicode_code_points"),
        start: z.number().int().nonnegative().max(2147483647),
        end: z.number().int().positive().max(2147483647),
        quote: sourceText(10000).refine((text) => text.length > 0),
        prefix: sourceText(128),
        suffix: sourceText(128),
      })
      .strict()
      .refine((anchor) => anchor.end > anchor.start, "Anchor range is invalid."),
    kind: z.enum(["discussion", "blocking"]),
    body: reviewBodyText,
  })
  .strict();

export const replyReviewCommentSchema = z
  .object({ requestId: z.string().uuid(), body: reviewBodyText })
  .strict();
export const editReviewCommentSchema = replyReviewCommentSchema
  .extend({ commentId: z.string().uuid(), expectedRevision: z.number().int().positive() })
  .strict();
export const transitionReviewThreadSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    status: z.enum(["open", "resolved", "superseded"]),
    reason: reviewBodyText,
  })
  .strict();

class ReviewHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function reviewJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/** Do not expose raw database exception text or untrusted request content. */
export function reviewErrorResponse(error: unknown) {
  if (error instanceof ReviewHttpError) {
    return reviewJson({ error: error.message }, error.status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return reviewJson({ error: "Review request is invalid." }, 400);
  }
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  if (code === "40001") {
    return reviewJson({ error: "This review changed. Refresh it before saving again." }, 409);
  }
  if (code === "23505") {
    return reviewJson({ error: "This request id was already used with different content." }, 409);
  }
  if (code === "42501") {
    return reviewJson({ error: "You do not have permission to change this review." }, 403);
  }
  if (["23514", "23503", "22P02"].includes(code ?? "")) {
    return reviewJson({ error: "Review request is invalid." }, 400);
  }
  return reviewJson({ error: "Could not load or save this review." }, 500);
}

export function readReviewPage(request: Request) {
  const query = new URL(request.url).searchParams;
  const page = reviewPageSchema.parse({
    pageSize: query.get("pageSize") ?? undefined,
    cursorCreatedAt: query.get("cursorCreatedAt") ?? undefined,
    cursorId: query.get("cursorId") ?? undefined,
  });
  return {
    pageSize: page.pageSize,
    cursor:
      page.cursorCreatedAt && page.cursorId
        ? { createdAt: page.cursorCreatedAt, id: page.cursorId }
        : undefined,
  };
}

/** Every lookup uses the authenticated RLS client, never the service role. */
export async function loadReviewContext(sessionId: string, write = false) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) throw new ReviewHttpError(401, "Sign in before reviewing artifacts.");

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id, pipeline_id, archived_at, artifact_review_revision")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionError) throw sessionError;
  if (!session) throw new ReviewHttpError(404, "Session not found.");

  const { data: member, error: memberError } = await supabase
    .from("workspace_members")
    .select("id, role")
    .eq("workspace_id", session.workspace_id)
    .eq("user_id", user.id)
    .eq("kind", "human")
    .eq("is_active", true)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) throw new ReviewHttpError(403, "Active workspace membership is required.");
  if (write && session.archived_at) {
    throw new ReviewHttpError(409, "Archived sessions are read-only.");
  }
  return { supabase, session, member };
}

export type ReviewContext = Awaited<ReturnType<typeof loadReviewContext>>;

export async function loadReviewArtifact(context: ReviewContext, artifactId: string) {
  const { data: artifact, error } = await context.supabase
    .from("session_artifacts")
    .select("id, session_id, workspace_id, stage_id, version")
    .eq("id", artifactId)
    .eq("session_id", context.session.id)
    .eq("workspace_id", context.session.workspace_id)
    .maybeSingle();
  if (error) throw error;
  if (!artifact) throw new ReviewHttpError(404, "Artifact not found.");
  return artifact;
}

export async function loadReviewThread(context: ReviewContext, threadId: string) {
  const { data: thread, error } = await context.supabase
    .from("artifact_review_threads")
    .select("*")
    .eq("id", threadId)
    .eq("session_id", context.session.id)
    .eq("workspace_id", context.session.workspace_id)
    .maybeSingle();
  if (error) throw error;
  if (!thread) throw new ReviewHttpError(404, "Review thread not found.");
  return thread;
}

export async function reviewViewer(context: ReviewContext, stageId: string | null) {
  const { supabase, session, member } = context;
  const { data: stage, error } = stageId
    ? await supabase
        .from("pipeline_stages")
        .select("anyone_can_approve, approver_member_ids")
        .eq("id", stageId)
        .eq("workspace_id", session.workspace_id)
        .eq("pipeline_id", session.pipeline_id)
        .maybeSingle()
    : { data: null, error: null };
  if (error) throw error;
  const approvers = stage?.approver_member_ids ?? [];
  return {
    memberId: member.id,
    readOnly: Boolean(session.archived_at),
    canReview: Boolean(
      stage &&
      (stage.anyone_can_approve ||
        (approvers.length > 0
          ? approvers.includes(member.id)
          : member.role === "owner" || member.role === "admin")),
    ),
  };
}

export function requireReviewArtifactVersion(
  artifact: Awaited<ReturnType<typeof loadReviewArtifact>>,
  version: number,
) {
  if (!artifact.stage_id || artifact.version !== version) {
    throw new ReviewHttpError(409, "Artifact identity changed. Choose the artifact again.");
  }
  return artifact.stage_id;
}
