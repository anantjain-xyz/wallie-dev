import { z } from "zod";

import {
  automationFilterTextSchema,
  automationPullRequestActionSchema,
  factoryAutomationPathSchema,
  factoryAutomationReadQuerySchema,
} from "./contracts";

const id = z.string().uuid().toLowerCase();
const revisionId = factoryAutomationReadQuerySchema.shape.revisionId.unwrap();
export const automationDryRunNamesHeader = "X-Wallie-Automation-Names";

const scheduledFor = z
  .string()
  .datetime({ offset: true })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/)
  .refine((value) => !value.startsWith("0000-"));

export const automationDryRunEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("schedule"), scheduledFor }),
  z.strictObject({
    kind: z.literal("pull-request"),
    repositoryId: id,
    action: automationPullRequestActionSchema,
    baseBranch: automationFilterTextSchema,
  }),
  z.strictObject({
    kind: z.literal("issue-state"),
    stateId: automationFilterTextSchema,
    teamId: automationFilterTextSchema.nullable(),
    projectId: automationFilterTextSchema.nullable(),
  }),
]);

export const automationDryRunRequestSchema = z.strictObject({
  revisionId,
  event: automationDryRunEventSchema,
});

export const automationDryRunResponseSchema = z.strictObject({
  automationId: factoryAutomationPathSchema.shape.automationId,
  revisionId,
  matched: z.boolean(),
  checks: z
    .array(
      z.strictObject({
        field: z.enum([
          "kind",
          "repositoryId",
          "action",
          "baseBranch",
          "stateId",
          "teamId",
          "projectId",
        ]),
        actual: z.string().nullable(),
        expected: z.array(z.string()).max(32),
        passed: z.boolean(),
      }),
    )
    .min(1)
    .max(4),
  budgetPayerMemberId: id,
  names: z
    .strictObject({
      budgetPayer: z.string().nullable(),
      executionPolicyRevision: z.number().int().positive().safe().nullable(),
    })
    .optional(),
  assignment: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("eligible"),
      agentName: z.string(),
      workflowName: z.string().nullable(),
      executionPolicyRevisionId: id,
    }),
    z.strictObject({
      status: z.literal("denied"),
      reason: z.enum(["invalid_assignment", "authority_changing", "archived"]),
      message: z.string(),
    }),
  ]),
});

export type AutomationDryRunEvent = z.infer<typeof automationDryRunEventSchema>;
export type AutomationDryRunRequest = z.infer<typeof automationDryRunRequestSchema>;
export type AutomationDryRunResponse = z.infer<typeof automationDryRunResponseSchema>;
