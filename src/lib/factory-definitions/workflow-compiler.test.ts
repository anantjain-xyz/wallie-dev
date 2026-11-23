import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { compileWorkflowGraph } from "./workflow-compiler";

const agentPromptRevisionId = "c5410000-0000-4000-8000-000000000013";
const approverId = "c5410000-0000-4000-8000-000000000010";
const grant = { id: "c5410000-0000-4000-8000-000000000020", version: 3 };
const workspaceId = "c5410000-0000-4000-8000-000000000001";
const otherWorkspaceId = "c5410000-0000-4000-8000-000000000002";
const catalog = {
  workspaceId,
  agentPromptRevisions: [{ id: agentPromptRevisionId, workspaceId }],
  approvers: [{ id: approverId, workspaceId }],
};

function parallelGraph() {
  return {
    schemaVersion: 1,
    kind: "graph",
    entryNodeId: "split",
    grants: [],
    nodes: [
      { id: "split", kind: "branch" },
      { id: "services", kind: "agent", agentPromptRevisionId },
      { id: "docs", kind: "agent", agentPromptRevisionId },
      { id: "integrate", kind: "join" },
      { id: "verify", kind: "deterministic", operation: "validation" },
      { id: "approve", kind: "human-gate", anyoneCanApprove: false, approverMemberIds: [] },
    ],
    edges: [
      { id: "run-services", from: "split", to: "services", kind: "branch", required: true },
      { id: "run-docs", from: "split", to: "docs", kind: "branch", required: false },
      { id: "services-result", from: "services", to: "integrate", kind: "branch-result" },
      { id: "docs-result", from: "docs", to: "integrate", kind: "branch-result" },
      { id: "check-output", from: "integrate", to: "verify", kind: "next" },
      { id: "request-review", from: "verify", to: "approve", kind: "next" },
    ],
  };
}

function routeGraph() {
  return {
    schemaVersion: 1,
    kind: "graph",
    entryNodeId: "implement",
    grants: [],
    nodes: [
      { id: "implement", kind: "agent", agentPromptRevisionId },
      { id: "decide", kind: "route", agentPromptRevisionId },
      { id: "complete", kind: "deterministic", operation: "checkpoint" },
    ],
    edges: [
      { id: "inspect", from: "implement", to: "decide", kind: "next" },
      { id: "deliver", from: "decide", to: "complete", kind: "route" },
      { id: "repair", from: "decide", to: "implement", kind: "loop", maxTraversals: 2 },
    ],
  };
}

function governedRouteGraph() {
  const graph = routeGraph();
  return {
    ...graph,
    nodes: [
      ...graph.nodes,
      { id: "escalate", kind: "human-gate", anyoneCanApprove: false, approverMemberIds: [] },
    ],
    edges: [...graph.edges, { id: "escalation", from: "decide", to: "escalate", kind: "route" }],
    routePolicy: {
      maxNodeVisits: 12,
      maxLoopTraversals: 2,
      nodes: {
        decide: {
          minimumConfidence: 0.8,
          allowedDestinationIds: ["implement", "complete"],
          fallback: { kind: "route", destinationId: "escalate" },
        },
      },
    },
  };
}

function compile(value: unknown, approvedGrants?: readonly (typeof grant)[]) {
  return compileWorkflowGraph(
    { kind: "structured", value },
    { ...catalog, approvedGrants: approvedGrants?.map((entry) => ({ ...entry, workspaceId })) },
  );
}

