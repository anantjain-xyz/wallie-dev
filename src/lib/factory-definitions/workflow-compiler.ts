import type { FactoryDefinitionSource } from "./compiler";
import { normalizeFactoryId, type FactoryReferenceEntry } from "./references";
import type { CompiledFactoryDefinition } from "./schema";
import { parseFactoryDefinitionJson, serializeFactoryDefinition } from "./serialization";
import { validateWorkflowTopology } from "./workflow-topology";
import {
  workflowEdgeIdSchema,
  workflowGraphSchema,
  workflowNodeIdSchema,
  type WorkflowDiagnostic,
  type WorkflowGraphDefinition,
  type WorkflowNodeId,
  type WorkflowRoutePolicy,
} from "./workflow-schema";

type WorkflowReference = Pick<FactoryReferenceEntry, "id" | "workspaceId">;
type WorkflowGrant = WorkflowGraphDefinition["grants"][number] & WorkflowReference;

type WorkflowGraphCatalog = {
  workspaceId: string;
  agentPromptRevisions: readonly WorkflowReference[];
  approvers: readonly WorkflowReference[];
  approvedGrants?: readonly WorkflowGrant[];
};

export type WorkflowGraphCompileResult =
  | { ok: false; diagnostics: WorkflowDiagnostic[] }
  | {
      ok: true;
      bundle: WorkflowGraphDefinition;
      definitionJson: string;
      canonicalDigest: string;
    };

/** Compile graph data against the components authorized for the owning factory. */
export function compileWorkflowGraph(
  source: FactoryDefinitionSource,
  catalog: WorkflowGraphCatalog,
): WorkflowGraphCompileResult {
  const input =
    source.kind === "json"
      ? parseFactoryDefinitionJson(source.text)
      : { ok: true as const, value: source.value };
  if (!input.ok) {
    return { ok: false, diagnostics: [{ path: [], code: "invalid_json", message: input.message }] };
  }

  const parsed = workflowGraphSchema.safeParse(input.value);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map(({ path, message }) => ({
        path,
        code: "invalid_schema",
        message,
      })),
    };
  }

  const graph = parsed.data;
  const diagnostics = [
    ...validateWorkflowTopology(graph),
    ...validateWorkflowReferences(graph, catalog),
  ];
  if (diagnostics.length) return { ok: false, diagnostics };

  const { routePolicy, delegationPolicy, ...graphWithoutPolicies } = graph;
  const bundle = {
    ...graphWithoutPolicies,
    ...(routePolicy ? { routePolicy: canonicalRoutePolicy(routePolicy) } : {}),
    ...(delegationPolicy ? { delegationPolicy } : {}),
    nodes: graph.nodes.map(canonicalWorkflowNode).sort(compareIds),
    edges: [...graph.edges].sort(compareIds),
    grants: [...graph.grants].sort(compareIds),
  };
  return { ok: true, bundle, ...serializeFactoryDefinition(bundle) };
}

function canonicalRoutePolicy(policy: WorkflowRoutePolicy): WorkflowRoutePolicy {
  return {
    ...policy,
    maxLoopTraversals: Math.max(0, policy.maxLoopTraversals),
    nodes: Object.fromEntries(
      Object.entries(policy.nodes).map(([id, { foremanProfile, ...node }]) => [
        id,
        {
          ...node,
          ...(foremanProfile ? { foremanProfile } : {}),
          minimumConfidence: Math.max(0, node.minimumConfidence),
          allowedDestinationIds: [...node.allowedDestinationIds].sort(),
        },
      ]),
    ),
  };
}

function canonicalWorkflowNode(
  node: WorkflowGraphDefinition["nodes"][number],
): WorkflowGraphDefinition["nodes"][number] {
  if (node.kind === "human-gate") {
    return { ...node, approverMemberIds: [...new Set(node.approverMemberIds)].sort() };
  }
  if (node.kind === "review") {
    const { repair, ...review } = node;
    return {
      ...review,
      ruleIds: [...review.ruleIds].sort(),
      ...(repair
        ? { repair: { ...repair, eligibleRuleIds: [...repair.eligibleRuleIds].sort() } }
        : {}),
    };
  }
  if (node.kind === "agent" || node.kind === "route") {
    const { grantId, ...binding } = node;
    return grantId === undefined ? binding : node;
  }
  return node;
}

