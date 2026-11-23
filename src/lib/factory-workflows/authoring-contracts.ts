import { z } from "zod";

import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";

const id = z.string().uuid().toLowerCase();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const workflowBaseDefinitionSchema = z.strictObject({
  activationId: id,
  revisionId: id,
  digest,
});
const unavailableBaseSchema = z
  .strictObject({ activationId: z.null(), revisionId: z.null(), digest: z.null() })
  .transform(() => null);
const workflowHeadSchema = z.strictObject({
  draftId: id.nullable(),
  activationId: id.nullable(),
});
const expectation = workflowHeadSchema.extend({ baseDefinition: workflowBaseDefinitionSchema });
const workflowIdentitySchema = z.strictObject({
  workflowId: id,
  displayName: z.string().trim().min(1).max(120),
});

export const createWorkflowAuthoringSchema = workflowIdentitySchema;
export const workflowAuthoringPathSchema = z.object({
  workspaceId: id,
  factoryId: id,
  workflowId: id,
});
export const workflowAuthoringSnapshotSchema = workflowIdentitySchema
  .extend(workflowHeadSchema.shape)
  .extend({
    baseDefinition: z.union([workflowBaseDefinitionSchema, unavailableBaseSchema, z.null()]),
    draftBaseDefinition: workflowBaseDefinitionSchema.nullable(),
    graph: workflowGraphSchema.nullable(),
    draftDigest: digest.nullable(),
    recentDrafts: z
      .strictObject({ id, revision: z.number().int().positive().safe() })
      .array()
      .max(20),
    publishedDraftId: id.nullable(),
    publishedGraphRevisionId: id.nullable(),
    selectedDraftId: id.nullable(),
    selectedDraftGraph: workflowGraphSchema.nullable(),
    selectedDraftDigest: digest.nullable(),
    selectedDraftBaseDefinition: workflowBaseDefinitionSchema.nullable(),
  });
export const workflowAuthoringListSchema = z.object({
  workflows: workflowIdentitySchema
    .extend(workflowHeadSchema.shape)
    .extend({
      publishedDraftId: id.nullable(),
    })
    .array()
    .max(51),
});
export const workflowAuthoringCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save"),
    requestId: id,
    expected: expectation,
    graph: z.unknown(),
    rebase: z.boolean().default(false),
  }),
  z.strictObject({
    action: z.literal("publish"),
    requestId: id,
    expected: expectation.extend({ draftId: id }),
  }),
]);
export const workflowSaveReceiptSchema = z.strictObject({
  draftId: id,
  digest,
  created: z.boolean(),
});
export const workflowPublishReceiptSchema = workflowSaveReceiptSchema.extend({
  activationId: id,
  graphRevisionId: id,
});

export const workflowReferencePageSize = 100;
export const workflowReferenceKindSchema = z.enum(["prompts", "approvers", "profiles"]);
const referenceChoice = z.strictObject({ id, label: z.string() });
const profileChoice = referenceChoice.extend({ digest });
const nextOffset = z.number().int().nonnegative().safe().nullable();
const referenceChoices = referenceChoice.array().max(workflowReferencePageSize);
const profileChoices = profileChoice.array().max(workflowReferencePageSize);
export const workflowReferencePageSchema = z.discriminatedUnion("catalog", [
  z.strictObject({ catalog: z.literal("prompts"), items: referenceChoices, nextOffset }),
  z.strictObject({ catalog: z.literal("approvers"), items: referenceChoices, nextOffset }),
  z.strictObject({ catalog: z.literal("profiles"), items: profileChoices, nextOffset }),
]);
const workflowEditorChoicesSchema = z.strictObject({
  prompts: referenceChoices,
  approvers: referenceChoices,
  profiles: profileChoices,
  grant: z.strictObject({ id, version: z.number().int().positive().safe() }).nullable(),
  nextOffsets: z.strictObject({ prompts: nextOffset, approvers: nextOffset, profiles: nextOffset }),
});
export const workflowAuthoringEditorSchema = z.strictObject({
  snapshot: workflowAuthoringSnapshotSchema,
  choices: workflowEditorChoicesSchema,
});
export type WorkflowAuthoringSnapshot = z.output<typeof workflowAuthoringSnapshotSchema>;
export type WorkflowAuthoringCommand = z.output<typeof workflowAuthoringCommandSchema>;
export type WorkflowBaseDefinition = z.output<typeof workflowBaseDefinitionSchema>;
export type WorkflowReferenceKind = z.output<typeof workflowReferenceKindSchema>;
export type WorkflowReferencePage = z.output<typeof workflowReferencePageSchema>;
export type WorkflowEditorCatalog = z.output<typeof workflowEditorChoicesSchema>;
