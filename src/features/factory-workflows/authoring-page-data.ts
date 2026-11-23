import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import type { WorkflowBaseDefinition } from "@/lib/factory-workflows/authoring-contracts";

import type { WorkflowEditorChoices } from "./editor-graph";

const factoryIdSchema = z.string().uuid().toLowerCase();

/** Factory-only managers and workspace owners see the same scope as the native editor RPCs. */
export async function loadWorkflowAuthoringPageScope(workspaceSlug: string, factoryQuery: unknown) {
  const [context, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const manageable = factories.filter(
    (factory) => factory.canManage && factory.status === "active",
  );
  const requested = factoryIdSchema.optional().safeParse(factoryQuery);
  if (!requested.success) notFound();
  const factory = requested.data
    ? manageable.find(({ id }) => id === requested.data)
    : (manageable.find(({ isDefault }) => isDefault) ?? manageable[0]);
  if (!factory) notFound();
  return {
    ...context,
    factories: manageable,
    workspaceId: context.workspace.id,
    factoryId: factory.id,
  };
}

export async function loadWorkflowEditorChoices(
  { supabase, workspaceId, factoryId }: Awaited<ReturnType<typeof loadWorkflowAuthoringPageScope>>,
  base: WorkflowBaseDefinition | null,
): Promise<WorkflowEditorChoices> {
  const revisionQuery = () =>
    supabase
      .from("factory_definition_revisions")
      .select("id, canonical_digest, created_at")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId);
  const [prompts, approvers, revisions, baseRevision] = await Promise.all([
    supabase
      .from("factory_agent_prompt_revisions")
      .select("id, revision_number, factory_agents!inner(name)")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(100),
    supabase
      .from("workspace_members")
      .select("id, full_name, username, email")
      .eq("workspace_id", workspaceId)
      .eq("kind", "human")
      .eq("is_active", true)
      .order("full_name")
      .order("id")
      .limit(100),
    revisionQuery().order("created_at", { ascending: false }).order("id").limit(100),
    base
      ? supabase
          .from("factory_definition_revisions")
          .select("definition_json")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("id", base.revisionId)
          .eq("canonical_digest", base.digest)
          .maybeSingle()
      : { data: null, error: null },
  ]);
  for (const result of [prompts, approvers, revisions, baseRevision]) {
    if (result.error) throw result.error;
  }
  const definition =
    base && baseRevision.data
      ? readVerifiedFactoryDefinition(baseRevision.data.definition_json, base.digest)
      : null;
  return {
    prompts: (prompts.data ?? []).map((item) => ({
      id: item.id,
      label: `${item.factory_agents.name} · Revision ${item.revision_number}`,
    })),
    approvers: (approvers.data ?? []).map(({ id, full_name, username, email }) => ({
      id,
      label: full_name || username || email || id,
    })),
    profiles: (revisions.data ?? []).map(({ id, canonical_digest, created_at }) => ({
      id,
      digest: canonical_digest,
      label: `${created_at.slice(0, 10)} · ${canonical_digest.slice(0, 10)}`,
    })),
    grant: definition?.executionGrant ?? null,
  };
}
