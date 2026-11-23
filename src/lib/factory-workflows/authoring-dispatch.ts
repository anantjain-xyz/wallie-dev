import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { workflowNodeIdSchema } from "@/lib/factory-definitions/workflow-schema";
import { observeUntilAbort } from "@/lib/sandbox/lifecycle";
import type { Database } from "@/lib/supabase/database.types";

import { executeFactoryWorkflowOccurrence } from "./execute";

const rpcTimeoutMs = 5_000;
const uuid = z.string().uuid();
const authoredEntryClaim = z.strictObject({
  leaseId: uuid,
  leaseExpiresAt: z.string().datetime({ offset: true }),
  rootSessionId: uuid,
  workspaceId: uuid,
  factoryId: uuid,
  inputRunId: uuid,
  workflowDigest: z.string().regex(/^[a-f0-9]{64}$/),
  occurrenceId: uuid,
  nodeId: workflowNodeIdSchema,
  generation: z.number().int().positive().safe(),
  ownershipToken: uuid,
});

/** Observe one due entry while the exact adopted preparation remains its source. */
export async function drainAuthoredFactoryWorkflowEntry(admin: SupabaseClient<Database>) {
  const leaseId = randomUUID();
  const acquire = async () => {
    const { data, error } = await admin
      .rpc("claim_factory_workflow_authoring_dispatch", { p_lease_id: leaseId })
      .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
    if (error) throw error;
    return data;
  };
  let data;
  try {
    data = await acquire();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code) throw error;
    data = await acquire();
  }

  if (data === null) return;
  const claim = authoredEntryClaim.parse(data);
  if (claim.leaseId !== leaseId) throw new Error("The authored workflow lease changed.");
  const remainingMs = Date.parse(claim.leaseExpiresAt) - Date.now() - rpcTimeoutMs;
  try {
    if (remainingMs > 0) {
      const signal = AbortSignal.timeout(Math.min(remainingMs, 60_000));
      await observeUntilAbort(signal, () =>
        executeFactoryWorkflowOccurrence(
          admin,
          {
            p_root_session_id: claim.rootSessionId,
            p_workspace_id: claim.workspaceId,
            p_factory_id: claim.factoryId,
            p_expected_generation: claim.generation,
            p_ownership_token: claim.ownershipToken,
            occurrenceId: claim.occurrenceId,
            nodeId: claim.nodeId,
            workflowDigest: claim.workflowDigest,
          },
          { signal },
        ),
      );
    }
  } finally {
    const { error } = await admin
      .rpc("finish_factory_workflow_authoring_dispatch", {
        p_session_id: claim.rootSessionId,
        p_input_run_id: claim.inputRunId,
        p_lease_id: claim.leaseId,
        p_expected_generation: claim.generation,
      })
      .abortSignal(AbortSignal.timeout(rpcTimeoutMs));
    if (error) throw error;
  }
}
