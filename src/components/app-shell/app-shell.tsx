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
    // Keep the workspace shell out of the document scroll flow. Settings anchors
    // scroll the nested <main>; a fixed shell prevents scrollIntoView from also
    // moving the root document and exposing blank space below the viewport.
    <div className="fixed inset-x-0 top-0 h-[100dvh] min-h-[100svh] overflow-hidden bg-background">
      <div className="flex h-full min-w-0 flex-col bg-surface">
        <ShellHeader
          navItems={navItems}
          onboarding={onboarding}
          viewerEmail={viewerEmail}
          viewerId={viewerId}
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
