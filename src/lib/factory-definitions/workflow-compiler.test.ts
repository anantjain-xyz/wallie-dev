import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { compileWorkflowGraph } from "./workflow-compiler";

const agentPromptRevisionId = "c5410000-0000-4000-8000-000000000013";
const reviewerPromptRevisionId = "c5410000-0000-4000-8000-000000000014";
const approverId = "c5410000-0000-4000-8000-000000000010";
const grant = { id: "c5410000-0000-4000-8000-000000000020", version: 3 };
const workspaceId = "c5410000-0000-4000-8000-000000000001";
const otherWorkspaceId = "c5410000-0000-4000-8000-000000000002";
const catalog = {
  workspaceId,
  agentPromptRevisions: [
    { id: agentPromptRevisionId, workspaceId },
    { id: reviewerPromptRevisionId, workspaceId },
  ],
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

const exactReview = {
  id: "review",
  kind: "review",
  reviewerPromptRevisionId,
  ruleIds: ["lint", "changed-files"],
  repair: {
    edgeId: "review.repair",
    maxRepairs: 2,
    eligibleRuleIds: ["lint", "changed-files"],
  },
};

function exactReviewGraph(review: Partial<typeof exactReview> = {}) {
  const graph = parallelGraph();
  const profile = {
    definitionRevisionId: "c5410000-0000-4000-8000-000000000019",
    definitionDigest: "a".repeat(64),
  };
  return {
    ...graph,
    nodes: [...graph.nodes, { ...exactReview, ...review }],
    edges: [
      ...graph.edges.map((edge) =>
        edge.id === "check-output" ? { ...edge, from: "review" } : edge,
      ),
      { id: "review-output", from: "integrate", to: "review", kind: "next" },
    ],
    delegationPolicy: {
      maxChildren: 2,
      maxConcurrentChildren: 2,
      maxAttempts: 8,
      maxTotalTokens: 100_000,
      maxCostUsd: 10,
      maxTokensPerAttempt: 5_000,
      maxCostUsdPerAttempt: 1,
      targets: { services: profile, docs: profile },
    },
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

  it("pins the reviewer and compiles one canonical rule set without adding a public loop edge", () => {
    const graph = exactReviewGraph();
    const compiled = compile(graph);
    expect(compiled.ok).toBe(true);
    expect(compiled).toEqual(
      compile(
        exactReviewGraph({
          ruleIds: [...exactReview.ruleIds].reverse(),
          repair: {
            ...exactReview.repair,
            eligibleRuleIds: [...exactReview.repair.eligibleRuleIds].reverse(),
          },
        }),
      ),
    );
    if (!compiled.ok) throw new Error("Expected the exact review graph to compile.");
    expect(compiled.bundle.nodes).toContainEqual({
      ...exactReview,
      ruleIds: ["changed-files", "lint"],
      repair: { ...exactReview.repair, eligibleRuleIds: ["changed-files", "lint"] },
    });
    expect(compiled.bundle.edges).not.toContainEqual(
      expect.objectContaining({ id: "review.repair" }),
    );
    expect(compiled.bundle.nodes).toContainEqual(
      expect.objectContaining({ id: "approve", kind: "human-gate" }),
    );
  });

  it("rejects a review without one exact upstream join and its shared budget", () => {
    const graph = exactReviewGraph();
    const compiled = compile({
      ...graph,
      delegationPolicy: undefined,
      edges: graph.edges.map((edge) =>
        edge.id === "review-output" ? { ...edge, from: "services" } : edge,
      ),
    });
    expect(compiled).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_review",
          message: expect.stringContaining("adopted join"),
        }),
        expect.objectContaining({
          code: "invalid_review",
          message: expect.stringContaining("shared delegation policy"),
        }),
      ]),
    });
  });

  it("rejects undeclared repair rules and a repair ID aliasing a regular edge", () => {
    const compiled = compile(
      exactReviewGraph({
        repair: { edgeId: "check-output", maxRepairs: 2, eligibleRuleIds: ["undeclared"] },
      }),
    );
    expect(compiled).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_id", path: ["nodes", 6, "repair", "edgeId"] }),
        expect.objectContaining({
          code: "invalid_review",
          path: ["nodes", 6, "repair", "eligibleRuleIds"],
        }),
      ]),
    });
  });

  it("rejects duplicate rule identities, excess repair visits, and cross-workspace reviewer pins", () => {
    expect(compile(exactReviewGraph({ ruleIds: ["lint", "lint"] }))).toMatchObject({ ok: false });
    expect(
      compile(
        exactReviewGraph({
          repair: { ...exactReview.repair, maxRepairs: 9 },
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      compileWorkflowGraph(
        { kind: "structured", value: exactReviewGraph() },
        {
          ...catalog,
          agentPromptRevisions: [
            { id: agentPromptRevisionId, workspaceId },
            { id: reviewerPromptRevisionId, workspaceId: otherWorkspaceId },
          ],
        },
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "missing_reference",
          path: ["nodes", 6, "reviewerPromptRevisionId"],
        }),
      ]),
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

  it("rejects an oversized route policy before reading malformed entries", () => {
    const graph = governedRouteGraph();
    const nodes = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`route.${index}`, null]),
    );
    const readEntry = vi.fn(() => null);
    Object.defineProperty(nodes, "route.0", { enumerable: true, get: readEntry });

    const result = compile({ ...graph, routePolicy: { ...graph.routePolicy, nodes } });

    expect(readEntry).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "invalid_schema",
          path: ["routePolicy", "nodes"],
          message: "Declare at most 128 route policy entries.",
        },
      ],
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

