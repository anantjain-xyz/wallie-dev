import "server-only";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveAnalyticsFactory } from "@/features/factories/factory-selection";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

export async function loadImprovementScope(
  workspaceSlug: string,
  requestedFactory: string | string[] | undefined,
) {
  const [{ currentMember, supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const factory = resolveAnalyticsFactory(factories, requestedFactory);
  return factory
    ? {
        supabase,
        factory,
        workspaceId: workspace.id,
        factoryId: factory.id,
        reviewerMemberId: currentMember.id,
      }
    : null;
}
