import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { isWorkspaceOperator } from "@/features/workspaces/authenticated-context";
import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";

type WorkspaceAppLayoutProps = {
  children: ReactNode;
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceAppLayout({ children, params }: WorkspaceAppLayoutProps) {
  const { workspaceSlug } = await params;
  const [
    { currentMember, onboarding, user, viewerAvatarUrl, workspace, workspaceAvatarUrl },
    factories,
  ] = await Promise.all([
    loadWorkspaceLayoutContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const defaultFactory = factories.find(
    (factory) => factory.isDefault && factory.status === "active",
  );

  return (
    <AppShell
      canManageFactoryDefinition={isWorkspaceOperator(currentMember)}
      canManageGovernance={factories.some(({ canManage }) => canManage)}
      creationFactory={defaultFactory ? { id: defaultFactory.id, name: defaultFactory.name } : null}
      onboarding={onboarding}
      viewerAvatarUrl={viewerAvatarUrl}
      viewerEmail={user.email ?? null}
      viewerId={user.id}
      workspace={workspace}
      workspaceAvatarUrl={workspaceAvatarUrl}
    >
      {children}
    </AppShell>
  );
}