describe("workflow graph compiler", () => {
  it("preserves named parallel inputs, optional branches, validation, and the human gate", () => {
    const graph = parallelGraph();
    expect(compile(graph)).toMatchObject({
      ok: true,
      bundle: {
        entryNodeId: graph.entryNodeId,
        nodes: expect.arrayContaining(graph.nodes),
        edges: expect.arrayContaining(graph.edges),
      },
    });
  });

  it("produces the same canonical digest from JSON and a structured definition", () => {
    const graph = routeGraph();
    const { schemaVersion, kind, entryNodeId, nodes, edges, grants } = graph;
    const compiled = compile(graph);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    expect(
      compileWorkflowGraph(
        {
          kind: "json",
          text: JSON.stringify(
            {
              grants,
              edges: [...edges].reverse(),
              nodes: [...nodes].reverse(),
              entryNodeId,
              kind,
              schemaVersion,
            },
            null,
            2,
          ),
        },
        catalog,
      ),
    ).toEqual(compiled);
    expect(compiled.canonicalDigest).toBe(
      createHash("sha256").update(compiled.definitionJson, "utf8").digest("hex"),
    );
    expect(compiled.bundle.edges).toContainEqual({
      id: "repair",
      from: "decide",
      to: "implement",
      kind: "loop",
      maxTraversals: 2,
    });
  });

  it("rejects duplicated node and edge IDs at their declarations", () => {
    const graph = routeGraph();
    const result = compile({
      ...graph,
      nodes: [...graph.nodes, graph.nodes[0]],
      edges: [...graph.edges, graph.edges[0]],
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_id", path: ["nodes", 3, "id"] }),
        expect.objectContaining({ code: "duplicate_id", path: ["edges", 3, "id"] }),
      ]),
    });
  });

  it("compiles explicitly undefined grant bindings like omitted bindings", () => {
    const graph = routeGraph();
    const structured = compile({
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.kind === "agent" || node.kind === "route" ? { ...node, grantId: undefined } : node,
      ),
    });
    const json = compileWorkflowGraph({ kind: "json", text: JSON.stringify(graph) }, catalog);
    if (!structured.ok || !json.ok) throw new Error("Expected both graph inputs to compile.");

    expect(JSON.parse(structured.definitionJson)).toEqual(json.bundle);
    expect(structured.canonicalDigest).toBe(json.canonicalDigest);
  });

  it("rejects a reference to an undeclared destination", () => {
    const graph = routeGraph();
    const result = compile({
      ...graph,
      edges: graph.edges.map((edge) => (edge.id === "deliver" ? { ...edge, to: "missing" } : edge)),
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "missing_reference", path: ["edges", 1, "to"] }),
      ]),
    });
  });

  it("rejects nodes reachable only by following a loop edge", () => {
    const graph = routeGraph();
    const result = compile({
      ...graph,
      nodes: [...graph.nodes, { id: "orphan", kind: "deterministic", operation: "policy" }],
      edges: graph.edges.map((edge) => (edge.id === "repair" ? { ...edge, to: "orphan" } : edge)),
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "unreachable_node" }),
        expect.objectContaining({ code: "invalid_loop" }),
      ]),
    });
  });

  it("rejects a cycle composed of ordinary forward edges", () => {
    const graph = routeGraph();
    const result = compile({
      ...graph,
      edges: [
        ...graph.edges.filter((edge) => edge.id !== "repair"),
        { id: "back-to-route", from: "complete", to: "decide", kind: "next" },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "unbounded_cycle" })]),
    });
  });

  it("rejects total expansion above the workflow budget even with bounded loop edges", () => {
    const routeNodes = Array.from({ length: 8 }, (_, index) => ({
      id: `decision-${index}`,
      kind: "route",
      agentPromptRevisionId,
    }));
    const graph = {
      schemaVersion: 1,
      kind: "graph",
      entryNodeId: routeNodes[0].id,
      grants: [],
      nodes: [...routeNodes, { id: "complete", kind: "deterministic", operation: "checkpoint" }],
      edges: routeNodes.flatMap(({ id }, index) => [
        {
          id: `advance-${index}`,
          from: id,
          to: routeNodes[index + 1]?.id ?? "complete",
          kind: "route",
        },
        { id: `retry-${index}`, from: id, to: id, kind: "loop", maxTraversals: 16 },
      ]),
    };
    expect(compile(graph)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "expansion_limit" })]),
    });
  });

  it("rejects a join that omits one of the declared branch results", () => {
    const graph = parallelGraph();
    const result = compile({
      ...graph,
      edges: graph.edges.filter((edge) => edge.id !== "docs-result"),
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "invalid_join" })]),
    });
  });

  it("rejects a direct successor edge from a branch", () => {
    const graph = parallelGraph();
    const result = compile({
      ...graph,
      edges: [
        ...graph.edges,
        { id: "skip-integration", from: "split", to: "approve", kind: "next" },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "invalid_edge" })]),
    });
  });

  it("requires exact approved grant revisions and a declaration for each grant used by a node", () => {
    const base = routeGraph();
    const graph = {
      ...base,
      grants: [grant],
      nodes: base.nodes.map((node) =>
        node.id === "decide" ? { ...node, grantId: grant.id } : node,
      ),
    };
    expect(compile(graph, [grant])).toMatchObject({ ok: true, bundle: { grants: [grant] } });
    expect(compile(graph, [{ ...grant, version: grant.version + 1 }])).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "invalid_grant" })]),
    });
    expect(compile({ ...graph, grants: [] }, [grant])).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: "invalid_grant" })]),
    });
  });

  it("requires prompt revisions and approvers from the eligible workspace catalog", () => {
    const base = parallelGraph();
    const graph = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === "approve" ? { ...node, approverMemberIds: [approverId] } : node,
      ),
    };
    const source = { kind: "structured", value: graph } as const;
    expect(compileWorkflowGraph(source, catalog).ok).toBe(true);
    expect(
      compileWorkflowGraph(source, {
        ...catalog,
        agentPromptRevisions: [{ id: agentPromptRevisionId, workspaceId: otherWorkspaceId }],
        approvers: [{ id: approverId, workspaceId: otherWorkspaceId }],
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_reference",
          path: ["nodes", 1, "agentPromptRevisionId"],
        }),
        expect.objectContaining({
          code: "missing_reference",
          path: ["nodes", 5, "approverMemberIds", 0],
        }),
      ]),
    });
  });
});

