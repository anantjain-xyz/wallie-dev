import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  createGitHubResourceReader,
  GitHubAccessError,
  verifyLiveGitHubContextRevision,
} from "@/lib/factory-context/github-source";
import { runContextManifestSchema } from "@/lib/run-context/contracts";
import { formatRunContextMessage } from "@/lib/run-context/conversation";
import { fingerprintRunContextInput } from "@/lib/run-context/packing";
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";

import type { BenchmarkCapturePreview } from "./capture-contracts";
import { verifyRequiredRunInputs } from "./capture-required";

type Scope = {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  access: WorkspaceAccessContext;
  factoryId: string;
  run: Pick<Tables<"agent_runs">, "id" | "session_id" | "agent_job_id" | "attempt_count">;
};
type SourcePreview = BenchmarkCapturePreview["source"];
type RunManifest = z.infer<typeof runContextManifestSchema>;
type SourceManifest = Pick<
  Tables<"session_attempt_manifests">,
  "repository_id" | "input_ref" | "input_sha" | "checkout_sha" | "retry_source_run_id"
>;

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const refResult = z.object({
  ref: z.string(),
  object: z.object({ type: z.literal("commit"), sha: shaSchema }),
});
const gitReadTimeoutMs = 10_000;

export async function verifyBenchmarkGitStart(
  repository: Parameters<typeof createGitHubResourceReader>[0],
  manifest: Pick<SourceManifest, "input_ref" | "input_sha">,
): Promise<"verified" | "unavailable" | "access_revoked"> {
  if (!shaSchema.safeParse(manifest.input_sha).success) return "unavailable";
  const ref = manifest.input_ref;
  const refSegments = ref?.slice("refs/".length).split("/");
  if (
    ref !== null &&
    (!ref.startsWith("refs/") ||
      refSegments?.some((part) => !part || part === "." || part === ".."))
  ) {
    return "unavailable";
  }
  try {
    const read = await createGitHubResourceReader(
      repository,
      AbortSignal.timeout(gitReadTimeoutMs),
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    if (refSegments && ref) {
      const bytes = await read(
        `git/ref/${refSegments.map(encodeURIComponent).join("/")}`,
        16 * 1024,
      );
      const resolved = refResult.parse(JSON.parse(decoder.decode(bytes)));
      return resolved.ref === ref && resolved.object.sha === manifest.input_sha
        ? "verified"
        : "unavailable";
    }
    const bytes = await read(`commits/${manifest.input_sha}`, 64, "application/vnd.github.sha");
    return decoder.decode(bytes).trim() === manifest.input_sha ? "verified" : "unavailable";
  } catch (error) {
    return error instanceof GitHubAccessError ? "access_revoked" : "unavailable";
  }
}

async function readConnectedRepository(scope: Scope, repositoryId: string) {
  const { data, error } = await scope.admin
    .from("github_repositories")
    .select(
      "repo_id, full_name, github_installation_id, github_installations!inner(installation_id, suspended, workspace_id)",
    )
    .eq("id", repositoryId)
    .eq("workspace_id", scope.access.workspace.id)
    .eq("factory_id", scope.factoryId)
    .eq("github_installations.workspace_id", scope.access.workspace.id)
    .eq("github_installations.suspended", false)
    .maybeSingle();
  if (error) throw error;
  if (
    !data ||
    !Number.isSafeInteger(data.repo_id) ||
    !Number.isSafeInteger(data.github_installations.installation_id)
  ) {
    return null;
  }
  return {
    recordedInstallationId: data.github_installation_id,
    installationId: data.github_installations.installation_id,
    repositoryId: data.repo_id,
    repositoryFullName: data.full_name,
  };
}

async function verifyBase(scope: Scope, manifest: SourceManifest): Promise<string | null> {
  const repository = await readConnectedRepository(scope, manifest.repository_id);
  if (!repository) return "Current access to the starting repository is unavailable.";
  const outcome = await verifyBenchmarkGitStart(repository, manifest);
  if (outcome === "access_revoked") return "Current access to the starting repository was revoked.";
  if (outcome === "unavailable")
    return "The exact starting source reference is missing or changed.";

  if (!manifest.retry_source_run_id) return null;
  const { data, error } = await scope.admin
    .from("session_retry_checkpoints")
    .select("checkpoint_path")
    .eq("workspace_id", scope.access.workspace.id)
    .eq("source_run_id", manifest.retry_source_run_id)
    .eq("input_sha", manifest.input_sha)
    .eq("head_sha", manifest.checkout_sha)
    .maybeSingle();
  if (error) throw error;
  if (!data) return "The original retry checkpoint is unavailable.";
  const receipt = await scope.admin.storage
    .from("session-source-checkpoints")
    .info(data.checkpoint_path);
  return receipt.error || !receipt.data ? "The original retry checkpoint is unavailable." : null;
}

async function verifyDocuments(scope: Scope, manifest: RunManifest): Promise<string | null> {
  const documents = manifest.documents.filter((document) => document.status === "selected");
  if (!documents.length) return null;

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
      .select("id, repository_id, github_installation_id, upstream_repository_id, file_path")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", scope.factoryId)
      .in("id", sourceIds),
    scope.admin
      .from("factory_context_source_revisions")
      .select("id, source_id, upstream_revision, content_sha256")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", scope.factoryId)
      .is("content_purged_at", null)
      .in(
        "id",
        documents.map(({ revisionId }) => revisionId),
      ),
  ]);
  if (access.error) {
    if (access.error.code === "42501" || access.error.code === "P0002") {
      return "Current access to a recorded context document was revoked.";
    }
    throw access.error;
  }
  if (sources.error) throw sources.error;
  if (revisions.error) throw revisions.error;

  const outcomes = await Promise.all(
    documents.map(async (document) => {
      const status = access.data.find((row) => row.source_id === document.sourceId)?.status;
      if (status === "access_revoked")
        return "Current access to a recorded context document was revoked.";
      if (status !== "available")
        return "A recorded context document was deleted or is unavailable.";
      const source = sources.data.find((row) => row.id === document.sourceId);
      const revision = revisions.data.find(({ id }) => id === document.revisionId);
      if (
        !source ||
        !revision ||
        revision.source_id !== document.sourceId ||
        revision.content_sha256 !== document.contentSha256 ||
        revision.upstream_revision !== document.upstreamRevision ||
        source.file_path !== document.filePath
      ) {
        return "A recorded context document revision is missing or changed.";
      }
      const repository = await readConnectedRepository(scope, source.repository_id);
      if (
        !repository ||
        repository.recordedInstallationId !== source.github_installation_id ||
        repository.repositoryId !== source.upstream_repository_id
      ) {
        return "Current access to a recorded context document was revoked.";
      }
      const proof = await verifyLiveGitHubContextRevision({
        ...repository,
        filePath: source.file_path,
        upstreamRevision: document.upstreamRevision,
        contentSha256: document.contentSha256,
      });
      if (proof.status === "verified") return null;
      if (proof.status === "access_revoked")
        return "Current access to a recorded context document was revoked.";
      return "A recorded context document revision could not be verified.";
    }),
  );
  return outcomes.find((reason) => reason !== null) ?? null;
}

