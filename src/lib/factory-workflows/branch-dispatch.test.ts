import { createClient } from "@supabase/supabase-js";
import { expect, it, vi } from "vitest";

import { serializeFactoryDefinition } from "@/lib/factory-definitions/serialization";
import type { Database } from "@/lib/supabase/database.types";

import { drainFactoryWorkflowBranches } from "./branch-dispatch";
import { executeFactoryWorkflowOccurrence } from "./execute";

const id = (suffix: number) => `651a0000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const scope = { p_root_session_id: id(1), p_workspace_id: id(2), p_factory_id: id(3) };
const forkOccurrence = { occurrenceId: id(4), nodeId: "fork" };
const childOccurrence = { occurrenceId: id(5), nodeId: "required" };

const graph = serializeFactoryDefinition({
  schemaVersion: 1,
  kind: "graph",
  entryNodeId: "fork",
  nodes: [
    { id: "fork", kind: "branch" },
    { id: "required", kind: "agent", agentPromptRevisionId: id(6) },
    { id: "optional", kind: "agent", agentPromptRevisionId: id(6) },
    { id: "join", kind: "join" },
  ],
  edges: [
    { id: "required.branch", kind: "branch", required: true, from: "fork", to: "required" },
    { id: "optional.branch", kind: "branch", required: false, from: "fork", to: "optional" },
    { id: "required.output", kind: "branch-result", from: "required", to: "join" },
    { id: "optional.output", kind: "branch-result", from: "optional", to: "join" },
  ],
  grants: [],
});

function fixture(
  replies: boolean[] = [],
  progress: unknown = { groupId: id(9), joinStatus: "optional_failure" },
) {
  const call = vi.fn<(name: string, body: unknown) => Response>((name, body) => {
    if (name === "read_factory_workflow_execution") {
      expect(body).toEqual(scope);
      return Response.json({
        execution: {
          root_session_id: scope.p_root_session_id,
          workspace_id: scope.p_workspace_id,
          factory_id: scope.p_factory_id,
          graph_revision_id: id(7),
          graph_input_run_id: id(8),
          workflow_json: graph.definitionJson,
          workflow_digest: graph.canonicalDigest,
          generation: 3,
        },
        occurrences: [
          {
            occurrence_id: forkOccurrence.occurrenceId,
            node_id: forkOccurrence.nodeId,
            is_entry: true,
          },
          { occurrence_id: childOccurrence.occurrenceId, node_id: childOccurrence.nodeId },
        ],
        results: [],
      });
    }
    if (name === "advance_factory_workflow_branch_occurrence") {
      return Response.json(progress);
    }
    if (name === "dispatch_next_factory_workflow_branch") {
      return Response.json(replies.shift() ?? false);
    }
    throw new Error(`Unexpected command ${name}`);
  });
  const fetcher: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    req.signal.throwIfAborted();
    return call(new URL(req.url).pathname.replace("/rest/v1/rpc/", ""), await req.json());
  };
  const admin = createClient<Database>("https://branch-fixture.supabase.test", "service-key", {
    global: { fetch: fetcher },
  });
  return { admin, call };
}

it.each([forkOccurrence, childOccurrence])(
  "uses the branch ledger for $nodeId through the workflow entry point",
  async (occurrence) => {
    const { admin, call } = fixture();
    await expect(
      executeFactoryWorkflowOccurrence(admin, {
        ...scope,
        ...occurrence,
        p_expected_generation: 3,
        p_ownership_token: id(10),
        workflowDigest: graph.canonicalDigest,
      }),
    ).resolves.toEqual({ status: "branch", groupId: id(9), joinStatus: "optional_failure" });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenLastCalledWith("advance_factory_workflow_branch_occurrence", {
      ...scope,
      p_expected_generation: 3,
      p_ownership_token: id(10),
      p_occurrence_id: occurrence.occurrenceId,
    });
  },
);

it("leaves stale branch ownership to the current generation", async () => {
  const { admin, call } = fixture();
  await expect(
    executeFactoryWorkflowOccurrence(admin, {
      ...scope,
      ...childOccurrence,
      p_expected_generation: 2,
      p_ownership_token: id(10),
      workflowDigest: graph.canonicalDigest,
    }),
  ).resolves.toEqual({ status: "stale", currentGeneration: 3 });
  expect(call).toHaveBeenCalledTimes(1);
});

it("does not advance an occurrence after the caller's deadline", async () => {
  const { admin, call } = fixture();
  await expect(
    executeFactoryWorkflowOccurrence(
      admin,
      {
        ...scope,
        ...forkOccurrence,
        p_expected_generation: 3,
        p_ownership_token: id(10),
        workflowDigest: graph.canonicalDigest,
      },
      { signal: AbortSignal.abort() },
    ),
  ).rejects.toMatchObject({ message: expect.stringContaining("AbortError") });
  expect(call).toHaveBeenCalledExactlyOnceWith("read_factory_workflow_execution", scope);
});

it("reports a changed parent checkpoint without treating the branch as runnable", async () => {
  const { admin } = fixture([], { blocker: "workflow_branch_source_changed" });
  await expect(
    executeFactoryWorkflowOccurrence(admin, {
      ...scope,
      ...forkOccurrence,
      p_expected_generation: 3,
      p_ownership_token: id(10),
      workflowDigest: graph.canonicalDigest,
    }),
  ).resolves.toEqual({ status: "blocked", code: "workflow_branch_source_changed" });
});

it("attempts at most four due groups from a shared maintenance pass", async () => {
  const { admin, call } = fixture(Array<boolean>(6).fill(true));
  await drainFactoryWorkflowBranches(admin);
  expect(call).toHaveBeenCalledTimes(4);
});

it("ends the maintenance pass once no group is due", async () => {
  const { admin, call } = fixture([true, false, true]);
  await drainFactoryWorkflowBranches(admin);
  expect(call).toHaveBeenCalledTimes(2);
});
