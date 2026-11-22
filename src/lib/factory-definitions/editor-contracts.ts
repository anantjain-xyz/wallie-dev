import { z } from "zod";

import { routingCanarySummarySchema } from "@/lib/model-routing/canary-contracts";
import { routingDraftEvidenceSchema } from "@/lib/model-routing/draft-contracts";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";

import {
  compiledFactoryDefinitionSchema,
  factoryDefinitionExpectedActivationSchema,
  factoryDefinitionSourceSchema,
  serialFactoryDefinitionSchema,
} from "./schema";

const uuid = z.string().uuid();
const activationNumber = z.number().int().safe().nonnegative();
const createdAt = z.string().datetime({ offset: true });
const contentSchema = z.object({
  source: serialFactoryDefinitionSchema,
  bundle: compiledFactoryDefinitionSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const documentSchema = contentSchema.extend({
  id: uuid,
  kind: z.enum(["draft", "revision"]),
  createdAt,
  sourceDraftId: uuid.nullable(),
  routingDraftEvidence: routingDraftEvidenceSchema.optional(),
});

export const factoryEditorSnapshotSchema = z.object({
  activationNumber,
  routingMode: z.enum(["shadow", "active"]).optional(),
  routingCanary: routingCanarySummarySchema.optional(),
  published: documentSchema.nullable(),
  draft: documentSchema.nullable(),
  baseline: z.object({ source: serialFactoryDefinitionSchema }).nullable(),
  readySandboxProviders: z.array(sandboxProviderSchema),
});
export const factoryEditorSnapshotResponseSchema = z.object({
  snapshot: factoryEditorSnapshotSchema,
});
export const factoryEditorDocumentResponseSchema = z.object({ document: documentSchema });
export const factoryEditorPreviewResponseSchema = z.object({ content: contentSchema });
export const factoryEditorPreviewRequestSchema = z
  .object({
    expectedActivationNumber: factoryDefinitionExpectedActivationSchema,
    expectedDraftId: uuid.nullable(),
    source: factoryDefinitionSourceSchema,
  })
  .strict();

export const factoryEditorActivationSchema = z.object({
  id: uuid,
  revisionId: uuid,
  activationNumber: activationNumber.positive(),
  previousActivationNumber: activationNumber.positive().nullable(),
  createdAt,
});
export const factoryEditorHistoryResponseSchema = z.object({
  factoryId: uuid,
  currentActivation: factoryEditorActivationSchema.nullable(),
  activations: z.array(factoryEditorActivationSchema),
  nextBeforeActivationNumber: activationNumber.positive().nullable(),
});

export type FactoryEditorContent = z.infer<typeof contentSchema>;
export type FactoryEditorDocument = z.infer<typeof documentSchema>;
export type FactoryEditorSnapshot = z.infer<typeof factoryEditorSnapshotSchema>;
export type FactoryEditorPreviewRequest = z.infer<typeof factoryEditorPreviewRequestSchema>;
export type FactoryEditorActivation = z.infer<typeof factoryEditorActivationSchema>;
