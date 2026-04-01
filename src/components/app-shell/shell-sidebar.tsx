"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  ChevronDownIcon,
  InboxIcon,
  IssueBarsIcon,
  MoreIcon,
  MyIssuesIcon,
  PlusIcon,
  ProjectsIcon,
  ReviewsIcon,
  SearchIcon,
  SparkIcon,
  ViewsIcon,
  WorkspaceGlyph,
} from "@/components/shared/linear-icons";
import type { WorkspaceSummary } from "@/lib/auth";
import {
  type WorkspaceNavItem,
  workspaceIssuesPath,
  workspaceSettingsPath,
} from "@/lib/routes";
import { cn } from "@/lib/utils";

type ShellSidebarProps = {
  navItems: WorkspaceNavItem[];
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
    "linear-sidebar-item justify-between",
    active && "linear-sidebar-item-active",
    disabled && "cursor-default opacity-70 hover:bg-transparent hover:text-[#666259]",
  );

  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="text-[#757167]">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      {trailing ? (
        <span className="shrink-0 text-[11px] text-muted">{trailing}</span>
      ) : null}
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

export function ShellSidebar({
  navItems,
  workspace,
}: ShellSidebarProps) {
  const pathname = usePathname();
  const issuesHref =
    navItems.find((item) => item.label === "Issues")?.href ??
    workspaceIssuesPath(workspace.slug);
  const settingsHref =
    navItems.find((item) => item.label === "Settings")?.href ??
    workspaceSettingsPath(workspace.slug);

  return (
    <aside className="hidden w-[216px] shrink-0 border-r border-border bg-background md:flex md:flex-col">
      <div className="flex items-center justify-between px-4 pb-4 pt-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#e7dcc8] text-[10px] font-semibold text-[#7a5b31]">
            {workspace.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="flex min-w-0 items-center gap-1 text-[13px] font-semibold text-foreground">
            <span className="truncate">{workspace.name}</span>
            <ChevronDownIcon className="h-3 w-3 text-muted" />
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="linear-icon-button"
            aria-label="Search"
          >
            <SearchIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="linear-icon-button"
            aria-label="Create"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-2 pb-4">
        <div className="space-y-1">
          <SidebarEntry disabled icon={<InboxIcon className="h-3.5 w-3.5" />} label="Inbox" />
          <SidebarEntry disabled icon={<ReviewsIcon className="h-3.5 w-3.5" />} label="Reviews" />
          <SidebarEntry disabled icon={<MyIssuesIcon className="h-3.5 w-3.5" />} label="My issues" />
        </div>

        <section className="space-y-1">
          <div className="linear-sidebar-heading flex items-center gap-1">
            <span>Workspace</span>
            <ChevronDownIcon className="h-3 w-3" />
          </div>
          <SidebarEntry disabled icon={<SparkIcon className="h-3.5 w-3.5" />} label="Initiatives" />
          <SidebarEntry disabled icon={<ProjectsIcon className="h-3.5 w-3.5" />} label="Projects" />
          <SidebarEntry disabled icon={<ViewsIcon className="h-3.5 w-3.5" />} label="Views" />
          <SidebarEntry
            href={settingsHref}
            active={isActive(pathname, settingsHref)}
            icon={<MoreIcon className="h-3.5 w-3.5" />}
            label="More"
          />
        </section>

        <section className="space-y-1">
          <div className="linear-sidebar-heading flex items-center gap-1">
            <span>Favorites</span>
            <ChevronDownIcon className="h-3 w-3" />
          </div>
          <SidebarEntry
            href={workspaceIssuesPath(workspace.slug, { estimate: "null" })}
            icon={<ViewsIcon className="h-3.5 w-3.5" />}
            label="Unestimated current cycle"
          />
          <SidebarEntry
            disabled
            icon={<MyIssuesIcon className="h-3.5 w-3.5" />}
            label="Unassigned current cycle"
          />
        </section>

        <section className="space-y-1">
          <div className="linear-sidebar-heading flex items-center gap-1">
            <span>Your teams</span>
            <ChevronDownIcon className="h-3 w-3" />
          </div>

          <div className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-semibold text-[#666259]">
            <span className="inline-flex h-4.5 w-4.5 items-center justify-center rounded-[4px] bg-[#dff3dc] text-[#4d9b57]">
              <WorkspaceGlyph className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{workspace.name}</span>
            <ChevronDownIcon className="ml-auto h-3 w-3 text-muted" />
          </div>

          <div className="space-y-1 pl-4">
            <SidebarEntry
              href={issuesHref}
              active={isActive(pathname, issuesHref)}
              icon={<IssueBarsIcon className="h-3.5 w-3.5" />}
              label="Issues"
            />
            <SidebarEntry disabled icon={<ProjectsIcon className="h-3.5 w-3.5" />} label="Projects" />
            <SidebarEntry disabled icon={<ViewsIcon className="h-3.5 w-3.5" />} label="Views" />
          </div>
        </section>
      </div>
    </aside>
  );
}
