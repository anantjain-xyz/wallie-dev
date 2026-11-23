import type { z } from "zod";

import type {
  WorkflowDelegationPolicy,
  WorkflowGraphDefinition,
  WorkflowRoutePolicy,
  workflowGraphSchema,
} from "@/lib/factory-definitions/workflow-schema";

type InputGraph = z.input<typeof workflowGraphSchema>;
type Route = WorkflowRoutePolicy["nodes"][string];
export type RouteDraft = Omit<Route, "allowedDestinationIds" | "fallback"> & {
  allowedDestinationIds: string[];
  fallback: { kind: "clarification" } | { kind: "route"; destinationId: string };
};
export type RoutePolicyDraft = Omit<WorkflowRoutePolicy, "nodes"> & {
  nodes: Record<string, RouteDraft>;
};
export type WorkflowGraphDraft = Omit<InputGraph, "routePolicy" | "delegationPolicy"> & {
  routePolicy?: RoutePolicyDraft;
  delegationPolicy?: WorkflowDelegationPolicy;
};
export type WorkflowNodeDraft = WorkflowGraphDraft["nodes"][number];
export type WorkflowEdgeDraft = WorkflowGraphDraft["edges"][number];
export type WorkflowEditorChoices = {
  prompts: { id: string; label: string }[];
  approvers: { id: string; label: string }[];
  profiles: { id: string; digest: string; label: string }[];
  grant: WorkflowGraphDefinition["grants"][number] | null;
};

export const nodeLabels = {
  agent: "Agent",
  deterministic: "Deterministic step",
  "human-gate": "Human gate",
  route: "Route",
  branch: "Branch",
  join: "Join",
} satisfies Record<WorkflowNodeDraft["kind"], string>;

export const edgeLabels = {
  next: "Next",
  route: "Route",
  loop: "Loop",
  branch: "Branch",
  "branch-result": "Branch result",
} satisfies Record<WorkflowEdgeDraft["kind"], string>;

export const initialGraph: WorkflowGraphDraft = {
  schemaVersion: 1,
  kind: "graph",
  entryNodeId: "checkpoint",
  nodes: [{ id: "checkpoint", kind: "deterministic", operation: "checkpoint" }],
  edges: [],
  grants: [],
};

export const defaultDelegationPolicy: WorkflowDelegationPolicy = {
  maxChildren: 4,
  maxConcurrentChildren: 2,
  maxAttempts: 8,
  maxTotalTokens: 80_000,
  maxCostUsd: 10,
  maxTokensPerAttempt: 10_000,
  maxCostUsdPerAttempt: 1,
  targets: {},
};

export function makeNode(id: string, kind: WorkflowNodeDraft["kind"]): WorkflowNodeDraft {
  switch (kind) {
    case "agent":
    case "route":
      return { id, kind, agentPromptRevisionId: "" };
    case "deterministic":
      return { id, kind, operation: "checkpoint" };
    case "human-gate":
      return { id, kind, anyoneCanApprove: true, approverMemberIds: [] };
    case "branch":
    case "join":
      return { id, kind };
  }
}

export function makeEdge(
  edge: Pick<WorkflowEdgeDraft, "id" | "from" | "to">,
  kind: WorkflowEdgeDraft["kind"],
): WorkflowEdgeDraft {
  const identity = { id: edge.id, from: edge.from, to: edge.to };
  switch (kind) {
    case "loop":
      return { ...identity, kind, maxTraversals: 1 };
    case "branch":
      return { ...identity, kind, required: true };
    default:
      return { ...identity, kind };
  }
}

export function nextEditorId(prefix: string, used: readonly { id: string }[]) {
  const ids = new Set(used.map(({ id }) => id));
  let suffix = 1;
  while (ids.has(`${prefix}-${suffix}`)) suffix++;
  return `${prefix}-${suffix}`;
}

export function setNodeRoute(graph: WorkflowGraphDraft, id: string, update: RouteDraft) {
  const policy = graph.routePolicy ?? { maxNodeVisits: 32, maxLoopTraversals: 4, nodes: {} };
  return { ...graph, routePolicy: { ...policy, nodes: { ...policy.nodes, [id]: update } } };
}

