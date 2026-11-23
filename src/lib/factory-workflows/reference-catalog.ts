import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { withCatalogSignal } from "@/lib/factory-definitions/catalog-query";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import type { WorkflowGraphDefinition } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";

import {
  workflowReferencePageSize,
  type WorkflowBaseDefinition,
  type WorkflowDatedReferenceCursor,
  type WorkflowEditorCatalog,
  type WorkflowReferencePage,
  type WorkflowReferenceQuery,
} from "./authoring-contracts";

type CatalogScope = {
  supabase: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
};

function referencePage<Row, Choice, Cursor>(
  rows: Row[],
  choice: (row: Row) => Choice,
  cursor: (row: Row) => Cursor,
) {
  const last = rows[workflowReferencePageSize - 1];
  return {
    items: rows.slice(0, workflowReferencePageSize).map(choice),
    nextCursor: rows.length > workflowReferencePageSize && last ? cursor(last) : null,
  };
}

function olderReferenceFilter({ createdAt, id }: WorkflowDatedReferenceCursor) {
  return `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`;
}

async function loadPromptChoices(
  { supabase, workspaceId, factoryId }: CatalogScope,
  after?: WorkflowDatedReferenceCursor,
) {
  const query = supabase
    .from("factory_agent_prompt_revisions")
    .select("id, created_at, revision_number, factory_agents!inner(name)")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(workflowReferencePageSize + 1);
  const { data, error } = await (after ? query.or(olderReferenceFilter(after)) : query);
  if (error) throw error;
  return referencePage(
    data,
    (item) => ({
      id: item.id,
      label: `${item.factory_agents.name} · Revision ${item.revision_number}`,
    }),
    ({ id, created_at }) => ({ id, createdAt: created_at }),
  );
}

async function loadApproverChoices({ supabase, workspaceId }: CatalogScope, afterId?: string) {
  const query = supabase
    .from("workspace_members")
    .select("id, full_name, username, email")
    .eq("workspace_id", workspaceId)
    .eq("kind", "human")
    .eq("is_active", true)
    .order("id")
    .limit(workflowReferencePageSize + 1);
  const { data, error } = await (afterId ? query.gt("id", afterId) : query);
  if (error) throw error;
  return referencePage(
    data,
    ({ id, full_name, username, email }) => ({
      id,
      label: full_name || username || email || id,
    }),
    ({ id }) => ({ id }),
  );
}

async function loadProfileChoices(
  { supabase, workspaceId, factoryId }: CatalogScope,
  after?: WorkflowDatedReferenceCursor,
) {
  const query = supabase
    .from("factory_definition_revisions")
    .select("id, canonical_digest, created_at")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(workflowReferencePageSize + 1);
  const { data, error } = await (after ? query.or(olderReferenceFilter(after)) : query);
  if (error) throw error;
  return referencePage(
    data,
    ({ id, canonical_digest, created_at }) => ({
      id,
      digest: canonical_digest,
      label: `${created_at.slice(0, 10)} · ${canonical_digest.slice(0, 10)}`,
    }),
    ({ id, created_at }) => ({ id, createdAt: created_at }),
  );
}

/** The caller checks the current manager authority before using the signed-in RLS client. */
export async function loadWorkflowReferencePage(
  scope: CatalogScope,
  query: WorkflowReferenceQuery,
): Promise<WorkflowReferencePage> {
  const { afterId } = query;
  switch (query.catalog) {
    case "prompts":
      return {
        catalog: query.catalog,
        ...(await loadPromptChoices(scope, { id: afterId, createdAt: query.afterCreatedAt })),
      };
    case "approvers":
      return { catalog: query.catalog, ...(await loadApproverChoices(scope, afterId)) };
    case "profiles":
      return {
        catalog: query.catalog,
        ...(await loadProfileChoices(scope, { id: afterId, createdAt: query.afterCreatedAt })),
      };
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
    loadPromptChoices(scope),
    loadApproverChoices(scope),
    loadProfileChoices(scope),
    loadWorkflowBaseGrant(scope, base),
  ]);
  return {
    prompts: prompts.items,
    approvers: approvers.items,
    profiles: profiles.items,
    grant,
    nextCursors: {
      prompts: prompts.nextCursor,
      approvers: approvers.nextCursor,
      profiles: profiles.nextCursor,
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
