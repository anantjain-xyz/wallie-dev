"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { WallieMark } from "@/components/shared/wallie-mark";
import type { WorkspaceSummary } from "@/lib/auth";
import { type WorkspaceNavItem } from "@/lib/routes";
import { cn } from "@/lib/utils";

type ShellSidebarProps = {
  navItems: WorkspaceNavItem[];
  workspace: WorkspaceSummary;
};

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function ShellSidebar({
  navItems,
  workspace,
}: ShellSidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="w-full shrink-0 xl:w-[15.5rem]">
      <div className="ui-panel sticky top-3 flex flex-col gap-3 p-3">
        <div className="flex items-center gap-3 px-1 py-1">
          <WallieMark />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {workspace.name}
            </p>
            <p className="text-xs font-mono text-muted">/{workspace.slug}</p>
          </div>
        </div>

        <nav className="space-y-1">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-[10px] px-3 py-2 text-sm font-medium transition",
                  active
                    ? "bg-foreground text-background"
                    : "text-foreground/80 hover:bg-surface-muted hover:text-foreground",
                )}
              >
                <span>{item.label}</span>
                <span
                  className={cn(
                    "text-[11px]",
                    active ? "text-background/72" : "text-muted",
                  )}
                >
                  /{item.label.toLowerCase().replace(/\s+/g, "-")}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="ui-subpanel mt-auto px-3 py-3">
          <p className="text-[11px] font-medium text-muted">Cloud rebuild</p>
          <p className="mt-1 text-sm font-medium text-foreground">
            Next.js, Supabase, Vercel
          </p>
          <p className="mt-1 text-xs leading-5 text-muted">
            Dense issue workflow and async Wallie runs, without carrying the old
            local-first architecture forward.
          </p>
        </div>
      </div>
    </aside>
  );
}