function compareIds(left: { id: string }, right: { id: string }) {
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function validateWorkflowReferences(
  graph: WorkflowGraphDefinition,
  { workspaceId, agentPromptRevisions, approvers, approvedGrants = [] }: WorkflowGraphCatalog,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const scope = normalizeFactoryId(workspaceId);
  const inWorkspace = (entry: WorkflowReference) => normalizeFactoryId(entry.workspaceId) === scope;
  const allowedGrants = new Set(
    approvedGrants
      .filter(inWorkspace)
      .map(({ id, version }) => `${normalizeFactoryId(id)}:${version}`),
  );
  const allowedAgents = new Set(
    agentPromptRevisions.filter(inWorkspace).map(({ id }) => normalizeFactoryId(id)),
  );
  const allowedApprovers = new Set(
    approvers.filter(inWorkspace).map(({ id }) => normalizeFactoryId(id)),
  );
  const declared = new Set<string>();
  graph.grants.forEach(({ id, version }, index) => {
    if (declared.has(id)) {
      diagnostics.push({
        path: ["grants", index, "id"],
        code: "invalid_grant",
        message: `Declare only one revision of grant "${id}".`,
      });
    }
    if (!allowedGrants.has(`${id}:${version}`)) {
      diagnostics.push({
        path: ["grants", index],
        code: "invalid_grant",
        message: `Grant "${id}" revision ${version} is unavailable to this workflow.`,
      });
    }
    declared.add(id);
  });
  graph.nodes.forEach((node, index) => {
    if ("agentPromptRevisionId" in node && !allowedAgents.has(node.agentPromptRevisionId)) {
      diagnostics.push({
        path: ["nodes", index, "agentPromptRevisionId"],
        code: "missing_reference",
        message: `Agent prompt revision "${node.agentPromptRevisionId}" is unavailable to this workflow.`,
      });
    }
    if (node.kind === "review" && !allowedAgents.has(node.reviewerPromptRevisionId)) {
      diagnostics.push({
        path: ["nodes", index, "reviewerPromptRevisionId"],
        code: "missing_reference",
        message: `Reviewer prompt revision "${node.reviewerPromptRevisionId}" is unavailable to this workflow.`,
      });
    }
    if ("grantId" in node && node.grantId && !declared.has(node.grantId)) {
      diagnostics.push({
        path: ["nodes", index, "grantId"],
        code: "invalid_grant",
        message: `Declare an authorized revision of grant "${node.grantId}".`,
      });
    }
    if (node.kind === "human-gate") {
      node.approverMemberIds.forEach((id, approverIndex) => {
        if (allowedApprovers.has(id)) return;
        diagnostics.push({
          path: ["nodes", index, "approverMemberIds", approverIndex],
          code: "missing_reference",
          message: `Approver "${id}" is unavailable to this workflow.`,
        });
      });
    }
  });
  return diagnostics;
}

type SerialStage = CompiledFactoryDefinition["stages"][number];
type SerialWorkflowNode =
  | {
      id: WorkflowNodeId;
      kind: "agent";
      stage: Omit<SerialStage, "anyoneCanApprove" | "approverMemberIds">;
    }
  | {
      id: WorkflowNodeId;
      kind: "human-gate";
      stageId: SerialStage["id"];
      approval: Pick<SerialStage, "anyoneCanApprove" | "approverMemberIds">;
    };

/** Derive the workflow of an immutable serial revision without rewriting its stored bytes. */
export function projectSerialWorkflow(definition: CompiledFactoryDefinition) {
  const nodes: SerialWorkflowNode[] = definition.stages.flatMap(
    ({ anyoneCanApprove, approverMemberIds, ...stage }): SerialWorkflowNode[] => [
      {
        id: workflowNodeIdSchema.parse(`stage.${stage.id}`),
        kind: "agent",
        stage: { ...stage, previousStageIds: [...stage.previousStageIds] },
      },
      {
        id: workflowNodeIdSchema.parse(`approval.${stage.id}`),
        kind: "human-gate",
        stageId: stage.id,
        approval: { anyoneCanApprove, approverMemberIds: [...approverMemberIds] },
      },
    ],
  );
  const edges = nodes.slice(1).map((node, index) => {
    const predecessor = nodes[index];
    return {
      id: workflowEdgeIdSchema.parse(`next.${predecessor.id}`),
      kind: "next" as const,
      from: predecessor.id,
      to: node.id,
    };
  });
  return { kind: "serial" as const, entryNodeId: nodes[0].id, nodes, edges };
}
