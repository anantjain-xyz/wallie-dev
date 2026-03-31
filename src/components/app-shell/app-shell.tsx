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
    <div className="min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-[92rem] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8 xl:flex-row">
        <ShellSidebar navItems={navItems} workspace={workspace} />
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <ShellHeader viewerEmail={viewerEmail} workspace={workspace} />
          <main className="flex-1">{children}</main>
        </div>
      </div>
    </div>
  );
}
