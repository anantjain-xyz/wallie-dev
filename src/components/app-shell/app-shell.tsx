import type { ReactNode } from "react";

import { ShellHeader } from "@/components/app-shell/shell-header";
import type { WorkspaceSwitcherOption } from "@/components/app-shell/workspace-switcher";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import type { OnboardingResumeState } from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";

type AppShellProps = {
  canManageFactoryDefinition?: boolean;
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
  return (
    <div className="min-h-[100svh] min-w-0 bg-canvas" data-app-shell="">
      <ShellHeader
        canManageFactoryDefinition={canManageFactoryDefinition}
        factories={factories}
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
