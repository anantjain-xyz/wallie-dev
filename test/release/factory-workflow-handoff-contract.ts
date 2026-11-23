import assert from "node:assert/strict";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

const uuid = z.string().uuid();
export const workflowHandoffWitness = z.object({
  workspaceId: uuid,
  factoryId: uuid,
  memberId: uuid,
  sessionId: uuid,
  jobId: uuid,
  inputRunId: uuid,
  graphRevisionId: uuid,
  activationId: uuid,
  workflowDigest: z.string().regex(/^[a-f0-9]{64}$/),
  stageId: uuid,
  artifactId: uuid,
  artifactVersion: z.number().int().positive(),
  reviewRevision: z.number().int().nonnegative(),
  policyRevisionId: uuid,
});
export const abandonedWorkflowLease = z.object({
  leaseId: uuid,
  generation: z.number().int().positive(),
  occurrenceId: uuid,
});
const snapshotShape = z.object({
  execution: z.object({
    graph_revision_id: uuid,
    graph_input_run_id: uuid,
    workflow_digest: z.string(),
    generation: z.number().int().positive(),
  }),
  occurrences: z.array(z.object({ occurrence_id: uuid, node_id: z.string() })),
  results: z.array(z.object({ occurrence_id: uuid, evidence_ref: z.string().nullable() })),
});

export type WorkflowHandoffWitness = z.infer<typeof workflowHandoffWitness>;
type Snapshot = z.infer<typeof snapshotShape>;
type Client = SupabaseClient<Database>;

export function getWorkflowHandoffResult(graph: Snapshot, nodeId: string) {
  const occurrence = graph.occurrences.find((item) => item.node_id === nodeId);
  const results = graph.results.filter((item) => item.occurrence_id === occurrence?.occurrence_id);
  assert(results.length <= 1, `Repeated result for ${nodeId}.`);
  return results[0]?.evidence_ref ?? null;
}

export async function readWorkflowHandoff(admin: Client, witness: WorkflowHandoffWitness) {
  const { data, error } = await admin.rpc("read_factory_workflow_execution", {
    p_root_session_id: witness.sessionId,
    p_workspace_id: witness.workspaceId,
    p_factory_id: witness.factoryId,
  });
  assert(!error, error?.message);
  const graph = snapshotShape.parse(data);
  assert.equal(graph.execution.graph_revision_id, witness.graphRevisionId);
  assert.equal(graph.execution.graph_input_run_id, witness.inputRunId);
  assert.equal(graph.execution.workflow_digest, witness.workflowDigest);
  return graph;
}

export const WORKFLOW_ABANDONED_EXIT = 73;
