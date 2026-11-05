import { z } from "zod";

import { loadSubmittedThreadRevisions } from "@/features/sessions/review/submitted";
import { listCarriedReviewThreads } from "@/features/sessions/review/carry-forward";

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
    const carryForward = new URL(request.url).searchParams.get("includeUnresolved") === "true";
    const { supabase, session } = context;
    const reviewRevision = session.artifact_review_revision;
    if (!Number.isSafeInteger(reviewRevision) || reviewRevision < 0)
      throw new Error("The review revision cannot be represented safely.");
    const countQuery = () => {
      let query = supabase
        .from("artifact_review_threads")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id);
      query =
        carryForward && artifact.stage_id
          ? query
              .eq("stage_id", artifact.stage_id)
              .or(
                `artifact_id.eq.${artifact.id},and(status.eq.open,artifact_version.lt.${artifact.version})`,
              )
          : query.eq("artifact_id", artifact.id);
      return query;
    };
    const [threads, viewer, total, open, blocking] = await Promise.all([
      carryForward && artifact.stage_id
        ? listCarriedReviewThreads(context, artifact, page)
        : listArtifactReviewThreads(supabase, {
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
    const sourceIds = carryForward
      ? [...new Set(threads.items.map((thread) => thread.artifact_id))]
      : [artifact.id];
    const submittedThreadRevisions = Object.assign(
      {},
      ...(await Promise.all(
        sourceIds.map((sourceId) =>
          loadSubmittedThreadRevisions(
            context,
            sourceId,
            threads.items
              .filter((thread) => !carryForward || thread.artifact_id === sourceId)
              .map((thread) => thread.id),
          ),
        ),
      )),
    );
    return reviewJson({
      // Captured by loadReviewContext before thread reads. A concurrent change
      // invalidates this token instead of pairing old content with a new token.
      reviewRevision,
      submittedThreadRevisions,
      threads: threads.items,
      mappings: "mappings" in threads ? threads.mappings : undefined,
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