describe("workflow route policies", () => {
  it("canonicalizes proposed destinations and retains the separate forward fallback", () => {
    const graph = governedRouteGraph();
    const compiled = compile(graph);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
    expect(compiled.bundle.routePolicy?.nodes).toEqual({
      decide: {
        minimumConfidence: 0.8,
        allowedDestinationIds: ["complete", "implement"],
        fallback: { kind: "route", destinationId: "escalate" },
      },
    });
    const reordered = {
      ...graph,
      routePolicy: {
        ...graph.routePolicy,
        nodes: {
          decide: {
            ...graph.routePolicy.nodes.decide,
            allowedDestinationIds: ["complete", "implement"],
          },
        },
      },
    };
    expect(
      compileWorkflowGraph({ kind: "json", text: JSON.stringify(reordered) }, catalog),
    ).toEqual(compiled);
  });

  it("leaves the canonical bytes of a structural graph unchanged when policy is omitted or undefined", () => {
    const graph = routeGraph();
    const omitted = compile(graph);
    if (!omitted.ok) throw new Error(JSON.stringify(omitted.diagnostics));
    expect(compile({ ...graph, routePolicy: undefined })).toEqual(omitted);
    expect(JSON.parse(omitted.definitionJson)).not.toHaveProperty("routePolicy");
  });

  it("allows clarification and zero root loop traversals", () => {
    const graph = routeGraph();
    expect(
      compile({
        ...graph,
        routePolicy: {
          maxNodeVisits: 1024,
          maxLoopTraversals: 0,
          nodes: {
            decide: {
              minimumConfidence: 1,
              allowedDestinationIds: ["complete"],
              fallback: { kind: "clarification" },
            },
          },
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("requires a policy entry for every route node and only route nodes", () => {
    const graph = governedRouteGraph();
    expect(
      compile({
        ...graph,
        routePolicy: { ...graph.routePolicy, nodes: { implement: graph.routePolicy.nodes.decide } },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_route_policy",
          path: ["routePolicy", "nodes", "implement"],
        }),
        expect.objectContaining({
          code: "invalid_route_policy",
          path: ["routePolicy", "nodes", "decide"],
        }),
      ]),
    });
  });

  it.each([
    ["duplicate", ["complete", "complete"], 1],
    ["off-edge", ["complete", "unknown"], 1],
    ["fallback", ["escalate"], 0],
  ] as const)("rejects a %s proposal destination", (_, allowedDestinationIds, index) => {
    const graph = governedRouteGraph();
    expect(
      compile({
        ...graph,
        routePolicy: {
          ...graph.routePolicy,
          nodes: { decide: { ...graph.routePolicy.nodes.decide, allowedDestinationIds } },
        },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "invalid_route_policy",
          path: ["routePolicy", "nodes", "decide", "allowedDestinationIds", index],
        }),
      ],
    });
  });

  it("rejects a bounded loop as an escalation route", () => {
    const graph = governedRouteGraph();
    expect(
      compile({
        ...graph,
        routePolicy: {
          ...graph.routePolicy,
          nodes: {
            decide: {
              ...graph.routePolicy.nodes.decide,
              allowedDestinationIds: ["complete"],
              fallback: { kind: "route", destinationId: "implement" },
            },
          },
        },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "invalid_route_policy",
          path: ["routePolicy", "nodes", "decide", "fallback", "destinationId"],
        }),
      ],
    });
  });

  it.each([
    ["maxNodeVisits", 0],
    ["maxNodeVisits", 1025],
    ["maxLoopTraversals", -1],
    ["maxLoopTraversals", 1025],
    ["maxLoopTraversals", 1.5],
  ] as const)("rejects out-of-range root limit %s=%s", (field, value) => {
    const graph = governedRouteGraph();
    expect(
      compile({ ...graph, routePolicy: { ...graph.routePolicy, [field]: value } }),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "invalid_schema", path: ["routePolicy", field] }),
      ],
    });
  });

  it.each([-0.1, 1.1, Infinity])(
    "rejects an out-of-range confidence threshold %s",
    (minimumConfidence) => {
      const graph = governedRouteGraph();
      expect(
        compile({
          ...graph,
          routePolicy: {
            ...graph.routePolicy,
            nodes: { decide: { ...graph.routePolicy.nodes.decide, minimumConfidence } },
          },
        }),
      ).toMatchObject({
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "invalid_schema",
            path: ["routePolicy", "nodes", "decide", "minimumConfidence"],
          }),
        ]),
      });
    },
  );
});
