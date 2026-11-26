import "server-only";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveAnalyticsFactory } from "@/features/factories/factory-selection";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

export async function loadFailureGroupScope(
  workspaceSlug: string,
  requestedFactory: string | string[] | undefined,
) {
  const [{ supabase, workspace, currentMember }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const factory = resolveAnalyticsFactory(factories, requestedFactory);
  return factory
    ? { supabase, factory, currentMember, workspaceId: workspace.id, factoryId: factory.id }
    : null;
}
