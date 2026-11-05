import { z } from "zod";
import type { Tables } from "@/lib/supabase/database.types";
import type { ReviewCursor } from "./types";

export const submittedCommentsSchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      revision: z.number().int().positive(),
      author_member_id: z.string().uuid(),
      author_label: z.string(),
      body: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
    }),
  )
  .min(1)
  .max(100);

export type FeedbackBatchSummary = Pick<
  Tables<"artifact_feedback_batches">,
  "id" | "artifact_id" | "artifact_version" | "actor_label" | "created_at" | "job_id" | "run_id"
>;
export type ReviewRun = Pick<
  Tables<"agent_runs">,
  "id" | "status" | "model_provider" | "model_name" | "attempt_count" | "created_at" | "finished_at"
>;
export type FeedbackHistoryPage = {
  batches: FeedbackBatchSummary[];
  nextCursor: ReviewCursor | null;
  producingRun: ReviewRun | null;
  receivedBatchId: string | null;
};
export type FeedbackBatchDetail = {
  batch: Tables<"artifact_feedback_batches">;
  threads: Array<
    Tables<"artifact_feedback_batch_threads"> & {
      sourceVersion: number;
      sourceStageSlug: string;
      comments: z.infer<typeof submittedCommentsSchema>;
    }
  >;
  initialRun: ReviewRun | null;
  outputs: Array<{
    artifactId: string;
    version: number;
    runId: string;
    createdAt: string;
    run: ReviewRun | null;
  }>;
  outputNextCursor: ReviewCursor | null;
};
