import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@/lib/supabase/database.types";

/** A submitted revision consumes its immutable batch, never live comment text. */
export async function loadJobFeedback(
  admin: SupabaseClient<Database>,
  job: Pick<Tables<"agent_jobs">, "id" | "session_id" | "workspace_id">,
  stageId: string,
): Promise<string | null> {
  const { data: batch, error: batchError } = await admin
    .from("artifact_feedback_batches")
    .select("rendered_feedback_text")
    .eq("job_id", job.id)
    .eq("session_id", job.session_id)
    .eq("workspace_id", job.workspace_id)
    .maybeSingle();
  if (batchError) throw batchError;
  if (batch) return batch.rendered_feedback_text;

  // Existing whole-stage callers keep their established feedback record.
  const { data, error } = await admin
    .from("session_artifact_feedback")
    .select("feedback_text")
    .eq("session_id", job.session_id)
    .eq("stage_id", stageId)
    .order("target_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.feedback_text ?? null;
}
