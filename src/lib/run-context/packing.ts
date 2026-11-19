import "server-only";

import { createHash } from "node:crypto";

import type { retrieveFactoryContextDocuments } from "@/lib/factory-context/retrieval";
import type { UntrustedPromptValue } from "@/lib/pipeline/prompt-safety";

import {
  DEFAULT_RUN_CONTEXT_LIMITS,
  runContextConversationInputSchema,
  runContextLimitsSchema,
  runContextManifestSchema,
  runContextRequiredInputsSchema,
  type RunContextConversationInput,
  type RunContextDocumentReceipt,
  type RunContextLimits,
  type RunContextManifest,
} from "./contracts";

export function fingerprintRunContextInput(body: string) {
  return {
    sha256: createHash("sha256").update(body, "utf8").digest("hex"),
    utf8Bytes: Buffer.byteLength(body, "utf8"),
  };
}

export class RunContextRequiredInputTooLargeError extends Error {
  constructor(readonly requiredKey: string) {
    super(`Required run context input "${requiredKey}" exceeds the packing budget.`);
    this.name = "RunContextRequiredInputTooLargeError";
  }
}

export function packRunContext(input: {
  requiredInputs: readonly { key: string; body: string }[];
  retrieval: Awaited<ReturnType<typeof retrieveFactoryContextDocuments>>;
  conversation: RunContextConversationInput;
  limits?: RunContextLimits;
}): {
  manifest: RunContextManifest;
  documents: UntrustedPromptValue[];
  conversationMessages: RunContextConversationInput["messages"];
} {
  const limits = runContextLimitsSchema.parse(input.limits ?? DEFAULT_RUN_CONTEXT_LIMITS);
  const requiredInputs = runContextRequiredInputsSchema.parse(input.requiredInputs);
  const conversation = runContextConversationInputSchema.parse(input.conversation);
  const documents: UntrustedPromptValue[] = [];
  const conversationMessages: RunContextConversationInput["messages"] = [];
  // Estimate one token per UTF-8 byte for the bounded input payload. The
  // separate caps make both limits explicit without a model-specific tokenizer.
  let usedUtf8Bytes = 0;
  function reserve(utf8Bytes: number) {
    if (utf8Bytes > Math.min(limits.maxUtf8Bytes, limits.maxEstimatedTokens) - usedUtf8Bytes) {
      return false;
    }
    usedUtf8Bytes += utf8Bytes;
    return true;
  }

  const required = requiredInputs.map(({ key, body }) => {
    const fingerprint = fingerprintRunContextInput(body);
    if (!reserve(fingerprint.utf8Bytes)) throw new RunContextRequiredInputTooLargeError(key);
    return { key, ...fingerprint };
  });

  let documentIndex = 0;
  const documentReceipts = input.retrieval.receipts.map((receipt): RunContextDocumentReceipt => {
    if (receipt.status !== "selected") return receipt;
    const value = input.retrieval.documents[documentIndex++];
    if (
      !value ||
      value.trust !== "untrusted" ||
      value.source !== `context.document.${receipt.sourceId}.${receipt.revisionId}`
    ) {
      throw new Error(
        "Selected run context documents do not match the ordered retrieval receipts.",
      );
    }
    const fingerprint = fingerprintRunContextInput(value.value);
    if (!reserve(fingerprint.utf8Bytes)) {
      const { sourceId, revisionId } = receipt;
      return { sourceId, revisionId, status: "excluded", reason: "context_budget" };
    }
    documents.push(value);
    return { ...receipt, ...fingerprint };
  });
  if (documentIndex !== input.retrieval.documents.length) {
    throw new Error("Selected run context documents do not match the ordered retrieval receipts.");
  }

  const messages = [...conversation.messages]
    .sort((left, right) => left.sequence - right.sequence)
    .map((message) => {
      const { sequence, body } = message;
      const fingerprint = fingerprintRunContextInput(body);
      if (!reserve(fingerprint.utf8Bytes)) {
        return { sequence, reason: "context_budget" as const };
      }
      conversationMessages.push(message);
      return { sequence, ...fingerprint };
    });

  const manifest = runContextManifestSchema.parse({
    version: 1,
    required,
    documents: documentReceipts,
    conversation: {
      throughSequence: conversation.throughSequence,
      olderOmitted: conversation.olderOmitted,
      messages,
    },
    budget: { ...limits, usedUtf8Bytes, estimatedTokens: usedUtf8Bytes },
  });
  return { manifest, documents, conversationMessages };
}
