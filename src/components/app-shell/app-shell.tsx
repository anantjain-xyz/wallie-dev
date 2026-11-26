import type { ReactNode } from "react";

import { ShellHeader, type CreationFactory } from "@/components/app-shell/shell-header";
import type { WorkspaceSwitcherOption } from "@/components/app-shell/workspace-switcher";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import type { OnboardingResumeState } from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import { getWorkspaceNavItems } from "@/lib/routes";

type AppShellProps = {
  canManageFactoryDefinition?: boolean;
  canManageGovernance?: boolean;
  creationFactory: CreationFactory | null;
  factories?: readonly FactorySelectionOption[];
  children: ReactNode;
  onboarding: OnboardingResumeState | null;
  /** Fixture/test override so chrome can render active nav off real routes. */
  pathnameOverride?: string;
  viewerAvatarUrl: string | null;
  viewerEmail: string | null;
  viewerId: string;
  workspace: WorkspaceSummary;
  workspaceAvatarUrl: string | null;
  workspaceOptions?: readonly WorkspaceSwitcherOption[];
};

export function AppShell({
  canManageFactoryDefinition,
  canManageGovernance,
  creationFactory,
  factories,
  children,
  onboarding,
  pathnameOverride,
  viewerAvatarUrl,
  viewerEmail,
  viewerId,
  workspace,
  workspaceAvatarUrl,
  workspaceOptions,
}: AppShellProps) {
  const canManageActiveFactory = factories?.some(
    ({ canManage, status }) => canManage && status === "active",
  );
  const navItems = getWorkspaceNavItems(workspace.slug, {
    canManageFactoryDefinition,
    canManageGovernance,
    canManageWorkflows: canManageActiveFactory,
    canManageAutomations: canManageActiveFactory,
  });

  return (
    <div className="min-h-[100svh] min-w-0 bg-canvas" data-app-shell="">
      <ShellHeader
        creationFactory={creationFactory}
        factories={factories}
        navItems={navItems}
        onboarding={onboarding}
        pathnameOverride={pathnameOverride}
        viewerAvatarUrl={viewerAvatarUrl}
        viewerEmail={viewerEmail}
        viewerId={viewerId}
        workspace={workspace}
        workspaceAvatarUrl={workspaceAvatarUrl}
        workspaceOptions={workspaceOptions}
      >
        {children}
      </ShellHeader>
    </div>
  );
}