const routeToAgentGraph = {
  schemaVersion: 1,
  kind: "graph",
  entryNodeId: "decide",
  nodes: [
    { id: "decide", kind: "route", agentPromptRevisionId },
    { id: "worker", kind: "agent", agentPromptRevisionId },
    { id: "check", kind: "deterministic", operation: "policy" },
  ],
  edges: [
    { id: "delegate", kind: "route", from: "decide", to: "worker" },
    { id: "verify", kind: "next", from: "worker", to: "check" },
  ],
  grants: [],
  routePolicy: {
    maxNodeVisits: 3,
    maxLoopTraversals: 0,
    nodes: {
      decide: {
        minimumConfidence: 0.8,
        allowedDestinationIds: ["worker"],
        fallback: { kind: "clarification" },
      },
    },
  },
};

const childProfile = {
  definitionRevisionId: "c5410000-0000-4000-8000-000000000060",
  definitionDigest: "c".repeat(64),
};
const delegationPolicy = {
  maxChildren: 4,
  maxConcurrentChildren: 2,
  maxAttempts: 8,
  maxTotalTokens: 10_000,
  maxCostUsd: 3.5,
  maxTokensPerAttempt: 1_000,
  maxCostUsdPerAttempt: 0.5,
  targets: { worker: childProfile },
};

describe("foreman route profile", () => {
  const profile = {
    definitionRevisionId: "c5410000-0000-4000-8000-000000000061",
    definitionDigest: "d".repeat(64),
  };
  const withForemanProfile = (foremanProfile: unknown) => ({
    ...routeToAgentGraph,
    routePolicy: {
      ...routeToAgentGraph.routePolicy,
      nodes: {
        decide: { ...routeToAgentGraph.routePolicy.nodes.decide, foremanProfile },
      },
    },
  });

  it("pins the configured foreman profile alongside an independent worker profile", () => {
    const compiled = compile({
      ...withForemanProfile({
        ...profile,
        definitionRevisionId: profile.definitionRevisionId.toUpperCase(),
      }),
      delegationPolicy,
    });
    expect(compiled).toMatchObject({
      ok: true,
      bundle: { routePolicy: { nodes: { decide: { foremanProfile: profile } } }, delegationPolicy },
    });
  });

  it("preserves the existing canonical graph when no foreman profile is provided", () => {
    expect(compile(withForemanProfile(undefined))).toEqual(compile(routeToAgentGraph));
  });

  it("requires the root delegation budget and denies extra provider settings", () => {
    expect(compile(withForemanProfile(profile))).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "invalid_route_policy",
          path: ["routePolicy", "nodes", "decide", "foremanProfile"],
        },
      ],
    });
    expect(
      compile({
        ...withForemanProfile({ ...profile, tools: ["other"] }),
        delegationPolicy,
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        { code: "invalid_schema", path: ["routePolicy", "nodes", "decide", "foremanProfile"] },
      ],
    });
  });
});

