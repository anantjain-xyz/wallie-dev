import "server-only";

import type { ReviewContext } from "./http";

/** Read only the exact artifact/thread identities already authorized by RLS. */
export async function loadSubmittedThreadRevisions(
  context: ReviewContext,
  artifactId: string,
  threadIds: string[],
): Promise<Record<string, number>> {
  const revisions: Record<string, number> = {};
  if (!threadIds.length) return revisions;
  const { data, error } = await context.supabase
    .from("artifact_feedback_batch_threads")
    .select("thread_id, thread_revision")
    .eq("workspace_id", context.session.workspace_id)
    .eq("session_id", context.session.id)
    .eq("artifact_id", artifactId)
    .in("thread_id", threadIds);
  if (error) throw error;
  for (const row of data ?? []) {
    revisions[row.thread_id] = Math.max(revisions[row.thread_id] ?? 0, row.thread_revision);
  }
  return revisions;
}
