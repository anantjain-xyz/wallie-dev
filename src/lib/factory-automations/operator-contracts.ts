import { z } from "zod";

export const automationTriggerKindSchema = z.enum(["schedule", "pull-request", "issue-state"]);

const id = z.string().uuid().toLowerCase();
const timestamp = z.string().datetime({ offset: true });
const positiveInteger = z.number().int().positive().safe();

export const automationSetupSchema = z.strictObject({
  assignment: z
    .strictObject({
      definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
      definitionRevisionId: id,
      agentId: id,
      agentName: z.string().min(1),
      executionGrant: z.strictObject({ id, version: positiveInteger }),
      servicePrincipalId: id,
      budgetPayerMemberId: id,
      credentialBindingId: id,
    })
    .nullable(),
});

const cursorTimestamp = timestamp
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/)
  .refine((value) => !value.startsWith("0000-"));

export const automationHistoryCursorSchema = z.strictObject({ recordedAt: cursorTimestamp, id });
const occurrenceIdentity = z.strictObject({
  id,
  revisionId: id.optional(),
  revisionNumber: positiveInteger,
  triggerKind: automationTriggerKindSchema,
  attemptCount: z.number().int().min(0).max(5),
  recordedAt: timestamp,
});

export const automationHistorySchema = z.strictObject({
  occurrences: z
    .array(
      z.discriminatedUnion("status", [
        occurrenceIdentity.extend({
          status: z.literal("pending"),
          reason: z.enum(["paused", "capacity", "authority_changing"]).nullable(),
          settledAt: z.null(),
          nextAttemptAt: timestamp,
          sessionNumber: z.null(),
        }),
        occurrenceIdentity.extend({
          status: z.literal("admitted"),
          reason: z.null(),
          settledAt: timestamp,
          nextAttemptAt: z.null(),
          sessionNumber: positiveInteger.nullable(),
        }),
        occurrenceIdentity.extend({
          status: z.literal("denied"),
          reason: z.enum([
            "automation_archived",
            "revision_changed",
            "event_no_match",
            "recursive_event",
            "invalid_cause",
            "invalid_assignment",
            "budget_exhausted",
            "retry_exhausted",
            "factory_unavailable",
          ]),
          settledAt: timestamp,
          nextAttemptAt: z.null(),
          sessionNumber: z.null(),
        }),
      ]),
    )
    .max(20),
  nextCursor: automationHistoryCursorSchema.nullable(),
});

export type AutomationSetupAssignment = NonNullable<
  z.infer<typeof automationSetupSchema>["assignment"]
>;
export type AutomationHistoryCursor = z.infer<typeof automationHistoryCursorSchema>;
export type AutomationHistory = z.infer<typeof automationHistorySchema>;
export type AutomationTriggerKind = z.infer<typeof automationTriggerKindSchema>;

export type AutomationSetupOptions = {
  assignment: AutomationSetupAssignment | null;
  repositories: { id: string; name: string }[];
  workflows: { id: string; activationId: string; name: string }[];
};
