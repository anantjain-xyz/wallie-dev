import type { z } from "zod";

import type {
  WorkflowDelegationPolicy,
  WorkflowGraphDefinition,
  WorkflowRoutePolicy,
  workflowGraphSchema,
} from "@/lib/factory-definitions/workflow-schema";
import type { WorkflowEditorCatalog } from "@/lib/factory-workflows/authoring-contracts";

type InputGraph = z.input<typeof workflowGraphSchema>;
type Route = WorkflowRoutePolicy["nodes"][string];
export type RouteDraft = Omit<Route, "allowedDestinationIds" | "fallback"> & {
  allowedDestinationIds: string[];
  fallback: { kind: "clarification" } | { kind: "route"; destinationId: string };
};
export type RoutePolicyDraft = Omit<WorkflowRoutePolicy, "nodes"> & {
  nodes: Record<string, RouteDraft>;
};
export type RepositoryWriterDraft = {
  repositoryId: string;
  writerGrant: { id: string; version: number };
  branchEdgeIds: string[];
};
export type WorkflowGraphDraft = Omit<
  InputGraph,
  "routePolicy" | "delegationPolicy" | "repositorySets"
> & {
  routePolicy?: RoutePolicyDraft;
  delegationPolicy?: WorkflowDelegationPolicy;
  repositorySets?: Record<string, RepositoryWriterDraft[]>;
};
export type WorkflowNodeDraft = WorkflowGraphDraft["nodes"][number];
export type WorkflowEdgeDraft = WorkflowGraphDraft["edges"][number];
export type WorkflowEditorChoices = {
  prompts: { id: string; label: string }[];
  approvers: { id: string; label: string }[];
  profiles: { id: string; digest: string; label: string }[];
  grant: WorkflowGraphDefinition["grants"][number] | null;
  grantRepository?: string;
  nextCursors?: WorkflowEditorCatalog["nextCursors"];
  writers: { repositoryId: string; id: string; version: number; label: string }[];
};

