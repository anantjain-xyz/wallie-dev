import { describe, expect, it } from "vitest";

import { untrustedPromptValue } from "@/lib/pipeline/prompt-safety";

import { DEFAULT_RUN_CONTEXT_LIMITS, runContextManifestSchema } from "./contracts";
import {
  fingerprintRunContextInput,
  packRunContext,
  RunContextRequiredInputTooLargeError,
} from "./packing";

const id = (value: number) => `58000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const emptyInput = {
  requiredInputs: [],
  retrieval: { documents: [], receipts: [] },
  conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
};

function document(position: number, content: string) {
  const sourceId = id(position * 2);
  const revisionId = id(position * 2 + 1);
  const filePath = `docs/notes-${position}.md`;
  const upstreamRevision = "a".repeat(40);
  const fingerprint = fingerprintRunContextInput(content);
  return {
    value: untrustedPromptValue(
      `context.document.${sourceId}.${revisionId}`,
      `File ${filePath}\nGit revision ${upstreamRevision}\n\n${content}`,
    ),
    receipt: {
      sourceId,
      revisionId,
      status: "selected" as const,
      reason: "exact_revision" as const,
      filePath,
      upstreamRevision,
      contentSha256: fingerprint.sha256,
      contentBytes: fingerprint.utf8Bytes,
      stale: false,
    },
  };
}

describe("packRunContext", () => {
  it("records explicit production limits and a body-free empty context", () => {
    expect(DEFAULT_RUN_CONTEXT_LIMITS).toEqual({
      maxUtf8Bytes: 128 * 1024,
      maxEstimatedTokens: 32_768,
    });
    expect(packRunContext(emptyInput)).toEqual({
      documents: [],
      memories: [],
      conversationMessages: [],
      manifest: {
        version: 1,
        required: [],
        documents: [],
        conversation: { throughSequence: 0, olderOmitted: 0, messages: [] },
        budget: {
          maxUtf8Bytes: 128 * 1024,
          maxEstimatedTokens: 32_768,
          usedUtf8Bytes: 0,
          estimatedTokens: 0,
        },
      },
    });
  });

  it("spends one budget on approved memories before conversation and records exclusions", () => {
    const memories = ["é", "over the budget"].map((body, i) => ({
      memory_id: id(20 + i),
      revision_id: id(30 + i),
      approval_id: id(40 + i),
      content_sha256: fingerprintRunContextInput(body).sha256,
      body_md: body,
    }));
    const packed = packRunContext({
      ...emptyInput,
      memories,
      conversation: { throughSequence: 1, olderOmitted: 0, messages: [{ sequence: 1, body: "x" }] },
      limits: { maxUtf8Bytes: 4, maxEstimatedTokens: 2 },
    });
    expect(packed.manifest).toMatchObject({
      version: 2,
      memories: [
        {
          memoryId: memories[0].memory_id,
          revisionId: memories[0].revision_id,
          approvalId: memories[0].approval_id,
          status: "selected",
          sha256: memories[0].content_sha256,
          utf8Bytes: 2,
        },
        {
          memoryId: memories[1].memory_id,
          revisionId: memories[1].revision_id,
          status: "excluded",
          reason: "context_budget",
        },
      ],
      conversation: { messages: [{ sequence: 1, reason: "context_budget" }] },
      budget: { usedUtf8Bytes: 2, estimatedTokens: 2 },
    });
    expect(packed.memories.map((value) => value.value)).toEqual(["é"]);
    expect(packed.conversationMessages).toEqual([]);
    expect(() =>
      packRunContext({
        ...emptyInput,
        memories: [{ ...memories[0], content_sha256: "0".repeat(64) }],
      }),
    ).toThrow("does not match its recorded digest");
  });

  it("fails with the exact artifact or feedback key when required inputs cannot fit", () => {
    const required = [
      { key: "session.prompt", body: "first" },
      { key: `artifact.${id(1)}.v2.${id(2)}`, body: "é🙂" },
      { key: `feedback.${id(3)}`, body: "follow-up" },
    ];
    expect(fingerprintRunContextInput(required[1].body).utf8Bytes).toBe(6);
    for (const limits of [
      { maxUtf8Bytes: 10, maxEstimatedTokens: 60 },
      { maxUtf8Bytes: 60, maxEstimatedTokens: 10 },
    ]) {
      expect(() => packRunContext({ ...emptyInput, requiredInputs: required, limits })).toThrow(
        RunContextRequiredInputTooLargeError,
      );
      try {
        packRunContext({ ...emptyInput, requiredInputs: required, limits });
      } catch (error) {
        expect(error).toMatchObject({ requiredKey: required[1].key });
      }
    }
  });

  it("keeps required inputs, ordered documents and chronological messages under one exact budget", () => {
    const documentA = document(1, "include this source");
    const documentB = document(2, "over-budget source text".repeat(50));
    const unavailable = { sourceId: id(30), revisionId: id(31) };
    const required = [
      { key: "session.prompt", body: "Source content is reference only." },
      { key: `artifact.${id(50)}.v2.${id(51)}`, body: "Exact artifact body." },
    ];
    const conversation = {
      throughSequence: 5,
      olderOmitted: 2,
      messages: [
        { sequence: 5, body: "é" },
        { sequence: 4, body: "omitted conversation".repeat(10) },
        { sequence: 3, body: "Q" },
      ],
    };
    const requiredBytes = required.reduce((total, { body }) => total + Buffer.byteLength(body), 0);
    const size = requiredBytes + Buffer.byteLength(documentA.value.value) + 3;
    const limits = { maxUtf8Bytes: size + 500, maxEstimatedTokens: size };
    const input = {
      requiredInputs: required,
      retrieval: {
        documents: [documentA.value, documentB.value],
        receipts: [
          documentA.receipt,
          { ...unavailable, status: "unavailable" as const, reason: "access_revoked" as const },
          documentB.receipt,
        ],
      },
      conversation,
      limits,
    };
    const result = packRunContext(input);
    expect(packRunContext(input)).toEqual(result);
    expect(result.manifest.required).toEqual(
      required.map(({ key, body }) => ({ key, ...fingerprintRunContextInput(body) })),
    );
    expect(result.manifest.documents).toEqual([
      { ...documentA.receipt, ...fingerprintRunContextInput(documentA.value.value) },
      { ...unavailable, status: "unavailable", reason: "access_revoked" },
      {
        sourceId: documentB.receipt.sourceId,
        revisionId: documentB.receipt.revisionId,
        status: "excluded",
        reason: "context_budget",
      },
    ]);
    expect(result.documents).toEqual([documentA.value]);
    expect(result.manifest.conversation).toEqual({
      throughSequence: 5,
      olderOmitted: 2,
      messages: [
        { sequence: 3, ...fingerprintRunContextInput("Q") },
        { sequence: 4, reason: "context_budget" },
        { sequence: 5, ...fingerprintRunContextInput("é") },
      ],
    });
    expect(result.conversationMessages).toEqual([
      { sequence: 3, body: "Q" },
      { sequence: 5, body: "é" },
    ]);
    expect(result.manifest.budget).toEqual({
      ...limits,
      usedUtf8Bytes: size,
      estimatedTokens: size,
    });
    const manifest = JSON.stringify(result.manifest);
    for (const body of [
      ...required.map(({ body }) => body),
      "include this source",
      "over-budget source text",
      "omitted conversation",
    ]) {
      expect(manifest).not.toContain(body);
    }
  });

  it("charges the exact document formatting even when the raw text would fit", () => {
    const requested = document(1, "abc");
    const result = packRunContext({
      ...emptyInput,
      retrieval: { documents: [requested.value], receipts: [requested.receipt] },
      limits: { maxUtf8Bytes: 4, maxEstimatedTokens: 4 },
    });
    expect(result.documents).toEqual([]);
    expect(result.manifest.documents).toMatchObject([
      { sourceId: requested.receipt.sourceId, status: "excluded", reason: "context_budget" },
    ]);
    expect(result.manifest.budget.usedUtf8Bytes).toBe(0);
  });

  it("rejects incomplete or reordered document bodies even if a budget would exclude them", () => {
    const first = document(1, "first");
    const second = document(2, "second");
    const receipts = [first.receipt, second.receipt];
    for (const documents of [
      [first.value],
      [second.value, first.value],
      [first.value, second.value, first.value],
    ]) {
      expect(() =>
        packRunContext({
          ...emptyInput,
          retrieval: { receipts, documents },
          limits: { maxUtf8Bytes: 0, maxEstimatedTokens: 0 },
        }),
      ).toThrow("do not match the ordered retrieval receipts");
    }
  });

  it("does not borrow updated document, artifact, or conversation hashes", () => {
    const original = document(1, "original source");
    const edited = document(1, "changed source");
    const snapshot = (artifact: string, message: string, chosen: typeof original) =>
      packRunContext({
        requiredInputs: [{ key: `artifact.${id(55)}.v1.${id(56)}`, body: artifact }],
        retrieval: { documents: [chosen.value], receipts: [chosen.receipt] },
        conversation: {
          throughSequence: 1,
          olderOmitted: 0,
          messages: [{ sequence: 1, body: message }],
        },
      }).manifest;
    const frozen = snapshot("original artifact", "original message", original);
    const changed = snapshot("updated artifact", "updated message", edited);
    expect(frozen.required).not.toEqual(changed.required);
    expect(frozen.documents).not.toEqual(changed.documents);
    expect(frozen.conversation.messages).not.toEqual(changed.conversation.messages);
    expect(snapshot("original artifact", "original message", original)).toEqual(frozen);
  });
});

describe("runContextManifestSchema", () => {
  it("rejects unbounded, unaccounted or body-bearing replay metadata", () => {
    const base = packRunContext({
      ...emptyInput,
      requiredInputs: [{ key: "session.prompt", body: "request" }],
      conversation: {
        throughSequence: 1,
        olderOmitted: 0,
        messages: [{ sequence: 1, body: "answer" }],
      },
    }).manifest;
    const invalid = [
      { ...base, required: [...base.required, ...base.required] },
      { ...base, required: [{ ...base.required[0], body: "malformed manifest with content" }] },
      { ...base, budget: { ...base.budget, usedUtf8Bytes: 0 } },
      { ...base, budget: { ...base.budget, estimatedTokens: 0 } },
      { ...base, budget: { ...base.budget, maxEstimatedTokens: 32_769 } },
      { ...base, conversation: { ...base.conversation, throughSequence: 0 } },
      {
        ...base,
        conversation: {
          ...base.conversation,
          messages: [...base.conversation.messages, ...base.conversation.messages],
        },
      },
    ];
    for (const manifest of invalid)
      expect(runContextManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
