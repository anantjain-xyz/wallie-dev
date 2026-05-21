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
  const {
    defaultSessionGithubRepositoryId,
    onboarding,
    sessionRepositoryOptions,
    user,
    workspace,
  } = await loadWorkspaceLayoutContext(workspaceSlug);

  return (
    <AppShell
      defaultSessionGithubRepositoryId={defaultSessionGithubRepositoryId}
      onboarding={onboarding}
      sessionRepositoryOptions={sessionRepositoryOptions}
      viewerEmail={user.email ?? null}
      workspace={workspace}
    >
      {children}
    </AppShell>
  );
}
