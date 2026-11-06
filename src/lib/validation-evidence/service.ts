import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import type { Database, Json } from "@/lib/supabase/database.types";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";
import type { captureValidationEvidence } from "./capture";

export const VALIDATION_EVIDENCE_BUCKET = "session-validation-evidence";
type CapturedEvidence = Awaited<ReturnType<typeof captureValidationEvidence>>;
type AdminClient = SupabaseClient<Database>;

/** Analysis policies suppress execution; unknown policies never invent evidence. */
export async function shouldCaptureValidationEvidence(
  admin: AdminClient,
  workspaceId: string,
  pipelineId: string,
): Promise<boolean> {
  const { data: policy, error } = await admin
    .from("delivery_policies")
    .select("current_revision_id")
    .eq("workspace_id", workspaceId)
    .eq("pipeline_id", pipelineId)
    .maybeSingle();
  if (error) throw new Error("Validation policy is unavailable.");
  if (!policy) return true;
  const { data: revision, error: revisionError } = await admin
    .from("delivery_policy_revisions")
    .select("requirements")
    .eq("id", policy.current_revision_id)
    .eq("workspace_id", workspaceId)
    .eq("pipeline_id", pipelineId)
    .single();
  if (revisionError || !revision) throw new Error("Validation policy is unavailable.");
  const requirements = deliveryRequirementsSchema.safeParse(revision.requirements);
  if (!requirements.success) throw new Error("Validation policy is unsupported.");
  return requirements.data.deliveryMode === "code";
}

/** Persist only already-redacted bytes. Storage identity is a path+digest, never a signed URL. */
export async function persistValidationEvidence(input: {
  admin: AdminClient;
  workspaceId: string;
  runId: string;
  evidence: CapturedEvidence;
  signal?: AbortSignal;
}) {
  const { admin, evidence, runId, workspaceId, signal } = input;
  const manifests: Array<{
    id: string;
    key: string;
    kind: string;
    required: boolean;
    storagePath: string;
    sha256: string;
    contentType: string;
    sizeBytes: number;
  }> = [];
  signal?.throwIfAborted();
  for (const asset of evidence.assets) {
    signal?.throwIfAborted();
    const storagePath = `${workspaceId}/${runId}/${asset.id}`;
    try {
      const { error } = await uploadWorkspaceObject(admin, {
        bucket: VALIDATION_EVIDENCE_BUCKET,
        bytes: asset.bytes,
        contentType: asset.contentType,
        path: storagePath,
        workspaceId,
      });
      if (error) throw new Error("Upload unavailable.");
    } catch {
      // Even optional assets are retained in the capture result only when durable.
      // A missing required asset changes its command outcome below.
      continue;
    }
    manifests.push({
      id: asset.id,
      key: asset.key,
      kind: asset.kind,
      required: asset.required,
      storagePath,
      sha256: createHash("sha256").update(asset.bytes).digest("hex"),
      contentType: asset.contentType,
      sizeBytes: asset.bytes.length,
    });
  }
  const missing = new Set(
    evidence.assets
      .filter((asset) => asset.required && !manifests.some((entry) => entry.id === asset.id))
      .map((asset) => asset.key),
  );
  const records = evidence.records.map((record) => {
    const missingRequiredReports = [
      ...new Set([
        ...record.missingRequiredReports,
        ...record.reportKeys.filter((key) => missing.has(key)),
      ]),
    ];
    return {
      ...record,
      missingRequiredReports,
      status:
        record.status === "passed" && missingRequiredReports.length ? "failed" : record.status,
    };
  });
  signal?.throwIfAborted();
  const request = admin.rpc("record_session_validation_evidence", {
    p_run_id: runId,
    p_commit_sha: evidence.commitSha,
    p_validation_tree_sha: evidence.treeSha,
    p_records: records as unknown as Json,
    p_assets: manifests as unknown as Json,
  });
  const { error } = await (signal ? request.abortSignal(signal) : request);
  signal?.throwIfAborted();
  if (error) throw new Error("Validation evidence could not be recorded.");
}

/** Always preserve post-validation source, including edits made by a failed command. */
export async function validateCheckpoint(input: {
  admin: AdminClient;
  workspaceId: string;
  pipelineId: string;
  runId: string;
  sandbox: import("@/lib/sandbox/types").SandboxHandle;
  checkpoint: import("@/lib/pipeline/source-checkpoint").SourceCheckpoint;
  secrets: string[];
  signal?: AbortSignal;
}) {
  const { captureValidationEvidence } = await import("./capture");
  const { captureSourceCheckpoint } = await import("@/lib/pipeline/source-checkpoint");
  let evidence: CapturedEvidence | null = null;
  try {
    if (!(await shouldCaptureValidationEvidence(input.admin, input.workspaceId, input.pipelineId)))
      return input.checkpoint;
    evidence = await captureValidationEvidence({
      sandbox: input.sandbox,
      commitSha: input.checkpoint.headSha,
      secrets: input.secrets,
      signal: input.signal,
    });
  } catch {
    input.signal?.throwIfAborted();
    // No receipt is a nonpassing result. Agent markdown cannot replace it.
    // Provider failures may contain secrets, so never log their text.
  }
  input.signal?.throwIfAborted();
  const checkpoint = await captureSourceCheckpoint({
    sandbox: input.sandbox,
    baseSha: input.checkpoint.baseSha,
    sensitiveValues: input.secrets,
    signal: input.signal,
  });
  if (evidence) {
    if (checkpoint.headSha !== evidence.commitSha) {
      // The validation command edited files; the final retained code is different.
      // Mark every earlier receipt stale even if a command reported exit zero.
      evidence.records = evidence.records.map((record) => ({ ...record, status: "stale" }));
      evidence.commitSha = checkpoint.headSha;
      const process = await input.sandbox.exec("git", ["rev-parse", "--verify", "HEAD^{tree}"], {
        signal: input.signal,
      });
      const [output, code] = await Promise.all([process.output(), process.exitCode]);
      if (code !== 0 || !/^[a-f0-9]{40}$/.test(output.stdout.trim())) return checkpoint;
      evidence.treeSha = output.stdout.trim();
    }
    try {
      await persistValidationEvidence({ ...input, evidence });
    } catch {
      input.signal?.throwIfAborted();
      // Evidence outages must not discard durable source work. Readiness needs
      // an immutable receipt and therefore cannot pass when this write is absent.
    }
  }
  return checkpoint;
}
