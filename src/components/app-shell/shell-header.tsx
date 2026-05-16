"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { LogoutIcon } from "@/components/shared/icons";
import type { WorkspaceSummary } from "@/lib/auth";
import { type WorkspaceNavItem, workspaceBasePath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type ShellHeaderProps = {
  navItems: WorkspaceNavItem[];
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
};

function navLabel(item: WorkspaceNavItem) {
  return item.label === "Settings" ? "Workspace Settings" : item.label;
}

function isActive(pathname: string, workspaceSlug: string, item: WorkspaceNavItem) {
  const pipelineHref = workspaceBasePath(workspaceSlug);

  if (item.href === pipelineHref) {
    return pathname === pipelineHref;
  }

  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function ShellHeader({ navItems, viewerEmail, workspace }: ShellHeaderProps) {
  const pathname = usePathname();
  const signOutLabel = viewerEmail ? `Sign out ${viewerEmail}` : "Sign out";

  return (
    <header className="sticky top-0 z-20 flex h-14 min-w-0 items-center justify-between gap-3 border-b border-border bg-surface px-3 sm:px-5">
      <nav className="min-w-0 flex-1 overflow-x-auto" aria-label="Workspace navigation">
        <div className="flex min-w-max items-center gap-1">
          {navItems.map((item) => {
            const active = isActive(pathname, workspace.slug, item);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn("ui-top-nav-tab", active && "ui-top-nav-tab-active")}
              >
                {navLabel(item)}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="shrink-0">
        <form action="/auth/signout" method="post">
          <button type="submit" className="ui-icon-button" aria-label={signOutLabel}>
            <LogoutIcon className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </header>
  );
}
