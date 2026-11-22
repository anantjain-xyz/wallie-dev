import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type {
  WorkflowOccurrenceMetadata,
  WorkflowOccurrencePin,
} from "@/lib/factory-workflows/deterministic-command";
import {
  executeFactoryWorkflowOccurrence,
  resumeFactoryWorkflowOccurrence,
} from "@/lib/factory-workflows/execute";
import type { Database } from "@/lib/supabase/database.types";

const scope = {
  p_workspace_id: "10000000-0000-4000-8000-000000000001",
  p_factory_id: "10000000-0000-4000-8000-000000000002",
  p_root_session_id: "10000000-0000-4000-8000-000000000003",
};
const graphRevisionId = "10000000-0000-4000-8000-000000000004";
const policyRevisionId = "10000000-0000-4000-8000-000000000005";
const occurrenceId = "10000000-0000-4000-8000-000000000006";
const resultId = "10000000-0000-4000-8000-000000000007";
const transitionId = "10000000-0000-4000-8000-000000000008";
const targetOccurrenceId = "10000000-0000-4000-8000-000000000009";
const ownershipToken = "10000000-0000-4000-8000-000000000010";
const inputRunId = "10000000-0000-4000-8000-000000000011";
const nodeId = "check-policy";
const edgeId = "continue-to-checkpoint";
const generation = 2;
const ownership = {
  ...scope,
  p_expected_generation: generation,
  p_ownership_token: ownershipToken,
};
const handoff = {
  execution_generation: generation + 1,
  ownership_token: "10000000-0000-4000-8000-000000000012",
};
const admitted = {
  status: "admitted",
  resultId,
  transitionId,
  targetOccurrenceId,
  nextNodeId: "checkpoint",
};
const resultRef = "policy:" + policyRevisionId;
const graph = serializeFactoryDefinition({
  kind: "graph",
  schemaVersion: 1,
  entryNodeId: nodeId,
  nodes: [
    { id: nodeId, kind: "deterministic", operation: "policy" },
    { id: "checkpoint", kind: "deterministic", operation: "checkpoint" },
  ],
  edges: [{ id: edgeId, kind: "next", from: nodeId, to: "checkpoint" }],
  grants: [],
});
const observedMetadata = {
  ...scope,
  p_expected_generation: generation,
  nodeId,
  occurrenceId,
  workflowDigest: graph.canonicalDigest,
} satisfies WorkflowOccurrenceMetadata;
const pin = {
  ...observedMetadata,
  p_ownership_token: ownershipToken,
} satisfies WorkflowOccurrencePin;

function policyFixture({
  observedPolicy = policyRevisionId,
  resultCanBeRecorded = true,
  persisted,
}: {
  observedPolicy?: string | null;
  resultCanBeRecorded?: boolean;
  persisted?: "result" | "transition";
} = {}) {
  const requests: Array<{ name: string; args: unknown }> = [];
  const origin = "https://workflow-fixture.supabase.test";
  let currentGeneration = generation;
  const transport: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(origin);
    if (url.pathname === "/rest/v1/sessions" && request.method === "GET") {
      expect(persisted).not.toBe("transition");
      expect(url.searchParams.get("id")).toBe("eq." + scope.p_root_session_id);
      expect(url.searchParams.get("workspace_id")).toBe("eq." + scope.p_workspace_id);
      expect(url.searchParams.get("factory_id")).toBe("eq." + scope.p_factory_id);
      return Response.json([{ execution_policy_revision_id: policyRevisionId }]);
    }
    expect(request.method).toBe("POST");
    const name = url.pathname.replace(/^\/rest\/v1\/rpc\//, "");
    requests.push({ name, args: await request.json() });
    switch (name) {
      case "read_factory_workflow_execution":
        return Response.json({
          execution: {
            workspace_id: scope.p_workspace_id,
            factory_id: scope.p_factory_id,
            root_session_id: scope.p_root_session_id,
            graph_revision_id: graphRevisionId,
            graph_input_run_id: inputRunId,
            workflow_json: graph.definitionJson,
            workflow_digest: graph.canonicalDigest,
            generation: currentGeneration,
          },
          occurrences: [{ occurrence_id: occurrenceId, node_id: nodeId }],
          results: persisted
            ? [
                {
                  occurrence_id: occurrenceId,
                  result_id: resultId,
                  outcome: "succeeded",
                  evidence_ref: resultRef,
                },
              ]
            : [],
          transitions:
            persisted === "transition"
              ? [
                  {
                    source_occurrence_id: occurrenceId,
                    source_result_id: resultId,
                    edge_id: edgeId,
                  },
                ]
              : [],
        });
      case "advance_factory_workflow_generation":
        currentGeneration = handoff.execution_generation;
        return Response.json(handoff);
      case "check_factory_workflow_execution_policy":
        return Response.json({ policy_revision_id: observedPolicy, exhaustion_code: null });
      case "record_factory_workflow_command_result":
        return Response.json(resultCanBeRecorded ? [{ result_id: resultId, created: true }] : []);
      case "admit_factory_workflow_next":
        return Response.json([
          {
            transition_id: transitionId,
            target_occurrence_id: targetOccurrenceId,
            created: persisted !== "transition",
          },
        ]);
      default:
        throw new Error("Unexpected workflow request: " + url.pathname);
    }
  };
  const admin = createClient<Database>(origin, "synthetic-workflow-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: transport },
  });
  return { admin, requests };
}

