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
    <div className="min-h-screen bg-background">
      <div className="flex min-h-screen w-full flex-col gap-3 p-3 xl:flex-row">
        <ShellSidebar navItems={navItems} workspace={workspace} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <ShellHeader viewerEmail={viewerEmail} workspace={workspace} />
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </div>
  );
}
