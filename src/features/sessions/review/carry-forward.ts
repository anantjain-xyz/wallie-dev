import "server-only";

import type { ReviewContext, loadReviewArtifact } from "./http";
import { mapRevisionAnchor, type AnchorMapping } from "./revision";
import type { ReviewCursor } from "./types";

export async function listCarriedReviewThreads(
  context: ReviewContext,
  artifact: Awaited<ReturnType<typeof loadReviewArtifact>>,
  page: { pageSize: number; cursor?: ReviewCursor },
) {
  const query = () =>
    context.supabase
      .from("artifact_review_threads")
      .select("*")
      .eq("workspace_id", context.session.workspace_id)
      .eq("session_id", context.session.id)
      .eq("stage_id", artifact.stage_id!)
      .or(
        `artifact_id.eq.${artifact.id},and(status.eq.open,artifact_version.lt.${artifact.version})`,
      );
  let rowsQuery = query()
    .order("created_at")
    .order("id")
    .limit(page.pageSize + 1);
  if (page.cursor)
    rowsQuery = rowsQuery.or(
      `created_at.gt.${page.cursor.createdAt},and(created_at.eq.${page.cursor.createdAt},id.gt.${page.cursor.id})`,
    );
  const { data, error } = await rowsQuery;
  if (error) throw error;
  const items = (data ?? []).slice(0, page.pageSize);
  const sourceIds = [...new Set([artifact.id, ...items.map((thread) => thread.artifact_id)])];
  const { data: sources, error: sourceError } = await context.supabase
    .from("session_artifacts")
    .select("id, artifact_json")
    .eq("workspace_id", context.session.workspace_id)
    .eq("session_id", context.session.id)
    .eq("stage_id", artifact.stage_id!)
    .in("id", sourceIds);
  if (sourceError) throw sourceError;
  const sourceById = new Map(sources?.map((source) => [source.id, source.artifact_json]));
  const target = sourceById.get(artifact.id);
  const mappings: Record<string, AnchorMapping> = {};
  for (const thread of items) {
    const source = sourceById.get(thread.artifact_id);
    mappings[thread.id] =
      typeof source === "string" && typeof target === "string"
        ? mapRevisionAnchor(source, target, thread.anchor)
        : { status: "outdated", reason: "Original Markdown source is unavailable." };
  }
  const last = items.at(-1);
  return {
    items,
    mappings,
    nextCursor:
      data && data.length > page.pageSize && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
  };
}
