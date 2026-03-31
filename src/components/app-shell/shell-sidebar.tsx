"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { WallieMark } from "@/components/shared/wallie-mark";
import type { WorkspaceSummary } from "@/lib/auth";
import { siteConfig } from "@/lib/site-config";
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
    <aside className="w-full max-w-sm shrink-0 xl:max-w-xs">
      <div className="sticky top-6 rounded-[2rem] border border-border/90 bg-surface/95 p-5 shadow-[0_24px_80px_rgba(20,33,61,0.08)] backdrop-blur">
        <div className="flex items-center gap-4 border-b border-border/70 pb-5">
          <WallieMark />
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted">
              Implementation Target
            </p>
            <p className="text-lg font-semibold text-foreground">
              {workspace.name}
            </p>
            <p className="text-xs font-mono text-muted">/{workspace.slug}</p>
          </div>
        </div>

        <nav className="mt-5 space-y-3">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "block rounded-[1.5rem] border px-4 py-4 transition",
                  active
                    ? "border-accent/40 bg-accent/12 text-foreground shadow-[0_18px_36px_rgba(184,79,47,0.12)]"
                    : "border-border/70 bg-surface-strong/70 text-foreground/85 hover:border-accent/30 hover:bg-surface-strong",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold tracking-[0.14em] uppercase">
                    {item.label}
                  </span>
                  <span className="text-xs text-muted">/{item.label.toLowerCase().replace(/\s+/g, "-")}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {item.description}
                </p>
              </Link>
            );
          })}
        </nav>

        <div className="mt-5 rounded-[1.5rem] border border-border/70 bg-foreground px-4 py-4 text-background shadow-[0_18px_36px_rgba(20,33,61,0.18)]">
          <p className="text-xs font-semibold uppercase tracking-[0.26em] text-background/70">
            Bootstrap Rules
          </p>
          <ul className="mt-3 space-y-3 text-sm leading-6 text-background/90">
            {siteConfig.principles.map((principle) => (
              <li key={principle}>{principle}</li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}
