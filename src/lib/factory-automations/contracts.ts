import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

import { parseFactoryAutomationCron } from "./cron";

const id = z.string().uuid().toLowerCase();
const automationId = id.brand<"FactoryAutomationId">();
const revisionId = id.brand<"FactoryAutomationRevisionId">();
const version = z.number().int().positive().safe();
const timestamp = z.string().datetime({ offset: true });

function isAutomationText(value: string) {
  return isFactoryDefinitionText(value) && !/\p{Cc}/u.test(value) && [...value].length <= 120;
}

export const automationFilterTextSchema = z
  .string()
  .min(1)
  .refine((value) => isAutomationText(value) && value === value.trim());

function distinctFilters<Item extends string>(item: z.ZodType<Item>, minimum = 0) {
  return z
    .array(item)
    .min(minimum)
    .max(32)
    .refine((values) => new Set(values).size === values.length, {
      message: "List each filter value once.",
    });
}

export const automationPullRequestActionSchema = z.enum([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "closed",
  "merged",
]);

const automationTarget = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    definitionRevisionId: id,
    agentId: id,
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    definitionRevisionId: id,
    agentId: id,
    workflowId: id,
    workflowActivationId: id,
  }),
]);

const automationAssignment = z.strictObject({
  name: z.string().trim().min(1).refine(isAutomationText),
  target: automationTarget,
  executionGrant: z.strictObject({ id, version }),
  servicePrincipalId: id,
  budgetPayerMemberId: id,
  credentialBindingId: id,
});

export const factoryAutomationDefinitionSchema = z.union([
  automationAssignment.extend({
    trigger: z.strictObject({
      kind: z.literal("schedule"),
      cron: z.string().refine((value) => parseFactoryAutomationCron(value) !== null, {
        message: "Provide five numeric cron fields using valid ranges and positive steps.",
      }),
      timeZone: z
        .string()
        .max(80)
        .regex(/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/),
    }),
    filters: z.strictObject({}),
  }),
  automationAssignment.extend({
    trigger: z.strictObject({ kind: z.literal("pull-request"), repositoryId: id }),
    filters: z.strictObject({
      actions: distinctFilters(automationPullRequestActionSchema),
      baseBranches: distinctFilters(automationFilterTextSchema),
    }),
  }),
  automationAssignment.extend({
    trigger: z.strictObject({ kind: z.literal("issue-state") }),
    filters: z.strictObject({
      stateIds: distinctFilters(automationFilterTextSchema, 1),
      teamIds: distinctFilters(automationFilterTextSchema),
      projectIds: distinctFilters(automationFilterTextSchema),
    }),
  }),
]);

export const createFactoryAutomationSchema = z.strictObject({
  automationId,
  definition: factoryAutomationDefinitionSchema,
});

const expectedRevision = z.strictObject({ expectedRevisionId: revisionId });
export const factoryAutomationCommandSchema = z.discriminatedUnion("action", [
  expectedRevision.extend({
    action: z.literal("save"),
    definition: factoryAutomationDefinitionSchema,
  }),
  expectedRevision.extend({ action: z.literal("publish") }),
  expectedRevision.extend({
    action: z.literal("archive"),
    expectedPublication: z.strictObject({ revisionId: revisionId.nullable() }),
  }),
]);

export const factoryAutomationPathSchema = z.strictObject({
  workspaceId: id,
  factoryId: id,
  automationId,
});
export const factoryAutomationListQuerySchema = z.strictObject({
  afterId: automationId.optional(),
});
export const factoryAutomationReadQuerySchema = z.strictObject({
  revisionId: revisionId.optional(),
});

const factoryAutomationRevisionSchema = z.strictObject({
  id: revisionId,
  revision: version,
  definition: factoryAutomationDefinitionSchema,
  createdAt: timestamp,
  createdByMemberId: id,
});

export const factoryAutomationSnapshotSchema = z.strictObject({
  automationId,
  draftRevisionId: revisionId,
  publishedRevisionId: revisionId.nullable(),
  archivedAt: timestamp.nullable(),
  revision: factoryAutomationRevisionSchema,
});

export const factoryAutomationListSchema = z.strictObject({
  automations: z.array(factoryAutomationSnapshotSchema).max(50),
  nextCursor: automationId.nullable(),
});

export type FactoryAutomationDefinition = z.output<typeof factoryAutomationDefinitionSchema>;
export type FactoryAutomationCommand = z.output<typeof factoryAutomationCommandSchema>;
