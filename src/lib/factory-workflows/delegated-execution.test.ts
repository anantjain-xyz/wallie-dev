import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type { Database } from "@/lib/supabase/database.types";

import { admitFactoryWorkflowDelegatedSession, type WorkflowDelegationPin } from "./execute";

const uuid = (value: number) => `c5410000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const scope = { p_root_session_id: uuid(1), p_workspace_id: uuid(2), p_factory_id: uuid(3) };
const occurrenceId = uuid(4);
const definitionRevisionId = uuid(5);
const parentSessionId = uuid(6);
const sourceCheckpointRunId = uuid(7);
const owner = uuid(8);
const promptRevisionId = uuid(9);
const profileDigest = "a".repeat(64);
const graph = {
  schemaVersion: 1,
  kind: "graph",
  entryNodeId: "route",
  grants: [],
  nodes: [
    { id: "route", kind: "route", agentPromptRevisionId: promptRevisionId },
    { id: "worker", kind: "agent", agentPromptRevisionId: promptRevisionId },
  ],
  edges: [{ id: "delegate", kind: "route", from: "route", to: "worker" }],
  routePolicy: {
    maxNodeVisits: 2,
    maxLoopTraversals: 0,
    nodes: {
      route: {
        minimumConfidence: 0.8,
        allowedDestinationIds: ["worker"],
        fallback: { kind: "clarification" },
      },
    },
  },
};
const policy = {
  maxChildren: 2,
  maxConcurrentChildren: 1,
  maxAttempts: 4,
  maxTotalTokens: 10_000,
  maxCostUsd: 3,
  maxTokensPerAttempt: 1_000,
  maxCostUsdPerAttempt: 0.5,
  targets: { worker: { definitionRevisionId, definitionDigest: profileDigest } },
};
const creationReceipt = { child_session_id: uuid(10), job_id: uuid(11), run_id: uuid(12) };
const delegate = {
  title: "Review the change",
  promptMd: "Address the assigned change.\nKeep the scoped input.",
};

function fixture({
  hasPolicy = true,
  generation = 3,
  nodeId = "worker",
  admissionError = null,
}: {
  hasPolicy?: boolean;
  generation?: number;
  nodeId?: string;
  admissionError?: { code: string; message: string } | null;
} = {}) {
  const plan = hasPolicy ? { ...graph, delegationPolicy: policy } : graph;
  const { definitionJson, canonicalDigest } = serializeFactoryDefinition(plan);
  const pin = {
    ...scope,
    p_expected_generation: 3,
    p_ownership_token: owner,
    occurrenceId,
    nodeId,
    workflowDigest: canonicalDigest,
    parentSessionId,
    sourceCheckpointRunId,
  } satisfies WorkflowDelegationPin;
  let hasReceipt = false;
  const rpc = vi.fn((name: string, args: unknown) => {
    switch (name) {
      case "read_factory_workflow_execution":
        expect(args).toEqual(scope);
        return {
          error: null,
          data: {
            execution: {
              root_session_id: scope.p_root_session_id,
              workspace_id: scope.p_workspace_id,
              factory_id: scope.p_factory_id,
              graph_revision_id: uuid(13),
              graph_input_run_id: uuid(14),
              workflow_json: definitionJson,
              workflow_digest: canonicalDigest,
              generation,
            },
            occurrences: [{ occurrence_id: occurrenceId, node_id: nodeId, is_entry: false }],
            results: [],
          },
        };
      case "admit_factory_workflow_delegated_session":
        return {
          single: () => {
            const receipt = { ...creationReceipt, created: !hasReceipt };
            hasReceipt = true;
            return { data: admissionError ? null : receipt, error: admissionError };
          },
        };
      default:
        throw new Error(`Unexpected delegation RPC "${name}".`);
    }
  });
  const from = () => {
    throw new Error("Delegation must use the scoped ledger and native admission only.");
  };
  return { admin: { from, rpc } as unknown as SupabaseClient<Database>, pin, rpc };
}

it("sends exact work, source and owned occurrence pins and returns the same native replay receipt", async () => {
  const { admin, pin, rpc } = fixture();
  expect(await admitFactoryWorkflowDelegatedSession(admin, pin, delegate)).toEqual({
    status: "delegated",
    receipt: { ...creationReceipt, created: true },
  });
  expect(await admitFactoryWorkflowDelegatedSession(admin, pin, delegate)).toEqual({
    status: "delegated",
    receipt: { ...creationReceipt, created: false },
  });
  const expected = {
    ...scope,
    p_expected_generation: 3,
    p_ownership_token: owner,
    p_target_occurrence_id: occurrenceId,
    p_parent_session_id: parentSessionId,
    p_source_checkpoint_run_id: sourceCheckpointRunId,
    p_title: delegate.title,
    p_prompt_md: delegate.promptMd,
  };
  const submissions = rpc.mock.calls
    .filter(([name]) => name === "admit_factory_workflow_delegated_session")
    .map(([, args]) => args);
  expect(submissions).toEqual([expected, expected]);
});

it("accepts Unicode work text at the database character limits", async () => {
  const { admin, pin, rpc } = fixture();
  const work = { title: "🧱".repeat(200), promptMd: "🧱".repeat(20_000) };
  expect(await admitFactoryWorkflowDelegatedSession(admin, pin, work)).toEqual({
    status: "delegated",
    receipt: { ...creationReceipt, created: true },
  });
  expect(rpc).toHaveBeenCalledWith(
    "admit_factory_workflow_delegated_session",
    expect.objectContaining({ p_title: work.title, p_prompt_md: work.promptMd }),
  );
});

it.each([
  { ...delegate, title: " " },
  { ...delegate, title: "🧱".repeat(201) },
  { ...delegate, promptMd: "a".repeat(20_001) },
  { ...delegate, promptMd: "contains\u0000nul" },
  { ...delegate, sourceCheckpointRunId: uuid(30), definitionRevisionId: uuid(31) },
])("blocks malformed or authority-changing work text before any RPC", async (request) => {
  const { admin, pin, rpc } = fixture();
  expect(await admitFactoryWorkflowDelegatedSession(admin, pin, request)).toEqual({
    status: "blocked",
    code: "invalid_delegation_request",
  });
  expect(rpc).not.toHaveBeenCalled();
});

it.each([{ hasPolicy: false }, { nodeId: "route" }])(
  "blocks policy-free and non-agent occurrences",
  async (options) => {
    const { admin, pin, rpc } = fixture(options);
    expect(await admitFactoryWorkflowDelegatedSession(admin, pin, delegate)).toEqual({
      status: "blocked",
      code: "invalid_delegation_target",
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["read_factory_workflow_execution"]);
  },
);

it("does not submit for a stale owner generation or a different workflow digest", async () => {
  const stale = fixture({ generation: 4 });
  const otherWorkflow = fixture();
  expect(await admitFactoryWorkflowDelegatedSession(stale.admin, stale.pin, delegate)).toEqual({
    status: "stale",
    currentGeneration: 4,
  });
  expect(
    await admitFactoryWorkflowDelegatedSession(
      otherWorkflow.admin,
      { ...otherWorkflow.pin, workflowDigest: "f".repeat(64) },
      delegate,
    ),
  ).toEqual({ status: "unavailable" });
  for (const rpc of [stale.rpc, otherWorkflow.rpc])
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["read_factory_workflow_execution"]);
});

it("propagates native admission refusal without manufacturing a child receipt", async () => {
  const denied = {
    code: "PT409",
    message: "The workflow root has no remaining child attempt capacity.",
  };
  const { admin, pin } = fixture({ admissionError: denied });
  await expect(admitFactoryWorkflowDelegatedSession(admin, pin, delegate)).rejects.toEqual(denied);
});
