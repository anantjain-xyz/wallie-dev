import "server-only";

import { PageSection } from "@/components/ui/page-shell";
import { ConnectedOAuthClients } from "@/features/factory-governance/governance-oauth";
import {
  loadOAuthClientData,
  type GovernanceOAuthData,
} from "@/features/factory-governance/governance-oauth-data";
import { GovernanceResourcePages } from "@/features/factory-governance/governance-resource-link";
import { SettingsSectionError } from "@/features/settings/settings-server-shell";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { workspaceSettingsPath } from "@/lib/routes";

export async function PersonalOAuthConnections({
  afterOAuthGrant,
  workspaceSlug,
}: {
  afterOAuthGrant?: string;
  workspaceSlug: string;
}) {
  const { currentMember, supabase, workspace } =
    await loadAuthenticatedWorkspaceContext(workspaceSlug);
  if (!currentMember.is_active || currentMember.kind !== "human") return null;
  let data: GovernanceOAuthData;
  try {
    data = await loadOAuthClientData(
      { supabase, workspaceId: workspace.id },
      { afterOAuthGrant, consentingMemberId: currentMember.id },
    );
  } catch {
    return (
      <PageSection anchorId="connected-clients" title="Connected clients">
        <SettingsSectionError label="Connections" />
      </PageSection>
    );
  }

  const pageHref = (after?: string) =>
    `${workspaceSettingsPath(workspace.slug, { category: "workspace", afterOAuthGrant: after })}#connected-clients`;
  return (
    <ConnectedOAuthClients
      data={data}
      workspaceId={workspace.id}
      navigation={
        <GovernanceResourcePages
          href={pageHref()}
          next={data.nextGrant && pageHref(data.nextGrant)}
          previous={Boolean(afterOAuthGrant)}
        />
      }
    />
  );
}
