import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import { untrustedPromptValue, type UntrustedPromptValue } from "@/lib/pipeline/prompt-safety";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  contextDocumentReferencesSchema,
  contextFilePathSchema,
  type ContextDocumentReference,
} from "./contracts";
import { verifyLiveGitHubContextRevision } from "./github-source";

type RetrievalInput = {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  workspaceId: string;
  jobId: string;
  runId: string;
  attemptCount: number;
  references: readonly ContextDocumentReference[];
  signal?: AbortSignal;
};

const maxContextBytes = 128 * 1024;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const exactMetadata = {
  file_path: contextFilePathSchema,
  upstream_revision: z.string().regex(/^[a-f0-9]{40}$/),
  content_sha256: sha256,
  content_bytes: z.number().int().min(0).max(maxContextBytes),
  stale: z.boolean(),
};
const rejectedStatus = z.enum([
  "not_selected",
  "missing_revision",
  "source_unavailable",
  "access_revoked",
  "revision_changed",
]);
const rejectedRow = z.object({ status: rejectedStatus, content: z.null() });
const contextCandidate = z.object({
  ...exactMetadata,
  status: z.literal("candidate"),
  installation_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  repository_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  repository_full_name: z.string().min(1),
  content: z.null(),
});
const contextSelection = z.object({
  ...exactMetadata,
  status: z.literal("selected"),
  content: z.string(),
});

type ContextReceipt = ContextDocumentReference &
  (
    | {
        status: "selected";
        reason: "exact_revision";
        filePath: string;
        upstreamRevision: string;
        contentSha256: string;
        contentBytes: number;
        stale: boolean;
      }
    | { status: "excluded"; reason: "not_selected" | "byte_limit" }
    | {
        status: "unavailable";
        reason:
          | Exclude<z.infer<typeof rejectedStatus>, "not_selected">
          | "upstream_deleted"
          | "upstream_unavailable"
          | "revision_mismatch";
      }
  );

function rejectedReceipt(
  reference: ContextDocumentReference,
  reason: z.infer<typeof rejectedStatus>,
): ContextReceipt {
  return reason === "not_selected"
    ? { ...reference, status: "excluded", reason }
    : { ...reference, status: "unavailable", reason };
}

async function readRevision(
  input: RetrievalInput,
  reference: ContextDocumentReference,
  verifiedDigest?: string,
) {
  input.signal?.throwIfAborted();
  const query = input.admin.rpc("read_factory_run_context_revision", {
    p_workspace_id: input.workspaceId,
    p_job_id: input.jobId,
    p_run_id: input.runId,
    p_attempt_count: input.attemptCount,
    p_source_id: reference.sourceId,
    p_revision_id: reference.revisionId,
    ...(verifiedDigest ? { p_expected_content_sha256: verifiedDigest } : {}),
  });
  const { data, error } = await (input.signal ? query.abortSignal(input.signal) : query).single();
  input.signal?.throwIfAborted();
  if (error) throw new Error("Could not verify a configured context revision for this attempt.");
  return data;
}

/** Current upstream proof is required even when the immutable body is already stored locally. */
export async function retrieveFactoryContextDocuments(input: RetrievalInput): Promise<{
  documents: UntrustedPromptValue[];
  receipts: ContextReceipt[];
}> {
  const documents: UntrustedPromptValue[] = [];
  const receipts: ContextReceipt[] = [];
  if (!input.references.length) return { documents, receipts };

  const references = contextDocumentReferencesSchema.parse(input.references);
  const candidates = await Promise.all(
    references.map(async (reference) => ({
      reference,
      candidate: contextCandidate.or(rejectedRow).parse(await readRevision(input, reference)),
    })),
  );
  const checked = await Promise.all(
    candidates.map(async ({ reference, candidate }) => ({
      reference,
      proof:
        candidate.status === "candidate"
          ? await verifyLiveGitHubContextRevision({
              installationId: candidate.installation_id,
              repositoryId: candidate.repository_id,
              repositoryFullName: candidate.repository_full_name,
              filePath: candidate.file_path,
              upstreamRevision: candidate.upstream_revision,
              contentSha256: candidate.content_sha256,
              signal: input.signal,
            })
          : null,
      candidate,
    })),
  );

  let remainingBytes = maxContextBytes;
  for (const { reference, candidate, proof } of checked) {
    if (candidate.status !== "candidate") {
      receipts.push(rejectedReceipt(reference, candidate.status));
      continue;
    }
    if (proof?.status !== "verified") {
      const reason =
        !proof || proof.status === "unavailable" ? "upstream_unavailable" : proof.status;
      receipts.push({ ...reference, status: "unavailable", reason });
      continue;
    }
    if (candidate.content_bytes > remainingBytes) {
      receipts.push({ ...reference, status: "excluded", reason: "byte_limit" });
      continue;
    }

    const revision = contextSelection
      .or(rejectedRow)
      .parse(await readRevision(input, reference, candidate.content_sha256));
    if (revision.status !== "selected") {
      receipts.push(rejectedReceipt(reference, revision.status));
      continue;
    }
    if (
      revision.content_sha256 !== candidate.content_sha256 ||
      revision.upstream_revision !== candidate.upstream_revision ||
      revision.content_bytes !== candidate.content_bytes ||
      revision.file_path !== candidate.file_path ||
      new TextEncoder().encode(revision.content).byteLength !== revision.content_bytes ||
      createHash("sha256").update(revision.content).digest("hex") !== revision.content_sha256
    ) {
      receipts.push({ ...reference, status: "unavailable", reason: "revision_changed" });
      continue;
    }

    remainingBytes -= revision.content_bytes;
    documents.push(
      untrustedPromptValue(
        `context.document.${reference.sourceId}.${reference.revisionId}`,
        [
          "File " + revision.file_path,
          "Git revision " + revision.upstream_revision,
          "",
          revision.content,
        ].join("\n"),
      ),
    );
    receipts.push({
      ...reference,
      status: "selected",
      reason: "exact_revision",
      filePath: revision.file_path,
      upstreamRevision: revision.upstream_revision,
      contentSha256: revision.content_sha256,
      contentBytes: revision.content_bytes,
      stale: revision.stale || proof.currentContentSha256 !== revision.content_sha256,
    });
  }
  input.signal?.throwIfAborted();
  return { documents, receipts };
}
