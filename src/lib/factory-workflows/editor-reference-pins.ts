import type { WorkflowGraphDefinition } from "@/lib/factory-definitions/workflow-schema";

export function workflowEditorReferencePins(graph: WorkflowGraphDefinition | null | undefined) {
  return {
    prompts: new Set(
      graph?.nodes.flatMap((node) =>
        node.kind === "review"
          ? [node.reviewerPromptRevisionId]
          : "agentPromptRevisionId" in node
            ? [node.agentPromptRevisionId]
            : [],
      ),
    ),
    approvers: new Set(
      graph?.nodes.flatMap((node) => (node.kind === "human-gate" ? node.approverMemberIds : [])),
    ),
    profiles: new Set([
      ...Object.values(graph?.delegationPolicy?.targets ?? {}).map(
        (profile) => profile.definitionRevisionId,
      ),
      ...Object.values(graph?.routePolicy?.nodes ?? {}).flatMap(({ foremanProfile }) =>
        foremanProfile ? [foremanProfile.definitionRevisionId] : [],
      ),
    ]),
    writers: new Set(
      Object.values(graph?.repositorySets ?? {}).flatMap((writers) =>
        writers.map(({ writerGrant }) => writerGrant.id),
      ),
    ),
  };
}
