import "server-only";

import { z } from "zod";

import { retrieveFactoryContextDocuments } from "@/lib/factory-context/retrieval";
import {
  FACTORY_MEMORY_CONTEXT_LIMIT,
  factoryMemoryContextRowSchema,
} from "@/lib/factory-memory/contracts";
import type { materializeFactoryRepositoryContext } from "@/lib/pipeline/repository-context";
import type { AttemptPredecessor } from "@/lib/pipeline/stages";
import { untrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import type { SpecificationPromptContext } from "@/lib/prompt-templates";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { runContextManifestSchema, type RunContextManifest } from "./contracts";
import { formatRunContextMessage } from "./conversation";
import { factoryMemoryPromptValue, fingerprintRunContextInput, packRunContext } from "./packing";

const maxConversationMessages = 32;

type ContextScope = {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string;
  factoryId: string;
  sessionId: string;
  jobId: string;
  runId: string;
  attemptCount: number;
  signal?: AbortSignal;
};

type ContextReference = Parameters<typeof retrieveFactoryContextDocuments>[0]["references"];
const originSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("fresh") }),
  z.object({ status: z.literal("missing") }),
  z.object({
    status: z.literal("replay"),
    origin_run_id: z.string().uuid(),
    manifest: runContextManifestSchema,
  }),
]);

type RunContextOrigin = Exclude<z.infer<typeof originSchema>, { status: "missing" }>;
type RepositoryContexts = Awaited<ReturnType<typeof materializeFactoryRepositoryContext>>;

export class FrozenRunContextUnavailableError extends Error {
  constructor(dependency: string) {
    super("Frozen run context is unavailable. " + dependency);
    this.name = "FrozenRunContextUnavailableError";
  }
}

export function requiredRunContextInputs(input: {
  sessionPrompt: { title: string; promptMd: string };
  feedback: { key: string; body: string } | null;
  predecessors: AttemptPredecessor[];
  predecessorText: Record<string, string>;
  repositoryContexts?: RepositoryContexts;
  specification?: SpecificationPromptContext;
}) {
  const required = [
    { key: "session/title", body: input.sessionPrompt.title },
    { key: "session/prompt", body: input.sessionPrompt.promptMd },
  ];
  if (input.feedback) required.push(input.feedback);

  for (const predecessor of input.predecessors) {
    if (predecessor.status !== "approved") {
      throw new FrozenRunContextUnavailableError("An exact predecessor approval is missing.");
    }
    const body = input.predecessorText[predecessor.stageSlug];
    if (body === undefined) {
      throw new FrozenRunContextUnavailableError("An approved predecessor body is missing.");
    }
    required.push({
      key: [
        "predecessor",
        predecessor.stageId,
        predecessor.stageSlug,
        predecessor.approvalReceiptId,
        predecessor.artifactId,
        predecessor.artifactVersion,
      ].join("/"),
      body,
    });
  }

  for (const repository of input.repositoryContexts ?? []) {
    required.push({
      key: ["repository", repository.repositoryId, repository.commitSha].join("/"),
      body: [repository.fullName, repository.upstreamRepositoryId].join("\n"),
    });
  }

  if (input.specification) {
    required.push({
      key: "specification/clarification-available",
      body: String(input.specification.canAskClarification),
    });
    if (input.specification.priorDraft) {
      required.push({
        key: "specification/prior-draft",
        body: input.specification.priorDraft.value,
      });
    }
    if (input.specification.clarificationHistory) {
      required.push({
        key: "specification/clarification-history",
        body: input.specification.clarificationHistory.value,
      });
    }
  }
  return required;
}

function attemptArgs(scope: ContextScope) {
  return {
    p_workspace_id: scope.workspaceId,
    p_job_id: scope.jobId,
    p_run_id: scope.runId,
    p_attempt_count: scope.attemptCount,
  };
}

function scopedMessages(scope: ContextScope) {
  return scope.admin
    .from("session_conversation_messages")
    .select("sequence, author_label, body_md, body_truncated", { count: "exact" })
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .eq("session_id", scope.sessionId)
    .eq("kind", "message");
}