export const nodeLabels = {
  agent: "Agent",
  deterministic: "Deterministic step",
  "human-gate": "Human gate",
  route: "Route",
  branch: "Branch",
  join: "Join",
  review: "Review",
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

export const defaultRoutePolicy: RoutePolicyDraft = {
  maxNodeVisits: 32,
  maxLoopTraversals: 4,
  nodes: {},
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
    case "review":
      return { id, kind, reviewerPromptRevisionId: "", ruleIds: ["review-1"] };
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
  const policy = graph.routePolicy ?? defaultRoutePolicy;
  return {
    ...graph,
    routePolicy: { ...policy, nodes: { ...policy.nodes, [id]: update } },
  };
}

export function setEditorNode(graph: WorkflowGraphDraft, index: number, node: WorkflowNodeDraft) {
  const prior = graph.nodes[index];
  if (!prior) return graph;
  const renamed = prior.id !== node.id;
  if (renamed && graph.nodes.some(({ id }, position) => position !== index && id === node.id)) {
    return graph;
  }
  const alias = (id: string) => (renamed && id === prior.id ? node.id : id);
  const next = {
    ...graph,
    entryNodeId: alias(graph.entryNodeId),
    nodes: graph.nodes.map((value, position) => (position === index ? node : value)),
    edges: graph.edges.map((edge) => ({
      ...edge,
      from: alias(edge.from),
      to: alias(edge.to),
    })),
  };
  if (graph.repositorySets) {
    const sets = Object.entries(graph.repositorySets).flatMap(([id, writers]) =>
      id === prior.id && node.kind !== "join" ? [] : [[alias(id), writers] as const],
    );
    next.repositorySets = sets.length ? Object.fromEntries(sets) : undefined;
  }
  if (graph.routePolicy) {
    const routes = Object.entries(graph.routePolicy.nodes).flatMap(([id, route]) => {
      if (id === prior.id && node.kind !== "route") return [];
      const updated: RouteDraft = {
        ...route,
        allowedDestinationIds: route.allowedDestinationIds.map(alias),
        fallback:
          route.fallback.kind === "route"
            ? {
                ...route.fallback,
                destinationId: alias(route.fallback.destinationId),
              }
            : route.fallback,
      };
      return [[alias(id), updated] as const];
    });
    next.routePolicy = { ...graph.routePolicy, nodes: Object.fromEntries(routes) };
  }
  if (graph.delegationPolicy) {
    const targets = Object.entries(graph.delegationPolicy.targets).flatMap(([id, target]) =>
      id === prior.id && node.kind !== "agent" ? [] : [[alias(id), target] as const],
    );
    next.delegationPolicy = {
      ...graph.delegationPolicy,
      targets: Object.fromEntries(targets),
    };
  }
  if (
    node.kind === "route" &&
    (!next.routePolicy || !Object.hasOwn(next.routePolicy.nodes, node.id))
  ) {
    return syncRepositoryWriters(
      graph,
      setNodeRoute(next, node.id, {
        minimumConfidence: 0.8,
        allowedDestinationIds: [],
        fallback: { kind: "clarification" },
      }),
    );
  }
  const grantChanged =
    node.kind === "agent" && prior.kind === "agent" && node.grantId !== prior.grantId;
  return renamed || prior.kind !== node.kind || grantChanged
    ? syncRepositoryWriters(graph, next)
    : next;
}

export function deleteEditorNode(graph: WorkflowGraphDraft, index: number) {
  const removed = graph.nodes[index];
  if (!removed) return graph;
  const nodes = graph.nodes.filter((_, position) => position !== index);
  const withoutPolicy = setEditorNode(graph, index, makeNode(removed.id, "deterministic"));
  const routePolicy = withoutPolicy.routePolicy;
  return syncRepositoryWriters(graph, {
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
  } satisfies WorkflowGraphDraft);
}

export function branchEdgesForJoin(graph: WorkflowGraphDraft, joinId: string) {
  const joinedAgents = new Set(
    graph.edges
      .filter((edge) => edge.kind === "branch-result" && edge.to === joinId)
      .map(({ from }) => from),
  );
  return graph.edges.filter((edge) => edge.kind === "branch" && joinedAgents.has(edge.to));
}

export function getAgentRepositoryWriter(graph: WorkflowGraphDraft, agentId: string) {
  let assignment: { joinId: string; writerGrant: RepositoryWriterDraft["writerGrant"] } | undefined;
  for (const [joinId, writers] of Object.entries(graph.repositorySets ?? {})) {
    const branchIds = new Set(
      branchEdgesForJoin(graph, joinId)
        .filter(({ to }) => to === agentId)
        .map(({ id }) => id),
    );
    for (const { writerGrant, branchEdgeIds } of writers) {
      if (branchEdgeIds.some((id) => branchIds.has(id))) assignment = { joinId, writerGrant };
    }
  }
  return assignment;
}

export function removeObsoleteEditorGrants(
  graph: WorkflowGraphDraft,
  primaryGrant: WorkflowEditorChoices["grant"],
): WorkflowGraphDraft {
  const key = ({ id, version }: WorkflowGraphDraft["grants"][number]) => `${id}:${version}`;
  const available = new Set(
    Object.values(graph.repositorySets ?? {}).flatMap((entries) =>
      entries.map(({ writerGrant }) => key(writerGrant)),
    ),
  );
  if (primaryGrant) available.add(key(primaryGrant));
  const grants = graph.grants.filter((grant) => available.has(key(grant)));
  if (grants.length === graph.grants.length) return graph;

  const retainedIds = new Set(grants.map(({ id }) => id));
  const removedIds = new Set(
    graph.grants.filter(({ id }) => !retainedIds.has(id)).map(({ id }) => id),
  );
  return {
    ...graph,
    grants,
    nodes: graph.nodes.map((node) =>
      "grantId" in node && node.grantId && removedIds.has(node.grantId)
        ? { ...node, grantId: undefined }
        : node,
    ),
  };
}

function syncRepositoryWriters(
  previous: WorkflowGraphDraft,
  updated: WorkflowGraphDraft,
): WorkflowGraphDraft {
  if (!previous.repositorySets && !updated.repositorySets) return updated;
  const assignments = new Map<string, string>();
  const writers = new Map<string, RepositoryWriterDraft["writerGrant"]>();
  const repositorySets = Object.fromEntries(
    Object.entries(updated.repositorySets ?? {}).map(([joinId, entries]) => {
      const branches = new Map(
        branchEdgesForJoin(updated, joinId).map((edge) => [edge.id, edge.to]),
      );
      return [
        joinId,
        entries.map((entry) => {
          writers.set(entry.writerGrant.id, entry.writerGrant);
          const branchEdgeIds = entry.branchEdgeIds.filter((id) => {
            const agent = branches.get(id);
            if (!agent) return false;
            assignments.set(agent, entry.writerGrant.id);
            return true;
          });
          return { ...entry, branchEdgeIds };
        }),
      ];
    }),
  );
  const previousWriters = new Set(
    Object.values(previous.repositorySets ?? {}).flatMap((entries) =>
      entries.map(({ writerGrant }) => writerGrant.id),
    ),
  );
  const nodes = updated.nodes.map((node) => {
    if (node.kind !== "agent") return node;
    const writerId = assignments.get(node.id);
    if (writerId) return { ...node, grantId: writerId };
    if (node.grantId && previousWriters.has(node.grantId)) return { ...node, grantId: undefined };
    return node;
  });
  return {
    ...updated,
    nodes,
    repositorySets: Object.keys(repositorySets).length ? repositorySets : undefined,
    grants: [
      ...updated.grants.filter(({ id }) => !previousWriters.has(id) && !writers.has(id)),
      ...writers.values(),
    ],
  };
}

export function setEditorRepositoryWriters(
  graph: WorkflowGraphDraft,
  joinId: string,
  entries: RepositoryWriterDraft[],
) {
  const repositorySets = { ...graph.repositorySets };
  if (entries.length) repositorySets[joinId] = entries;
  else delete repositorySets[joinId];
  return syncRepositoryWriters(graph, { ...graph, repositorySets });
}

export function updateEditorEdge(
  graph: WorkflowGraphDraft,
  index: number,
  edge?: WorkflowEdgeDraft,
) {
  const prior = graph.edges[index];
  if (!prior) return graph;
  if (edge && prior.id !== edge.id && graph.edges.some(({ id }) => id === edge.id)) return graph;
  const edges = edge
    ? graph.edges.map((item, position) => (position === index ? edge : item))
    : graph.edges.filter((_, position) => position !== index);
  const sets = Object.entries(graph.repositorySets ?? {}).map(([id, writers]) => [
    id,
    writers.map((writer) => ({
      ...writer,
      branchEdgeIds: writer.branchEdgeIds.flatMap((id) =>
        id === prior.id ? (edge?.kind === "branch" ? [edge.id] : []) : [id],
      ),
    })),
  ]);
  return syncRepositoryWriters(graph, {
    ...graph,
    edges,
    repositorySets: sets.length ? Object.fromEntries(sets) : undefined,
  });
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
