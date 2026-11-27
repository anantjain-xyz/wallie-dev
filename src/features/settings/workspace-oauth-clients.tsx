import "server-only";

import {
  ConnectedOAuthClients,
  RegisteredOAuthClients,
} from "@/features/factory-governance/governance-oauth";
import { loadOAuthClientData } from "@/features/factory-governance/governance-oauth-data";
import { GovernanceResourcePages } from "@/features/factory-governance/governance-resource-link";
import { Section } from "@/features/settings/settings-ui";
import { WorkspaceSettingsLoadError } from "@/features/settings/workspace-settings-load-error";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import { workspaceSettingsPath } from "@/lib/routes";

export async function WorkspaceOAuthClients({
  afterOAuthClient,
  afterOAuthGrant,
  workspaceSlug,
}: {
  afterOAuthClient?: string;
  afterOAuthGrant?: string;
  workspaceSlug: string;
}) {
  const { currentMember, supabase, workspace } =
    await loadAuthenticatedWorkspaceContext(workspaceSlug);
  if (!isWorkspaceOperator(currentMember)) return null;

  const result = await Promise.all([
    loadOAuthClientData(
      { supabase, workspaceId: workspace.id },
      { afterOAuthClient, afterOAuthGrant, isOperator: true },
    ),
    supabase
      .from("workspace_members")
      .select("id, full_name, email")
      .eq("workspace_id", workspace.id)
      .eq("kind", "human"),
  ]).catch(() => null);
  if (!result || result[1].error) {
    return (
      <>
        <Section anchorId="oauth-clients" title="OAuth clients">
          <WorkspaceSettingsLoadError label="OAuth clients" />
        </Section>
        <Section anchorId="workspace-oauth-connections" title="OAuth connections">
          <WorkspaceSettingsLoadError label="OAuth connections" />
        </Section>
      </>
    );
  }
  const [data, members] = result;
  const memberOptions = (members.data ?? []).map(({ email, full_name, id }) => ({
    id,
    label: full_name?.trim() || email || "Workspace member (name unavailable)",
  }));
  const href = (key: "afterOAuthClient" | "afterOAuthGrant", value?: string) =>
    `${workspaceSettingsPath(workspaceSlug, { category: "workspace", afterOAuthClient, afterOAuthGrant, [key]: value })}#${key === "afterOAuthClient" ? "oauth-clients" : "workspace-oauth-connections"}`;
  return (
    <>
      <RegisteredOAuthClients
        data={data}
        workspaceId={workspace.id}
        navigation={
          <GovernanceResourcePages
            href={href("afterOAuthClient")}
            next={data.nextClient && href("afterOAuthClient", data.nextClient)}
            previous={Boolean(afterOAuthClient)}
          />
        }
      />
      <ConnectedOAuthClients
        data={data}
        memberOptions={memberOptions}
        workspaceId={workspace.id}
        navigation={
          <GovernanceResourcePages
            href={href("afterOAuthGrant")}
            next={data.nextGrant && href("afterOAuthGrant", data.nextGrant)}
            previous={Boolean(afterOAuthGrant)}
          />
        }
      />
    </>
  );
}
