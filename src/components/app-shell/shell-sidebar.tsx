"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  ChevronDownIcon,
  IssueBarsIcon,
  LogoutIcon,
  PlusIcon,
  SearchIcon,
  ViewsIcon,
  WorkspaceGlyph,
} from "@/components/shared/icons";
import { Dropdown } from "@/components/shared/dropdown";
import type { WorkspaceSummary } from "@/lib/auth";
import {
  type WorkspaceNavItem,
  workspaceBasePath,
  workspaceSessionsPath,
  workspaceSettingsPath,
} from "@/lib/routes";
import { cn } from "@/lib/utils";

type ShellSidebarProps = {
  navItems: WorkspaceNavItem[];
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
};

type SidebarEntryProps = {
  active?: boolean;
  disabled?: boolean;
  href?: string;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
};

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarEntry({
  active = false,
  disabled = false,
  href,
  icon,
  label,
  trailing,
}: SidebarEntryProps) {
  const className = cn(
    "ui-sidebar-item justify-between",
    active && "ui-sidebar-item-active",
    disabled && "cursor-default opacity-70 hover:bg-transparent hover:text-[#6b6f76]",
  );

  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="text-[#7a7d84]">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      {trailing ? <span className="shrink-0 text-[11px] text-muted">{trailing}</span> : null}
    </>
  );

  if (!href || disabled) {
    return (
      <div aria-disabled={disabled} className={className}>
        {content}
      </div>
    );
  }

  return (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}

export function ShellSidebar({ navItems, viewerEmail, workspace }: ShellSidebarProps) {
  const pathname = usePathname();
  const pipelineHref =
    navItems.find((item) => item.label === "Pipeline")?.href ?? workspaceBasePath(workspace.slug);
  const sessionsHref =
    navItems.find((item) => item.label === "Sessions")?.href ??
    workspaceSessionsPath(workspace.slug);
  const settingsHref =
    navItems.find((item) => item.label === "Settings")?.href ??
    workspaceSettingsPath(workspace.slug);
  const sessionsCreateHref = `${sessionsHref}?create=1`;

  return (
    <aside className="hidden h-screen w-[216px] shrink-0 overflow-hidden border-r border-border bg-background md:sticky md:top-0 md:flex md:flex-col">
      <div className="flex items-center justify-between px-4 pb-4 pt-4">
        <Dropdown
          trigger={
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#e0e4ea] text-[10px] font-semibold text-[#5a6070]">
                {workspace.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-foreground">
                <span className="truncate">{workspace.name}</span>
                <ChevronDownIcon className="h-3 w-3 text-muted" />
              </span>
            </span>
          }
        >
          <Link
            href={settingsHref}
            role="menuitem"
            className={cn(
              "ui-dropdown-item",
              isActive(pathname, settingsHref) && "bg-[rgba(47,45,40,0.04)] text-foreground",
            )}
          >
            <ViewsIcon className="h-3.5 w-3.5" />
            <span>Settings</span>
          </Link>
        </Dropdown>

        <div className="flex items-center gap-1.5">
          <Link href={sessionsHref} className="ui-icon-button" aria-label="Search sessions">
            <SearchIcon className="h-3.5 w-3.5" />
          </Link>
          <Link href={sessionsCreateHref} className="ui-icon-button" aria-label="Create session">
            <PlusIcon className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-2 pb-4">
        <section className="space-y-1">
          <div className="ui-sidebar-heading flex items-center gap-1">
            <span>Your teams</span>
            <ChevronDownIcon className="h-3 w-3" />
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-semibold text-[#6b6f76]">
            <span className="inline-flex h-4.5 w-4.5 items-center justify-center rounded-[4px] bg-[#dff3dc] text-[#4d9b57]">
              <WorkspaceGlyph className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{workspace.name}</span>
            <ChevronDownIcon className="ml-auto h-3 w-3 text-muted" />
          </div>

          <div className="space-y-1 pl-4">
            <SidebarEntry
              href={pipelineHref}
              active={pathname === pipelineHref}
              icon={<ViewsIcon className="h-3.5 w-3.5" />}
              label="Pipeline"
            />
            <SidebarEntry
              href={sessionsHref}
              active={isActive(pathname, sessionsHref)}
              icon={<IssueBarsIcon className="h-3.5 w-3.5" />}
              label="Sessions"
            />
          </div>
        </section>
      </div>

      <div className="border-t border-border px-3 py-3">
        <div className="flex items-center gap-2 rounded-[8px] bg-surface px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium text-foreground">
              {viewerEmail ?? "Account"}
            </p>
            <p className="text-[11px] text-muted">Signed in</p>
          </div>

          <form action="/auth/signout" method="post">
            <button type="submit" className="ui-icon-button" aria-label="Sign out">
              <LogoutIcon className="h-3.5 w-3.5" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
