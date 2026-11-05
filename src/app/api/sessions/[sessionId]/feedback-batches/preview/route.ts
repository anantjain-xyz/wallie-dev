import { z } from "zod";
import {
  loadReviewArtifact,
  loadReviewContext,
  requireReviewArtifactVersion,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";

export const preferredRegion = "home";
const schema = z
  .object({
    artifactId: z.string().uuid(),
    version: z.number().int().positive(),
    expectedReviewRevision: z.number().int().nonnegative(),
    selectedThreadIds: z.array(z.string().uuid()).max(20),
    note: z.string(),
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const input = schema.parse(await request.json());
    const context = await loadReviewContext(sessionId);
    const artifact = await loadReviewArtifact(context, input.artifactId);
    const stageId = requireReviewArtifactVersion(artifact, input.version);
    if (input.expectedReviewRevision !== context.session.artifact_review_revision)
      return reviewJson({ error: "This review changed. Refresh comments before previewing." }, 409);
    const ids = [...new Set(input.selectedThreadIds)].sort();
    const note = input.note.trim();
    if (
      ids.length !== input.selectedThreadIds.length ||
      Array.from(note).length > 4000 ||
      (!ids.length && !note)
    )
      return reviewJson(
        { error: "Select up to 20 unique threads or add a note within 4000 characters." },
        400,
      );
    const { supabase, session } = context;
    const threads = ids.length
      ? await supabase
          .from("artifact_review_threads")
          .select("*")
          .eq("workspace_id", session.workspace_id)
          .eq("session_id", session.id)
          .eq("stage_id", stageId)
          .eq("status", "open")
          .in("id", ids)
          .order("id")
      : { data: [], error: null };
    if (threads.error) throw threads.error;
    if (
      threads.data?.length !== ids.length ||
      threads.data.some(
        (thread) =>
          thread.artifact_id !== artifact.id && thread.artifact_version >= artifact.version,
      )
    )
      return reviewJson(
        {
          error:
            "Selected threads must belong to this artifact or an earlier version of this stage.",
        },
        400,
      );
    const comments = ids.length
      ? await supabase
          .from("artifact_review_comments")
          .select("id, revision, author_label, body, created_at, thread_id")
          .eq("workspace_id", session.workspace_id)
          .in("thread_id", ids)
          .order("created_at")
          .order("id")
          .limit(101)
      : { data: [], error: null };
    if (comments.error) throw comments.error;
    if ((comments.data?.length ?? 0) > 100)
      return reviewJson(
        { error: "Selected threads contain more than 100 comments. Select fewer threads." },
        400,
      );
    const parts = note ? [`Whole-stage feedback:\n${note}`] : [];
    for (const thread of threads.data) {
      const anchor = thread.anchor;
      if (
        !anchor ||
        typeof anchor !== "object" ||
        Array.isArray(anchor) ||
        typeof anchor.quote !== "string"
      )
        throw new Error("Invalid stored anchor.");
      const rows = (comments.data ?? []).filter((comment) => comment.thread_id === thread.id);
      if (!rows.length) throw new Error("Comment snapshot is unavailable.");
      parts.push(
        `Inline thread ${thread.id} (${thread.kind}, revision ${thread.revision})\nOriginal artifact ${thread.artifact_id} version ${thread.artifact_version}\nQuoted artifact text:\n${anchor.quote}${rows.map((comment) => `\n\nComment ${comment.id} (revision ${comment.revision}) by ${comment.author_label}:\n${comment.body}`).join("")}`,
      );
    }
    const renderedFeedback = parts.join("\n\n");
    if (Array.from(renderedFeedback).length > 40000)
      return reviewJson(
        {
          error:
            "Combined feedback exceeds 40000 characters. Select fewer threads or shorten the note.",
        },
        400,
      );
    return reviewJson({ renderedFeedback, reviewRevision: input.expectedReviewRevision });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