async function readNewConversation(scope: ContextScope) {
  const head = scope.admin
    .from("session_conversations")
    .select("last_sequence")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .eq("session_id", scope.sessionId);
  const { data, error } = await (
    scope.signal ? head.abortSignal(scope.signal) : head
  ).maybeSingle();
  if (error) {
    throw new FrozenRunContextUnavailableError("The conversation boundary could not be read.");
  }
  const throughSequence = data?.last_sequence ?? 0;
  const query = scopedMessages(scope)
    .lte("sequence", throughSequence)
    .order("sequence", { ascending: false })
    .limit(maxConversationMessages);
  const result = await (scope.signal ? query.abortSignal(scope.signal) : query);
  if (result.error || result.data === null || result.count === null) {
    throw new FrozenRunContextUnavailableError("The conversation messages could not be read.");
  }
  return {
    throughSequence,
    olderOmitted: result.count - result.data.length,
    messages: result.data.slice().reverse().map(formatRunContextMessage),
  };
}

function sameFingerprint(body: string, expected: { sha256: string; utf8Bytes: number }) {
  const actual = fingerprintRunContextInput(body);
  return actual.sha256 === expected.sha256 && actual.utf8Bytes === expected.utf8Bytes;
}

async function restoreConversation(scope: ContextScope, manifest: RunContextManifest) {
  const selected = manifest.conversation.messages.filter((message) => "sha256" in message);
  if (!selected.length) return [];
  const query = scopedMessages(scope)
    .in(
      "sequence",
      selected.map(({ sequence }) => sequence),
    )
    .lte("sequence", manifest.conversation.throughSequence)
    .order("sequence");
  const { data, error } = await (scope.signal ? query.abortSignal(scope.signal) : query);
  if (error || !data || data.length !== selected.length) {
    throw new FrozenRunContextUnavailableError("A recorded conversation message is missing.");
  }
  const restored = data.map(formatRunContextMessage);
  if (
    restored.some(
      (message, i) =>
        message.sequence !== selected[i].sequence || !sameFingerprint(message.body, selected[i]),
    )
  ) {
    throw new FrozenRunContextUnavailableError("A recorded conversation message changed.");
  }
  return restored;
}

async function restoreDocuments(scope: ContextScope, manifest: RunContextManifest) {
  const selected = manifest.documents.filter((document) => document.status === "selected");
  const restored = await retrieveFactoryContextDocuments({
    ...scope,
    references: selected.map(({ sourceId, revisionId }) => ({ sourceId, revisionId })),
  });
  if (restored.documents.length !== selected.length) {
    const missing = restored.receipts.find((receipt) => receipt.status !== "selected");
    throw new FrozenRunContextUnavailableError(
      "A recorded external document could not be read (" + (missing?.reason ?? "missing") + ").",
    );
  }
  if (restored.documents.some((document, i) => !sameFingerprint(document.value, selected[i]))) {
    throw new FrozenRunContextUnavailableError("A recorded external document changed.");
  }
  return restored.documents;
}

async function readFactoryMemories(scope: ContextScope, revisionIds?: string[]) {
  const query = scope.admin.rpc("read_factory_memory_context", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    ...(revisionIds ? { p_revision_ids: revisionIds } : {}),
  });
  const { data, error } = await (scope.signal ? query.abortSignal(scope.signal) : query);
  const result = z
    .array(factoryMemoryContextRowSchema)
    .max(FACTORY_MEMORY_CONTEXT_LIMIT)
    .safeParse(data);
  if (error || !result.success) {
    throw new FrozenRunContextUnavailableError("Factory memory could not be read.");
  }
  return result.data;
}

async function restoreFactoryMemories(scope: ContextScope, manifest: RunContextManifest) {
  if (manifest.version === 1) return [];
  const selected = manifest.memories.filter((memory) => memory.status === "selected");
  if (!selected.length) return [];
  const rows = await readFactoryMemories(
    scope,
    selected.map(({ revisionId }) => revisionId),
  );
  const byRevision = new Map(rows.map((row) => [row.revision_id, row]));
  if (rows.length !== selected.length || byRevision.size !== selected.length) {
    throw new FrozenRunContextUnavailableError("A recorded factory memory is no longer eligible.");
  }
  return selected.map((reference) => {
    const row = byRevision.get(reference.revisionId);
    if (
      !row ||
      row.memory_id !== reference.memoryId ||
      row.approval_id !== reference.approvalId ||
      row.content_sha256 !== reference.sha256 ||
      !sameFingerprint(row.body_md, reference)
    ) {
      throw new FrozenRunContextUnavailableError("A recorded factory memory changed.");
    }
    return factoryMemoryPromptValue(row);
  });
}

