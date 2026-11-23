import { z } from "zod/v4";

export const workflowIntakeSelectionSchema = z
  .object({
    workflowId: z.string().uuid().toLowerCase(),
    activationId: z.string().uuid().toLowerCase(),
  })
  .strict();

export type WorkflowIntakeSelection = z.output<typeof workflowIntakeSelectionSchema>;
