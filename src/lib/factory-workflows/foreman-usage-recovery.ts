import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import type { WorkflowOccurrencePin } from "./deterministic-command";
import { observeUntilAbort, type ForemanAccountingOutcome } from "./foreman-runtime";

type Admin = SupabaseClient<Database>;

const bucket = "factory-workflow-usage-recovery";
const recordLimit = 8192;
const recoveryOperationMs = 2_000;
const uuid = z.string().uuid();
const tokens = z.number().int().nonnegative().safe();
const journal = z.strictObject({
  version: z.literal(1),
  foremanRunId: uuid,
  issueId: uuid,
  owner: z.strictObject({
    p_root_session_id: uuid,
    p_workspace_id: uuid,
    p_factory_id: uuid,
    p_expected_generation: z.number().int().positive().safe(),
    p_ownership_token: uuid,
    occurrenceId: uuid,
    workflowDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  outcome: z.strictObject({
    status: z.literal("accounting"),
    usage: z.strictObject({
      inputTokens: tokens.nullable(),
      outputTokens: tokens.nullable(),
      costUsd: z.number().min(0).max(1_000_000_000).nullable(),
    }),
    providerReceiptId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,160}$/)
      .optional(),
  }),
});

function recordPath(pin: WorkflowOccurrencePin, runId: string) {
  return [pin.p_workspace_id, pin.p_factory_id, pin.p_root_session_id, runId].join("/") + ".enc";
}

export async function retainForemanUsage(
  admin: Admin,
  pin: WorkflowOccurrencePin,
  foremanRunId: string,
  issueId: string,
  outcome: ForemanAccountingOutcome,
) {
  const owner = {
    p_root_session_id: pin.p_root_session_id,
    p_workspace_id: pin.p_workspace_id,
    p_factory_id: pin.p_factory_id,
    p_expected_generation: pin.p_expected_generation,
    p_ownership_token: pin.p_ownership_token,
    occurrenceId: pin.occurrenceId,
    workflowDigest: pin.workflowDigest,
  };
  const record = journal.parse({ version: 1, foremanRunId, issueId, owner, outcome });
  const encrypted = encryptSecretValue(JSON.stringify(record));
  const { error } = await admin.storage
    .from(bucket)
    .upload(recordPath(pin, foremanRunId), encrypted, {
      contentType: "text/plain",
      upsert: false,
    });
  if (error) throw new Error("Could not retain foreman usage.");
}

export async function recoverForemanUsage(
  admin: Admin,
  pin: WorkflowOccurrencePin,
  runId: string,
  issuedGeneration: number,
) {
  const objects = admin.storage.from(bucket);
  const path = recordPath(pin, runId);
  const { data, error } = await objects.download(
    path,
    {},
    { signal: AbortSignal.timeout(recoveryOperationMs) },
  );
  if (error || !data || data.size > recordLimit) return null;

  const record = journal.safeParse(JSON.parse(decryptSecretValue(await data.text())));
  if (!record.success) return null;
  const { foremanRunId, issueId, owner, outcome } = record.data;
  if (
    foremanRunId !== runId ||
    owner.p_root_session_id !== pin.p_root_session_id ||
    owner.p_workspace_id !== pin.p_workspace_id ||
    owner.p_factory_id !== pin.p_factory_id ||
    owner.occurrenceId !== pin.occurrenceId ||
    owner.workflowDigest !== pin.workflowDigest ||
    owner.p_expected_generation !== issuedGeneration
  ) {
    return null;
  }

  const settled = await admin
    .rpc("settle_factory_workflow_foreman_inference", {
      p_root_session_id: owner.p_root_session_id,
      p_workspace_id: owner.p_workspace_id,
      p_factory_id: owner.p_factory_id,
      p_expected_generation: owner.p_expected_generation,
      p_ownership_token: owner.p_ownership_token,
      p_route_occurrence_id: owner.occurrenceId,
      p_issue_id: issueId,
      p_outcome: outcome,
    })
    .abortSignal(AbortSignal.timeout(recoveryOperationMs));
  if (settled.error || !settled.data) return null;

  // The database now owns the measured usage. Replaying the journal is safe
  // if deleting the encrypted object fails or the process stops here.
  await observeUntilAbort(
    objects.remove([path]).catch(() => undefined),
    AbortSignal.timeout(recoveryOperationMs),
  );
  return settled.data;
}
