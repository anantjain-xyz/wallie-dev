import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type { Database } from "@/lib/supabase/database.types";

import { enrollFactoryWorkflowGraph } from "./enroll";
import { executeFactoryWorkflowOccurrence, submitFactoryWorkflowRouteProposal } from "./execute";

const workspaceId = "c5410000-0000-4000-8000-000000000001";
const factoryId = "c5410000-0000-4000-8000-000000000002";
const rootSessionId = "c5410000-0000-4000-8000-000000000003";
const graphRevisionId = "c5410000-0000-4000-8000-000000000004";
const routePromptRevisionId = "c5410000-0000-4000-8000-000000000005";
const routeOccurrenceId = "c5410000-0000-4000-8000-000000000006";
const terminalOccurrenceId = "c5410000-0000-4000-8000-000000000007";
const decisionId = "c5410000-0000-4000-8000-000000000008";
const transitionId = "c5410000-0000-4000-8000-000000000009";
const originalOwner = "c5410000-0000-4000-8000-000000000010";
const scope = {
  p_root_session_id: rootSessionId,
  p_workspace_id: workspaceId,
  p_factory_id: factoryId,
};
const structuralRouteGraph = {
  schemaVersion: 1,
  kind: "graph",
  entryNodeId: "route",
  nodes: [
    { id: "route", kind: "route", agentPromptRevisionId: routePromptRevisionId },
    { id: "finish", kind: "deterministic", operation: "policy" },
  ],
  edges: [{ id: "complete", from: "route", to: "finish", kind: "route" }],
  grants: [],
} as const;
const governedRouteGraph = {
  ...structuralRouteGraph,
  routePolicy: {
    maxNodeVisits: 2,
    maxLoopTraversals: 0,
    nodes: {
      route: {
        minimumConfidence: 0.8,
        allowedDestinationIds: ["finish"],
        fallback: { kind: "clarification" },
      },
    },
  },
};
const selectedReceipt = {
  decision_id: decisionId,
  resolution: "selected",
  transition_id: transitionId,
  target_occurrence_id: terminalOccurrenceId,
};
const clarificationReceipt = {
  decision_id: decisionId,
  resolution: "clarification",
  transition_id: null,
  target_occurrence_id: null,
};
const selectedProgress = {
  status: "route_decided",
  resolution: "selected",
  decisionId,
  transitionId,
  targetOccurrenceId: terminalOccurrenceId,
};
const choice = JSON.stringify({
  version: 1,
  decision: {
    kind: "choose",
    destinationNodeId: "finish",
    confidence: 0.9,
    reason: "The review is complete.",
  },
});

function fixture({
  hasPolicy = true,
  generation = 2,
  persisted = null,
  admitted = selectedReceipt,
  blocker,
}: {
  hasPolicy?: boolean;
  generation?: number;
  persisted?: typeof selectedReceipt | typeof clarificationReceipt | null;
  admitted?: typeof selectedReceipt | typeof clarificationReceipt | null;
  blocker?: "root_unavailable" | "execution_policy_required" | "execution_budget_exhausted";
} = {}) {
  const { definitionJson, canonicalDigest } = serializeFactoryDefinition(
    hasPolicy ? governedRouteGraph : structuralRouteGraph,
  );
  const pin = {
    ...scope,
    p_expected_generation: 2,
    p_ownership_token: originalOwner,
    occurrenceId: routeOccurrenceId,
    nodeId: "route",
    workflowDigest: canonicalDigest,
  };
  const from = vi.fn(() => {
    throw new Error("The route executor must use only the ledger and guarded route RPCs.");
  });
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
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
              graph_input_run_id: null,
              workflow_json: definitionJson,
              workflow_digest: canonicalDigest,
              generation,
              graph_route_blocker: blocker,
            },
            occurrences: [{ occurrence_id: routeOccurrenceId, node_id: "route", is_entry: true }],
            results: [],
          },
        };
      case "acquire_factory_workflow_ownership":
        expect(args).toMatchObject({ ...scope, p_expected_generation: generation });
        generation += 1;
        return {
          maybeSingle: () => ({
            error: null,
            data: {
              execution_generation: generation,
              ownership_token: args.p_candidate_ownership_token,
            },
          }),
        };
      case "admit_factory_workflow_route_decision":
        return { maybeSingle: () => ({ error: null, data: admitted }) };
      case "read_factory_workflow_route_decision":
        expect(args).toEqual({ ...scope, p_route_occurrence_id: routeOccurrenceId });
        return { error: null, data: persisted };
      default:
        throw new Error(`Unexpected route RPC "${name}".`);
    }
  });
  return { admin: { from, rpc } as unknown as SupabaseClient<Database>, canonicalDigest, pin, rpc };
}

it("rejects a fresh route graph without a pinned policy before querying the catalog", async () => {
  const { admin, rpc } = fixture({ hasPolicy: false });
  expect(
    await enrollFactoryWorkflowGraph(admin, {
      rootSessionId,
      workspaceId,
      factoryId,
      source: { kind: "structured", value: structuralRouteGraph },
    }),
  ).toMatchObject({
    ok: false,
    diagnostics: [{ code: "invalid_route_policy", path: ["routePolicy"] }],
  });
  expect(rpc).not.toHaveBeenCalled();
});

