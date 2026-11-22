import {
  MAX_WORKFLOW_NODE_VISITS,
  type WorkflowDiagnostic,
  type WorkflowGraphDefinition,
} from "./workflow-schema";

type WorkflowNode = WorkflowGraphDefinition["nodes"][number];
type WorkflowEdge = WorkflowGraphDefinition["edges"][number];
type NodeId = WorkflowNode["id"];
type IndexedEdge = { edge: WorkflowEdge; index: number };
type EdgesByNode = Map<NodeId, IndexedEdge[]>;

function addEdge(edges: EdgesByNode, id: NodeId, entry: IndexedEdge) {
  const previous = edges.get(id);
  if (previous) previous.push(entry);
  else edges.set(id, [entry]);
}

function edgeConnectsNodeKinds(
  kind: WorkflowEdge["kind"],
  from: WorkflowNode["kind"],
  to: WorkflowNode["kind"],
) {
  switch (kind) {
    case "next":
      return from !== "route" && from !== "branch";
    case "route":
    case "loop":
      return from === "route";
    case "branch":
      return from === "branch" && to === "agent";
    case "branch-result":
      return from === "agent" && to === "join";
  }
}

function reachableForward(start: NodeId, outgoing: EdgesByNode) {
  const reachable = new Set<NodeId>([start]);
  const pending = [start];
  for (let index = 0; index < pending.length; index += 1) {
    for (const { edge } of outgoing.get(pending[index]) ?? []) {
      if (edge.kind === "loop" || reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      pending.push(edge.to);
    }
  }
  return reachable;
}

function firstForwardCycle(nodes: readonly WorkflowNode[], outgoing: EdgesByNode) {
  const state = new Map<NodeId, "visiting" | "visited">();

  function visit(nodeId: NodeId): IndexedEdge | undefined {
    state.set(nodeId, "visiting");
    for (const entry of outgoing.get(nodeId) ?? []) {
      if (entry.edge.kind === "loop") continue;
      const target = entry.edge.to;
      if (state.get(target) === "visiting") return entry;
      if (state.has(target)) continue;
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    state.set(nodeId, "visited");
  }

  for (const { id } of nodes) {
    if (state.has(id)) continue;
    const cycle = visit(id);
    if (cycle) return cycle;
  }
}

function validateBranch(
  paths: readonly IndexedEdge[],
  outgoing: EdgesByNode,
  index: number,
  diagnostics: WorkflowDiagnostic[],
) {
  const targets = new Set(paths.map(({ edge }) => edge.to));
  if (
    targets.size < 2 ||
    paths.length !== targets.size ||
    !paths.some(({ edge }) => edge.kind === "branch" && edge.required)
  ) {
    diagnostics.push({
      code: "invalid_edge",
      path: ["nodes", index, "id"],
      message: "A branch needs at least two distinct agent targets, including a required target.",
    });
  }

  const joins = new Set<NodeId>();
  for (const target of targets) {
    const result = outgoing.get(target)?.find(({ edge }) => edge.kind === "branch-result");
    if (result) joins.add(result.edge.to);
  }
  if (joins.size !== 1) {
    diagnostics.push({
      code: "invalid_join",
      path: ["nodes", index, "id"],
      message: "Send all results from this branch to the same join.",
    });
  }
}

export function validateWorkflowTopology(graph: WorkflowGraphDefinition): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const nodesById = new Map<NodeId, WorkflowNode>();
  const edgeIds = new Set<WorkflowEdge["id"]>();
  const incoming: EdgesByNode = new Map();
  const outgoing: EdgesByNode = new Map();

  graph.nodes.forEach((node, index) => {
    if (nodesById.has(node.id)) {
      diagnostics.push({
        code: "duplicate_id",
        path: ["nodes", index, "id"],
        message: `Node ID "${node.id}" is already used.`,
      });
    }
    nodesById.set(node.id, node);
  });

  graph.edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) {
      diagnostics.push({
        code: "duplicate_id",
        path: ["edges", index, "id"],
        message: `Edge ID "${edge.id}" is already used.`,
      });
    }
    edgeIds.add(edge.id);

    const from = nodesById.get(edge.from);
    const to = nodesById.get(edge.to);
    if (!from || !to) {
      for (const end of ["from", "to"] as const) {
        if (nodesById.has(edge[end])) continue;
        diagnostics.push({
          code: "missing_reference",
          path: ["edges", index, end],
          message: `Node "${edge[end]}" does not exist.`,
        });
      }
      return;
    }
    if (!edgeConnectsNodeKinds(edge.kind, from.kind, to.kind)) {
      diagnostics.push({
        code: "invalid_edge",
        path: ["edges", index, "kind"],
        message: `A ${edge.kind} edge cannot connect a ${from.kind} node to a ${to.kind} node.`,
      });
      return;
    }
    addEdge(incoming, to.id, { edge, index });
    addEdge(outgoing, from.id, { edge, index });
  });

  const entry = nodesById.get(graph.entryNodeId);
  if (!entry) {
    diagnostics.push({
      code: "missing_reference",
      path: ["entryNodeId"],
      message: `Entry node "${graph.entryNodeId}" does not exist.`,
    });
  }
  if (!entry || diagnostics.length) return diagnostics;

  if (entry.kind === "join" || incoming.get(entry.id)?.some(({ edge }) => edge.kind !== "loop")) {
    diagnostics.push({
      code: "invalid_edge",
      path: ["entryNodeId"],
      message: "Choose an entry node with no forward predecessors. A join cannot be the entry.",
    });
  }

  const reachable = reachableForward(entry.id, outgoing);
  graph.nodes.forEach((node, index) => {
    if (!reachable.has(node.id)) {
      diagnostics.push({
        code: "unreachable_node",
        path: ["nodes", index, "id"],
        message: `Node "${node.id}" needs a forward path from the entry node.`,
      });
    }

    const predecessors = incoming.get(node.id) ?? [];
    const successors = outgoing.get(node.id) ?? [];
    const path = ["nodes", index, "id"];

    switch (node.kind) {
      case "route": {
        if (!successors.some(({ edge }) => edge.kind === "route")) {
          diagnostics.push({
            code: "invalid_edge",
            path,
            message: "Add a forward route so this node can advance when loops are exhausted.",
          });
        }
        const targets = new Set<NodeId>();
        for (const { edge, index } of successors) {
          if (targets.has(edge.to)) {
            diagnostics.push({
              code: "invalid_edge",
              path: ["edges", index, "to"],
              message: `This route already has a choice leading to "${edge.to}".`,
            });
          }
          targets.add(edge.to);
        }
        break;
      }
      case "branch":
        validateBranch(successors, outgoing, index, diagnostics);
        break;
      case "join": {
        const branchInputs = predecessors.flatMap(({ edge }) =>
          edge.kind === "branch-result"
            ? (incoming.get(edge.from) ?? []).filter(({ edge }) => edge.kind === "branch")
            : [],
        );
        if (
          predecessors.length < 2 ||
          branchInputs.length !== predecessors.length ||
          new Set(branchInputs.map(({ edge }) => edge.from)).size !== 1
        ) {
          diagnostics.push({
            code: "invalid_join",
            path,
            message: "A join must receive results from the isolated agents of exactly one branch.",
          });
        }
        break;
      }
      case "agent":
        if (
          predecessors.some(({ edge }) => edge.kind === "branch") ||
          successors.some(({ edge }) => edge.kind === "branch-result")
        ) {
          if (
            predecessors.length !== 1 ||
            predecessors[0]?.edge.kind !== "branch" ||
            successors.length !== 1 ||
            successors[0]?.edge.kind !== "branch-result"
          ) {
            diagnostics.push({
              code: "invalid_join",
              path,
              message: "A branch agent needs exactly one branch input and one result to its join.",
            });
          }
        }
        break;
      case "deterministic":
      case "human-gate":
        break;
    }

    if (node.kind !== "route" && node.kind !== "branch" && successors.length > 1) {
      diagnostics.push({
        code: "invalid_edge",
        path,
        message: "Use an explicit route or branch to add more than one outgoing edge.",
      });
    }
  });

  const cycle = firstForwardCycle(graph.nodes, outgoing);
  if (cycle) {
    diagnostics.push({
      code: "unbounded_cycle",
      path: ["edges", cycle.index, "kind"],
      message: "Forward edges form a cycle. Use an explicit bounded loop from a route.",
    });
  }

  let loopTraversals = 0;
  graph.edges.forEach((edge, index) => {
    if (edge.kind !== "loop") return;
    loopTraversals += edge.maxTraversals;
    if (!cycle && !reachableForward(edge.to, outgoing).has(edge.from)) {
      diagnostics.push({
        code: "invalid_loop",
        path: ["edges", index, "to"],
        message: "A bounded loop must return to its route or a forward ancestor of that route.",
      });
    }
  });
  if (graph.nodes.length * (1 + loopTraversals) > MAX_WORKFLOW_NODE_VISITS) {
    diagnostics.push({
      code: "expansion_limit",
      path: ["edges"],
      message: `Reduce node count or loop limits to fit within ${MAX_WORKFLOW_NODE_VISITS} node visits per execution.`,
    });
  }

  return diagnostics;
}