describe("delegated agent policy", () => {
  it("keeps identical canonical bytes when an existing graph carries no delegation policy", () => {
    const existing = compile(routeToAgentGraph);
    expect(existing).toMatchObject({
      ok: true,
      canonicalDigest: "d2336052e11de78e2ecf58769e25b6bbbfdb09cb5bac454caf1daf8fa5ad609f",
    });
    expect(compile({ ...routeToAgentGraph, delegationPolicy: undefined })).toEqual(existing);
  });

  it("pins the exact profile digest and canonical revision ID for each agent", () => {
    const compiled = compile({
      ...routeToAgentGraph,
      delegationPolicy: {
        ...delegationPolicy,
        targets: {
          worker: {
            ...childProfile,
            definitionRevisionId: childProfile.definitionRevisionId.toUpperCase(),
          },
        },
      },
    });
    expect(compiled).toMatchObject({
      ok: true,
      bundle: { delegationPolicy },
    });
    if (compiled.ok) {
      expect(JSON.parse(compiled.definitionJson).delegationPolicy.targets).toEqual({
        worker: childProfile,
      });
    }
  });

  it("requires exactly the agent-node targets, including agents in branch graphs", () => {
    expect(
      compile({
        ...routeToAgentGraph,
        delegationPolicy: { ...delegationPolicy, targets: { decide: childProfile } },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "invalid_delegation_policy",
          path: ["delegationPolicy", "targets", "decide"],
        }),
        expect.objectContaining({
          code: "invalid_delegation_policy",
          path: ["delegationPolicy", "targets", "worker"],
        }),
      ],
    });
    expect(
      compile({
        ...parallelGraph(),
        delegationPolicy: {
          ...delegationPolicy,
          targets: { services: childProfile, docs: childProfile },
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("allows 128 distinct delegated agent targets", () => {
    const nodes = Array.from({ length: 128 }, (_, index) => ({
      id: `agent.${index}`,
      kind: "agent",
      agentPromptRevisionId,
    }));
    const graph = {
      schemaVersion: 1,
      kind: "graph",
      entryNodeId: nodes[0].id,
      nodes,
      edges: nodes.slice(1).map(({ id }, index) => ({
        id: `next.${index}`,
        kind: "next",
        from: nodes[index].id,
        to: id,
      })),
      grants: [],
      delegationPolicy: {
        ...delegationPolicy,
        maxChildren: 128,
        maxAttempts: 128,
        targets: Object.fromEntries(nodes.map(({ id }) => [id, childProfile])),
      },
    };

    expect(compile(graph)).toMatchObject({ ok: true });
  });

  it("rejects an oversized delegation target map before reading malformed entries", () => {
    const targets = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`agent.${index}`, null]),
    );
    const readTarget = vi.fn(() => null);
    Object.defineProperty(targets, "agent.0", { enumerable: true, get: readTarget });

    const result = compile({
      ...routeToAgentGraph,
      delegationPolicy: { ...delegationPolicy, targets },
    });

    expect(readTarget).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "invalid_schema",
          path: ["delegationPolicy", "targets"],
          message: "Declare at most 128 delegation targets.",
        },
      ],
    });
  });

  it("rejects a live definition alias or malformed digest in a target", () => {
    expect(
      compile({
        ...routeToAgentGraph,
        delegationPolicy: {
          ...delegationPolicy,
          targets: { worker: { definitionRevisionId: "active", definitionDigest: "latest" } },
        },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          path: ["delegationPolicy", "targets", "worker", "definitionRevisionId"],
        }),
        expect.objectContaining({
          path: ["delegationPolicy", "targets", "worker", "definitionDigest"],
        }),
      ]),
    });
  });

  it.each([
    ["maxChildren", 0],
    ["maxChildren", 1025],
    ["maxConcurrentChildren", 5],
    ["maxAttempts", 1.5],
    ["maxAttempts", 0],
    ["maxTotalTokens", 1_000_000_000_001],
    ["maxCostUsd", Infinity],
    ["maxTokensPerAttempt", 10_001],
    ["maxCostUsdPerAttempt", 3.51],
    ["maxCostUsdPerAttempt", 0.0000001],
  ])("rejects the out-of-bounds %s value %s", (key, value) => {
    expect(
      compile({
        ...routeToAgentGraph,
        delegationPolicy: { ...delegationPolicy, [key]: value },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_schema", path: ["delegationPolicy", key] }),
      ]),
    });
  });
});
