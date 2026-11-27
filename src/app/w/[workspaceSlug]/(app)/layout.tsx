import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { loadWorkspaceSwitcherOptions } from "@/components/app-shell/workspace-switcher-data";
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
    workspaceOptions,
  ] = await Promise.all([
    loadWorkspaceLayoutContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
    loadWorkspaceSwitcherOptions(workspaceSlug),
  ]);
  return (
    <AppShell
      canManageFactoryDefinition={isWorkspaceOperator(currentMember)}
      factories={factories}
      onboarding={onboarding}
      viewerAvatarUrl={viewerAvatarUrl}
      viewerEmail={user.email ?? null}
      viewerId={user.id}
      workspace={workspace}
      workspaceAvatarUrl={workspaceAvatarUrl}
      workspaceOptions={workspaceOptions}
    >
      {children}
    </AppShell>
  );
}
