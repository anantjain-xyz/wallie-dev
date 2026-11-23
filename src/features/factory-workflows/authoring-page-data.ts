import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
export { loadWorkflowEditorChoices } from "@/lib/factory-workflows/reference-catalog";

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
