import { describe, expect, it } from "vitest";

import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";

import {
  deleteEditorNode,
  initialGraph,
  makeEdge,
  makeNode,
  removeObsoleteEditorGrants,
  setEditorNode,
  setEditorRepositoryWriters,
  setNodeRoute,
  updateEditorEdge,
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
    expect(setEditorNode(governed, 0, { ...graph.nodes[0], id: "route" })).toBe(governed);
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

  it("creates an own route entry for a step named constructor", () => {
    const graph = setEditorNode(initialGraph, 0, makeNode("constructor", "deterministic"));
    const revisited = setEditorNode(
      { ...graph, routePolicy: { maxNodeVisits: 4, maxLoopTraversals: 1, nodes: {} } },
      0,
      { id: "constructor", kind: "route", agentPromptRevisionId: promptRevisionId },
    );
    expect(Object.hasOwn(revisited.routePolicy?.nodes ?? {}, "constructor")).toBe(true);
    expect(revisited.routePolicy?.nodes["constructor"]).toMatchObject({
      fallback: { kind: "clarification" },
    });
  });

  it("preserves the graph-wide visit and loop limits after removing its final route", () => {
    const graph: WorkflowGraphDraft = {
      ...initialGraph,
      nodes: [...initialGraph.nodes, makeNode("route", "route")],
      routePolicy: {
        nodes: {
          route: {
            minimumConfidence: 0.8,
            allowedDestinationIds: [],
            fallback: { kind: "clarification" },
          },
        },
        maxNodeVisits: 11,
        maxLoopTraversals: 3,
      },
    };
    const expectedPolicy = { nodes: {}, maxNodeVisits: 11, maxLoopTraversals: 3 };
    expect(deleteEditorNode(graph, 1).routePolicy).toEqual(expectedPolicy);
    expect(setEditorNode(graph, 1, makeNode("route", "deterministic")).routePolicy).toEqual(
      expectedPolicy,
    );
  });

  it("keeps secondary writer authority tied to the selected branch and its join", () => {
    const primary = { id: "655d0000-0000-4000-8000-000000000011", version: 1 };
    const secondary = { id: "655d0000-0000-4000-8000-000000000012", version: 2 };
    const repositoryId = "655d0000-0000-4000-8000-000000000013";
    const graph: WorkflowGraphDraft = {
      ...initialGraph,
      entryNodeId: "split",
      nodes: [makeNode("split", "branch"), makeNode("writer", "agent"), makeNode("join", "join")],
      edges: [
        makeEdge({ id: "work", from: "split", to: "writer" }, "branch"),
        makeEdge({ id: "output", from: "writer", to: "join" }, "branch-result"),
      ],
      grants: [primary],
    };
    const assigned = setEditorRepositoryWriters(graph, "join", [
      { repositoryId, writerGrant: secondary, branchEdgeIds: ["work"] },
    ]);
    expect(assigned.nodes[1]).toMatchObject({ grantId: secondary.id });
    expect(assigned.grants).toEqual([primary, secondary]);
    const edited = setEditorNode(assigned, 1, makeNode("writer", "agent"));
    expect(edited.nodes[1]).toMatchObject({ grantId: secondary.id });
    expect(edited.repositorySets).toEqual(assigned.repositorySets);
    expect(updateEditorEdge(assigned, 0, { ...assigned.edges[0], id: "output" })).toBe(assigned);
    const renamed = updateEditorEdge(assigned, 0, { ...assigned.edges[0], id: "build" });
    expect(renamed.repositorySets?.join[0].branchEdgeIds).toEqual(["build"]);
    const changedJoin = setEditorNode(renamed, 2, makeNode("integrate", "join"));
    expect(changedJoin.repositorySets?.integrate[0].branchEdgeIds).toEqual(["build"]);
    const removed = deleteEditorNode(changedJoin, 2);
    expect(removed.repositorySets).toBeUndefined();
    expect(removed.nodes[1]).not.toMatchObject({ grantId: secondary.id });
    expect(removed.grants).toEqual([primary]);
  });

  it("removes a retired primary revision without clearing a referenced secondary grant", () => {
    const primary = { id: "655d0000-0000-4000-8000-000000000011", version: 1 };
    const secondary = { id: "655d0000-0000-4000-8000-000000000012", version: 2 };
    const repositoryId = "655d0000-0000-4000-8000-000000000013";
    const graph: WorkflowGraphDraft = {
      ...initialGraph,
      grants: [primary, secondary],
      nodes: [
        {
          id: "primary",
          kind: "agent",
          agentPromptRevisionId: promptRevisionId,
          grantId: primary.id,
        },
        {
          id: "secondary",
          kind: "agent",
          agentPromptRevisionId: promptRevisionId,
          grantId: secondary.id,
        },
      ],
      repositorySets: {
        join: [{ repositoryId, writerGrant: secondary, branchEdgeIds: ["supporting"] }],
      },
    };
    for (const active of [null, { ...primary, version: 2 }]) {
      const cleaned = removeObsoleteEditorGrants(graph, active);
      expect(cleaned.grants).toEqual([secondary]);
      expect(cleaned.repositorySets).toBe(graph.repositorySets);
      expect(cleaned.nodes).toEqual([{ ...graph.nodes[0], grantId: undefined }, graph.nodes[1]]);
      expect(removeObsoleteEditorGrants(cleaned, active)).toBe(cleaned);
    }
  });
});
