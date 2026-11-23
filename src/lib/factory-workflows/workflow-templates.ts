import { z } from "zod";
import {
  workflowNodeIdSchema,
  type WorkflowDelegationPolicy,
  type WorkflowRoutePolicy,
  type workflowGraphSchema,
} from "@/lib/factory-definitions/workflow-schema";

type Graph = Omit<
  z.input<typeof workflowGraphSchema>,
  "routePolicy" | "delegationPolicy" | "repositorySets"
> & {
  routePolicy?: WorkflowRoutePolicy;
  delegationPolicy: WorkflowDelegationPolicy;
};
type Node = Graph["nodes"][number];
type Edge = Graph["edges"][number];
type Review = Extract<Node, { kind: "review" }>;
export type WorkflowTemplateRole = {
  promptRevisionId: string;
  profile: WorkflowDelegationPolicy["targets"][string];
};
type Approvers = { anyoneCanApprove: boolean; memberIds: string[] };
type Budget = Omit<WorkflowDelegationPolicy, "targets">;

type BaseBindings = {
  grant: Graph["grants"][number];
  finalApprovers: Approvers;
  budget: Budget;
};
type CodeRoles = {
  implementation: WorkflowTemplateRole;
  supporting: WorkflowTemplateRole;
  reviewer: {
    promptRevisionId: string;
    ruleIds: Review["ruleIds"];
    repair?: Omit<NonNullable<Review["repair"]>, "edgeId">;
  };
};
export type WorkflowTemplateRequest = BaseBindings &
  (
    | (CodeRoles & {
        templateId: "product-delivery";
        foreman: WorkflowTemplateRole;
      })
    | (CodeRoles & { templateId: "scoped-fix" })
    | { templateId: "incident-analysis"; foreman: WorkflowTemplateRole }
  );

export const workflowTemplates = [
  { id: "product-delivery", version: 1, label: "Product delivery" },
  { id: "scoped-fix", version: 1, label: "Scoped fix" },
  { id: "incident-analysis", version: 1, label: "Incident analysis" },
] as const;

export const workflowTemplateRevisionSchema = z.strictObject({
  id: z.enum(["product-delivery", "scoped-fix", "incident-analysis"]),
  version: z.literal(1),
});

export type WorkflowTemplateRevision = z.output<typeof workflowTemplateRevisionSchema>;

const reviewRepairHeadroom = 8;

// Preparation, two branch agents, the join, and the first exact review.
// Product delivery also uses a Foreman. Each repair adds its job and a re-review.
export const workflowCodeTemplateDefaultAttempts = {
  "product-delivery": 6 + 2 * reviewRepairHeadroom,
  "scoped-fix": 5 + 2 * reviewRepairHeadroom,
};

const next = (id: string, from: string, to: string): Edge => ({
  id,
  from,
  to,
  kind: "next",
});

function gate(id: string, approvers: Approvers): Node {
  return {
    id,
    kind: "human-gate",
    anyoneCanApprove: approvers.anyoneCanApprove,
    approverMemberIds: [...approvers.memberIds],
  };
}

function route(
  role: WorkflowTemplateRole,
  grantId: string,
  destination: string,
  maxNodeVisits: number,
) {
  return {
    node: {
      id: "triage.route",
      kind: "route",
      agentPromptRevisionId: role.promptRevisionId,
      grantId,
    } satisfies Node,
    edge: {
      id: "route.proceed",
      from: "triage.route",
      to: destination,
      kind: "route",
    } satisfies Edge,
    policy: {
      maxNodeVisits,
      maxLoopTraversals: 0,
      nodes: {
        "triage.route": {
          minimumConfidence: 0.8,
          allowedDestinationIds: [workflowNodeIdSchema.parse(destination)],
          fallback: { kind: "clarification" },
          foremanProfile: { ...role.profile },
        },
      },
    } satisfies NonNullable<Graph["routePolicy"]>,
  };
}

export function materializeWorkflowTemplate(request: WorkflowTemplateRequest) {
  const { templateId, grant, budget } = request;
  const finalGate = gate("final.approval", request.finalApprovers);
  const entryNodeId =
    templateId === "product-delivery"
      ? "scope.approval"
      : templateId === "scoped-fix"
        ? "source.accepted"
        : "triage.route";
  const graph: Graph = {
    schemaVersion: 1,
    kind: "graph",
    entryNodeId,
    nodes: [finalGate],
    edges: [],
    grants: [{ ...grant }],
    delegationPolicy: { ...budget, targets: {} },
  };

  if (templateId === "incident-analysis") {
    // The analysis artifact belongs to the selected serial stage and is
    // already adopted when the workflow begins. Its human verdict is still due.
    const foreman = route(request.foreman, grant.id, finalGate.id, 2);
    graph.nodes.unshift(foreman.node);
    graph.edges.push(foreman.edge);
    graph.routePolicy = foreman.policy;
    return graph;
  }

  const { implementation, supporting, reviewer } = request;
  const codeNodes: Node[] = [
    { id: "work.split", kind: "branch" },
    {
      id: "work.implementation",
      kind: "agent",
      agentPromptRevisionId: implementation.promptRevisionId,
      grantId: grant.id,
    },
    {
      id: "work.support",
      kind: "agent",
      agentPromptRevisionId: supporting.promptRevisionId,
      grantId: grant.id,
    },
    { id: "work.join", kind: "join" },
    {
      id: "work.review",
      kind: "review",
      reviewerPromptRevisionId: reviewer.promptRevisionId,
      ruleIds: [...reviewer.ruleIds],
      ...(reviewer.repair && {
        repair: {
          edgeId: "review.repair",
          maxRepairs: reviewer.repair.maxRepairs,
          eligibleRuleIds: [...reviewer.repair.eligibleRuleIds],
        },
      }),
    },
  ];
  graph.nodes.unshift(...codeNodes);
  graph.edges.push(
    {
      id: "split.implementation",
      from: "work.split",
      to: "work.implementation",
      kind: "branch",
      required: true,
    },
    {
      id: "split.support",
      from: "work.split",
      to: "work.support",
      kind: "branch",
      required: false,
    },
    {
      id: "output.implementation",
      from: "work.implementation",
      to: "work.join",
      kind: "branch-result",
    },
    {
      id: "output.support",
      from: "work.support",
      to: "work.join",
      kind: "branch-result",
    },
    next("join.review", "work.join", "work.review"),
    next("review.approve", "work.review", finalGate.id),
  );
  graph.delegationPolicy = {
    ...budget,
    targets: {
      "work.implementation": { ...implementation.profile },
      "work.support": { ...supporting.profile },
    },
  };

  if (templateId === "product-delivery") {
    const scopeGate = gate("scope.approval", request.finalApprovers);
    // A repair job adds one re-review occurrence and two charged attempts.
    // Keep capacity for authors who enable repairs after applying the template.
    const foreman = route(
      request.foreman,
      grant.id,
      "work.split",
      graph.nodes.length + 2 + reviewRepairHeadroom,
    );
    graph.nodes.unshift(scopeGate, foreman.node);
    graph.edges.unshift(next("scope.route", scopeGate.id, foreman.node.id), foreman.edge);
    graph.routePolicy = foreman.policy;
  } else {
    graph.nodes.unshift({
      id: graph.entryNodeId,
      kind: "deterministic",
      operation: "checkpoint",
    });
    graph.edges.unshift(next("source.fork", graph.entryNodeId, "work.split"));
  }

  return graph;
}
