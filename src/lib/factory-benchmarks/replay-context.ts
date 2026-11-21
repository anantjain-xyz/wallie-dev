import "server-only";

import { formatRunContextMessage } from "@/lib/run-context/conversation";
import type { RunContextManifest } from "@/lib/run-context/contracts";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";

import type { resolveBenchmarkCapture } from "./capture";
import { BenchmarkReplayUnavailable, replaySha256 } from "./replay-contracts";

type Scope = Awaited<ReturnType<typeof resolveBenchmarkCapture>>;

function verifyBody(body: string, expected: { sha256: string; utf8Bytes: number }) {
  const actual = fingerprintRunContextInput(body);
  if (actual.sha256 !== expected.sha256 || actual.utf8Bytes !== expected.utf8Bytes) {
    throw new BenchmarkReplayUnavailable("A recorded context body changed.");
  }
  return body;
}

async function restoreDocuments(
  scope: Scope,
  manifest: RunContextManifest,
  grant: { id: string | null; version: number | null },
) {
  const documents = manifest.documents.filter((document) => document.status === "selected");
  if (!documents.length) return [];
  if (!grant.id || grant.version === null)
    throw new BenchmarkReplayUnavailable("The original document access grant is unavailable.");
  const workspaceId = scope.access.workspace.id;
  const sourceIds = documents.map(({ sourceId }) => sourceId);
  const [access, sources, revisions] = await Promise.all([
    scope.access.supabase.rpc("list_factory_context_source_access", {
      target_workspace_id: workspaceId,
      target_factory_id: scope.factoryId,
      target_source_ids: sourceIds,
    }),
    scope.admin
      .from("factory_context_sources")
      .select("id, grant_id, grant_version, file_path")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", scope.factoryId)
      .in("id", sourceIds),
    scope.admin
      .from("factory_context_source_revisions")
      .select("id, source_id, upstream_revision, content_sha256, content")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", scope.factoryId)
      .is("content_purged_at", null)
      .in(
        "id",
        documents.map(({ revisionId }) => revisionId),
      ),
  ]);
  if (access.error || sources.error || revisions.error) {
    throw new BenchmarkReplayUnavailable("Recorded document access could not be verified.");
  }
  return documents.map((document) => {
    const source = sources.data.find(({ id }) => id === document.sourceId);
    const revision = revisions.data.find(({ id }) => id === document.revisionId);
    if (
      access.data.find(({ source_id }) => source_id === document.sourceId)?.status !==
        "available" ||
      !source ||
      source.grant_id !== grant.id ||
      source.grant_version !== grant.version
    ) {
      throw new BenchmarkReplayUnavailable(
        "Current access to a recorded context document is unavailable.",
      );
    }
    if (
      !revision ||
      revision.source_id !== source.id ||
      source.file_path !== document.filePath ||
      revision.upstream_revision !== document.upstreamRevision ||
      revision.content_sha256 !== document.contentSha256 ||
      revision.content === null ||
      Buffer.byteLength(revision.content) !== document.contentBytes ||
      replaySha256(revision.content) !== document.contentSha256
    ) {
      throw new BenchmarkReplayUnavailable("A recorded context document is missing or changed.");
    }
    return {
      revisionId: document.revisionId,
      body: verifyBody(
        [
          `File ${document.filePath}`,
          `Git revision ${document.upstreamRevision}`,
          "",
          revision.content,
        ].join("\n"),
        document,
      ),
    };
  });
}

async function restoreMemories(scope: Scope, manifest: RunContextManifest) {
  const memories =
    manifest.version === 2
      ? manifest.memories.filter((memory) => memory.status === "selected")
      : [];
  if (!memories.length) return [];
  const { data, error } = await scope.admin.rpc("read_factory_memory_context", {
    p_workspace_id: scope.access.workspace.id,
    p_factory_id: scope.factoryId,
    p_revision_ids: memories.map(({ revisionId }) => revisionId),
  });
  if (error) throw error;
  return memories.map((memory) => {
    const row = data.find(({ revision_id }) => revision_id === memory.revisionId);
    if (
      !row ||
      row.memory_id !== memory.memoryId ||
      row.approval_id !== memory.approvalId ||
      row.content_sha256 !== memory.sha256
    ) {
      throw new BenchmarkReplayUnavailable("A recorded memory revision is no longer accessible.");
    }
    return { revisionId: memory.revisionId, body: verifyBody(row.body_md, memory) };
  });
}

async function restoreConversation(scope: Scope, manifest: RunContextManifest) {
  const messages = manifest.conversation.messages.filter((message) => "sha256" in message);
  if (!messages.length) return [];
  const { data, error } = await scope.admin
    .from("session_conversation_messages")
    .select("sequence, author_label, body_md, body_truncated")
    .eq("workspace_id", scope.access.workspace.id)
    .eq("factory_id", scope.factoryId)
    .eq("session_id", scope.run.session_id)
    .eq("kind", "message")
    .in(
      "sequence",
      messages.map(({ sequence }) => sequence),
    );
  if (error) throw error;
  return messages.map((message) => {
    const row = data.find(({ sequence }) => sequence === message.sequence);
    if (!row)
      throw new BenchmarkReplayUnavailable("A recorded conversation message is unavailable.");
    return {
      sequence: message.sequence,
      body: verifyBody(formatRunContextMessage(row).body, message),
    };
  });
}

export async function readReplayContext(
  scope: Scope,
  manifest: RunContextManifest,
  grant: { id: string | null; version: number | null },
) {
  const [documents, memories, conversation] = await Promise.all([
    restoreDocuments(scope, manifest, grant),
    restoreMemories(scope, manifest),
    restoreConversation(scope, manifest),
  ]);
  return { documents, memories, conversation };
}
