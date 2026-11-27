import "server-only";

import Link from "next/link";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { WorkspaceFactoryManagementIsland } from "@/features/settings/islands/factory-management-island";
import { Section } from "@/features/settings/settings-ui";
import { WorkspaceSettingsLoadError } from "@/features/settings/workspace-settings-load-error";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { workspaceSettingsPath } from "@/lib/routes";
import type { Tables } from "@/lib/supabase/database.types";

export type FactoryManagementMember = {
  id: string;
  label: string;
  factoryRole: "manager" | "member" | null;
  workspaceRole: Tables<"workspace_members">["role"];
};

export async function WorkspaceFactoryManagement({
  factoryId,
  workspaceSlug,
}: {
  factoryId: string;
  workspaceSlug: string;
}) {
  const [{ supabase, workspace }, options] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const factory = options.find(({ canManage, id }) => canManage && id === factoryId);
  if (!factory) {
    return (
      <Section anchorId="factory-management" heading="h3" title="Factory management unavailable">
        <p className="type-secondary text-muted">You need manager access to this factory.</p>
      </Section>
    );
  }

  const [grants, workspaceMembers] = await Promise.all([
    supabase
      .from("factory_members")
      .select("member_id, role")
      .eq("workspace_id", workspace.id)
      .eq("factory_id", factory.id)
      .is("revoked_at", null),
    supabase
      .from("workspace_members")
      .select("id, full_name, email, role")
      .eq("workspace_id", workspace.id)
      .eq("kind", "human")
      .eq("is_active", true)
      .order("full_name")
      .order("id"),
  ]);
  if (grants.error || workspaceMembers.error) {
    return (
      <Section anchorId="factory-management" heading="h3" title={factory.name}>
        <WorkspaceSettingsLoadError label="factory management" />
      </Section>
    );
  }

  const roles = new Map(
    grants.data.map(
      ({ member_id, role }) => [member_id, role === "manager" ? "manager" : "member"] as const,
    ),
  );
  const members: FactoryManagementMember[] = workspaceMembers.data.map(
    ({ email, full_name, id, role }) => ({
      factoryRole: roles.get(id) ?? null,
      id,
      label: [full_name?.trim(), email].filter(Boolean).join(" · ") || "Workspace member",
      workspaceRole: role,
    }),
  );
  return (
    <Section
      actions={
        <Link
          aria-label="Close factory management"
          className="ui-button min-h-11 sm:min-h-9"
          href={`${workspaceSettingsPath(workspaceSlug, { category: "workspace" })}#factories`}
          prefetch={false}
        >
          Close
        </Link>
      }
      anchorId="factory-management"
      className="ui-sheet p-4 sm:p-5"
      heading="h3"
      title={factory.name}
    >
      <WorkspaceFactoryManagementIsland
        key={factory.id}
        factory={factory}
        members={members}
        workspaceId={workspace.id}
      />
    </Section>
  );
}
