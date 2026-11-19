import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@/lib/supabase/database.types";

/** A submitted revision consumes its immutable batch, never live comment text. */
export async function loadJobFeedback(
  admin: SupabaseClient<Database>,
  job: Pick<Tables<"agent_jobs">, "id" | "session_id" | "workspace_id">,
  stageId: string,
  options?: { exactOnly: true },
): Promise<{ key: string; body: string } | null> {
  const { data: input, error: inputError } = await admin
    .from("artifact_feedback_batch_jobs")
    .select("batch_id")
    .eq("job_id", job.id)
    .eq("session_id", job.session_id)
    .eq("workspace_id", job.workspace_id)
    .maybeSingle();
  if (inputError) throw inputError;
  if (input) {
    const { data: batch, error } = await admin
      .from("artifact_feedback_batches")
      .select("rendered_feedback_text")
      .eq("id", input.batch_id)
      .eq("session_id", job.session_id)
      .eq("workspace_id", job.workspace_id)
      .eq("stage_id", stageId)
      .maybeSingle();
    if (error) throw error;
    if (!batch) throw new Error("The job's immutable feedback generation is unavailable.");
    return { key: "feedback/batch/" + input.batch_id, body: batch.rendered_feedback_text };
  }

  if (options?.exactOnly) return null;

  // Existing whole-stage callers keep their established feedback record.
  const { data, error } = await admin
    .from("session_artifact_feedback")
    .select("id, target_version, feedback_text")
    .eq("session_id", job.session_id)
    .eq("stage_id", stageId)
    .order("target_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        key: ["feedback", "artifact", data.id, data.target_version].join("/"),
        body: data.feedback_text,
      }
    : null;
}
