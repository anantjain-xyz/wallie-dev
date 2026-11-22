import type { ReactNode } from "react";

import { ShellHeader, type CreationFactory } from "@/components/app-shell/shell-header";
import type { OnboardingResumeState } from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import { getWorkspaceNavItems } from "@/lib/routes";

type AppShellProps = {
  canManageFactoryDefinition?: boolean;
  canManageGovernance?: boolean;
  creationFactory: CreationFactory | null;
  children: ReactNode;
  onboarding: OnboardingResumeState | null;
  /** Fixture/test override so chrome can render active nav off real routes. */
  pathnameOverride?: string;
  viewerAvatarUrl: string | null;
  viewerEmail: string | null;
  viewerId: string;
  workspace: WorkspaceSummary;
  workspaceAvatarUrl: string | null;
};

export function AppShell({
  canManageFactoryDefinition,
  canManageGovernance,
  creationFactory,
  children,
  onboarding,
  pathnameOverride,
  viewerAvatarUrl,
  viewerEmail,
  viewerId,
  workspace,
  workspaceAvatarUrl,
}: AppShellProps) {
  const navItems = getWorkspaceNavItems(workspace.slug, {
    canManageFactoryDefinition,
    canManageGovernance,
  });

  return (
    <div className="min-h-[100svh] min-w-0 bg-canvas" data-app-shell="">
      <ShellHeader
        creationFactory={creationFactory}
        navItems={navItems}
        onboarding={onboarding}
        pathnameOverride={pathnameOverride}
        viewerAvatarUrl={viewerAvatarUrl}
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
