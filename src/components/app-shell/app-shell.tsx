import type { ReactNode } from "react";

import { ShellHeader } from "@/components/app-shell/shell-header";
import type { OnboardingResumeState } from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import { getWorkspaceNavItems } from "@/lib/routes";

type AppShellProps = {
  children: ReactNode;
  onboarding: OnboardingResumeState | null;
  viewerEmail: string | null;
  viewerId: string;
  workspace: WorkspaceSummary;
  workspaceAvatarUrl: string | null;
};

export function AppShell({
  children,
  onboarding,
  viewerEmail,
  viewerId,
  workspace,
  workspaceAvatarUrl,
}: AppShellProps) {
  const navItems = getWorkspaceNavItems(workspace.slug);

  return (
    <div className="min-h-[100svh] min-w-0 bg-canvas" data-app-shell="">
      <div className="flex min-h-[100svh] min-w-0 flex-col bg-sheet">
        <ShellHeader
          navItems={navItems}
          onboarding={onboarding}
          viewerEmail={viewerEmail}
          viewerId={viewerId}
          workspace={workspace}
          workspaceAvatarUrl={workspaceAvatarUrl}
        />
        <main id="main-content" className="min-w-0 flex-1 pb-[env(safe-area-inset-bottom)]">
          {children}
        </main>
      </div>
    </div>
  );
}
