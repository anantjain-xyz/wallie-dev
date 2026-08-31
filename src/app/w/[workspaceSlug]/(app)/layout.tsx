import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";
import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";

type WorkspaceAppLayoutProps = {
  children: ReactNode;
  params: Promise<{
    workspaceSlug: string;
  }>;
};

export default async function WorkspaceAppLayout({ children, params }: WorkspaceAppLayoutProps) {
  const { workspaceSlug } = await params;
  const { onboarding, user, workspace, workspaceAvatarUrl } =
    await loadWorkspaceLayoutContext(workspaceSlug);

  return (
    <AppShell
      onboarding={onboarding}
      viewerEmail={user.email ?? null}
      viewerId={user.id}
      workspace={workspace}
      workspaceAvatarUrl={workspaceAvatarUrl}
    >
      {children}
    </AppShell>
  );
}
