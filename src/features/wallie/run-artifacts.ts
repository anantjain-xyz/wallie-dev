import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  runArtifactAvailabilitySchema,
  runArtifactCursorSchema,
  runArtifactKindSchema,
  type RunArtifactKind,
} from "@/features/wallie/run-artifacts-contracts";
import type { Database } from "@/lib/supabase/database.types";
import { readPrivateValidationAsset } from "@/lib/validation-evidence/private-asset";

const MAX_DOWNLOAD_BYTES = 1024 * 1024;
const DEFAULT_PAGE_SIZE = 20;

type RunScope = {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  runId: string;
};
type ArtifactTarget = { kind: RunArtifactKind; artifactId: string };

const catalogRowSchema = z.object({
  artifact_id: z.string().uuid(),
  artifact_kind: runArtifactKindSchema,
  label: z.string(),
  digest: z.string().nullable(),
  digest_algorithm: z.enum(["sha256", "git_sha1"]).nullable(),
  content_type: z.string().nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  availability: runArtifactAvailabilitySchema,
  downloadable: z.boolean(),
  run_id: z.string().uuid(),
  session_id: z.string().uuid(),
  attempt_count: z.number().int().positive(),
  checkpoint_run_id: z.string().uuid().nullable(),
  accepted_commit_sha: z.string().nullable(),
  validation_run_id: z.string().uuid().nullable(),
  validation_commit_sha: z.string().nullable(),
  validation_tree_sha: z.string().nullable(),
  recorded_at: z.string(),
});

function describeArtifact(row: z.infer<typeof catalogRowSchema>) {
  return {
    id: row.artifact_id,
    kind: row.artifact_kind,
    label: row.label,
    digest:
      row.digest && row.digest_algorithm
        ? { algorithm: row.digest_algorithm, value: row.digest }
        : null,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    availability: row.availability,
    downloadable: row.downloadable,
    producer: { runId: row.run_id, sessionId: row.session_id, attemptCount: row.attempt_count },
    checkpoint:
      row.checkpoint_run_id && row.accepted_commit_sha
        ? { runId: row.checkpoint_run_id, commitSha: row.accepted_commit_sha }
        : null,
    validation:
      row.validation_run_id && row.validation_commit_sha && row.validation_tree_sha
        ? {
            runId: row.validation_run_id,
            commitSha: row.validation_commit_sha,
            treeSha: row.validation_tree_sha,
          }
        : null,
    recordedAt: row.recorded_at,
  };
}

type RunArtifact = ReturnType<typeof describeArtifact>;

export class RunArtifactCursorError extends Error {
  constructor() {
    super("Invalid run artifact cursor.");
    this.name = "RunArtifactCursorError";
  }
}

export async function listRunArtifacts(
  scope: RunScope,
  { cursor, limit = DEFAULT_PAGE_SIZE }: { cursor?: string; limit?: number },
) {
  const after = cursor ? parseCursor(scope, cursor) : undefined;
  const owner = await scope.supabase
    .from("agent_runs")
    .select("id")
    .eq("id", scope.runId)
    .eq("workspace_id", scope.workspaceId)
    .maybeSingle();
  if (owner.error) throw owner.error;
  if (!owner.data) return null;

  const { data, error } = await scope.supabase.rpc("list_run_artifacts", {
    p_workspace_id: scope.workspaceId,
    p_run_id: scope.runId,
    ...(after ? { p_after_kind: after.kind, p_after_id: after.artifactId } : {}),
    p_limit: limit + 1,
  });
  if (error?.code === "P0002") return null;
  if (error) throw error;
  const items = (data ?? [])
    .slice(0, limit)
    .map((row) => describeArtifact(catalogRowSchema.parse(row)));
  const last = items.at(-1);
  const nextCursor =
    last && (data?.length ?? 0) > limit
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            workspaceId: scope.workspaceId,
            runId: scope.runId,
            kind: last.kind,
            artifactId: last.id,
          }),
        ).toString("base64url")
      : null;
  return { items, nextCursor };
}

export async function findRunArtifact(scope: RunScope, target: ArtifactTarget) {
  const { data, error } = await scope.supabase.rpc("list_run_artifacts", {
    p_workspace_id: scope.workspaceId,
    p_run_id: scope.runId,
    p_kind: target.kind,
    p_artifact_id: target.artifactId,
    p_limit: 1,
  });
  if (error?.code === "P0002") return null;
  if (error) throw error;
  const row = data?.[0];
  return row ? describeArtifact(catalogRowSchema.parse(row)) : null;
}

export async function readRunArtifact(
  { supabase, workspaceId }: RunScope,
  artifact: RunArtifact,
  signal: AbortSignal,
) {
  if (!artifact.downloadable) {
    switch (artifact.availability) {
      case "missing":
      case "expired":
      case "redacted":
      case "integrity_mismatch":
      case "unavailable":
        return { status: artifact.availability };
      default:
        return { status: "inaccessible" as const };
    }
  }
  if (artifact.kind === "stage_markdown") {
    const { data, error } = await supabase
      .from("session_artifacts")
      .select("artifact_json")
      .eq("id", artifact.id)
      .eq("workspace_id", workspaceId)
      .eq("session_id", artifact.producer.sessionId)
      .abortSignal(signal)
      .maybeSingle();
    if (error) return { status: "unavailable" as const };
    if (!data) return { status: "missing" as const };
    if (
      typeof data.artifact_json !== "string" ||
      Buffer.byteLength(data.artifact_json) > MAX_DOWNLOAD_BYTES
    ) {
      return { status: "integrity_mismatch" as const };
    }
    const bytes = new TextEncoder().encode(data.artifact_json);
    if (
      bytes.length !== artifact.sizeBytes ||
      artifact.digest?.algorithm !== "sha256" ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.digest.value
    ) {
      return { status: "integrity_mismatch" as const };
    }
    return { status: "available" as const, bytes };
  }

  const { data, error } = await supabase
    .from("session_validation_assets")
    .select("id, run_id, storage_path, sha256, content_type, size_bytes")
    .eq("id", artifact.id)
    .eq("workspace_id", workspaceId)
    .eq("session_id", artifact.producer.sessionId)
    .eq("run_id", artifact.producer.runId)
    .abortSignal(signal)
    .maybeSingle();
  if (error) return { status: "unavailable" as const };
  if (!data) return { status: "missing" as const };
  if (
    artifact.digest?.algorithm !== "sha256" ||
    data.sha256 !== artifact.digest.value ||
    data.size_bytes !== artifact.sizeBytes ||
    data.content_type !== artifact.contentType
  ) {
    return { status: "integrity_mismatch" as const };
  }
  return readPrivateValidationAsset({ supabase, workspaceId, asset: data, signal });
}

function parseCursor(scope: RunScope, cursor: string) {
  try {
    const parsed = runArtifactCursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (parsed.workspaceId === scope.workspaceId && parsed.runId === scope.runId) return parsed;
  } catch {
    // Malformed cursors use the same response as cursors for another run.
  }
  throw new RunArtifactCursorError();
}
