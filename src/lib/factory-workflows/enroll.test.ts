import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import { enrollFactoryWorkflowGraph } from "./enroll";

vi.mock("@/lib/factory-definitions/authority", () => ({
  loadFactoryDefinitionCatalog: () => {
    throw new Error("A live catalog would reject the stored approver.");
  },
}));

vi.mock("@/lib/factory-definitions/workflow-compiler", () => ({
  compileWorkflowGraph: () => {
    throw new Error("Resume must use the stored workflow.");
  },
}));

it("resumes a stored approval entry when its approver is absent from the live catalog", async () => {
  const rootSessionId = "c5410000-0000-4000-8000-000000000001";
  const workspaceId = "c5410000-0000-4000-8000-000000000002";
  const factoryId = "c5410000-0000-4000-8000-000000000003";
  const graphRevisionId = "c5410000-0000-4000-8000-000000000004";
  const inputRunId = "c5410000-0000-4000-8000-000000000005";
  const entryId = "c5410000-0000-4000-8000-000000000006";
  const targetId = "c5410000-0000-4000-8000-000000000007";
  const resultId = "c5410000-0000-4000-8000-000000000008";
  const transitionId = "c5410000-0000-4000-8000-000000000009";
  const previousApproverId = "c5410000-0000-4000-8000-000000000011";
  const approvalId = "c5410000-0000-4000-8000-000000000012";
  const workflow = workflowGraphSchema.parse({
    schemaVersion: 1,
    kind: "graph",
    entryNodeId: "review",
    nodes: [
      { id: "check", kind: "deterministic", operation: "policy" },
      {
        id: "review",
        kind: "human-gate",
        anyoneCanApprove: false,
        approverMemberIds: [previousApproverId],
      },
    ],
    edges: [{ id: "reviewed", from: "review", to: "check", kind: "next" }],
    grants: [],
  });
  const { definitionJson: workflowJson, canonicalDigest: workflowDigest } =
    serializeFactoryDefinition(workflow);
  const scope = {
    p_root_session_id: rootSessionId,
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
  };
  let generation = 2;
  let ownershipToken: string | undefined;
  const from = vi.fn(() => {
    throw new Error("Resume must use ledger RPCs for an admitted transition.");
  });
  const rpc = vi.fn(
    (name: string, args: typeof scope & { p_candidate_ownership_token?: string }) => {
      switch (name) {
        case "read_factory_workflow_execution":
          expect(args).toEqual(scope);
          return {
            error: null,
            data: {
              execution: {
                root_session_id: rootSessionId,
                workspace_id: workspaceId,
                factory_id: factoryId,
                graph_revision_id: graphRevisionId,
                graph_input_run_id: inputRunId,
                workflow_json: workflowJson,
                workflow_digest: workflowDigest,
                generation,
              },
              occurrences: [
                { occurrence_id: targetId, node_id: "check", is_entry: false },
                { occurrence_id: entryId, node_id: "review", is_entry: true },
              ],
              results: [
                {
                  occurrence_id: entryId,
                  result_id: resultId,
                  outcome: "succeeded",
                  evidence_ref: "human-gate:" + approvalId,
                },
              ],
              transitions: [
                { source_occurrence_id: entryId, source_result_id: resultId, edge_id: "reviewed" },
              ],
            },
          };
        case "acquire_factory_workflow_ownership": {
          expect(args).toEqual({
            ...scope,
            p_expected_generation: 2,
            p_candidate_ownership_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
          });
          generation = 3;
          ownershipToken = args.p_candidate_ownership_token;
          return {
            maybeSingle: () => ({
              error: null,
              data: { execution_generation: generation, ownership_token: ownershipToken },
            }),
          };
        }
        case "admit_factory_workflow_next":
          expect(args).toEqual({
            ...scope,
            p_expected_generation: 3,
            p_ownership_token: ownershipToken,
            p_source_occurrence_id: entryId,
            p_edge_id: "reviewed",
            p_expected_result_id: resultId,
          });
          return {
            maybeSingle: () => ({
              error: null,
              data: {
                created: false,
                transition_id: transitionId,
                target_occurrence_id: targetId,
              },
            }),
          };
        default:
          throw new Error(`Unexpected resume RPC "${name}".`);
      }
    },
  );
  const admin = { from, rpc } as unknown as SupabaseClient<Database>;

  expect(
    await enrollFactoryWorkflowGraph(admin, {
      rootSessionId,
      workspaceId,
      factoryId,
      source: { kind: "structured", value: workflow },
      inputRunId,
      resumeFromGeneration: 2,
    }),
  ).toMatchObject({
    ok: true,
    execution: { created: false, execution_generation: 3 },
    entry: { occurrenceId: entryId, nodeId: "review", workflowDigest, p_expected_generation: 3 },
    progress: {
      status: "admitted",
      transitionId,
      targetOccurrenceId: targetId,
      nextNodeId: "check",
    },
  });
  expect(from).not.toHaveBeenCalled();
});