async function verifyContext(scope: Scope, manifest: RunManifest): Promise<string[]> {
  const memories =
    manifest.version === 2
      ? manifest.memories.filter((memory) => memory.status === "selected")
      : [];
  const messages = manifest.conversation.messages.filter((message) => "sha256" in message);
  const [documentError, memoryRows, conversationRows] = await Promise.all([
    verifyDocuments(scope, manifest),
    memories.length
      ? scope.admin.rpc("read_factory_memory_context", {
          p_workspace_id: scope.access.workspace.id,
          p_factory_id: scope.factoryId,
          p_revision_ids: memories.map(({ revisionId }) => revisionId),
        })
      : null,
    messages.length
      ? scope.admin
          .from("session_conversation_messages")
          .select("sequence, author_label, body_md, body_truncated")
          .eq("workspace_id", scope.access.workspace.id)
          .eq("factory_id", scope.factoryId)
          .eq("session_id", scope.run.session_id)
          .eq("kind", "message")
          .in(
            "sequence",
            messages.map(({ sequence }) => sequence),
          )
      : null,
  ]);
  if (memoryRows?.error) throw memoryRows.error;
  if (conversationRows?.error) throw conversationRows.error;

  const reasons = documentError ? [documentError] : [];
  if (
    memoryRows &&
    memories.some(
      (memory) =>
        !memoryRows.data.some(
          (row) =>
            row.revision_id === memory.revisionId &&
            row.memory_id === memory.memoryId &&
            row.approval_id === memory.approvalId &&
            row.content_sha256 === memory.sha256,
        ),
    )
  ) {
    reasons.push("A recorded memory revision is no longer available to this factory.");
  }
  if (
    conversationRows &&
    messages.some((message) => {
      const row = conversationRows.data.find(({ sequence }) => sequence === message.sequence);
      if (!row) return true;
      const { sha256, utf8Bytes } = fingerprintRunContextInput(formatRunContextMessage(row).body);
      return utf8Bytes !== message.utf8Bytes || sha256 !== message.sha256;
    })
  ) {
    reasons.push("A recorded conversation message is missing or changed.");
  }
  return reasons;
}

