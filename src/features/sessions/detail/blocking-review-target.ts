import { z } from "zod";

export const blockingReviewTargetSchema = z.object({
  threadId: z.string().uuid(),
  artifactId: z.string().uuid(),
  artifactVersion: z.number().int().positive(),
  stageSlug: z.string().min(1).max(200),
});

export type BlockingReviewTarget = z.infer<typeof blockingReviewTargetSchema>;
