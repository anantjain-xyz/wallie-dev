import { z } from "zod";

import {
  createReviewThreadSchema,
  loadReviewArtifact,
  loadReviewContext,
  readReviewPage,
  requireReviewArtifactVersion,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
  reviewViewer,
} from "@/features/sessions/review/http";
import {
  createArtifactReviewThread,
  listArtifactReviewThreads,
} from "@/features/sessions/review/repository";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const artifactId = z.string().uuid().parse(new URL(request.url).searchParams.get("artifactId"));
    const page = readReviewPage(request);
    const context = await loadReviewContext(sessionId);
    const artifact = await loadReviewArtifact(context, artifactId);
    const { supabase, session } = context;
    const countQuery = () =>
      supabase
        .from("artifact_review_threads")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .eq("artifact_id", artifact.id);
    const [threads, viewer, total, open, blocking] = await Promise.all([
      listArtifactReviewThreads(supabase, {
        workspaceId: session.workspace_id,
        artifactId: artifact.id,
        ...page,
      }),
      reviewViewer(context, artifact.stage_id),
      countQuery(),
      countQuery().eq("status", "open"),
      countQuery().eq("status", "open").eq("kind", "blocking"),
    ]);
    for (const result of [total, open, blocking]) {
      if (result.error) throw result.error;
    }
    return reviewJson({
      threads: threads.items,
      nextCursor: threads.nextCursor,
      counts: { total: total.count ?? 0, open: open.count ?? 0, blocking: blocking.count ?? 0 },
      viewer,
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const body = createReviewThreadSchema.parse(await request.json());
    const context = await loadReviewContext(sessionId, true);
    const artifact = await loadReviewArtifact(context, body.artifactId);
    const stageId = requireReviewArtifactVersion(artifact, body.artifactVersion);
    const thread = await createArtifactReviewThread(context.supabase, {
      ...body,
      workspaceId: context.session.workspace_id,
      sessionId: context.session.id,
      stageId,
    });
    return reviewJson({ thread });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