export async function readRunContextOrigin(scope: ContextScope): Promise<RunContextOrigin> {
  scope.signal?.throwIfAborted();
  const read = scope.admin.rpc("read_factory_run_context_origin", attemptArgs(scope));
  const { data, error } = await (scope.signal ? read.abortSignal(scope.signal) : read).single();
  const decoded = originSchema.safeParse(data);
  if (error || !decoded.success || decoded.data.status === "missing") {
    throw new FrozenRunContextUnavailableError("The original attempt manifest could not be read.");
  }
  return decoded.data;
}

const repositoryKey = z.tuple([
  z.literal("repository"),
  z.string().uuid(),
  z.string().regex(/^[a-f0-9]{40}$/),
]);

export function frozenRepositoryCommits(origin: RunContextOrigin | undefined) {
  if (origin?.status !== "replay") return undefined;
  const commits = new Map<string, string>();
  for (const { key } of origin.manifest.required) {
    if (!key.startsWith("repository/")) continue;
    const result = repositoryKey.safeParse(key.split("/"));
    if (!result.success || commits.has(result.data[1])) {
      throw new FrozenRunContextUnavailableError(
        "An exact read-context repository is unavailable.",
      );
    }
    commits.set(result.data[1], result.data[2]);
  }
  return commits;
}

/** Pin or restore the finite set of context inputs for this exact attempt. */
export async function prepareRunContext(
  scope: ContextScope,
  input: {
    references: ContextReference;
    requiredInputs: ReturnType<typeof requiredRunContextInputs>;
    origin?: RunContextOrigin;
  },
) {
  const origin = input.origin ?? (await readRunContextOrigin(scope));
  let packed: ReturnType<typeof packRunContext>;
  if (origin.status === "replay") {
    const { manifest } = origin;
    if (
      input.requiredInputs.length !== manifest.required.length ||
      input.requiredInputs.some(
        ({ key, body }, i) =>
          key !== manifest.required[i].key || !sameFingerprint(body, manifest.required[i]),
      )
    ) {
      throw new FrozenRunContextUnavailableError(
        "The original required prompt, feedback or predecessor is missing or changed.",
      );
    }
    const [documents, conversationMessages, memories] = await Promise.all([
      restoreDocuments(scope, manifest),
      restoreConversation(scope, manifest),
      restoreFactoryMemories(scope, manifest),
    ]);
    packed = { manifest, documents, conversationMessages, memories };
  } else {
    const [retrieval, conversation, memories] = await Promise.all([
      retrieveFactoryContextDocuments({ ...scope, references: input.references }),
      readNewConversation(scope),
      readFactoryMemories(scope),
    ]);
    packed = packRunContext({
      requiredInputs: input.requiredInputs,
      retrieval,
      conversation,
      memories,
    });
  }

  scope.signal?.throwIfAborted();
  const pin = scope.admin.rpc("pin_factory_run_context", {
    ...attemptArgs(scope),
    p_manifest: packed.manifest,
    ...(origin.status === "replay" ? { p_origin_run_id: origin.origin_run_id } : {}),
  });
  const persisted = await (scope.signal ? pin.abortSignal(scope.signal) : pin);
  if (persisted.error || !persisted.data) {
    throw new FrozenRunContextUnavailableError("The exact attempt no longer owns the manifest.");
  }
  const conversation = packed.conversationMessages.map(({ sequence, body }) =>
    untrustedPromptValue(`conversation.message.${sequence}`, body),
  );
  return {
    manifest: packed.manifest,
    documents: packed.documents,
    conversation,
    memories: packed.memories,
    memoryProposalsEnabled: packed.manifest.version === 2,
  };
}