it("rejects malformed agent output before any ledger read or mutation", async () => {
  const { admin, pin, rpc } = fixture();
  expect(await submitFactoryWorkflowRouteProposal(admin, pin, "not JSON")).toEqual({
    status: "blocked",
    code: "invalid_proposal",
  });
  expect(rpc).not.toHaveBeenCalled();
});

it("submits a bounded proposal for the exact owned occurrence and returns the admitted target", async () => {
  const { admin, pin, rpc } = fixture();
  expect(await submitFactoryWorkflowRouteProposal(admin, pin, choice)).toEqual(selectedProgress);
  expect(rpc).toHaveBeenCalledWith("admit_factory_workflow_route_decision", {
    ...scope,
    p_expected_generation: 2,
    p_ownership_token: originalOwner,
    p_route_occurrence_id: routeOccurrenceId,
    p_reason: "The review is complete.",
    p_destination_id: "finish",
    p_confidence: 0.9,
  });
});

it("rejects an unlisted low-confidence choice before admission", async () => {
  const { admin, pin, rpc } = fixture();
  const unknown = JSON.stringify({
    version: 1,
    decision: {
      kind: "choose",
      destinationNodeId: "outside",
      confidence: 0.1,
      reason: "Use the fallback to authorize this choice.",
    },
  });
  expect(await submitFactoryWorkflowRouteProposal(admin, pin, unknown)).toEqual({
    status: "blocked",
    code: "destination_not_allowed",
  });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual(["read_factory_workflow_execution"]);
});

it("submits unresolved proposals without a destination and returns only a clarification receipt", async () => {
  const { admin, pin, rpc } = fixture({ admitted: clarificationReceipt });
  const unresolved = JSON.stringify({
    version: 1,
    decision: { kind: "unresolved", reason: "More input is needed." },
  });
  expect(await submitFactoryWorkflowRouteProposal(admin, pin, unresolved)).toEqual({
    status: "route_decided",
    resolution: "clarification",
    decisionId,
  });
  expect(rpc).toHaveBeenCalledWith("admit_factory_workflow_route_decision", {
    ...scope,
    p_expected_generation: 2,
    p_ownership_token: originalOwner,
    p_route_occurrence_id: routeOccurrenceId,
    p_reason: "More input is needed.",
  });
});

it("does not submit for a policy-free or stale occurrence", async () => {
  const legacy = fixture({ hasPolicy: false });
  expect(await executeFactoryWorkflowOccurrence(legacy.admin, legacy.pin)).toEqual({
    status: "blocked",
    code: "invalid_route_policy",
  });
  expect(await submitFactoryWorkflowRouteProposal(legacy.admin, legacy.pin, choice)).toEqual({
    status: "blocked",
    code: "invalid_route_policy",
  });
  expect(legacy.rpc.mock.calls.map(([name]) => name)).toEqual([
    "read_factory_workflow_execution",
    "read_factory_workflow_execution",
  ]);
  const stale = fixture({ generation: 3 });
  expect(await submitFactoryWorkflowRouteProposal(stale.admin, stale.pin, choice)).toEqual({
    status: "stale",
    currentGeneration: 3,
  });
  expect(stale.rpc.mock.calls.map(([name]) => name)).toEqual(["read_factory_workflow_execution"]);
});

it("keeps pending and budget-blocked routes from advancing", async () => {
  const { admin, pin } = fixture({ admitted: null });
  expect(await executeFactoryWorkflowOccurrence(admin, pin)).toEqual({
    status: "pending",
    code: "route_proposal_required",
  });
  expect(await submitFactoryWorkflowRouteProposal(admin, pin, choice)).toEqual({
    status: "blocked",
    code: "execution_budget_exhausted",
  });
});

it("distinguishes a missing budget from an exhausted budget", async () => {
  const { admin, pin } = fixture({ admitted: null, blocker: "execution_policy_required" });
  const blocked = { status: "blocked", code: "execution_policy_required" };
  expect(await executeFactoryWorkflowOccurrence(admin, pin)).toEqual(blocked);
  expect(await submitFactoryWorkflowRouteProposal(admin, pin, choice)).toEqual(blocked);
});

it("resumes a decided route after the root budget is exhausted", async () => {
  const { admin, pin } = fixture({
    persisted: selectedReceipt,
    blocker: "execution_budget_exhausted",
  });
  expect(await executeFactoryWorkflowOccurrence(admin, pin)).toEqual(selectedProgress);
});

it("resumes a route graph from its persisted decision without consulting the live catalog", async () => {
  const { admin, canonicalDigest, rpc } = fixture({ persisted: selectedReceipt });
  expect(
    await enrollFactoryWorkflowGraph(admin, {
      rootSessionId,
      workspaceId,
      factoryId,
      resumeFromGeneration: 2,
    }),
  ).toMatchObject({
    ok: true,
    execution: { created: false, execution_generation: 3 },
    entry: {
      occurrenceId: routeOccurrenceId,
      nodeId: "route",
      workflowDigest: canonicalDigest,
      p_expected_generation: 3,
    },
    progress: selectedProgress,
  });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    "read_factory_workflow_execution",
    "read_factory_workflow_execution",
    "acquire_factory_workflow_ownership",
    "read_factory_workflow_execution",
    "read_factory_workflow_route_decision",
  ]);
});