it("forwards the handoff owner to the guarded policy, result, and successor RPCs in Workerd", async () => {
  const { admin, requests } = policyFixture();

  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual(admitted);
  expect(requests).toEqual([
    { name: "read_factory_workflow_execution", args: scope },
    {
      name: "check_factory_workflow_execution_policy",
      args: { ...ownership, p_occurrence_id: occurrenceId },
    },
    {
      name: "record_factory_workflow_command_result",
      args: { ...ownership, p_occurrence_id: occurrenceId, p_evidence_ref: resultRef },
    },
    {
      name: "admit_factory_workflow_next",
      args: {
        ...ownership,
        p_source_occurrence_id: occurrenceId,
        p_edge_id: edgeId,
        p_expected_result_id: resultId,
      },
    },
  ]);
});

it("waits when authoritative policy evidence is unavailable", async () => {
  const { admin, requests } = policyFixture({ observedPolicy: null });

  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual({
    status: "pending",
    code: "evidence_missing",
  });
  expect(requests.map(({ name }) => name)).toEqual([
    "read_factory_workflow_execution",
    "check_factory_workflow_execution_policy",
  ]);
});

it("leaves the successor unadmitted when the guarded result became stale", async () => {
  const { admin, requests } = policyFixture({ resultCanBeRecorded: false });

  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual({
    status: "blocked",
    code: "evidence_stale",
  });
  expect(requests.map(({ name }) => name)).toEqual([
    "read_factory_workflow_execution",
    "check_factory_workflow_execution_policy",
    "record_factory_workflow_command_result",
  ]);
});

it("resumes from the persisted result through guarded successor admission", async () => {
  const { admin, requests } = policyFixture({ persisted: "result" });

  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual(admitted);
  expect(requests).toEqual([
    { name: "read_factory_workflow_execution", args: scope },
    {
      name: "admit_factory_workflow_next",
      args: {
        ...ownership,
        p_source_occurrence_id: occurrenceId,
        p_edge_id: edgeId,
        p_expected_result_id: resultId,
      },
    },
  ]);
});

it("rotates ownership before replaying an admitted transition in Workerd", async () => {
  const { admin, requests } = policyFixture({ persisted: "transition" });

  await expect(resumeFactoryWorkflowOccurrence(admin, observedMetadata)).resolves.toEqual({
    ownership: handoff,
    progress: admitted,
  });
  expect(requests).toEqual([
    { name: "read_factory_workflow_execution", args: scope },
    {
      name: "advance_factory_workflow_generation",
      args: { ...scope, p_expected_generation: generation },
    },
    { name: "read_factory_workflow_execution", args: scope },
    {
      name: "admit_factory_workflow_next",
      args: {
        ...scope,
        p_expected_generation: handoff.execution_generation,
        p_ownership_token: handoff.ownership_token,
        p_source_occurrence_id: occurrenceId,
        p_edge_id: edgeId,
        p_expected_result_id: resultId,
      },
    },
  ]);
});
