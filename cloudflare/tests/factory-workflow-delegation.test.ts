import { createClient } from "@supabase/supabase-js";
import { expect, it } from "vitest";

import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import {
  admitFactoryWorkflowDelegatedSession,
  executeFactoryWorkflowOccurrence,
  type WorkflowDelegationPin,
} from "@/lib/factory-workflows/execute";
import type { Database } from "@/lib/supabase/database.types";

const uuid = (index: number) => `647a0000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const origin = "https://delegation-fixture.supabase.test";
const scope = { p_workspace_id: uuid(1), p_factory_id: uuid(2), p_root_session_id: uuid(3) };
const routeOccurrenceId = uuid(4);
const targetOccurrenceId = uuid(5);
const sourceRunId = uuid(6);
const promptRevisionId = uuid(7);
const routeDecisionId = uuid(8);
const routeResultId = uuid(9);
const delegatedResultId = uuid(16);
const successorTransitionId = uuid(17);
const successorOccurrenceId = uuid(18);
const generation = 2;
const work = {
  title: "Review the delegated changes",
  promptMd: "Inspect the exact delegated source.",
};
const childReceipt = { child_session_id: uuid(10), job_id: uuid(11), run_id: uuid(12) };
const staleOwner = {
  code: "PT409",
  message: "Workflow ownership token is stale.",
  details: null,
  hint: null,
};
const graph = serializeFactoryDefinition({
  schemaVersion: 1,
  kind: "graph",
  entryNodeId: "route",
  nodes: [
    { id: "route", kind: "route", agentPromptRevisionId: promptRevisionId },
    { id: "worker", kind: "agent", agentPromptRevisionId: promptRevisionId },
    { id: "check", kind: "deterministic", operation: "policy" },
  ],
  edges: [
    { id: "delegate", from: "route", to: "worker", kind: "route" },
    { id: "next.check", from: "worker", to: "check", kind: "next" },
  ],
  grants: [],
  routePolicy: {
    maxNodeVisits: 3,
    maxLoopTraversals: 0,
    nodes: {
      route: {
        allowedDestinationIds: ["worker"],
        minimumConfidence: 0.8,
        fallback: { kind: "clarification" },
      },
    },
  },
  delegationPolicy: {
    maxChildren: 1,
    maxConcurrentChildren: 1,
    maxAttempts: 3,
    maxTotalTokens: 10_000,
    maxCostUsd: 2,
    maxTokensPerAttempt: 1_000,
    maxCostUsdPerAttempt: 0.5,
    targets: { worker: { definitionRevisionId: uuid(13), definitionDigest: "a".repeat(64) } },
  },
});
const pin = {
  ...scope,
  p_expected_generation: generation,
  p_ownership_token: uuid(14),
  occurrenceId: targetOccurrenceId,
  nodeId: "worker",
  workflowDigest: graph.canonicalDigest,
  parentSessionId: scope.p_root_session_id,
  sourceCheckpointRunId: sourceRunId,
} satisfies WorkflowDelegationPin;

function fixture({ observedGeneration = generation, rejectOwnership = false } = {}) {
  const requests: Array<{ name: string; args: unknown }> = [];
  let created = false;
  let childApproved = false;
  let completionRecorded = false;
  const transport: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(origin);
    expect(request.method).toBe("POST");
    const name = url.pathname.replace(/^\/rest\/v1\/rpc\//, "");
    const args: unknown = await request.json();
    requests.push({ name, args });
    switch (name) {
      case "read_factory_workflow_execution":
        return Response.json({
          execution: {
            root_session_id: scope.p_root_session_id,
            workspace_id: scope.p_workspace_id,
            factory_id: scope.p_factory_id,
            graph_revision_id: uuid(15),
            graph_input_run_id: sourceRunId,
            workflow_json: graph.definitionJson,
            workflow_digest: graph.canonicalDigest,
            generation: observedGeneration,
          },
          occurrences: [
            { occurrence_id: routeOccurrenceId, node_id: "route", is_entry: true },
            { occurrence_id: targetOccurrenceId, node_id: "worker", is_entry: false },
          ],
          results: [
            {
              occurrence_id: routeOccurrenceId,
              result_id: routeResultId,
              outcome: "succeeded",
              evidence_ref: "route:" + routeDecisionId,
            },
            ...(completionRecorded
              ? [
                  {
                    occurrence_id: targetOccurrenceId,
                    result_id: delegatedResultId,
                    outcome: "succeeded",
                  },
                ]
              : []),
          ],
          transitions: [
            {
              source_occurrence_id: routeOccurrenceId,
              source_result_id: routeResultId,
              target_occurrence_id: targetOccurrenceId,
              edge_id: "delegate",
            },
          ],
        });
      case "admit_factory_workflow_delegated_session": {
        expect(request.headers.get("accept")).toBe("application/vnd.pgrst.object+json");
        if (rejectOwnership) return Response.json(staleOwner, { status: 409 });
        const receipt = { ...childReceipt, created: !created };
        created = true;
        return Response.json(receipt);
      }
      case "record_factory_workflow_delegated_result":
        if (!childApproved) return Response.json([]);
        completionRecorded = true;
        return Response.json([{ result_id: delegatedResultId, created: true }]);
      case "admit_factory_workflow_next":
        expect(completionRecorded).toBe(true);
        return Response.json([
          {
            transition_id: successorTransitionId,
            target_occurrence_id: successorOccurrenceId,
            created: true,
          },
        ]);
      default:
        throw new Error("Unexpected delegation request: " + url.pathname);
    }
  };
  const admin = createClient<Database>(origin, "synthetic-delegation-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: transport },
  });
  return {
    admin,
    requests,
    approveChild: () => {
      childApproved = true;
    },
  };
}

const readRequest = { name: "read_factory_workflow_execution", args: scope };
const admitRequest = {
  name: "admit_factory_workflow_delegated_session",
  args: {
    ...scope,
    p_expected_generation: generation,
    p_ownership_token: pin.p_ownership_token,
    p_parent_session_id: pin.parentSessionId,
    p_target_occurrence_id: targetOccurrenceId,
    p_source_checkpoint_run_id: sourceRunId,
    p_title: work.title,
    p_prompt_md: work.promptMd,
  },
};

it("submits only scoped pins and work text and returns the same delegated receipt on replay", async () => {
  const { admin, requests } = fixture();
  await expect(admitFactoryWorkflowDelegatedSession(admin, pin, work)).resolves.toEqual({
    status: "delegated",
    receipt: { ...childReceipt, created: true },
  });
  await expect(admitFactoryWorkflowDelegatedSession(admin, pin, work)).resolves.toEqual({
    status: "delegated",
    receipt: { ...childReceipt, created: false },
  });
  expect(requests).toEqual([readRequest, admitRequest, readRequest, admitRequest]);
});

it("rejects request-supplied execution authority before making a Workerd fetch", async () => {
  const { admin, requests } = fixture();
  const broadened = { ...work, parentSessionId: uuid(42), definitionRevisionId: uuid(43) };
  await expect(admitFactoryWorkflowDelegatedSession(admin, pin, broadened)).resolves.toEqual({
    status: "blocked",
    code: "invalid_delegation_request",
  });
  expect(requests).toEqual([]);
});

it("reads the ledger without admitting a stale generation or unmatched agent occurrence", async () => {
  const stale = fixture({ observedGeneration: generation + 1 });
  const wrongOccurrence = fixture();
  await expect(admitFactoryWorkflowDelegatedSession(stale.admin, pin, work)).resolves.toEqual({
    status: "stale",
    currentGeneration: generation + 1,
  });
  await expect(
    admitFactoryWorkflowDelegatedSession(
      wrongOccurrence.admin,
      { ...pin, occurrenceId: routeOccurrenceId },
      work,
    ),
  ).resolves.toEqual({ status: "unavailable" });
  expect(stale.requests).toEqual([readRequest]);
  expect(wrongOccurrence.requests).toEqual([readRequest]);
});

it("propagates a native ownership loss between the ledger read and admission", async () => {
  const { admin, requests } = fixture({ rejectOwnership: true });
  await expect(admitFactoryWorkflowDelegatedSession(admin, pin, work)).rejects.toMatchObject({
    code: staleOwner.code,
    message: staleOwner.message,
  });
  expect(requests).toEqual([readRequest, admitRequest]);
});

it("observes an approved child before admitting its successor and replays the retained result", async () => {
  const { admin, requests, approveChild } = fixture();
  const ownership = {
    ...scope,
    p_expected_generation: generation,
    p_ownership_token: pin.p_ownership_token,
  };
  const record = {
    name: "record_factory_workflow_delegated_result",
    args: { ...ownership, p_occurrence_id: targetOccurrenceId },
  };
  const next = {
    name: "admit_factory_workflow_next",
    args: {
      ...ownership,
      p_source_occurrence_id: targetOccurrenceId,
      p_edge_id: "next.check",
      p_expected_result_id: delegatedResultId,
    },
  };
  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual({
    status: "pending",
    code: "child_completion_pending",
  });
  approveChild();
  const admitted = {
    status: "admitted",
    resultId: delegatedResultId,
    transitionId: successorTransitionId,
    targetOccurrenceId: successorOccurrenceId,
    nextNodeId: "check",
  };
  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual(admitted);
  await expect(executeFactoryWorkflowOccurrence(admin, pin)).resolves.toEqual(admitted);
  expect(requests).toEqual([readRequest, record, readRequest, record, next, readRequest, next]);
});
