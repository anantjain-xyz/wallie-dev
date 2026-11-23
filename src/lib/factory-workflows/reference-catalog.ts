import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { withCatalogSignal } from "@/lib/factory-definitions/catalog-query";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import type { WorkflowGraphDefinition } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import {
  workflowReferencePageSize,
  type WorkflowBaseDefinition,
  type WorkflowEditorCatalog,
  type WorkflowReferenceKind,
  type WorkflowReferencePage,
} from "./authoring-contracts";

type CatalogScope = {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
};

function referencePage<T>(items: T[], offset: number) {
  return {
    items: items.slice(0, workflowReferencePageSize),
    nextOffset:
      items.length > workflowReferencePageSize ? offset + workflowReferencePageSize : null,
  };
}

async function loadPromptChoices(
  { supabase, workspaceId, factoryId }: CatalogScope,
  offset: number,
) {
  const { data, error } = await supabase
    .from("factory_agent_prompt_revisions")
    .select("id, revision_number, factory_agents!inner(name)")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("created_at", { ascending: false })
    .order("id")
    .range(offset, offset + workflowReferencePageSize);
  if (error) throw error;
  return referencePage(
    data.map((item) => ({
      id: item.id,
      label: `${item.factory_agents.name} · Revision ${item.revision_number}`,
    })),
    offset,
  );
}

async function loadApproverChoices({ supabase, workspaceId }: CatalogScope, offset: number) {
  const { data, error } = await supabase
    .from("workspace_members")
    .select("id, full_name, username, email")
    .eq("workspace_id", workspaceId)
    .eq("kind", "human")
    .eq("is_active", true)
    .order("full_name")
    .order("id")
    .range(offset, offset + workflowReferencePageSize);
  if (error) throw error;
  return referencePage(
    data.map(({ id, full_name, username, email }) => ({
      id,
      label: full_name || username || email || id,
    })),
    offset,
  );
}

async function loadProfileChoices(
  { supabase, workspaceId, factoryId }: CatalogScope,
  offset: number,
) {
  const { data, error } = await supabase
    .from("factory_definition_revisions")
    .select("id, canonical_digest, created_at")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("created_at", { ascending: false })
    .order("id")
    .range(offset, offset + workflowReferencePageSize);
  if (error) throw error;
  return referencePage(
    data.map(({ id, canonical_digest, created_at }) => ({
      id,
      digest: canonical_digest,
      label: `${created_at.slice(0, 10)} · ${canonical_digest.slice(0, 10)}`,
    })),
    offset,
  );
}

/** The caller checks the current manager authority before using the signed-in RLS client. */
export async function loadWorkflowReferencePage(
  scope: CatalogScope,
  catalog: WorkflowReferenceKind,
  offset: number,
): Promise<WorkflowReferencePage> {
  switch (catalog) {
    case "prompts":
      return { catalog, ...(await loadPromptChoices(scope, offset)) };
    case "approvers":
      return { catalog, ...(await loadApproverChoices(scope, offset)) };
    case "profiles":
      return { catalog, ...(await loadProfileChoices(scope, offset)) };
  }
}

async function loadWorkflowBaseGrant(
  { supabase, workspaceId, factoryId }: CatalogScope,
  base: WorkflowBaseDefinition | null,
) {
  if (!base) return null;
  const { data, error } = await supabase
    .from("factory_definition_revisions")
    .select("definition_json")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("id", base.revisionId)
    .eq("canonical_digest", base.digest)
    .maybeSingle();
  if (error) throw error;
  return data
    ? (readVerifiedFactoryDefinition(data.definition_json, base.digest)?.executionGrant ?? null)
    : null;
}

export async function loadWorkflowEditorChoices(
  scope: CatalogScope,
  base: WorkflowBaseDefinition | null,
): Promise<WorkflowEditorCatalog> {
  const [prompts, approvers, profiles, grant] = await Promise.all([
    loadPromptChoices(scope, 0),
    loadApproverChoices(scope, 0),
    loadProfileChoices(scope, 0),
    loadWorkflowBaseGrant(scope, base),
  ]);
  return {
    prompts: prompts.items,
    approvers: approvers.items,
    profiles: profiles.items,
    grant,
    nextOffsets: {
      prompts: prompts.nextOffset,
      approvers: approvers.nextOffset,
      profiles: profiles.nextOffset,
    },
  };
}

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
        node.kind === "review"
          ? [node.reviewerPromptRevisionId]
          : "agentPromptRevisionId" in node
            ? [node.agentPromptRevisionId]
            : [],
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
