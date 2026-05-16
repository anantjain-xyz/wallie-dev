import type { ReactNode } from "react";

import { ShellHeader } from "@/components/app-shell/shell-header";
import type { WorkspaceSummary } from "@/lib/auth";
import { getWorkspaceNavItems } from "@/lib/routes";

type AppShellProps = {
  children: ReactNode;
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
};

export function AppShell({ children, viewerEmail, workspace }: AppShellProps) {
  const navItems = getWorkspaceNavItems(workspace.slug);

  return (
    <div className="h-screen overflow-hidden bg-background">
      <div className="flex h-full min-w-0 flex-col bg-surface">
        <ShellHeader navItems={navItems} viewerEmail={viewerEmail} workspace={workspace} />
        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
