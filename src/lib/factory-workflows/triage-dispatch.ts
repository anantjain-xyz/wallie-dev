import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { workflowNodeIdSchema } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import { executeFactoryWorkflowOccurrence } from "./execute";

const claimSchema = z
  .object({
    root_session_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    factory_id: z.string().uuid(),
    occurrence_id: z.string().uuid(),
    node_id: workflowNodeIdSchema,
    workflow_digest: z.string().regex(/^[a-f0-9]{64}$/),
    execution_generation: z.number().int().positive().safe(),
    ownership_token: z.string().uuid(),
  })
  .strict();

/** Take one ready route during the existing maintenance pass. */
export async function drainAcceptedTriageRoute(admin: SupabaseClient<Database>) {
  const candidate = randomUUID();
  const acquire = async () => {
    const { data, error } = await admin
      .rpc("claim_factory_workflow_accepted_triage_route", { p_candidate_token: candidate })
      .maybeSingle();
    if (error) throw error;
    return data;
  };

  let claimed;
  try {
    claimed = await acquire();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code) throw error;
    claimed = await acquire();
  }
  if (!claimed) return;
  const claim = claimSchema.parse(claimed);
  if (claim.ownership_token !== candidate) {
    throw new Error("The triage route lease returned a different ownership token.");
  }

  const scope = {
    p_root_session_id: claim.root_session_id,
    p_workspace_id: claim.workspace_id,
    p_factory_id: claim.factory_id,
    p_expected_generation: claim.execution_generation,
    p_ownership_token: claim.ownership_token,
  };
  let completed = false;
  try {
    const result = await executeFactoryWorkflowOccurrence(
      admin,
      {
        ...scope,
        occurrenceId: claim.occurrence_id,
        nodeId: claim.node_id,
        workflowDigest: claim.workflow_digest,
      },
      { signal: AbortSignal.timeout(60_000) },
    );
    const foreman = "foreman" in result ? result.foreman : undefined;
    if (foreman) {
      completed = foreman.status === "completed" || foreman.status === "blocked";
    } else {
      completed = result.status === "route_decided";
    }
  } finally {
    const { error } = await admin.rpc("finish_factory_workflow_accepted_triage_route", {
      ...scope,
      p_occurrence_id: claim.occurrence_id,
      p_completed: completed,
    });
    if (error) throw error;
  }
}