export function setEditorNode(graph: WorkflowGraphDraft, index: number, node: WorkflowNodeDraft) {
  const prior = graph.nodes[index];
  if (!prior) return graph;
  const renamed = prior.id !== node.id;
  const alias = (id: string) => (renamed && id === prior.id ? node.id : id);
  const next = {
    ...graph,
    entryNodeId: alias(graph.entryNodeId),
    nodes: graph.nodes.map((value, position) => (position === index ? node : value)),
    edges: graph.edges.map((edge) => ({ ...edge, from: alias(edge.from), to: alias(edge.to) })),
  };
  if (graph.routePolicy) {
    const routes = Object.entries(graph.routePolicy.nodes).flatMap(([id, route]) => {
      if (id === prior.id && node.kind !== "route") return [];
      const updated: RouteDraft = {
        ...route,
        allowedDestinationIds: route.allowedDestinationIds.map(alias),
        fallback:
          route.fallback.kind === "route"
            ? { ...route.fallback, destinationId: alias(route.fallback.destinationId) }
            : route.fallback,
      };
      return [[alias(id), updated] as const];
    });
    next.routePolicy = routes.length
      ? { ...graph.routePolicy, nodes: Object.fromEntries(routes) }
      : undefined;
  }
  if (graph.delegationPolicy) {
    const targets = Object.entries(graph.delegationPolicy.targets).flatMap(([id, target]) =>
      id === prior.id && node.kind !== "agent" ? [] : [[alias(id), target] as const],
    );
    next.delegationPolicy = { ...graph.delegationPolicy, targets: Object.fromEntries(targets) };
  }
  if (node.kind === "route" && !next.routePolicy?.nodes[node.id]) {
    return setNodeRoute(next, node.id, {
      minimumConfidence: 0.8,
      allowedDestinationIds: [],
      fallback: { kind: "clarification" },
    });
  }
  return next;
}

export function deleteEditorNode(graph: WorkflowGraphDraft, index: number) {
  const removed = graph.nodes[index];
  if (!removed) return graph;
  const nodes = graph.nodes.filter((_, position) => position !== index);
  const withoutPolicy = setEditorNode(graph, index, makeNode(removed.id, "deterministic"));
  const routePolicy = withoutPolicy.routePolicy;
  return {
    ...withoutPolicy,
    nodes,
    entryNodeId: graph.entryNodeId === removed.id ? (nodes[0]?.id ?? "") : graph.entryNodeId,
    edges: graph.edges.filter(({ from, to }) => from !== removed.id && to !== removed.id),
    routePolicy: routePolicy
      ? {
          ...routePolicy,
          nodes: Object.fromEntries(
            Object.entries(routePolicy.nodes).map(([id, route]) => [
              id,
              {
                ...route,
                allowedDestinationIds: route.allowedDestinationIds.filter(
                  (target) => target !== removed.id,
                ),
                fallback:
                  route.fallback.kind === "route" && route.fallback.destinationId === removed.id
                    ? { kind: "clarification" }
                    : route.fallback,
              },
            ]),
          ),
        }
      : undefined,
  } satisfies WorkflowGraphDraft;
}

export function workflowLayers(graph: WorkflowGraphDraft) {
  const heads = new Map(graph.nodes.map(({ id }) => [id, 0]));
  const targets = new Map<string, string[]>();
  for (const { kind, from, to } of graph.edges) {
    if (kind === "loop" || !heads.has(from) || !heads.has(to) || to === graph.entryNodeId) continue;
    heads.set(to, (heads.get(to) ?? 0) + 1);
    const adjacent = targets.get(from);
    if (adjacent) adjacent.push(to);
    else targets.set(from, [to]);
  }
  const layers: string[][] = [];
  const first = [...heads].filter(([, count]) => count === 0).map(([id]) => id);
  if (first.includes(graph.entryNodeId)) {
    first.splice(first.indexOf(graph.entryNodeId), 1);
    first.unshift(graph.entryNodeId);
  }
  let layer = first;
  while (layer.length) {
    layers.push(layer);
    const next: string[] = [];
    for (const id of layer) {
      heads.delete(id);
      for (const to of targets.get(id) ?? []) {
        const count = heads.get(to);
        if (count === undefined) continue;
        heads.set(to, count - 1);
        if (count === 1) next.push(to);
      }
    }
    layer = next;
  }
  if (heads.size) layers.push([...heads.keys()]);
  return layers;
}
