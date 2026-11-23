import { expect, it } from "vitest";
import { compileWorkflowGraph } from "@/lib/factory-definitions/workflow-compiler";
import {
  materializeWorkflowTemplate,
  type WorkflowTemplateRequest,
  workflowCodeTemplateDefaultAttempts,
} from "./workflow-templates";

const id = (suffix: number) => `65600000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const role = (slot: number) => ({
  promptRevisionId: id(slot),
  profile: {
    definitionRevisionId: id(slot + 10),
    definitionDigest: "a".repeat(64),
  },
});
const base = {
  finalApprovers: { anyoneCanApprove: false, memberIds: [id(6)] },
  grant: { id: id(7), version: 1 },
  budget: {
    maxChildren: 2,
    maxConcurrentChildren: 2,
    maxAttempts: 12,
    maxTotalTokens: 10000,
    maxCostUsd: 10,
    maxTokensPerAttempt: 500,
    maxCostUsdPerAttempt: 0.5,
  },
};
const code = {
  implementation: role(3),
  supporting: role(4),
  reviewer: { promptRevisionId: id(8), ruleIds: ["scope", "tests"] },
};
const foreman = role(2);
const product = {
  ...base,
  ...code,
  templateId: "product-delivery",
  foreman,
} satisfies WorkflowTemplateRequest;
const scopedFix = {
  ...base,
  ...code,
  templateId: "scoped-fix",
} satisfies WorkflowTemplateRequest;
const incident = {
  ...base,
  templateId: "incident-analysis",
  foreman,
} satisfies WorkflowTemplateRequest;

const catalog = {
  workspaceId: id(1),
  agentPromptRevisions: [2, 3, 4, 8].map((slot) => ({
    id: id(slot),
    workspaceId: id(1),
  })),
  approvers: [5, 6].map((slot) => ({ id: id(slot), workspaceId: id(1) })),
  approvedGrants: [{ ...base.grant, workspaceId: id(1) }],
};
const compile = (value: unknown) => compileWorkflowGraph({ kind: "structured", value }, catalog);

it.each([product, scopedFix, incident])(
  "compiles $templateId with a stable display order and editable immutable revisions",
  (template) => {
    const graph = materializeWorkflowTemplate(template);
    const first = compile(graph);
    expect(first.ok ? true : first.diagnostics).toBe(true);
    expect(
      compile({
        ...graph,
        nodes: graph.nodes.toReversed(),
        edges: graph.edges.toReversed(),
      }),
    ).toEqual(first);
    const changed = compile(
      materializeWorkflowTemplate({
        ...template,
        finalApprovers: { anyoneCanApprove: false, memberIds: [id(5)] },
      }),
    );
    if (!first.ok || !changed.ok) throw new Error("Expected both graph revisions to compile.");
    expect(changed.canonicalDigest).not.toBe(first.canonicalDigest);
  },
);

it("starts product delivery at the native triage gate and maps the configured foreman profile", () => {
  const graph = materializeWorkflowTemplate(product);
  expect(graph.entryNodeId).toBe("scope.approval");
  expect(graph.nodes).toContainEqual({
    id: "scope.approval",
    kind: "human-gate",
    anyoneCanApprove: false,
    approverMemberIds: [id(6)],
  });
  expect(graph.edges).toContainEqual({
    id: "scope.route",
    from: "scope.approval",
    to: "triage.route",
    kind: "next",
  });
  expect(graph.routePolicy).toMatchObject({
    nodes: {
      "triage.route": {
        foremanProfile: foreman.profile,
        allowedDestinationIds: ["work.split"],
      },
    },
  });
});

it("scoped fixes start at an exact accepted checkpoint without requiring a foreman", () => {
  const graph = materializeWorkflowTemplate(scopedFix);
  expect(graph.entryNodeId).toBe("source.accepted");
  expect(graph.routePolicy).toBeUndefined();
  expect(graph.nodes).toContainEqual({
    id: "source.accepted",
    kind: "deterministic",
    operation: "checkpoint",
  });
});

it.each([product, scopedFix])("pins a reviewer after adoption for $templateId", (template) => {
  const graph = materializeWorkflowTemplate(template);
  expect(graph.delegationPolicy).toMatchObject({
    targets: {
      "work.implementation": code.implementation.profile,
      "work.support": code.supporting.profile,
    },
  });
  expect(graph.nodes).toContainEqual({
    id: "work.review",
    kind: "review",
    reviewerPromptRevisionId: id(8),
    ruleIds: ["scope", "tests"],
  });
  expect(
    graph.edges.filter((edge) => edge.from === "work.join" || edge.from === "work.review"),
  ).toEqual([
    { id: "join.review", from: "work.join", to: "work.review", kind: "next" },
    {
      id: "review.approve",
      from: "work.review",
      to: "final.approval",
      kind: "next",
    },
  ]);
  expect(graph.edges.find((edge) => edge.id === "split.implementation")).toMatchObject({
    required: true,
  });
  expect(graph.edges.find((edge) => edge.id === "split.support")).toMatchObject({
    required: false,
  });
});

it("stores a configured bounded repair without adding a graph edge", () => {
  const graph = materializeWorkflowTemplate({
    ...product,
    reviewer: {
      ...code.reviewer,
      repair: { maxRepairs: 2, eligibleRuleIds: ["scope"] },
    },
  });
  const compiled = compile(graph);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  expect(compiled.bundle.nodes).toContainEqual(
    expect.objectContaining({
      repair: {
        edgeId: "review.repair",
        maxRepairs: 2,
        eligibleRuleIds: ["scope"],
      },
    }),
  );
  expect(compiled.bundle.edges.map(({ id: edge }) => edge)).not.toContain("review.repair");
  expect(compiled.bundle.routePolicy).toMatchObject({ maxNodeVisits: 16, maxLoopTraversals: 0 });
  expect(compiled.bundle.delegationPolicy?.maxAttempts).toBe(base.budget.maxAttempts);
});

it("keeps a later maximum repair edit within the product template visit and attempt bounds", () => {
  const graph = materializeWorkflowTemplate({
    ...product,
    budget: {
      ...base.budget,
      maxAttempts: workflowCodeTemplateDefaultAttempts["product-delivery"],
    },
  });
  const maxRepairs = 8;
  const edited = compile({
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.kind === "review"
        ? { ...node, repair: { edgeId: "review.repair", maxRepairs, eligibleRuleIds: ["scope"] } }
        : node,
    ),
  });
  if (!edited.ok) throw new Error(JSON.stringify(edited.diagnostics));

  const { nodes, routePolicy, delegationPolicy, edges } = edited.bundle;
  // Each repair adds one review visit. The final gate still needs its own visit.
  expect(routePolicy?.maxNodeVisits).toBe(nodes.length + maxRepairs);
  expect(routePolicy?.maxLoopTraversals).toBe(0);
  expect(edges).toHaveLength(graph.edges.length);
  expect(edges).toContainEqual({
    id: "review.approve",
    kind: "next",
    from: "work.review",
    to: "final.approval",
  });
  expect(delegationPolicy).toMatchObject({ ...base.budget, maxAttempts: 6 + 2 * maxRepairs });
  expect(workflowCodeTemplateDefaultAttempts["scoped-fix"]).toBe(5 + 2 * maxRepairs);
  expect(
    materializeWorkflowTemplate({ ...product, budget: { ...base.budget, maxAttempts: 24 } })
      .delegationPolicy.maxAttempts,
  ).toBe(24);
});

it("routes an incident to an independent verdict or a clarification without any implementation destination", () => {
  const graph = materializeWorkflowTemplate(incident);
  expect(graph.nodes.map((node) => node.kind)).toEqual(["route", "human-gate"]);
  expect(graph.delegationPolicy).toMatchObject({ targets: {} });
  expect(graph.routePolicy).toMatchObject({
    nodes: {
      "triage.route": {
        allowedDestinationIds: ["final.approval"],
        fallback: { kind: "clarification" },
      },
    },
  });
  expect(graph.edges).toEqual([
    {
      id: "route.proceed",
      from: "triage.route",
      to: "final.approval",
      kind: "route",
    },
  ]);
});

it.each([2, 3, 4, 8])(
  "rejects configured role %i when it is outside the factory catalog",
  (slot) => {
    const graph = materializeWorkflowTemplate(product);
    expect(
      compileWorkflowGraph(
        { kind: "structured", value: graph },
        {
          ...catalog,
          agentPromptRevisions: catalog.agentPromptRevisions.filter(
            ({ id: revision }) => revision !== id(slot),
          ),
        },
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "missing_reference" })],
    });
  },
);
