import { describe, expect, it } from "vitest";

import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";

import {
  deleteEditorNode,
  initialGraph,
  makeEdge,
  makeNode,
  setEditorNode,
  setNodeRoute,
  workflowLayers,
  type WorkflowGraphDraft,
} from "./editor-graph";

const workspaceId = "655d0000-0000-4000-8000-000000000001";
const promptRevisionId = "655d0000-0000-4000-8000-000000000002";
const compile = (value: WorkflowGraphDraft) =>
  compileWorkflowGraph(
    { kind: "structured", value },
    { workspaceId, agentPromptRevisions: [{ id: promptRevisionId, workspaceId }], approvers: [] },
  );

describe("workflow editing", () => {
  it("reopens checkpoint and human review edits with the exact graph and digest", () => {
    const graph: WorkflowGraphDraft = {
      ...initialGraph,
      nodes: [...initialGraph.nodes, makeNode("approve", "human-gate")],
      edges: [makeEdge({ id: "review", from: "checkpoint", to: "approve" }, "next")],
    };
    const first = compile(graph);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(compile(first.bundle)).toEqual(first);
    expect(workflowLayers(first.bundle)).toEqual([["checkpoint"], ["approve"]]);
  });

  it("preserves named branch outputs and review when the same draft is laid out again", () => {
    const graph: WorkflowGraphDraft = {
      ...initialGraph,
      entryNodeId: "split",
      nodes: [
        makeNode("split", "branch"),
        { id: "first", kind: "agent", agentPromptRevisionId: promptRevisionId },
        { id: "second", kind: "agent", agentPromptRevisionId: promptRevisionId },
        makeNode("join", "join"),
        makeNode("approve", "human-gate"),
      ],
      edges: [
        makeEdge({ id: "first-branch", from: "split", to: "first" }, "branch"),
        { id: "second-branch", from: "split", to: "second", kind: "branch", required: false },
        makeEdge({ id: "first-result", from: "first", to: "join" }, "branch-result"),
        makeEdge({ id: "second-result", from: "second", to: "join" }, "branch-result"),
        makeEdge({ id: "review", from: "join", to: "approve" }, "next"),
      ],
    };
    const renamed = setEditorNode(graph, 3, { kind: "join", id: "integrated" });
    expect(workflowLayers(renamed)).toEqual([
      ["split"],
      ["first", "second"],
      ["integrated"],
      ["approve"],
    ]);
    const compiled = compile(renamed);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const reordered = {
      ...compiled.bundle,
      nodes: [...compiled.bundle.nodes].reverse(),
      edges: [...compiled.bundle.edges].reverse(),
    };
    expect(compile(reordered)).toEqual(compiled);
    expect(compiled.bundle.edges).toContainEqual({
      id: "second-branch",
      from: "split",
      to: "second",
      kind: "branch",
      required: false,
    });
  });

  it("keeps route references consistent when a step is renamed then removed", () => {
    const graph: WorkflowGraphDraft = {
      ...initialGraph,
      nodes: [
        ...initialGraph.nodes,
        { id: "route", kind: "route", agentPromptRevisionId: promptRevisionId },
      ],
      edges: [makeEdge({ id: "finished", from: "route", to: "checkpoint" }, "route")],
    };
    const governed = setNodeRoute(graph, "route", {
      allowedDestinationIds: ["checkpoint"],
      fallback: { kind: "route", destinationId: "checkpoint" },
      minimumConfidence: 0.8,
    });
    const renamed = setEditorNode(governed, 0, {
      id: "review",
      kind: "deterministic",
      operation: "checkpoint",
    });
    expect(renamed).toMatchObject({
      entryNodeId: "review",
      edges: [{ to: "review" }],
      routePolicy: {
        nodes: {
          route: {
            allowedDestinationIds: ["review"],
            fallback: { kind: "route", destinationId: "review" },
          },
        },
      },
    });
    expect(deleteEditorNode(renamed, 0)).toMatchObject({
      entryNodeId: "route",
      edges: [],
      routePolicy: {
        nodes: { route: { allowedDestinationIds: [], fallback: { kind: "clarification" } } },
      },
    });
  });
});
