import type { ReactNode } from "react";

import { ShellHeader } from "@/components/app-shell/shell-header";
import { ShellSidebar } from "@/components/app-shell/shell-sidebar";
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
      <div className="flex h-full w-full">
        <ShellSidebar navItems={navItems} viewerEmail={viewerEmail} workspace={workspace} />
        <div className="flex min-w-0 flex-1 flex-col bg-surface">
          <div className="md:hidden">
            <ShellHeader viewerEmail={viewerEmail} workspace={workspace} />
          </div>
          <main id="main-content" className="flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
