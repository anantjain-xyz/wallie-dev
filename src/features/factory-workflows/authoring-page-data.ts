import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
export { loadWorkflowEditorChoices } from "@/lib/factory-workflows/reference-catalog";

const factoryIdSchema = z.string().uuid().toLowerCase();

/** Factory-only managers and workspace owners see the same scope as the native editor RPCs. */
export async function loadWorkflowAuthoringPageScope(workspaceSlug: string, factoryQuery: unknown) {
  const { factory, ...context } = await loadWorkflowAuthoringScope(workspaceSlug, factoryQuery);
  if (!factory) notFound();
  return { ...context, factoryId: factory.id };
}

export async function loadWorkflowAuthoringScope(workspaceSlug: string, factoryQuery: unknown) {
  const [context, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const manageable = factories.filter(
    (factory) => factory.canManage && factory.status === "active",
  );
  const requested = factoryIdSchema.optional().safeParse(factoryQuery);
  const factory = !requested.success
    ? undefined
    : requested.data
      ? manageable.find(({ id }) => id === requested.data)
      : (manageable.find(({ isDefault }) => isDefault) ?? manageable[0]);
  return {
    ...context,
    factories: manageable,
    workspaceId: context.workspace.id,
    factory,
  };
}
