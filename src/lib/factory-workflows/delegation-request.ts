import { z } from "zod/v4";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

function boundedWorkflowDelegationText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .refine((text) => text.length <= maxLength * 2 && [...text].length <= maxLength)
    .refine(isFactoryDefinitionText);
}

export const workflowDelegationRequestSchema = z
  .object({
    title: boundedWorkflowDelegationText(200),
    promptMd: boundedWorkflowDelegationText(20_000),
  })
  .strict();

export type WorkflowDelegationRequest = z.input<typeof workflowDelegationRequestSchema>;
