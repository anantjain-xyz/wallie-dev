import { z } from "zod";

import {
  contextDocumentReferenceSchema,
  contextFilePathSchema,
} from "@/lib/factory-context/contracts";

export const DEFAULT_RUN_CONTEXT_LIMITS = {
  maxUtf8Bytes: 128 * 1024,
  maxEstimatedTokens: 32_768,
};

const nonnegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sequence = nonnegativeSafeInteger.min(1);
const utf8Bytes = nonnegativeSafeInteger.max(DEFAULT_RUN_CONTEXT_LIMITS.maxUtf8Bytes);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const fingerprint = { sha256, utf8Bytes };
const requiredKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/);

export const runContextLimitsSchema = z.strictObject({
  maxUtf8Bytes: utf8Bytes,
  maxEstimatedTokens: nonnegativeSafeInteger.max(DEFAULT_RUN_CONTEXT_LIMITS.maxEstimatedTokens),
});

export const runContextDocumentReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...contextDocumentReferenceSchema.shape,
    status: z.literal("selected"),
    reason: z.literal("exact_revision"),
    filePath: contextFilePathSchema,
    upstreamRevision: z.string().regex(/^[0-9a-f]{40}$/),
    contentSha256: sha256,
    contentBytes: utf8Bytes,
    stale: z.boolean(),
    ...fingerprint,
  }),
  z.strictObject({
    ...contextDocumentReferenceSchema.shape,
    status: z.literal("excluded"),
    reason: z.enum(["not_selected", "byte_limit", "context_budget"]),
  }),
  z.strictObject({
    ...contextDocumentReferenceSchema.shape,
    status: z.literal("unavailable"),
    reason: z.enum([
      "missing_revision",
      "source_unavailable",
      "access_revoked",
      "revision_changed",
      "upstream_deleted",
      "upstream_unavailable",
      "revision_mismatch",
    ]),
  }),
]);

const includedMessage = z.strictObject({ sequence, ...fingerprint });
const omittedMessage = z.strictObject({ sequence, reason: z.literal("context_budget") });
const conversationRange = {
  throughSequence: nonnegativeSafeInteger,
  olderOmitted: nonnegativeSafeInteger,
};

export const runContextConversationSchema = z.strictObject({
  ...conversationRange,
  messages: z.array(z.union([includedMessage, omittedMessage])).max(100),
});

export const runContextRequiredInputsSchema = z
  .array(z.strictObject({ key: requiredKey, body: z.string() }))
  .max(128);

export const runContextConversationInputSchema = z.strictObject({
  ...conversationRange,
  messages: z.array(z.strictObject({ sequence, body: z.string() })).max(100),
});

export const runContextManifestSchema = z
  .strictObject({
    version: z.literal(1),
    required: z.array(z.strictObject({ key: requiredKey, ...fingerprint })).max(128),
    documents: z.array(runContextDocumentReceiptSchema).max(8),
    conversation: runContextConversationSchema,
    budget: runContextLimitsSchema.extend({
      usedUtf8Bytes: utf8Bytes,
      estimatedTokens: nonnegativeSafeInteger.max(DEFAULT_RUN_CONTEXT_LIMITS.maxEstimatedTokens),
    }),
  })
  .superRefine(({ required, documents, conversation, budget }, context) => {
    const distinctRequired = new Set(required.map(({ key }) => key));
    const distinctSources = new Set(documents.map(({ sourceId }) => sourceId));
    if (distinctRequired.size !== required.length || distinctSources.size !== documents.length) {
      context.addIssue({
        code: "custom",
        message: "Run context contains duplicate input identities.",
      });
    }

    if (
      conversation.olderOmitted > conversation.throughSequence ||
      conversation.messages.some(
        ({ sequence }, index) =>
          sequence > conversation.throughSequence ||
          sequence <= (conversation.messages[index - 1]?.sequence ?? 0),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Run context conversation is outside its ordered range.",
      });
    }

    const includedBytes =
      required.reduce((total, input) => total + input.utf8Bytes, 0) +
      documents.reduce(
        (total, document) => total + (document.status === "selected" ? document.utf8Bytes : 0),
        0,
      ) +
      conversation.messages.reduce(
        (total, message) => total + ("utf8Bytes" in message ? message.utf8Bytes : 0),
        0,
      );
    if (
      budget.usedUtf8Bytes !== includedBytes ||
      budget.estimatedTokens !== includedBytes ||
      includedBytes > Math.min(budget.maxUtf8Bytes, budget.maxEstimatedTokens)
    ) {
      context.addIssue({
        code: "custom",
        message: "Run context input sizes do not match the budget.",
      });
    }
  });

export type RunContextLimits = z.infer<typeof runContextLimitsSchema>;
export type RunContextManifest = z.infer<typeof runContextManifestSchema>;
export type RunContextDocumentReceipt = z.infer<typeof runContextDocumentReceiptSchema>;
export type RunContextConversationInput = z.infer<typeof runContextConversationInputSchema>;
