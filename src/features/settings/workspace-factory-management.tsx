import "server-only";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FactoryManagementCloseLink,
  WorkspaceFactoryManagementIsland,
} from "@/features/settings/islands/factory-management-island";
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

const memberPageSize = 500;

async function readMemberPages<Row>(
  readPage: (after?: string) => PromiseLike<{ data: Row[] | null; error: unknown }>,
  cursor: (row: Row) => string,
) {
  const rows: Row[] = [];
  let after: string | undefined;
  for (;;) {
    const { data, error } = await readPage(after);
    if (error || !data) throw error ?? new Error("Factory membership page unavailable.");
    rows.push(...data);
    if (data.length < memberPageSize) return rows;
    after = cursor(data[data.length - 1]);
  }
}

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
  const close = (
    <FactoryManagementCloseLink
      href={`${workspaceSettingsPath(workspaceSlug, { category: "workspace" })}#factories`}
    />
  );
  const factory = options.find(({ canManage, id }) => canManage && id === factoryId);
  if (!factory) {
    return (
      <Section
        actions={close}
        anchorId="factory-management"
        heading="h3"
        title="Factory management unavailable"
      >
        <p className="type-secondary text-muted">You need manager access to this factory.</p>
      </Section>
    );
  }

  const membership = await Promise.all([
    readMemberPages(
      (after) => {
        const query = supabase
          .from("factory_members")
          .select("member_id, role")
          .eq("workspace_id", workspace.id)
          .eq("factory_id", factory.id)
          .is("revoked_at", null)
          .order("member_id")
          .limit(memberPageSize);
        return after ? query.gt("member_id", after) : query;
      },
      (row) => row.member_id,
    ),
    readMemberPages(
      (after) => {
        const query = supabase
          .from("workspace_members")
          .select("id, full_name, email, role")
          .eq("workspace_id", workspace.id)
          .eq("kind", "human")
          .eq("is_active", true)
          .order("id")
          .limit(memberPageSize);
        return after ? query.gt("id", after) : query;
      },
      (row) => row.id,
    ),
  ]).catch(() => null);
  if (!membership) {
    return (
      <Section actions={close} anchorId="factory-management" heading="h3" title={factory.name}>
        <WorkspaceSettingsLoadError label="factory management" />
      </Section>
    );
  }

  const [grants, workspaceMembers] = membership;
  const roles = new Map(
    grants.map(
      ({ member_id, role }) => [member_id, role === "manager" ? "manager" : "member"] as const,
    ),
  );
  const members: FactoryManagementMember[] = workspaceMembers
    .map(({ email, full_name, id, role }) => ({
      factoryRole: roles.get(id) ?? null,
      id,
      label: [full_name?.trim(), email].filter(Boolean).join(" · ") || "Workspace member",
      workspaceRole: role,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return (
    <Section
      actions={close}
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
