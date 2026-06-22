import type { ReactNode } from "react";

import { ShellHeader } from "@/components/app-shell/shell-header";
import type { OnboardingResumeState } from "@/features/onboarding/flow";
import type { WorkspaceSummary } from "@/lib/auth";
import { getWorkspaceNavItems } from "@/lib/routes";

type AppShellProps = {
  children: ReactNode;
  defaultSessionGithubRepositoryId: string | null;
  onboarding: OnboardingResumeState | null;
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
  workspaceAvatarUrl: string | null;
};

export function AppShell({
  children,
  defaultSessionGithubRepositoryId,
  onboarding,
  viewerEmail,
  workspace,
  workspaceAvatarUrl,
}: AppShellProps) {
  const navItems = getWorkspaceNavItems(workspace.slug);

  return (
    <div className="h-[100dvh] min-h-[100svh] overflow-hidden bg-background">
      <div className="flex h-full min-w-0 flex-col bg-surface">
        <ShellHeader
          defaultSessionGithubRepositoryId={defaultSessionGithubRepositoryId}
          navItems={navItems}
          onboarding={onboarding}
          viewerEmail={viewerEmail}
          workspace={workspace}
          workspaceAvatarUrl={workspaceAvatarUrl}
        />
        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
