import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { withCatalogSignal } from "@/lib/factory-definitions/catalog-query";
import type { WorkflowGraphDefinition } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

async function loadWorkflowApprovers(
  admin: SupabaseClient<Database>,
  workspaceId: string,
  approverIds: string[],
  signal?: AbortSignal,
) {
  const approvers: { id: string; workspaceId: string }[] = [];
  const batchSize = 128;
  for (let from = 0; from < approverIds.length; from += batchSize) {
    const { data, error } = await withCatalogSignal(
      admin
        .from("workspace_members")
        .select("id, workspace_id")
        .eq("workspace_id", workspaceId)
        .eq("kind", "human")
        .eq("is_active", true)
        .in("id", approverIds.slice(from, from + batchSize)),
      signal,
    );
    if (error) throw error;
    approvers.push(
      ...(data ?? []).map(({ id, workspace_id }) => ({ id, workspaceId: workspace_id })),
    );
  }
  return approvers;
}

/** The editor and graph enrollment resolve the same scoped prompt and approver references. */
export async function loadWorkflowGraphReferences(
  admin: SupabaseClient<Database>,
  {
    workspaceId,
    factoryId,
    graph,
    signal,
  }: {
    workspaceId: string;
    factoryId: string;
    graph: WorkflowGraphDefinition;
    signal?: AbortSignal;
  },
) {
  const revisionIds = [
    ...new Set(
      graph.nodes.flatMap((node) =>
        "agentPromptRevisionId" in node ? [node.agentPromptRevisionId] : [],
      ),
    ),
  ];
  const approverIds = [
    ...new Set(
      graph.nodes.flatMap((node) => (node.kind === "human-gate" ? node.approverMemberIds : [])),
    ),
  ];
  const [prompts, approvers] = await Promise.all([
    revisionIds.length
      ? withCatalogSignal(
          admin
            .from("factory_agent_prompt_revisions")
            .select("id, workspace_id")
            .eq("workspace_id", workspaceId)
            .eq("factory_id", factoryId)
            .in("id", revisionIds),
          signal,
        )
      : { data: [], error: null },
    loadWorkflowApprovers(admin, workspaceId, approverIds, signal),
  ]);
  if (prompts.error) throw prompts.error;
  return {
    agentPromptRevisions: (prompts.data ?? []).map(({ id, workspace_id }) => ({
      id,
      workspaceId: workspace_id,
    })),
    approvers,
  };
}
