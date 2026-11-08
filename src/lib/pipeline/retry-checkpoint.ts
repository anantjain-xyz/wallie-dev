import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SandboxHandle } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";

import { restoreRetryCheckpoint } from "./retry-checkpoint-git";
import {
  captureCommittedSourceCheckpoint,
  readSourceBase,
  SOURCE_CHECKPOINT_BUCKET,
} from "./source-checkpoint";

type RetryCheckpointContext = {
  admin: SupabaseClient<Database>;
  attemptCount: number;
  baseSha: string;
  jobId: string;
  runId: string;
  sandbox: SandboxHandle;
};

export async function saveRetryCheckpoint(
  input: RetryCheckpointContext & {
    deadlineAt: string;
    sensitiveValues: () => Promise<readonly string[]>;
    signal: AbortSignal;
    workspaceId: string;
  },
): Promise<boolean> {
  const { admin, sandbox, baseSha, runId, attemptCount, signal } = input;
  const headSha = await readSourceBase(sandbox, signal);
  if (headSha === baseSha) return false;

  // Resolve the credential set after pinning HEAD so a refresh cannot add
  // sensitive material to that commit after we take the list.
  const sensitiveValues = await input.sensitiveValues();
  signal.throwIfAborted();
  const checkpoint = await captureCommittedSourceCheckpoint({
    sandbox,
    baseSha,
    headSha,
    sensitiveValues,
    signal,
  });
  if (checkpoint.kind !== "bundle") return false;
  signal.throwIfAborted();

  const path = `${input.workspaceId}/${runId}-retry-${attemptCount}-${randomUUID()}.bundle`;
  const { error: uploadError, operationId } = await uploadWorkspaceObject(admin, {
    bucket: SOURCE_CHECKPOINT_BUCKET,
    bytes: checkpoint.bytes,
    contentType: "application/octet-stream",
    deferTransfer: true,
    path,
    signal,
    workspaceId: input.workspaceId,
  });
  if (uploadError) throw new Error("Could not store the Retry checkpoint.");
  signal.throwIfAborted();

  const { data, error } = await admin
    .rpc("save_session_retry_checkpoint", {
      p_job_id: input.jobId,
      p_attempt_count: attemptCount,
      p_run_id: runId,
      p_input_sha: baseSha,
      p_head_sha: checkpoint.headSha,
      p_bundle_sha256: checkpoint.sha256,
      p_checkpoint_path: path,
      p_deadline_at: input.deadlineAt,
      p_upload_operation_id: operationId,
    })
    .abortSignal(signal);
  if (error) throw new Error("Could not record the Retry checkpoint.");
  return data === true;
}

export async function restoreRetryInput(
  input: RetryCheckpointContext & { signal?: AbortSignal },
): Promise<boolean> {
  const { admin, sandbox, baseSha, signal } = input;
  const request = admin.rpc("get_session_retry_checkpoint", {
    p_job_id: input.jobId,
    p_attempt_count: input.attemptCount,
    p_run_id: input.runId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw new Error("Could not read the Retry checkpoint.");
  const checkpoint = data?.[0];
  if (!checkpoint) return false;
  if (checkpoint.input_sha !== baseSha) {
    throw new Error("The Retry checkpoint belongs to a different source input.");
  }

  signal?.throwIfAborted();
  const { data: bundle, error: downloadError } = await admin.storage
    .from(SOURCE_CHECKPOINT_BUCKET)
    .download(checkpoint.checkpoint_path, {}, { signal });
  if (downloadError || !bundle) throw new Error("Could not download the Retry checkpoint.");
  signal?.throwIfAborted();

  await restoreRetryCheckpoint({
    sandbox,
    baseSha,
    headSha: checkpoint.head_sha,
    bytes: Buffer.from(await bundle.arrayBuffer()),
    sha256: checkpoint.bundle_sha256,
    signal,
  });
  return true;
}