export async function loadBenchmarkSource(scope: Scope): Promise<SourcePreview> {
  const { workspace } = scope.access;
  const { run } = scope;
  const noAttempt =
    run.agent_job_id === null || run.attempt_count === null || run.attempt_count < 1;
  const [admission, attempt, context] = await Promise.all([
    scope.admin
      .from("session_factory_admission_inputs")
      .select(
        "original_title, original_prompt_md, prompt_sha256, definition_revision_id, definition_digest, execution_grant_id, execution_grant_version",
      )
      .eq("workspace_id", workspace.id)
      .eq("factory_id", scope.factoryId)
      .eq("session_id", run.session_id)
      .maybeSingle(),
    noAttempt
      ? null
      : scope.admin
          .from("session_attempt_manifests")
          .select(
            "repository_id, input_ref, input_sha, checkout_sha, retry_source_run_id, definition_revision_id, definition_digest, prompt_sha256",
          )
          .eq("workspace_id", workspace.id)
          .eq("session_id", run.session_id)
          .eq("run_id", run.id)
          .eq("job_id", run.agent_job_id ?? "")
          .eq("attempt_count", run.attempt_count ?? 0)
          .maybeSingle(),
    noAttempt
      ? null
      : scope.admin
          .from("session_run_context_manifests")
          .select("manifest, manifest_sha256")
          .eq("workspace_id", workspace.id)
          .eq("session_id", run.session_id)
          .eq("run_id", run.id)
          .eq("job_id", run.agent_job_id ?? "")
          .eq("attempt_count", run.attempt_count ?? 0)
          .maybeSingle(),
  ]);
  if (admission.error) throw admission.error;
  if (attempt?.error) throw attempt.error;
  if (context?.error) throw context.error;

  const original = admission.data;
  const manifest = attempt?.data ?? null;
  const parsedContext = runContextManifestSchema.safeParse(context?.data?.manifest);
  const originalPrompt =
    original?.original_prompt_md &&
    createHash("sha256").update(original.original_prompt_md).digest("hex") ===
      original.prompt_sha256
      ? original.original_prompt_md
      : null;

  const reasons: string[] = [];
  if (!originalPrompt) reasons.push("The original task request was not retained.");
  if (!manifest) reasons.push("The original attempt inputs were not retained.");
  if (!parsedContext.success) reasons.push("The original context manifest was not retained.");
  if (
    manifest &&
    (!manifest.definition_revision_id ||
      !original ||
      original.definition_revision_id !== manifest.definition_revision_id ||
      original.definition_digest !== manifest.definition_digest)
  ) {
    reasons.push("The original factory definition could not be verified.");
  }
  const [baseReason, contextReasons, requiredReasons] = await Promise.all([
    manifest ? verifyBase(scope, manifest) : null,
    parsedContext.success ? verifyContext(scope, parsedContext.data) : [],
    parsedContext.success
      ? verifyRequiredRunInputs(
          { admin: scope.admin, workspaceId: workspace.id, sessionId: run.session_id },
          parsedContext.data.required,
          { title: original?.original_title ?? null, prompt: originalPrompt },
          async ({ repositoryId, commitSha, sha256, utf8Bytes }) => {
            if (!original?.execution_grant_id || original.execution_grant_version === null)
              return false;
            const grant = await scope.admin
              .from("factory_execution_grants")
              .select("id")
              .eq("workspace_id", workspace.id)
              .eq("factory_id", scope.factoryId)
              .eq("id", original.execution_grant_id)
              .eq("version", original.execution_grant_version)
              .contains("read_context_repository_ids", [repositoryId])
              .is("revoked_at", null)
              .gt("expires_at", new Date().toISOString())
              .maybeSingle();
            if (grant.error) throw grant.error;
            if (!grant.data) return false;
            const repository = await readConnectedRepository(scope, repositoryId);
            if (!repository) return false;
            const expected = fingerprintRunContextInput(
              [repository.repositoryFullName, repository.repositoryId].join("\n"),
            );
            if (expected.sha256 !== sha256 || expected.utf8Bytes !== utf8Bytes) return false;
            return (
              (await verifyBenchmarkGitStart(repository, {
                input_sha: commitSha,
                input_ref: null,
              })) === "verified"
            );
          },
        )
      : [],
  ]);
  if (baseReason) reasons.push(baseReason);
  reasons.push(...contextReasons, ...requiredReasons);

  return {
    runId: run.id,
    sessionId: run.session_id,
    name: original?.original_title ?? `Historical run ${run.id.slice(0, 8)}`,
    originalPrompt,
    checkoutSha: manifest?.checkout_sha ?? null,
    inputRef: manifest?.input_ref ?? null,
    definitionRevisionId: manifest?.definition_revision_id ?? null,
    contextManifestSha: context?.data?.manifest_sha256 ?? null,
    recordedPromptSha: manifest?.prompt_sha256 ?? null,
    eligibility: reasons.length
      ? { status: "ineligible", reasons }
      : { status: "eligible", reasons: [] },
  };
}
