import type { ReactNode } from "react";

import { ShellHeader } from "@/components/app-shell/shell-header";
import type { OnboardingResumeState } from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import { getWorkspaceNavItems } from "@/lib/routes";

type AppShellProps = {
  children: ReactNode;
  onboarding: OnboardingResumeState | null;
  /** Fixture/test override so chrome can render active nav off real routes. */
  pathnameOverride?: string;
  viewerEmail: string | null;
  viewerId: string;
  workspace: WorkspaceSummary;
  workspaceAvatarUrl: string | null;
};

export function AppShell({
  children,
  onboarding,
  pathnameOverride,
  viewerEmail,
  viewerId,
  workspace,
  workspaceAvatarUrl,
}: AppShellProps) {
  const navItems = getWorkspaceNavItems(workspace.slug);

  return (
    <div className="min-h-[100svh] min-w-0 bg-canvas" data-app-shell="">
      <ShellHeader
        navItems={navItems}
        onboarding={onboarding}
        pathnameOverride={pathnameOverride}
        viewerEmail={viewerEmail}
        viewerId={viewerId}
        workspace={workspace}
        workspaceAvatarUrl={workspaceAvatarUrl}
      >
        {children}
      </ShellHeader>
    </div>
  );
}
